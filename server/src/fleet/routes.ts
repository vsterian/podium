import { ingestNativeEvent } from './nativeEvents.js';
// Express router for Podium, mounted at /api/fleet (SPEC 7.1, 7.7).
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Fleet } from './fleet.js';
import { checkReporter, REPORTER_SUPPORT, serverVersion } from './compat.js';
import { MAIN_LOOP, validateReport } from './protocol.js';
import { everyOf, type ActivityReply } from './activity.js';
import { OwnerConflict } from './ingest.js';
import { ADMIN_OWNER, nameKey, sourceAddress, type PeopleStore, type PersonRow } from './people.js';
import { ReporterStore, type IgnoreRule, type IgnoreTarget, type ReporterSeen } from './reporters.js';
import { parsePersonToken, safeEqualStr, tokenMatches } from './tokens.js';
import { createLogger, loggerFromLine, type Logger } from '../logging/logger.js';
import { GuessThrottle, Lockout } from './lockout.js';
import { mountRespondRoutes, replyFor } from './respondRoutes.js';
import type { RespondBridge } from './respondBridge.js';

export interface FleetRouterOptions {
  /** The admin secret (PODIUM_TOKEN). When set, POST /report, DELETE and POST /hook need a credential in X-Podium-Token: this, or a person's token. */
  token?: string | null;
  /** Per-person tokens. Without it only the admin secret works. */
  people?: PeopleStore | null;
  /** Where every accepted report's sender is recorded, for the Admin's Reporters page (#142). */
  reporters?: ReporterStore | null;
  /** The server's logger (#140). Never given a report body, a token or typed text. */
  logger?: Logger;
  /** A plain line sink, kept for callers from before the logger: text lines, as `logger` would print them. */
  log?: (line: string) => void;
  /** Wrong-try counter shared with Admin's unlock, for the sign-in to respond (#206). A fresh one when absent. */
  lockout?: Lockout;
  /** Throttle for wrong secrets sent as X-Podium-Token, separate from `lockout` (#255). A fresh one when absent. */
  guesses?: GuessThrottle;
  /** Filled in so Admin can open for a browser already signed in to respond as an Administrator (#215). */
  respondBridge?: RespondBridge;
  /** Runs ahead of the sign-in to respond, to note a plain-HTTP connection (#306). It never blocks. */
  onSignIn?: RequestHandler;
}

export const BODY_LIMIT = '512kb';

/** Who a request's X-Podium-Token says it is. */
export type Identity = { kind: 'person'; person: PersonRow } | { kind: 'admin' } | { kind: 'open' };

/** Who a request is, or why it was refused (the reason goes to the log, never to the client, and never the token). */
function identify(opts: FleetRouterOptions, given: unknown): Identity | { refused: string } {
  const presented = typeof given === 'string' ? given : '';
  const parsed = presented ? parsePersonToken(presented) : null;
  if (parsed && opts.people) {
    const person = opts.people.findByKeyId(parsed.keyId);
    if (!person) return { refused: 'unknown person token' };
    if (person.revokedAt !== null) return { refused: 'revoked person token' };
    if (!tokenMatches(presented, person.tokenHash)) return { refused: 'wrong person token' };
    return { kind: 'person', person };
  }
  if (opts.token) {
    if (!presented) return { refused: 'missing token' };
    if (!safeEqualStr(opts.token, presented)) return { refused: 'wrong token' };
    return !opts.people || opts.people.adminReportingAllowed() ? { kind: 'admin' } : { refused: 'reporting with the admin secret is off' };
  }
  // Authentication is off. A token that was presented but is not a person's is simply ignored.
  return { kind: 'open' };
}

/** The address a report came from, as the Machines column shows it. */
const machineOf = (req: Request): string | null => (req.ip ? sourceAddress(req.ip) : null);

/** How the Reporters page names the credential: a person's token by its key id (never the token), or the admin secret. */
const credentialOf = (id: Identity): string | null => (id.kind === 'person' ? `pdm_${id.person.keyId}` : id.kind === 'admin' ? 'admin secret' : null);

/** The `hostSurface` the simulator reports; the Reporters page never lists it (#168). */
const SIMULATOR_SURFACE = 'simulator';

/** Bookkeeping for the Reporters page must never turn a stored report into a failed one. */
function noteReporter(opts: FleetRouterOptions, logger: Logger, seen: ReporterSeen, now: number): void {
  try {
    opts.reporters?.record(seen, now);
  } catch (err) {
    logger.warn('reporter.record_failed', `podium: could not note the reporter: ${(err as Error).message}`, { reason: (err as Error).message });
  }
}

/** The key a sender is known by, and any other row that already holds its session, for the ignore check. */
function keyTarget(opts: FleetRouterOptions, s: { kind: 'mod' | 'hooks' | 'native'; engine?: string; machineId: string | null; source: string | null; sessionId: string; owner?: string | null }): { key: string; otherKeys: string[] } {
  const own = ReporterStore.keyOf(s);
  try {
    const keys = opts.reporters?.keysFor(s) ?? [own];
    return { key: own, otherKeys: keys.filter((k) => k !== own) };
  } catch {
    return { key: own, otherKeys: [] };
  }
}

/** Refuses a report from a reporter the Admin ignores (issue #167): says so, notes it, and returns true. Nothing is stored. */
function refuseIgnored(opts: FleetRouterOptions, logger: Logger, fleet: Fleet, req: Request, res: Response, who: IgnoreTarget): boolean {
  let rule: IgnoreRule | undefined;
  try {
    rule = opts.reporters?.ignoredBy(who);
  } catch (err) {
    logger.warn('reporter.ignore_check_failed', `podium: could not check the ignore rules: ${(err as Error).message}`, { reason: (err as Error).message });
  }
  if (!rule) return false;
  const reason = 'this reporter is ignored by the Admin';
  logger.warn('report.ignored', `podium: refused ${routeName(req)} from ${machineOf(req) ?? 'unknown'}: ${reason}`, { route: routeName(req), method: req.method, status: 403, reason, rule_id: rule.id, source: machineOf(req) });
  opts.reporters?.rejected(machineOf(req), reason, fleet.now());
  res.status(403).json({ ok: false, error: reason, path: '$' });
  return true;
}

const ownerOf = (id: Identity): string | null => (id.kind === 'person' ? id.person.name : id.kind === 'admin' ? ADMIN_OWNER : null);

/** Rows per page on `GET /history` (#195): the choices the page offers, and the default. */
export const HISTORY_PAGE_SIZES = [25, 50, 100];
const HISTORY_PAGE_SIZE = 50;

function intParam(v: unknown): number | null | 'bad' {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return 'bad';
  return Number(v);
}

/** The route a request matched, as `/api/fleet/report`. */
const routeName = (req: Request): string => `${req.baseUrl}${(req.route as { path?: string } | undefined)?.path ?? req.path}`;

export function createFleetRouter(fleet: Fleet, opts: FleetRouterOptions = {}): Router {
  const logger = opts.logger ?? (opts.log ? loggerFromLine(opts.log) : createLogger({ secrets: opts.token ? [opts.token] : [] }));
  const router = Router();
  const json = express.json({ limit: BODY_LIMIT, type: ['application/json', 'application/*+json'] });

  const guesses = opts.guesses ?? new GuessThrottle(fleet.now);
  /** A person's token is 192 random bits, so it cannot be guessed and is never throttled; anything else could be a guess at the admin secret. */
  const mayBeGuess = (given: unknown): given is string => typeof given === 'string' && given !== '' && !(opts.people && parsePersonToken(given));

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const given = req.get('x-podium-token');
    const source = machineOf(req) ?? 'unknown';
    // A throttled address gets no answer for anything that could be a guess, even the right secret, or the throttle would confirm one.
    const lockedFor = opts.token && mayBeGuess(given) ? guesses.lockedFor(source) : 0;
    if (lockedFor > 0) {
      const route = routeName(req);
      logger.warn('auth.failed', `podium: throttled ${req.method} ${route} from ${source}: too many wrong secrets`, {
        route,
        method: req.method,
        status: 429,
        reason: 'too many wrong secrets',
        source,
      });
      opts.reporters?.rejected(machineOf(req), 'too many wrong secrets', fleet.now());
      res.set('Retry-After', String(Math.ceil(lockedFor / 1000)));
      res.status(429).json({ ok: false, error: 'too many wrong tries', retryAfterSec: Math.ceil(lockedFor / 1000) });
      return;
    }
    const id = identify(opts, given);
    if ('refused' in id && opts.token && mayBeGuess(given) && id.refused === 'wrong token') guesses.fail(source, given);
    if (!('refused' in id)) {
      res.locals.identity = id;
      return next();
    }
    const route = routeName(req);
    logger.warn('auth.failed', `podium: refused ${req.method} ${route} from ${machineOf(req) ?? 'unknown'}: ${id.refused}`, {
      route,
      method: req.method,
      status: 401,
      reason: id.refused,
      source: machineOf(req),
    });
    opts.reporters?.rejected(machineOf(req), id.refused, fleet.now());
    res.status(401).json({ ok: false, error: 'missing or wrong X-Podium-Token', path: '$' });
  };
  const identityOf = (res: Response): Identity => res.locals.identity as Identity;

  router.post('/report', requireToken, json, (req, res) => {
    const result = validateReport(req.body);
    if (!result.ok) {
      logger.warn('report.rejected', `podium: rejected report at ${result.path}: ${result.error}`, {
        reason: result.error,
        path: result.path,
        status: 400,
        source: machineOf(req),
      });
      opts.reporters?.rejected(machineOf(req), `${result.error} (${result.path})`, fleet.now());
      res.status(400).json({ ok: false, error: result.error, path: result.path });
      return;
    }
    const id = identityOf(res);
    // The token decides who the sender is; the name it carries must agree (a consistency check, since names are visible).
    if (id.kind === 'person' && nameKey(result.report.userName ?? '') !== nameKey(id.person.name)) {
      logger.warn('auth.failed', `podium: refused a report from ${machineOf(req) ?? 'unknown'}: the token does not belong to that name`, {
        route: routeName(req),
        method: req.method,
        status: 401,
        reason: 'the token does not belong to that name',
        owner: id.person.name,
        source: machineOf(req),
        session_id: result.report.session.id,
      });
      opts.reporters?.rejected(machineOf(req), 'the token does not belong to that name', fleet.now());
      res.status(401).json({ ok: false, error: 'the token does not belong to that name', path: '$.userName' });
      return;
    }
    const machineId = result.report.machine?.id ?? null;
    const asHooks = result.report.reporter.hostSurface === 'settings-hooks';
    if (
      result.report.reporter.hostSurface !== SIMULATOR_SURFACE &&
      refuseIgnored(opts, logger, fleet, req, res, {
        ...keyTarget(opts, { kind: asHooks ? 'hooks' : 'mod', machineId, source: machineOf(req), sessionId: result.report.session.id, owner: ownerOf(id) }),
        source: machineOf(req),
        version: result.report.reporter.version,
      })
    ) {
      return;
    }
    try {
      const out = fleet.ingest(result.report, ownerOf(id));
      if (id.kind === 'person') opts.people?.touch(id.person.id, machineOf(req), fleet.now()); // only a report that was stored counts
      const r = result.report;
      // The simulator (`npm run podium:sim`) says so in hostSurface; it is never listed, so a run leaves no reporter row behind (#168).
      if (r.reporter.hostSurface !== SIMULATOR_SURFACE) {
        noteReporter(
          opts,
          logger,
          {
            kind: r.reporter.hostSurface === 'settings-hooks' ? 'hooks' : 'mod',
            machineId: r.machine?.id ?? null,
            machineName: r.machine?.name ?? null,
            source: machineOf(req),
            owner: ownerOf(id),
            credential: credentialOf(id),
            version: r.reporter.version,
            engineVersion: r.reporter.engineVersion,
            sessionId: out.sessionId,
          },
          fleet.now(),
        );
      }
      logger.debug('report.accepted', `podium: report for session ${out.sessionId}`, {
        session_id: out.sessionId,
        owner: ownerOf(id),
        events: result.report.events.length,
        new_events: out.newEvents.length,
        agents: result.report.agents.length,
        status: result.report.session.status,
        reporter_version: result.report.reporter.version,
      });
      res.json({ ok: true, serverTime: fleet.now(), ackedEvents: result.report.events.length, sessionId: out.sessionId, liveSessions: fleet.visibleCount(), serverVersion: serverVersion(), reporterSupport: REPORTER_SUPPORT, reporterCompat: checkReporter(result.report.reporter.version), watch: fleet.activity.watched(out.sessionId), ...replyFor(fleet, opts.token ?? null, out.sessionId) });
    } catch (err) {
      if (err instanceof OwnerConflict) {
        logger.warn('report.conflict', `podium: refused a report for session ${result.report.session.id}: it belongs to someone else`, {
          session_id: result.report.session.id,
          owner: ownerOf(id),
          status: 409,
          reason: 'that session belongs to someone else',
          source: machineOf(req),
        });
        res.status(409).json({ ok: false, error: 'that session belongs to someone else', path: '$.session.id' });
        return;
      }
      logger.error('ingest.failed', `podium: ingest failed for a report: ${(err as Error).message}`, {
        session_id: result.report.session.id,
        reason: (err as Error).message,
        status: 500,
      });
      res.status(500).json({ ok: false, error: 'ingest failed', path: '$' });
    }
  });

  // Classic settings hooks (T5.1): each hook POSTs its stdin payload here.
  router.post('/hook', requireToken, json, (req, res) => {
    try {
      const id = identityOf(res);
      const hookSession = typeof req.body?.session_id === 'string' ? (req.body.session_id as string) : '';
      if (refuseIgnored(opts, logger, fleet, req, res, { ...keyTarget(opts, { kind: 'hooks', machineId: null, source: machineOf(req), sessionId: hookSession }), source: machineOf(req), version: 'hooks' })) return;
      const out = fleet.ingestHook(req.body, ownerOf(id));
      if (!out.ok) {
        logger.warn('hook.rejected', `podium: rejected hook payload at ${out.path}: ${out.error}`, {
          reason: out.error,
          path: out.path,
          status: 400,
          source: machineOf(req),
        });
        opts.reporters?.rejected(machineOf(req), `${out.error} (${out.path})`, fleet.now());
        res.status(400).json(out);
        return;
      }
      if (id.kind === 'person') opts.people?.touch(id.person.id, machineOf(req), fleet.now());
      noteReporter(
        opts,
        logger,
        { kind: 'hooks', machineId: null, machineName: null, source: machineOf(req), owner: ownerOf(id), credential: credentialOf(id), version: 'hooks', engineVersion: null, sessionId: out.sessionId },
        fleet.now(),
      );
      res.json({ ok: true, sessionId: out.sessionId });
    } catch (err) {
      if (err instanceof OwnerConflict) {
        const sid = typeof req.body?.session_id === 'string' ? (req.body.session_id as string) : null;
        logger.warn('report.conflict', `podium: refused a hook payload for session ${sid ?? 'unknown'}: it belongs to someone else`, {
          session_id: sid,
          status: 409,
          reason: 'that session belongs to someone else',
          source: machineOf(req),
        });
        res.status(409).json({ ok: false, error: 'that session belongs to someone else', path: '$.session_id' });
        return;
      }
      logger.error('ingest.failed', `podium: hook ingest failed: ${(err as Error).message}`, { reason: (err as Error).message, status: 500, route: routeName(req) });
      res.status(500).json({ ok: false, error: 'ingest failed', path: '$' });
    }
  });

  router.post('/event', requireToken, json, (req, res) => {
    const id = identityOf(res);
    if (id.kind === 'person' && nameKey(typeof req.body?.userName === 'string' ? req.body.userName : '') !== nameKey(id.person.name)) {
      res.status(401).json({ ok: false, error: 'the token does not belong to that name', path: '$.userName' });
      return;
    }
    const sid = `${req.body?.engine}:${req.body?.sessionId}`;
    const version = `native-${req.body?.engine}-1.1.0`;
    if (refuseIgnored(opts, logger, fleet, req, res, { ...keyTarget(opts, { kind: 'native', engine: req.body?.engine, machineId: null, source: machineOf(req), sessionId: sid, owner: ownerOf(id) }), source: machineOf(req), version })) return;
    try {
      const result = ingestNativeEvent(fleet, req.body, ownerOf(id));
      if (result.ok && id.kind === 'person') opts.people?.touch(id.person.id, machineOf(req), fleet.now());
      if (result.ok && !('ignored' in result) && !('duplicate' in result)) noteReporter(opts, logger, {
        kind: 'native', engine: req.body.engine, machineId: null, machineName: null, source: machineOf(req), owner: ownerOf(id), credential: credentialOf(id),
        version, engineVersion: null, sessionId: result.sessionId,
      }, fleet.now());
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      if (err instanceof OwnerConflict) { res.status(409).json({ ok: false, error: err.message }); return; }
      logger.error('ingest.failed', 'podium: native event ingest failed', { route: '/event', status: 500 });
      res.status(500).json({ ok: false, error: 'ingest failed' });
    }
  });

  router.get('/state', (_req, res) => {
    res.json(fleet.state());
  });

  router.get('/stream', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (fleet.hub.isFull) {
      res.end('event: error\ndata: {"error":"too many clients"}\n\n');
      return;
    }
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const id = fleet.hub.add(
      {
        write: (chunk: string) => {
          if (res.writableEnded || res.destroyed) throw new Error('closed');
          res.write(chunk);
        },
        end: () => res.end(),
      },
      [fleet.snapshotMessage()],
    );
    // null here means the client vanished while being added: there is nobody left to tell.
    if (id === null) return;
    const drop = () => fleet.hub.remove(id);
    req.on('close', drop);
    res.on('error', drop);
  });

  router.get('/sessions/:id', (req, res) => {
    const view = fleet.view(req.params.id);
    if (!view) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    res.json(view);
  });

  // The whole prompt and answer, fetched when the console opens them (issue #97). Not in the state or
  // the stream: they can be tens of kilobytes per agent.
  router.get('/sessions/:id/agents/:agentId/text', (req, res) => {
    const t = fleet.db.getAgentTexts(req.params.id, req.params.agentId);
    if (!t) {
      res.status(404).json({ ok: false, error: 'no full text for this agent', path: '$.agentId' });
      return;
    }
    res.json(t);
  });

  // An agent's recent activity (#118). Each fetch takes or renews the viewer's lease on that loop for `every` seconds
  // plus a margin; the reply to the next report then asks the mod for its entries. `@orchestrator` is the main loop.
  // In memory only, never in the state or the stream. No token, like the other reads.
  router.get('/sessions/:id/agents/:agentId/activity', (req, res) => {
    const { id, agentId } = req.params;
    if (!fleet.db.getSession(id) || (agentId !== MAIN_LOOP && !fleet.db.getAgents(id).some((a) => a.id === agentId))) {
      res.status(404).json({ ok: false, error: 'unknown session or agent', path: '$.agentId' });
      return;
    }
    // With the Admin's flag off (Admin > Settings > Feature flags) no lease is taken; the panel keeps asking and says so.
    let body: ActivityReply;
    if (!fleet.activity.on) body = { entries: [], since: null, live: fleet.isLive(id), enabled: false, serverTime: fleet.now() };
    else if (!fleet.isLive(id)) body = { entries: [], since: null, live: false, enabled: true, serverTime: fleet.now() };
    else body = { ...fleet.activity.watch(id, agentId, everyOf(req.query.every)), live: true, enabled: true, serverTime: fleet.now() };
    res.set('Cache-Control', 'no-store').json(body);
  });

  router.delete('/sessions/:id', requireToken, (req, res) => {
    if (!fleet.deleteSession(req.params.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    res.json({ ok: true });
  });

  // Remove on a heartbeat-lost card. It only hides a card the server was about to drop anyway, so it takes
  // no token, like the other reads the dashboard makes. SPEC 7.1, 7.5.
  router.post('/sessions/:id/drop', (req, res) => {
    const out = fleet.dropSession(req.params.id);
    if (out === 'unknown') {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return;
    }
    if (out === 'not-stale') {
      res.status(409).json({ ok: false, error: 'session is not heartbeat lost', path: '$.id' });
      return;
    }
    res.json({ ok: true });
  });

  // Closing a wall notice and the Show/Hide link on the background-sessions note. Both only change how the wall
  // looks, like Remove above, so they take no token (and no admin cookie: the wall has none). SPEC 7.1, 8.1.
  router.post('/notices/:id/close', (req, res) => {
    if (!fleet.wall.setNotice(req.params.id, false)) {
      res.status(400).json({ ok: false, error: 'unknown notice', path: '$.id' });
      return;
    }
    opts.people?.log('wall_notice_changed', `Wall notice ${req.params.id} turned off from the wall`, machineOf(req) ?? '', fleet.now());
    logger.info('admin.wall_notice_changed', `podium: wall notice ${req.params.id} turned off from the wall`, { action: 'wall_notice_changed', setting: req.params.id, on: false, source: machineOf(req) });
    res.json({ ok: true });
  });

  router.put('/wall/background-sessions', json, (req, res) => {
    const v = req.body?.show;
    if (typeof v !== 'boolean') {
      res.status(400).json({ ok: false, error: 'show must be true or false', path: '$.show' });
      return;
    }
    fleet.wall.setShowBackgroundSessions(v);
    opts.people?.log('wall_background_changed', `Background sessions ${v ? 'shown' : 'hidden'} on the wall`, machineOf(req) ?? '', fleet.now());
    logger.info('admin.wall_background_changed', `podium: background sessions ${v ? 'shown' : 'hidden'} on the wall`, { action: 'wall_background_changed', on: v, source: machineOf(req) });
    res.json({ ok: true });
  });

  router.get('/events', (req, res) => {
    const before = intParam(req.query.before);
    const limit = intParam(req.query.limit);
    const sessionId = req.query.sessionId;
    if (before === 'bad' || limit === 'bad' || (sessionId !== undefined && typeof sessionId !== 'string')) {
      res.status(400).json({ ok: false, error: 'bad query', path: '$.query' });
      return;
    }
    const n = Math.max(1, Math.min(200, limit ?? 50));
    res.json({ events: fleet.events({ sessionId: sessionId || null, before, limit: n }) });
  });

  router.get('/history', (req, res) => {
    const day = typeof req.query.day === 'string' ? req.query.day : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) {
      res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD', path: '$.query.day' });
      return;
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const start = new Date(y, mo - 1, d);
    // Date rolls 2026-02-31 over to March 3rd; a day that does not exist is a 400.
    if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) {
      res.status(400).json({ ok: false, error: 'day is not a real date', path: '$.query.day' });
      return;
    }
    const page = intParam(req.query.page);
    const size = intParam(req.query.pageSize);
    if (page === 'bad' || size === 'bad' || page === 0 || (size !== null && !HISTORY_PAGE_SIZES.includes(size))) {
      res.status(400).json({ ok: false, error: `page must be 1 or more and pageSize one of ${HISTORY_PAGE_SIZES.join(', ')}`, path: '$.query' });
      return;
    }
    const pageSize = size ?? HISTORY_PAGE_SIZE;
    // The day's boundaries are the server's local midnight (the dashboard is for one machine).
    const from = start.getTime();
    const to = new Date(y, mo - 1, d + 1).getTime();
    // A page past the end is the last page, so a day that shrank under an open tab still shows rows.
    const { rows, total, page: at } = fleet.historyPage(from, to, page ?? 1, pageSize);
    res.json({ day, sessions: rows, total, page: at, pageSize });
  });

  router.get('/health', (_req, res) => {
    res.json(fleet.health());
  });

  // Responding from Podium (#206): the mod's ask routes and the browser's /respond routes.
  mountRespondRoutes(router, {
    fleet,
    token: opts.token ?? null,
    people: opts.people ?? null,
    logger,
    lockout: opts.lockout ?? new Lockout(fleet.now),
    bridge: opts.respondBridge,
    onSignIn: opts.onSignIn,
    requireToken,
    identityOf,
  });

  router.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found', path: '$' });
  });

  // Body-parser errors (malformed JSON, too large, bad charset) become 4xx; anything else 500.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: { type?: string; status?: number; message?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: `body over ${BODY_LIMIT}`, path: '$' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'malformed JSON', path: '$' });
      return;
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    logger.error('request.failed', `podium: request failed (${status}): ${err.type ?? err.message ?? 'error'}`, {
      status,
      reason: err.type ?? err.message ?? 'error',
      method: req.method,
      route: routeName(req),
    });
    res.status(status).json({ ok: false, error: status === 500 ? 'internal error' : (err.type ?? 'bad request'), path: '$' });
  });

  return router;
}
