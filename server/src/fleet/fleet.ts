// The fleet service: owns the live set, turns ingests and timer sweeps into SSE messages, and
// answers the read endpoints. Storage is FleetDb; rules are in ingest.ts and derive.ts. The clock is
// injected so the lifecycle tests can move time without waiting.
import { SAME_USAGE } from './db.js';
import type { CostOf, FleetDb, RetentionPolicy, SessionRow } from './db.js';
import { activityView, computeKpis, family, isUnused, repriced, sessionStatus, sessionView, shortenHome, staleAfterFor, startOfDay, type DeriveConfig } from './derive.js';
import { REPORTER_SUPPORT, serverVersion } from './compat.js';
import { ingestReport, type IngestResult } from './ingest.js';
import { hookToReport } from './hookIngest.js';
import { validateReport } from './protocol.js';
import type { ActivityView, HistoryRow, Kpis, RemovedReason, Report, ReporterSupport, SessionStatusView, SessionView, StateBody } from './protocol.js';
import { formatSse, SseHub } from './sse.js';
import { ModelPriceStore } from './modelPrices.js';
import { WallSettings } from './wallSettings.js';
import { ActivityStore } from './activity.js';
import { ACTIVITY_FEED, FeatureFlags, RESPOND } from './featureFlags.js';
import { RespondStore } from './respond.js';
import { MAIN_LOOP } from './protocol.js';
import { checkReporter } from './compat.js';
import { silentLogger, type Logger } from '../logging/logger.js';

export interface FleetConfig {
  staleAfterMs: number;
  /** Sessions known only from settings hooks send no heartbeat, so they get a much longer silence allowance. */
  hookStaleAfterMs: number;
  dropAfterMs: number;
  lingerMs: number;
  /** How long a session nobody is attached to stays on the wall, dimmed, before it is set aside. */
  detachedHideAfterMs: number;
  retention: RetentionPolicy;
  home: string;
  /** Minimum gap between two `session` messages for one session. */
  throttleMs: number;
  dbPath: string;
}

export const DEFAULT_CONFIG: Omit<FleetConfig, 'home' | 'dbPath'> = {
  staleAfterMs: 15_000,
  hookStaleAfterMs: 600_000,
  dropAfterMs: 60_000,
  lingerMs: 8_000,
  detachedHideAfterMs: 60_000,
  retention: { samplesMs: 24 * 3600_000, eventsMs: 30 * 24 * 3600_000, sessionsMs: 30 * 24 * 3600_000, adminLogMs: 90 * 24 * 3600_000 },
  throttleMs: 500,
};

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Lifecycle and retention settings from the environment (SPEC 7.2, 7.5). */
export function configFromEnv(env: NodeJS.ProcessEnv, base: { home: string; dbPath: string }): FleetConfig {
  const d = DEFAULT_CONFIG;
  // A containerised server cannot see the host's home, so podiumctl passes it in. Anything but an absolute
  // path other than `/` is ignored: a home of `/` would turn every path into `~/...`.
  const hostHome = env.PODIUM_HOST_HOME;
  return {
    ...base,
    home: hostHome && hostHome.startsWith('/') && hostHome !== '/' ? hostHome : base.home,
    staleAfterMs: envMs(env, 'STALE_AFTER_MS', d.staleAfterMs),
    hookStaleAfterMs: envMs(env, 'HOOK_STALE_AFTER_MS', d.hookStaleAfterMs),
    dropAfterMs: envMs(env, 'DROP_AFTER_MS', d.dropAfterMs),
    lingerMs: envMs(env, 'LINGER_MS', d.lingerMs),
    detachedHideAfterMs: envMs(env, 'DETACHED_HIDE_AFTER_MS', d.detachedHideAfterMs),
    throttleMs: d.throttleMs,
    retention: {
      samplesMs: envMs(env, 'RETAIN_SAMPLES_MS', d.retention.samplesMs),
      eventsMs: envMs(env, 'RETAIN_EVENTS_MS', d.retention.eventsMs),
      sessionsMs: envMs(env, 'RETAIN_SESSIONS_MS', d.retention.sessionsMs),
      adminLogMs: envMs(env, 'RETAIN_ADMIN_LOG_MS', d.retention.adminLogMs),
    },
  };
}

/** How many session ids a `sweep.removed` line names; the rest are counted in `session_ids_omitted`. */
const SWEEP_IDS_LOGGED = 10;

/** Reporters remembered for `reporter.connected`; the oldest is forgotten past this. */
const MAX_REPORTERS = 1000;

/** How many events /state returns and the UI keeps. */
export const STATE_EVENTS = 150;

interface LiveEntry {
  /** Reported since this server process started. */
  heard: boolean;
  /** The status last broadcast, to notice stale transitions. */
  status: SessionStatusView | null;
}

/** When a session ended: dropped, else ended, else last seen. */
const endedAtOf = (row: SessionRow): number => row.dropped_at ?? row.ended_at ?? row.last_seen_at;

export class Fleet {
  readonly hub = new SseHub();
  /** The wall's notice switches and background-session setting; a change reaches open browsers at once. */
  readonly wall: WallSettings;
  /** The Admin's model prices; every cost figure follows them (issue #117). */
  readonly prices: ModelPriceStore;
  /** The agent activity feed (#118): in memory only, and only for loops a viewer is watching. */
  readonly activity: ActivityStore;
  /** The Admin's feature flags. Turning the activity feed off drops what it held; any change reaches open browsers. */
  readonly features: FeatureFlags;
  /** Responding from Podium (#206): asks, answers and messages, in memory only. */
  readonly respond: RespondStore;
  private readonly live = new Map<string, LiveEntry>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startedAt: number;
  private readonly clockSkew = new Map<string, number>();
  private costMinuteCache: { at: number; rows: { m: number; v: number }[] } | null = null;
  /** When each reporter (owner, machine, kind) last reported, for `reporter.connected` (#140). */
  private readonly reporters = new Map<string, number>();

  constructor(
    readonly db: FleetDb,
    readonly cfg: FleetConfig,
    readonly now: () => number = Date.now,
    /** Lifecycle events (#140): session.started/ended, reporter.connected/silent, sweep.removed. Silent by default. */
    readonly logger: Logger = silentLogger,
  ) {
    this.startedAt = now();
    this.features = new FeatureFlags(db.db, (id, on) => {
      if (id === ACTIVITY_FEED && !on) this.activity.clear();
      // Responding needs both flags: either going off drops every ask and answer the server holds.
      if ((id === ACTIVITY_FEED || id === RESPOND) && !on) this.respond.clear();
      this.hub.broadcast('snapshot', this.state());
    });
    this.activity = new ActivityStore(now, () => this.features.featureOn(ACTIVITY_FEED));
    this.respond = new RespondStore(
      now,
      (sid) => {
        if (this.live.has(sid)) this.scheduleSession(sid);
      },
      {
        add: (sid, loop, ref, e) => this.activity.addPodium(sid, loop ?? MAIN_LOOP, ref, e),
        update: (sid, ref, note) => this.activity.updatePodium(sid, ref, note),
        remove: (sid, ref) => this.activity.removePodium(sid, ref),
      },
    );
    this.wall = new WallSettings(db.db, () => this.hub.broadcast('wall', this.wall.view()));
    // A price change moves every cost on the wall, so open browsers get a fresh snapshot.
    this.prices = new ModelPriceStore(db.db, () => {
      this.costMinuteCache = null; // the sparkline follows the prices too (#270)
      this.hub.broadcast('snapshot', this.state());
    });
    // On start every stored session that has not ended is treated as stale until it reports again;
    // a done session still inside its linger window stays until the window closes.
    for (const row of db.liveCandidates(this.startedAt - cfg.lingerMs)) {
      this.live.set(row.id, { heard: false, status: null });
    }
  }

  private get derive(): DeriveConfig {
    return { staleAfterMs: this.cfg.staleAfterMs, hookStaleAfterMs: this.cfg.hookStaleAfterMs, home: this.cfg.home };
  }

  /** Whether the Admin's switches let anyone respond: the respond and activity-feed flags. Authentication is the routes' check. */
  respondFlagsOn(): boolean {
    return this.features.featureOn(RESPOND) && this.features.featureOn(ACTIVITY_FEED);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  /** How many live sessions are on the wall: what the reporter's status line and /health report. */
  visibleCount(): number {
    let n = 0;
    for (const id of this.live.keys()) if (!this.unused(this.db.getSession(id))) n++;
    return n;
  }

  /** A session that has done nothing yet is kept off the wall and out of every feed (see `isUnused`). */
  private unused(row: SessionRow | undefined): boolean {
    return !!row && isUnused(row, () => this.db.getAgents(row.id).length);
  }

  // ---- ingest ---------------------------------------------------------------------------------

  ingest(report: Report, owner: string | null = null): IngestResult {
    const res = ingestReport(this.db, report, this.now(), owner);
    this.clockSkew.set(res.sessionId, res.clockSkewMs);
    this.activity.ingest(report, res.clockSkewMs);
    this.respond.noteReport(report, this.respondFlagsOn());
    this.noteReporter(report, owner);
    const entry = this.live.get(res.sessionId);
    const row = this.db.getSession(res.sessionId);
    if (entry) {
      entry.heard = true;
    } else if (!(res.ended && res.wasDone)) {
      // New, revived, or back after leaving the live set. A repeated final report for a session that
      // already left is stored but does not bring it back.
      this.live.set(res.sessionId, { heard: true, status: null });
      this.logger.info('session.started', `podium: session ${res.sessionId} ${res.created ? 'started' : 'is reporting again'}`, {
        session_id: res.sessionId,
        owner,
        created: res.created,
        revived: res.revived,
        model: row?.model ?? null,
        reporter: report.reporter.hostSurface === 'settings-hooks' ? 'hooks' : 'mod',
      });
    }
    if (res.ended && !res.wasDone) {
      this.logger.info('session.ended', `podium: session ${res.sessionId} ended${row?.end_reason ? ` (${row.end_reason})` : ''}`, {
        session_id: res.sessionId,
        owner,
        reason: 'done',
        end_reason: row?.end_reason ?? null,
      });
    }
    if (!this.unused(row)) {
      for (const e of res.newEvents.slice().sort((a, b) => a.t - b.t)) {
        this.hub.broadcast('activity', activityView(e, row));
      }
    }
    if (this.live.has(res.sessionId)) this.scheduleSession(res.sessionId);
    return res;
  }

  /** `reporter.connected` the first time a reporter is heard, and again when it comes back after going quiet. */
  private noteReporter(report: Report, owner: string | null): void {
    const kind = report.reporter.hostSurface === 'settings-hooks' ? 'hooks' : 'mod';
    const key = `${owner ?? ''}\u0000${report.machine?.id ?? ''}\u0000${kind}`;
    const now = this.now();
    const last = this.reporters.get(key);
    this.reporters.delete(key); // re-insert so the oldest entry is the one forgotten at the cap
    this.reporters.set(key, now);
    if (this.reporters.size > MAX_REPORTERS) this.reporters.delete(this.reporters.keys().next().value as string);
    if (last !== undefined && now - last <= this.cfg.staleAfterMs) return;
    const who = [owner, report.machine?.name].filter(Boolean).join(' on ') || 'an unnamed reporter';
    this.logger.info('reporter.connected', `podium: ${kind === 'hooks' ? 'settings hooks' : 'reporter'} ${report.reporter.version} connected (${who})`, {
      owner,
      machine: report.machine?.name ?? null,
      machine_id: report.machine?.id ?? null,
      reporter: kind,
      reporter_version: report.reporter.version,
      reporter_compat: checkReporter(report.reporter.version),
      returning: last !== undefined,
    });
  }

  /** A classic settings-hook payload (T5.1): merged with what is stored, then ingested as a report. */
  ingestHook(payload: unknown, owner: string | null = null): { ok: true; sessionId: string } | { ok: false; error: string; path: string } {
    const sid = typeof (payload as { session_id?: unknown })?.session_id === 'string' ? (payload as { session_id: string }).session_id : '';
    const stored = sid ? { session: this.db.getSession(sid), agents: this.db.getAgents(sid) } : { agents: [] };
    const res = hookToReport(payload, stored, this.now());
    if (!res.ok) return res;
    if ('ignored' in res) return { ok: true, sessionId: res.sessionId };
    const v = validateReport(res.report);
    if (!v.ok) return v;
    this.ingest(v.report, owner);
    return { ok: true, sessionId: v.report.session.id };
  }

  /** Coalesces `session` messages: at most one per session per throttle window, carrying the latest state. */
  private scheduleSession(id: string): void {
    if (this.pending.has(id)) return;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      const view = this.view(id);
      if (view && this.live.has(id) && !this.unused(this.db.getSession(id))) {
        const entry = this.live.get(id);
        if (entry) entry.status = view.status;
        this.hub.broadcast('session', view);
      }
    }, this.cfg.throttleMs);
    timer.unref?.();
    this.pending.set(id, timer);
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** One session's view, live or historical. */
  view(id: string): SessionView | undefined {
    const row = this.db.getSession(id);
    if (!row) return undefined;
    return this.viewOf(row);
  }

  private viewOf(row: SessionRow): SessionView {
    const now = this.now();
    const entry = this.live.get(row.id);
    return sessionView(
      {
        row,
        agents: this.db.getAgents(row.id),
        blowouts: this.db.getBlowouts(row.id),
        samples: this.db.samplesSince(row.id, Math.floor(now / 1000) - 61),
        heard: entry ? entry.heard : true,
        dropAt: entry ? this.dropAtFor(row, entry.heard, now) : null,
        hideAt: row.attached === 0 && row.detached_at !== null ? row.detached_at + this.cfg.detachedHideAfterMs : null,
        ownerGroup: this.db.groupOfOwner(row.owner),
        pricing: this.prices.pricing(),
        activityFeed: this.activity.feedOn(row.id),
        respond: this.respond.info(row.id),
        asks: this.respond.summaries(row.id),
      },
      now,
      this.derive,
    );
  }

  /**
   * When a stale live session leaves the wall by itself, or null if it is not stale. The drop clock starts
   * when the session went stale, but for one not heard since this server started it starts no earlier than
   * the server's start (SPEC 7.5). `sweep` and the view both use this, so the card says what will happen.
   */
  private dropAtFor(row: SessionRow, heard: boolean, now: number = this.now()): number | null {
    const staleAfterMs = staleAfterFor(row, this.derive);
    if (sessionStatus(row, heard, now, staleAfterMs) !== 'stale') return null;
    const base = row.last_seen_at + staleAfterMs;
    return (heard ? base : Math.max(base, this.startedAt)) + this.cfg.dropAfterMs;
  }

  liveViews(): SessionView[] {
    const out: SessionView[] = [];
    for (const id of this.live.keys()) {
      const row = this.db.getSession(id);
      if (row && !this.unused(row)) out.push(this.viewOf(row));
    }
    return out;
  }

  kpis(views: readonly SessionView[] = this.liveViews()): Kpis {
    const now = this.now();
    const nowSec = Math.floor(now / 1000);
    const pricing = this.prices.pricing();
    const cost: CostOf = (r) => repriced(pricing, r.usage_json, r.cost_usd);
    if (!this.costMinuteCache || now - this.costMinuteCache.at > 5000) {
      this.costMinuteCache = { at: now, rows: this.db.fleetCostPerMinute((Math.floor(nowSec / 60) - 59) * 60, cost) };
    }
    const spend = this.db.spendTotals(startOfDay(now), cost);
    return computeKpis(
      {
        views,
        costToday: spend.total,
        costTodayByOwner: spend.byOwner,
        tokensPerSecond: this.db.fleetTokensPerSecond(nowSec - 61),
        costPerMinute: this.costMinuteCache.rows,
      },
      now,
    );
  }

  clearedToday(): number {
    const now = this.now();
    return this.db.endedBetween(startOfDay(now), now + 1).filter((s) => !this.live.has(s.id) && !this.unused(s)).length;
  }

  events(opts: { sessionId?: string | null; before?: number | null; limit: number }): ActivityView[] {
    const rows = this.db.listEvents(opts);
    const sessions = new Map<string, SessionRow | undefined>();
    return rows
      .filter((e) => {
        if (!sessions.has(e.session_id)) sessions.set(e.session_id, this.db.getSession(e.session_id));
        return !this.unused(sessions.get(e.session_id));
      })
      .map((e) => activityView(e, sessions.get(e.session_id)));
  }

  /** Sessions that ended or were dropped in [from, to), as summary rows, newest first. */
  history(from: number, to: number): HistoryRow[] {
    return this.historyRows(from, to).map((row) => this.historyRow(row));
  }

  /**
   * One page of `history`, with the day's total. The filter and the sort use the session rows alone; the agents
   * query and the repricing run for the rows on the page only. A page past the end is the last page.
   */
  historyPage(from: number, to: number, page: number, pageSize: number): { rows: HistoryRow[]; total: number; page: number } {
    const all = this.historyRows(from, to);
    const at = Math.min(page, Math.max(1, Math.ceil(all.length / pageSize)));
    return { rows: all.slice((at - 1) * pageSize, at * pageSize).map((row) => this.historyRow(row)), total: all.length, page: at };
  }

  /** The day's sessions that did something, newest end first, with the id breaking ties so a row never moves between pages. */
  private historyRows(from: number, to: number): SessionRow[] {
    return this.db
      .endedBetween(from, to)
      .filter((row) => !this.unused(row))
      .sort((a, b) => endedAtOf(b) - endedAtOf(a) || (a.id < b.id ? -1 : 1));
  }

  private historyRow(row: SessionRow): HistoryRow {
    const agents = this.db.getAgents(row.id);
    const end = endedAtOf(row);
    return {
      id: row.id,
      name: row.name,
      ...(row.integration_json ? { integration: JSON.parse(row.integration_json) } : {}),
      project: shortenHome(row.project_root ?? row.cwd, this.cfg.home),
      model: row.model,
      modelFamily: family(row.model),
      startedAt: row.started_at,
      endedAt: end,
      durationSec: Math.max(0, Math.round((end - row.started_at) / 1000)),
      costUsd: repriced(this.prices.pricing(), row.usage_json, row.cost_usd),
      blowouts: row.blowouts + agents.reduce((n, a) => n + a.blowouts, 0),
      agents: agents.length,
      endReason: row.dropped_at !== null ? 'heartbeat lost' : row.end_reason,
      clearedFrom: row.cleared_from ?? null,
      clearedInto: this.db.clearedInto(row.id),
    };
  }

  state(): StateBody {
    const sessions = this.liveViews();
    return {
      serverTime: this.now(),
      config: { staleAfterMs: this.cfg.staleAfterMs, dropAfterMs: this.cfg.dropAfterMs, lingerMs: this.cfg.lingerMs, detachedHideAfterMs: this.cfg.detachedHideAfterMs },
      sessions,
      kpis: this.kpis(sessions),
      clearedToday: this.clearedToday(),
      events: this.events({ limit: STATE_EVENTS }),
      server: { version: serverVersion(), reporterSupport: REPORTER_SUPPORT },
      wall: this.wall.view(),
      features: this.features.view(),
    };
  }

  /** The first message a new SSE client gets. */
  snapshotMessage(): string {
    return formatSse('snapshot', this.state());
  }

  health(): { ok: true; dbPath: string; liveSessions: number; uptimeSec: number; reporterVersionsSeen: string[]; serverVersion: string; reporterSupport: ReporterSupport; sseClients: number; maxClockSkewMs: number } {
    let skew = 0;
    for (const id of this.live.keys()) skew = Math.max(skew, Math.abs(this.clockSkew.get(id) ?? 0));
    return {
      ok: true,
      dbPath: this.cfg.dbPath,
      liveSessions: this.visibleCount(),
      uptimeSec: Math.floor((this.now() - this.startedAt) / 1000),
      reporterVersionsSeen: this.db.distinctReporterVersions(),
      serverVersion: serverVersion(),
      reporterSupport: REPORTER_SUPPORT,
      sseClients: this.hub.size,
      maxClockSkewMs: skew,
    };
  }

  // ---- writes ---------------------------------------------------------------------------------

  deleteSession(id: string): boolean {
    const wasLive = this.live.delete(id);
    this.clockSkew.delete(id);
    this.activity.dropSession(id);
    this.respond.dropSession(id);
    const t = this.pending.get(id);
    if (t) clearTimeout(t);
    this.pending.delete(id);
    const existed = this.db.deleteSession(id);
    if (wasLive) this.hub.broadcast('removed', { sessionId: id, reason: 'deleted' satisfies RemovedReason });
    if (existed) this.logger.info('session.deleted', `podium: session ${id} deleted`, { session_id: id, live: wasLive });
    return existed;
  }

  /**
   * The Remove button on a heartbeat-lost card: the same exit as the automatic drop, run now. The session
   * stays in History, and comes back live if it reports again.
   */
  dropSession(id: string): 'dropped' | 'unknown' | 'not-stale' {
    const entry = this.live.get(id);
    const row = entry ? this.db.getSession(id) : undefined;
    if (!entry || !row) return 'unknown';
    if (sessionStatus(row, entry.heard, this.now(), staleAfterFor(row, this.derive)) !== 'stale') return 'not-stale';
    this.leave(row, 'dropped', 'heartbeat lost', 'remove');
    return 'dropped';
  }

  private leave(row: SessionRow, reason: 'done' | 'dropped', text: string, by: 'sweep' | 'remove' = 'sweep'): void {
    const now = this.now();
    if (reason === 'dropped') {
      this.logger.info('session.ended', `podium: session ${row.id} ended: heartbeat lost${by === 'remove' ? ' (removed from the wall)' : ''}`, {
        session_id: row.id,
        owner: row.owner,
        reason: 'heartbeat lost',
        by,
        silent_s: Math.round((now - row.last_seen_at) / 1000),
      });
    }
    this.live.delete(row.id);
    this.clockSkew.delete(row.id);
    this.activity.dropSession(row.id);
    this.respond.endSession(row.id);
    this.respond.dropSession(row.id);
    const t = this.pending.get(row.id);
    if (t) clearTimeout(t);
    this.pending.delete(row.id);
    if (reason === 'dropped') this.db.setDropped(row.id, now);
    const marker = reason === 'done' ? row.ended_at ?? now : row.last_seen_at;
    const ev = {
      id: `${row.id}:server:end:${reason}:${marker}`,
      session_id: row.id,
      agent_id: null,
      t: now,
      kind: 'end',
      text,
      data_json: JSON.stringify({ reason }),
    };
    const inserted = this.db.insertEvent(ev);
    // A session that never reached the wall gets no activity line on its way out. 'removed' is always sent:
    // a card shown while the session was running must still go when it ends with no usage.
    if (inserted && !this.unused(row)) this.hub.broadcast('activity', activityView(ev, row));
    this.hub.broadcast('removed', { sessionId: row.id, reason });
  }

  // ---- timers (driven by sweeper.ts) ------------------------------------------------------------

  /** Once a second: stale transitions, drops, lingering done sessions, carry-forward samples. */
  sweep(): void {
    const now = this.now();
    this.activity.expire();
    this.respond.expire();
    const nowSec = Math.floor(now / 1000);
    const removed = { done: [] as string[], dropped: [] as string[] };
    for (const [id, entry] of [...this.live]) {
      const row = this.db.getSession(id);
      if (!row) {
        this.live.delete(id);
        continue;
      }
      if (row.status === 'done') {
        if (now - (row.ended_at ?? now) >= this.cfg.lingerMs) {
          this.leave(row, 'done', 'session ended');
          removed.done.push(id);
        }
        continue;
      }
      const status = sessionStatus(row, entry.heard, now, staleAfterFor(row, this.derive));
      if (status === 'stale') {
        if (now >= (this.dropAtFor(row, entry.heard, now) ?? Infinity)) {
          this.leave(row, 'dropped', 'heartbeat lost');
          removed.dropped.push(id);
          continue;
        }
      } else {
        // A live session that reports less often than once a second still gets one sample per
        // second, so its charts do not fall to zero between heartbeats.
        const last = this.db.latestSample(id);
        if (last && last.t < nowSec) {
          // The copy repeats the usage as "same as before", except at the start of a minute, which needs it in full (#270).
          const usage = last.usage_json == null ? null : Math.floor(last.t / 60) === Math.floor(nowSec / 60) ? SAME_USAGE : row.usage_json;
          this.db.insertSampleIfAbsent({ ...last, t: nowSec, tokens_delta: 0, usage_json: usage });
        }
      }
      if (entry.status !== null && entry.status !== status) {
        if (status === 'stale') {
          this.logger.warn('reporter.silent', `podium: session ${id} went quiet (no report for ${Math.round((now - row.last_seen_at) / 1000)} s)`, {
            session_id: id,
            owner: row.owner,
            silent_s: Math.round((now - row.last_seen_at) / 1000),
            was: entry.status,
          });
        }
        entry.status = status;
        if (!this.unused(row)) this.hub.broadcast('session', this.viewOf(row));
      } else if (entry.status === null) {
        entry.status = status;
      }
    }
    const n = removed.done.length + removed.dropped.length;
    if (n > 0) {
      // A sweep after a long outage can remove hundreds; the line names the first few and the count it left out.
      const ids = [...removed.done, ...removed.dropped];
      this.logger.info('sweep.removed', `podium: sweep removed ${n} session${n === 1 ? '' : 's'} from the wall (${removed.done.length} ended, ${removed.dropped.length} heartbeat lost)`, {
        removed: n,
        done: removed.done.length,
        dropped: removed.dropped.length,
        session_ids: ids.slice(0, SWEEP_IDS_LOGGED).join(','),
        ...(ids.length > SWEEP_IDS_LOGGED ? { session_ids_omitted: ids.length - SWEEP_IDS_LOGGED } : {}),
      });
    }
  }

  /** Every 2 s: KPIs to every client; doubles as the keepalive. */
  tick(): void {
    this.hub.broadcast('tick', { serverTime: this.now(), kpis: this.kpis() });
  }

  /** Hourly: retention. */
  retain(): { samples: number; events: number; sessions: number; adminLog: number } {
    return this.db.retain(this.now(), this.cfg.retention);
  }

  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.hub.closeAll();
  }
}
