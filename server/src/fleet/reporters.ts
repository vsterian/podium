// Every podium-reporter the server has heard from (issue #142, SPEC 7.2 and 7.7). One row per machine, keyed on the
// machine id the reporter sends, or on its source address when it sends none. Retention does not touch the
// table, so a reporter outlives its sessions; only the Admin removes one, or the forget-by-age setting (#167). A reporter that stops is "silent", which is all the server can
// know: it cannot tell a reporter that is turned off from one that cannot reach it. All statements are parameterized.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { checkReporter } from './compat.js';
import { clampPage, likeTerm, type Paged } from './people.js';
import type { ReporterCompat } from './protocol.js';

/** A reporter heard from within this long is "reporting". */
export const REPORTING_MS = 2 * 60_000;
/** Up to this long since its last report it is "idle"; after that, "silent". */
export const IDLE_MS = 60 * 60_000;
const MAX_REJECTED = 200;
const SHOWN_REJECTED = 20;
const DAY_MS = 24 * 60 * 60_000;
/** After a start, reporters are not forgotten for this long, so a long outage does not empty the list before anyone could report. */
const FORGET_GRACE_MS = 60 * 60_000;
const MAX_PATTERN = 120;
const MAX_FORGET_DAYS = 3650;
const DEFAULT_FORGET_DAYS = 30;

export type ReporterState = 'reporting' | 'idle' | 'silent' | 'restart';
export const REPORTER_STATES: readonly ReporterState[] = ['reporting', 'idle', 'silent', 'restart'];
export type ReporterSort = 'state' | 'name' | 'who' | 'token' | 'ver' | 'last' | 'sessions';
const SORTS: readonly ReporterSort[] = ['state', 'name', 'who', 'token', 'ver', 'last', 'sessions'];
/** The credential the server records for a report made with the admin secret. */
export const ADMIN_SECRET = 'admin secret';

/** What one accepted report says about its sender. Never a token: `credential` is a key id or the words "admin secret". */
export interface ReporterSeen {
  kind: 'mod' | 'hooks' | 'native';
  engine?: string;
  machineId: string | null;
  machineName: string | null;
  source: string | null;
  owner: string | null;
  credential: string | null;
  version: string;
  engineVersion: string | null;
  sessionId: string;
}

export interface ReporterRow {
  key: string;
  state: ReporterState;
  name: string;
  /** False when the reporter sends no machine name and `name` is made up from its newest project or its address (issue #166). */
  named: boolean;
  who: string;
  /** The token's key id (`pdm_...`) or the words "admin secret"; null when the server had no authentication. Never a token. */
  credential: string | null;
  /** True when it reports with the admin secret instead of a token made for a person (issue #166). Always warned about. */
  adminSecret: boolean;
  version: string;
  compat: ReporterCompat;
  firstSeenAt: number;
  lastSeenAt: number;
  sessions: number;
  live: number;
}
export interface ReporterList extends Paged<ReporterRow> {
  /** When this server started: what "not since restart" is counted from. */
  serverStartedAt: number;
  /** How many reporters use the admin secret, whatever filter is on. */
  adminSecret: number;
  counts: Record<'all' | ReporterState, number>;
}
export interface ReporterDetail extends ReporterRow {
  serverStartedAt: number;
  kind: 'mod' | 'hooks' | 'native';
  machineId: string | null;
  source: string | null;
  engineVersion: string | null;
  recent: { id: string; name: string; status: string; lastSeenAt: number; costUsd: number | null }[];
  /** How many of its sessions the server still holds, and which page of them `recent` is. */
  recentTotal: number;
  recentPage: number;
  recentPageSize: number;
  rejected: { t: number; reason: string }[];
}

export type IgnoreKind = 'key' | 'address' | 'version';
export const IGNORE_KINDS: readonly IgnoreKind[] = ['key', 'address', 'version'];
export interface IgnoreRule {
  id: number;
  kind: IgnoreKind;
  pattern: string;
  createdAt: number;
}
/** What a rule is matched against: a reporter's key, source address and reporter version. */
export interface IgnoreTarget {
  key: string;
  /** Other keys the same sender is known by, so a rule on the row's key still matches after the sender changes address (#166). */
  otherKeys?: string[];
  source: string | null;
  version: string;
}
export interface ForgetSetting {
  enabled: boolean;
  days: number;
}

interface DbReporter {
  key: string;
  kind: 'mod' | 'hooks' | 'native';
  machine_id: string | null;
  machine_name: string | null;
  source_address: string | null;
  owner: string | null;
  credential: string | null;
  reporter_version: string;
  engine_version: string | null;
  first_seen_at: number;
  last_seen_at: number;
  state: ReporterState;
  sessions: number;
  live: number;
  project: string | null;
}

/** The state, in SQL, from the last report, the time the server started and now. */
const STATE_SQL = `CASE WHEN r.last_seen_at < :started THEN 'restart'
  WHEN :now - r.last_seen_at < ${REPORTING_MS} THEN 'reporting'
  WHEN :now - r.last_seen_at < ${IDLE_MS} THEN 'idle' ELSE 'silent' END`;
/** The project of the newest session a reporter reported: what an unnamed reporter is called. */
const PROJECT_SQL = `SELECT COALESCE(s.repo_name, s.name) FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
  WHERE x.reporter_key = r.key ORDER BY s.last_seen_at DESC LIMIT 1`;
const NAME_SQL = `COALESCE(r.machine_name, CASE r.kind WHEN 'hooks' THEN 'Hooks only' ELSE COALESCE((${PROJECT_SQL}), r.source_address, 'Unnamed reporter') END)`;
const SESSIONS_SQL = 'SELECT COUNT(*) FROM reporter_sessions x WHERE x.reporter_key = r.key';
const LIVE_SQL = `SELECT COUNT(*) FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
  WHERE x.reporter_key = r.key AND s.ended_at IS NULL AND s.dropped_at IS NULL`;
const ORDER: Record<ReporterSort, string> = {
  state: `CASE state WHEN 'reporting' THEN 0 WHEN 'idle' THEN 1 WHEN 'silent' THEN 2 ELSE 3 END`,
  name: `lower(${NAME_SQL.replace(/r\./g, 'q.')})`,
  who: `lower(COALESCE(q.owner, 'Unassigned'))`,
  token: `CASE WHEN q.credential = '${ADMIN_SECRET}' THEN 0 ELSE 1 END, q.credential`,
  ver: 'q.reporter_version',
  last: 'q.last_seen_at',
  sessions: 'q.sessions',
};

export class ReporterStore {
  private readonly stmts = new Map<string, StatementSync>();
  private rejections: { source: string; t: number; reason: string }[] = [];

  constructor(
    readonly db: DatabaseSync,
    /** When the server started: a reporter last heard before this has not reported since the restart. */
    private readonly startedAt: number,
  ) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** The key a reporter is known by. */
  static keyOf(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'engine'>): string {
    if (s.engine) return `native:${s.engine}:${s.source ?? 'unknown'}#${'owner' in s ? s.owner ?? '' : ''}`;
    if (s.machineId) return s.machineId;
    return `${s.kind === 'hooks' ? 'hooks' : 'addr'}:${s.source ?? 'unknown'}`;
  }

  /**
   * The key one account on a machine is filed under (#221). Two accounts on a machine report the same machine id, so
   * the first one keeps the machine id as its key (rows and ignore rules made before this stay valid) and each
   * other account gets `<machine id>#<owner>`. A reporter with no machine id is keyed by `keyOf` alone.
   */
  private accountKey(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'owner' | 'engine'>): string {
    const own = ReporterStore.keyOf(s);
    if (!s.machineId) return own;
    const apart = `${s.machineId}#${s.owner ?? ''}`;
    const has = (key: string) => this.stmt('SELECT owner FROM reporters WHERE key = ?').get(key) as { owner: string | null } | undefined;
    if (has(apart)) return apart;
    const bare = has(own);
    return !bare || bare.owner === s.owner ? own : apart;
  }

  /**
   * The key an earlier report of the same session was filed under, for a reporter that sends no machine id. A session
   * belongs to one reporter, so a report from a new source address that carries a known session is the same reporter
   * on a new address (a container that restarted), not a new one (issue #166). The oldest row wins.
   */
  private knownKey(s: ReporterSeen): string | undefined {
    if (s.machineId) return undefined;
    const prefix = s.engine ? `native:${s.engine}:` : s.kind === 'hooks' ? 'hooks:' : 'addr:';
    const hit = this.stmt(
      `SELECT r.key FROM reporter_sessions x JOIN reporters r ON r.key = x.reporter_key
       WHERE x.session_id = ? AND r.machine_id IS NULL AND r.kind = ? AND r.key LIKE ? ORDER BY r.first_seen_at, r.key LIMIT 1`,
    ).get(s.sessionId, s.kind, `${prefix}%`) as { key: string } | undefined;
    return hit?.key;
  }

  /** Every key a report from this sender can be known by: its own, and the row that already holds its session (#166). */
  keysFor(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'sessionId' | 'engine'> & { owner?: string | null }): string[] {
    const own = ReporterStore.keyOf(s);
    const known = this.knownKey(s as ReporterSeen);
    const account = this.accountKey({ ...s, owner: s.owner ?? null });
    // The machine id comes first, so a rule on it covers every account on the machine (#221).
    // The per-account form is always included, so a rule on `<machine id>#<owner>` still turns that account away when its row is keyed on the bare machine id.
    const apart = s.machineId ? [`${s.machineId}#${s.owner ?? ''}`] : [];
    return [...new Set([own, account, ...apart, ...(known ? [known] : [])])];
  }

  /** Notes one accepted report: creates the reporter or updates it, and links the session. */
  record(s: ReporterSeen, now: number): void {
    const own = ReporterStore.keyOf(s);
    const known = this.knownKey(s);
    const key = known ?? this.accountKey(s);
    // A row made for this address before a known session turned up here is the same reporter: fold it in.
    if (known && known !== own) this.merge(own, known);
    this.stmt(
      `INSERT INTO reporters (key, kind, machine_id, machine_name, source_address, owner, credential, reporter_version, engine_version, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, machine_name = excluded.machine_name, source_address = excluded.source_address,
         owner = excluded.owner, credential = excluded.credential, reporter_version = excluded.reporter_version,
         engine_version = excluded.engine_version, last_seen_at = excluded.last_seen_at`,
    ).run(
      key,
      s.kind,
      s.machineId,
      s.machineName?.slice(0, 64) ?? null,
      s.source?.slice(0, 120) ?? null,
      s.owner,
      s.credential,
      s.version.slice(0, 64),
      s.engineVersion?.slice(0, 64) ?? null,
      now,
      now,
    );
    this.stmt('INSERT OR IGNORE INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)').run(key, s.sessionId);
  }

  /** Moves `from`'s session links to `into`, keeps the earlier first-seen time, and drops `from`. */
  private merge(from: string, into: string): void {
    this.stmt('INSERT OR IGNORE INTO reporter_sessions (reporter_key, session_id) SELECT ?, session_id FROM reporter_sessions WHERE reporter_key = ?').run(into, from);
    this.stmt('UPDATE reporters SET first_seen_at = MIN(first_seen_at, COALESCE((SELECT first_seen_at FROM reporters WHERE key = ?), first_seen_at)) WHERE key = ?').run(from, into);
    this.stmt('DELETE FROM reporters WHERE key = ?').run(from);
  }

  /** Keeps a short, memory-only list of refused reports by source address, for the detail view. The reason is one of the server's own fixed phrases. */
  rejected(source: string | null, reason: string, now: number): void {
    if (!source) return;
    this.rejections.push({ source, t: now, reason: reason.slice(0, 200) });
    if (this.rejections.length > MAX_REJECTED) this.rejections.splice(0, this.rejections.length - MAX_REJECTED);
  }

  private toRow(r: DbReporter): ReporterRow {
    return {
      key: r.key,
      state: r.state,
      name: r.machine_name ?? (r.kind === 'hooks' ? 'Hooks only' : (r.project ?? r.source_address ?? 'Unnamed reporter')),
      named: r.machine_name !== null,
      who: r.owner ?? 'Unassigned',
      credential: r.credential,
      adminSecret: r.credential === ADMIN_SECRET,
      version: r.reporter_version,
      compat: checkReporter(r.reporter_version),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sessions: r.sessions,
      live: r.live,
    };
  }

  /** The query behind `list` and `keys`: the filtered rows with their state, the parameters, and the state filter. */
  private view(opts: { q?: string; state?: string; admin?: boolean }, now: number) {
    const q = (opts.q ?? '').trim().slice(0, 100);
    const state = REPORTER_STATES.find((s) => s === opts.state);
    const base = { now, started: this.startedAt };
    const where: string[] = [];
    const params: Record<string, string | number> = { ...base };
    if (opts.admin) {
      where.push('r.credential = :adminSecret');
      params.adminSecret = ADMIN_SECRET;
    }
    if (q) {
      where.push(`(lower(${NAME_SQL}) LIKE :like ESCAPE '\\' OR lower(COALESCE(r.owner, 'unassigned')) LIKE :like ESCAPE '\\'
        OR lower(COALESCE(r.source_address, '')) LIKE :like ESCAPE '\\' OR lower(COALESCE(r.machine_id, '')) LIKE :like ESCAPE '\\'
        OR lower(r.reporter_version) LIKE :like ESCAPE '\\')`);
      params.like = likeTerm(q);
    }
    const sub = `SELECT r.*, ${STATE_SQL} AS state, (${SESSIONS_SQL}) AS sessions, (${LIVE_SQL}) AS live, (${PROJECT_SQL}) AS project FROM reporters r${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    const filter = state ? ' WHERE q.state = :state' : '';
    if (state) params.state = state;
    return { sub, params, filter, base };
  }

  list(opts: { page?: number; pageSize?: number; q?: string; state?: string; sort?: string; dir?: number; admin?: boolean }, now: number): ReporterList {
    const { page, pageSize } = clampPage(opts);
    const sort = SORTS.find((s) => s === opts.sort) ?? 'last';
    const dir = opts.dir !== undefined ? (opts.dir > 0 ? 'ASC' : 'DESC') : sort === 'last' ? 'DESC' : 'ASC';
    const { sub, params, filter, base } = this.view(opts, now);

    const counts: ReporterList['counts'] = { all: 0, reporting: 0, idle: 0, silent: 0, restart: 0 };
    for (const c of this.stmt(`SELECT ${STATE_SQL} AS state, COUNT(*) AS n FROM reporters r GROUP BY state`).all(base) as unknown as { state: ReporterState; n: number }[]) {
      counts[c.state] = c.n;
      counts.all += c.n;
    }

    const total = (this.stmt(`SELECT COUNT(*) AS n FROM (${sub}) q${filter}`).get(params) as { n: number }).n;
    const rows = this.stmt(`SELECT q.* FROM (${sub}) q${filter} ORDER BY ${ORDER[sort]} ${dir}, q.key LIMIT :limit OFFSET :offset`).all({
      ...params,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }) as unknown as DbReporter[];
    return { total, page, pageSize, rows: rows.map((r) => this.toRow(r)), counts, serverStartedAt: this.startedAt, adminSecret: (this.stmt('SELECT COUNT(*) AS n FROM reporters WHERE credential = ?').get(ADMIN_SECRET) as { n: number }).n };
  }

  /** Every key a filtered view holds, not one page of it: what "select all in this filter" removes. */
  keys(opts: { q?: string; state?: string; admin?: boolean }, now: number): string[] {
    const { sub, params, filter } = this.view(opts, now);
    return (this.stmt(`SELECT q.key FROM (${sub}) q${filter}`).all(params) as unknown as { key: string }[]).map((r) => r.key);
  }

  get(key: string, now: number, opts: { page?: number; pageSize?: number } = {}): ReporterDetail | undefined {
    const r = this.stmt(
      `SELECT r.*, ${STATE_SQL} AS state, (${SESSIONS_SQL}) AS sessions, (${LIVE_SQL}) AS live, (${PROJECT_SQL}) AS project FROM reporters r WHERE r.key = :key`,
    ).get({ key, now, started: this.startedAt }) as unknown as DbReporter | undefined;
    if (!r) return undefined;
    const { page, pageSize } = clampPage(opts);
    const recentTotal = (
      this.stmt('SELECT COUNT(*) AS n FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id WHERE x.reporter_key = ?').get(key) as { n: number }
    ).n;
    const recent = this.stmt(
      `SELECT s.id, s.name, s.status, s.last_seen_at, s.cost_usd FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
       WHERE x.reporter_key = ? ORDER BY s.last_seen_at DESC, s.id LIMIT ? OFFSET ?`,
    ).all(key, pageSize, (page - 1) * pageSize) as unknown as { id: string; name: string; status: string; last_seen_at: number; cost_usd: number | null }[];
    const rejected = r.source_address
      ? this.rejections
          .filter((x) => x.source === r.source_address)
          .slice(-SHOWN_REJECTED)
          .reverse()
          .map((x) => ({ t: x.t, reason: x.reason }))
      : [];
    return {
      ...this.toRow(r),
      serverStartedAt: this.startedAt,
      kind: r.kind,
      machineId: r.machine_id,
      source: r.source_address,
      credential: r.credential,
      engineVersion: r.engine_version,
      recent: recent.map((s) => ({ id: s.id, name: s.name, status: s.status, lastSeenAt: s.last_seen_at, costUsd: s.cost_usd })),
      recentTotal,
      recentPage: page,
      recentPageSize: pageSize,
      rejected,
    };
  }

  /** Takes a reporter off the list; it comes back if it reports again. Its sessions are not touched. */
  remove(key: string): boolean {
    return Number(this.stmt('DELETE FROM reporters WHERE key = ?').run(key).changes) > 0;
  }

  /** Removes these reporters in one step; unknown keys are skipped. Returns how many went. Sessions are not touched. */
  removeMany(keys: string[]): number {
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const k of keys) n += Number(this.stmt('DELETE FROM reporters WHERE key = ?').run(k).changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /** Removes every reporter in one state ("Not since restart", say). Returns how many went. */
  removeState(state: ReporterState, now: number): number {
    return Number(
      this.stmt(`DELETE FROM reporters WHERE key IN (SELECT r.key FROM reporters r WHERE ${STATE_SQL} = :state)`).run({ now, started: this.startedAt, state }).changes,
    );
  }

  // ---- ignore rules (issue #167) --------------------------------------------------------------

  /** A pattern is exact text, compared without regard to case, with * for "anything". Never a regular expression. */
  private static matches(pattern: string, value: string): boolean {
    // Two-pointer wildcard match: * takes any run of characters, and the work stays proportional to the two lengths.
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    let pi = 0;
    let vi = 0;
    let star = -1;
    let mark = 0;
    while (vi < v.length) {
      if (pi < p.length && p[pi] === '*') {
        star = pi++;
        mark = vi;
      } else if (pi < p.length && p[pi] === v[vi]) {
        pi++;
        vi++;
      } else if (star >= 0) {
        pi = star + 1;
        vi = ++mark;
      } else {
        return false;
      }
    }
    while (pi < p.length && p[pi] === '*') pi++;
    return pi === p.length;
  }

  private static ruleOf(r: { id: number; kind: string; pattern: string; created_at: number }): IgnoreRule {
    return { id: r.id, kind: r.kind as IgnoreKind, pattern: r.pattern, createdAt: r.created_at };
  }

  listIgnores(): IgnoreRule[] {
    return (this.stmt('SELECT id, kind, pattern, created_at FROM reporter_ignores ORDER BY id').all() as unknown as Parameters<typeof ReporterStore.ruleOf>[0][]).map(ReporterStore.ruleOf);
  }

  /** The first rule a reporter matches, or undefined. */
  ignoredBy(t: IgnoreTarget): IgnoreRule | undefined {
    return this.listIgnores().find((r) => {
      if (r.kind === 'key') return [t.key, ...(t.otherKeys ?? [])].some((k) => ReporterStore.matches(r.pattern, k));
      const v = r.kind === 'address' ? t.source : t.version;
      return v !== null && ReporterStore.matches(r.pattern, v);
    });
  }

  /** Adds a rule (an identical one is kept once) and takes the reporters it matches off the list. Throws on a bad rule. */
  addIgnore(kind: IgnoreKind, pattern: string, now: number): IgnoreRule {
    const p = pattern.trim();
    if (!IGNORE_KINDS.includes(kind)) throw new Error('kind must be key, address or version');
    if (/^\*+$/.test(p)) throw new Error('pattern must name something besides *');
    if (p.length < 1 || p.length > MAX_PATTERN) throw new Error(`pattern must be 1 to ${MAX_PATTERN} characters`);
    this.stmt('INSERT OR IGNORE INTO reporter_ignores (kind, pattern, created_at) VALUES (?, ?, ?)').run(kind, p, now);
    const rule = ReporterStore.ruleOf(this.stmt('SELECT id, kind, pattern, created_at FROM reporter_ignores WHERE kind = ? AND pattern = ?').get(kind, p) as never);
    const all = this.stmt('SELECT key, machine_id, source_address, reporter_version FROM reporters').all() as unknown as { key: string; machine_id: string | null; source_address: string | null; reporter_version: string }[];
    this.removeMany(
      all
        .filter((r) => {
          // A rule on a machine id covers every account on that machine, so a key rule also tries the row's machine id (#221).
          if (kind === 'key') return ReporterStore.matches(p, r.key) || (r.machine_id !== null && ReporterStore.matches(p, r.machine_id));
          const v = kind === 'address' ? r.source_address : r.reporter_version;
          return v !== null && ReporterStore.matches(p, v);
        })
        .map((r) => r.key),
    );
    return rule;
  }

  removeIgnore(id: number): boolean {
    return Number(this.stmt('DELETE FROM reporter_ignores WHERE id = ?').run(id).changes) > 0;
  }

  // ---- forgetting by age (issue #167) ---------------------------------------------------------

  private setting(key: string): string | undefined {
    return (this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private putSetting(key: string, value: string): void {
    this.stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Off until the Admin turns it on; the days are kept while it is off. */
  forgetSetting(): ForgetSetting {
    const days = Number(this.setting('forget_reporters_days'));
    return { enabled: this.setting('forget_reporters_enabled') === '1', days: Number.isInteger(days) && days >= 1 ? days : DEFAULT_FORGET_DAYS };
  }

  /** Throws when `days` is not a whole number from 1 to 3650. */
  setForgetSetting(s: Partial<ForgetSetting>): void {
    if (s.days !== undefined && (!Number.isInteger(s.days) || s.days < 1 || s.days > MAX_FORGET_DAYS)) throw new Error(`days must be a whole number from 1 to ${MAX_FORGET_DAYS}`);
    if (s.days !== undefined) this.putSetting('forget_reporters_days', String(s.days));
    if (s.enabled !== undefined) this.putSetting('forget_reporters_enabled', s.enabled ? '1' : '0');
  }

  /** Removes reporters not heard from for the set number of days, when the setting is on and the server has been up for an hour. Returns how many went. */
  forgetStale(now: number): number {
    const f = this.forgetSetting();
    if (!f.enabled) return 0;
    // A server that was down for longer than the setting has heard from nobody yet: give every reporter time to report first.
    if (now - this.startedAt < FORGET_GRACE_MS) return 0;
    return Number(this.stmt('DELETE FROM reporters WHERE last_seen_at < ?').run(now - f.days * DAY_MS).changes);
  }
}
