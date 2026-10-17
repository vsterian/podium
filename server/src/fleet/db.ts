// SQLite storage for Podium (SPEC 7.2). Uses Node's built-in node:sqlite. It is loaded through
// process.getBuiltinModule because Vite (vitest) strips the `node:` prefix from a static import and
// then cannot resolve `sqlite`. Every statement is parameterized; no reported string is ever
// interpolated into SQL.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const sqlite = process.getBuiltinModule('node:sqlite');

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  wait_reason TEXT, wait_note TEXT, end_reason TEXT, resume_id TEXT,
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, dropped_at INTEGER,
  cwd TEXT NOT NULL, project_root TEXT, repo_name TEXT,
  git_json TEXT,
  model TEXT, effort TEXT,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  cost_usd REAL, tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER,
  rate_limits_json TEXT, blowouts INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT, reporter_version TEXT, engine_version TEXT
);
CREATE TABLE agents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
  parent_id TEXT, kind TEXT NOT NULL, type TEXT NOT NULL, name TEXT, description TEXT NOT NULL,
  model TEXT, effort TEXT, effort_source TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER, cost_usd_est REAL,
  skills_json TEXT, last_tool TEXT, tool_calls INTEGER, blowouts INTEGER NOT NULL DEFAULT 0,
  steps_done INTEGER, steps_total INTEGER, prompt_excerpt TEXT, answer_excerpt TEXT, failure_json TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, data_json TEXT
);
CREATE INDEX events_session_t ON events(session_id, t DESC);
CREATE INDEX events_t ON events(t DESC);
CREATE TABLE blowouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_before INTEGER, tokens_after INTEGER, UNIQUE (session_id, agent_id, t, kind)
);
CREATE TABLE samples (
  session_id TEXT NOT NULL, t INTEGER NOT NULL,
  tokens_total INTEGER NOT NULL, tokens_delta INTEGER NOT NULL, peak_context REAL NOT NULL,
  running_agents INTEGER NOT NULL, cost_usd REAL, PRIMARY KEY (session_id, t)
);
`,
  },
  {
    version: 2,
    // Calls per tool name as JSON; NULL for rows and reporters from before it existed.
    sql: 'ALTER TABLE agents ADD COLUMN tool_counts_json TEXT;',
  },
  {
    version: 3,
    // The main loop's steps, tools and skills as JSON; NULL for rows and reporters from before it existed.
    sql: 'ALTER TABLE sessions ADD COLUMN loop_json TEXT;',
  },
  {
    version: 4,
    // The files the session changed, as JSON; NULL for rows and reporters from before it existed.
    sql: 'ALTER TABLE sessions ADD COLUMN files_json TEXT;',
  },
  {
    version: 5,
    // Whether any client is attached (1 or 0; NULL when the reporter does not say), and when it first reported nobody attached.
    sql: 'ALTER TABLE sessions ADD COLUMN attached INTEGER; ALTER TABLE sessions ADD COLUMN detached_at INTEGER;',
  },
  {
    version: 6,
    // Per-person tokens, groups, the admin log and server settings (SPEC 7.2, issue #36). A token is never stored,
    // only its SHA-256 and its last four characters. sessions.owner is the name the server decided from the token
    // (the person's name, 'Admin' for the admin secret); NULL for rows from before it existed or with auth off.
    sql: `
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL, token_last4 TEXT NOT NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER, last_report_at INTEGER
);
CREATE TABLE person_machines (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, machine TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, machine)
);
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE sessions ADD COLUMN owner TEXT;
`,
  },
  {
    version: 7,
    // The machine a session runs on ({ name, id } as JSON, issue #34); NULL when the reporter sent none.
    sql: 'ALTER TABLE sessions ADD COLUMN machine_json TEXT;',
  },
  {
    version: 8,
    // The full task prompt and final answer of an agent (issue #97), kept apart so the agents table and
    // the state sent every tick stay small. Rows exist only for reporters with fullPrompts on.
    sql: `CREATE TABLE agent_texts (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prompt_text TEXT,
  answer_text TEXT,
  PRIMARY KEY (session_id, agent_id)
);`,
  },
  {
    version: 9,
    // What a session idle between turns still waits on (BackgroundWait as JSON, issue #119); NULL when nothing.
    sql: 'ALTER TABLE sessions ADD COLUMN background_json TEXT;',
  },
  {
    version: 10,
    // Tokens per model and prompt-size tier as JSON (issue #117), so the server prices them with the Admin's
    // prices when it reads; NULL for rows and reporters from before it existed (their stored cost stands).
    sql: 'ALTER TABLE sessions ADD COLUMN usage_json TEXT; ALTER TABLE agents ADD COLUMN usage_json TEXT;',
  },
  {
    version: 11,
    // Every reporter the server has heard from (issue #142), kept after its sessions are removed. The key is the
    // machine id the reporter sends, or its source address when it sends none. reporter_sessions links it to the
    // sessions it reported, only to count them and to list the recent ones that still exist.
    sql: `CREATE TABLE reporters (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, machine_id TEXT, machine_name TEXT, source_address TEXT,
  owner TEXT, credential TEXT, reporter_version TEXT NOT NULL, engine_version TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE reporter_sessions (
  reporter_key TEXT NOT NULL REFERENCES reporters(key) ON DELETE CASCADE, session_id TEXT NOT NULL,
  PRIMARY KEY (reporter_key, session_id)
);`,
  },
  {
    version: 12,
    // One row per reporter (issue #166). A reporter with no machine id was keyed on its source address, so a container
    // that came back on a new address added a row. Rows that share a session are one reporter: each is merged into
    // the oldest row it shares a session with, keeping every session link, the first seen time of the oldest row and the
    // address and last seen time of the newest.
    sql: `CREATE INDEX IF NOT EXISTS reporter_sessions_session ON reporter_sessions(session_id);
CREATE TEMP TABLE rmap0 AS
  SELECT a.reporter_key AS from_key, MIN((
    SELECT b.reporter_key FROM reporter_sessions b JOIN reporters rb ON rb.key = b.reporter_key
    WHERE b.session_id = a.session_id AND rb.machine_id IS NULL AND rb.kind = ra.kind AND rb.key LIKE (CASE ra.kind WHEN 'hooks' THEN 'hooks:%' ELSE 'addr:%' END)
    ORDER BY rb.first_seen_at, rb.key LIMIT 1)) AS to_key
  FROM reporter_sessions a JOIN reporters ra ON ra.key = a.reporter_key
  WHERE ra.machine_id IS NULL AND (ra.key LIKE 'addr:%' OR ra.key LIKE 'hooks:%')
  GROUP BY a.reporter_key;
DELETE FROM rmap0 WHERE from_key = to_key;
-- A row can point at a row that is itself merged away: follow each chain to its last row.
CREATE TEMP TABLE rmap AS WITH RECURSIVE chase(from_key, cur) AS (
  SELECT from_key, to_key FROM rmap0 UNION SELECT c.from_key, m.to_key FROM chase c JOIN rmap0 m ON m.from_key = c.cur)
  SELECT from_key, cur AS to_key FROM chase WHERE cur NOT IN (SELECT from_key FROM rmap0);
INSERT OR IGNORE INTO reporter_sessions (reporter_key, session_id)
  SELECT m.to_key, s.session_id FROM reporter_sessions s JOIN rmap m ON s.reporter_key = m.from_key;
UPDATE reporters SET
  first_seen_at = MIN(first_seen_at, COALESCE((SELECT MIN(f.first_seen_at) FROM reporters f JOIN rmap m ON m.from_key = f.key WHERE m.to_key = reporters.key), first_seen_at)),
  source_address = COALESCE((SELECT f.source_address FROM reporters f JOIN rmap m ON m.from_key = f.key WHERE m.to_key = reporters.key AND f.last_seen_at > reporters.last_seen_at ORDER BY f.last_seen_at DESC LIMIT 1), source_address),
  last_seen_at = MAX(last_seen_at, COALESCE((SELECT MAX(f.last_seen_at) FROM reporters f JOIN rmap m ON m.from_key = f.key WHERE m.to_key = reporters.key), 0))
  WHERE key IN (SELECT to_key FROM rmap);
DELETE FROM reporter_sessions WHERE reporter_key IN (SELECT from_key FROM rmap);
DELETE FROM reporters WHERE key IN (SELECT from_key FROM rmap);
DROP TABLE rmap;
DROP TABLE rmap0;`,
  },
  {
    version: 13,
    // Ignore rules (issue #167): a report from a reporter that matches one is refused. `kind` is key, address or version;
    // `pattern` is exact text with * for "anything".
    sql: `CREATE TABLE IF NOT EXISTS reporter_ignores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, pattern)
);`,
  },
  {
    version: 14,
    // The built-in Administrators group and who made each Admin change (issue #172). A group already named
    // Administrators is adopted as the built-in one. admin_log.actor is NULL for rows from before it existed.
    sql: `INSERT OR IGNORE INTO groups (name, name_lower, created_at) VALUES ('Administrators', 'administrators', CAST(strftime('%s','now') AS INTEGER) * 1000);
ALTER TABLE admin_log ADD COLUMN actor TEXT;`,
  },
  {
    version: 15,
    // The session a session continues after a /clear (issue #206), so History can link the two. NULL otherwise.
    sql: `ALTER TABLE sessions ADD COLUMN cleared_from TEXT;
CREATE INDEX IF NOT EXISTS sessions_cleared_from ON sessions(cleared_from);`,
  },
  {
    version: 16,
    // The session's per-model usage at each sample (issue #270), so the cost-per-minute chart can be priced with the
    // Admin's prices like every other figure. NULL for samples from before it existed and from older reporters.
    sql: 'ALTER TABLE samples ADD COLUMN usage_json TEXT;',
  },
  {
    version: 17,
    // The last four characters of a person's token, stored since #36 and unread since #218 (issue #277). Only the
    // SHA-256 of a token is kept now. The column is not indexed, so it can be dropped in place.
    sql: 'ALTER TABLE people DROP COLUMN token_last4;',
  },
  {
    version: 18,
    sql: `ALTER TABLE sessions ADD COLUMN integration_json TEXT;
CREATE TABLE native_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
);
CREATE TABLE native_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  usage_id TEXT NOT NULL, model TEXT, agent_id TEXT, tokens_json TEXT NOT NULL,
  cost_usd REAL, at INTEGER NOT NULL, PRIMARY KEY (session_id, usage_id)
);`,
  },
];

export interface SessionRow {
  integration_json?: string | null;
  id: string;
  name: string;
  status: 'running' | 'waiting' | 'done';
  wait_reason: string | null;
  wait_note: string | null;
  end_reason: string | null;
  resume_id: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  dropped_at: number | null;
  cwd: string;
  project_root: string | null;
  repo_name: string | null;
  git_json: string | null;
  model: string | null;
  effort: string | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  cost_usd: number | null;
  tok_in: number;
  tok_out: number;
  tok_cr: number;
  tok_cw: number;
  rate_limits_json: string | null;
  blowouts: number;
  plan_json: string | null;
  reporter_version: string | null;
  engine_version: string | null;
  loop_json: string | null;
  files_json: string | null;
  background_json: string | null;
  usage_json: string | null;
  attached: number | null;
  detached_at: number | null;
  owner: string | null;
  machine_json: string | null;
  /** The session this one continues after a /clear (Report.session.clearedFrom, #206); NULL otherwise. */
  cleared_from: string | null;
}

export interface AgentRow {
  session_id: string;
  id: string;
  parent_id: string | null;
  kind: string;
  type: string;
  name: string | null;
  description: string;
  model: string | null;
  effort: string | null;
  effort_source: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  tok_in: number;
  tok_out: number;
  tok_cr: number;
  tok_cw: number;
  cost_usd_est: number | null;
  skills_json: string | null;
  last_tool: string | null;
  tool_calls: number;
  tool_counts_json: string | null;
  usage_json: string | null;
  blowouts: number;
  steps_done: number | null;
  steps_total: number | null;
  prompt_excerpt: string | null;
  answer_excerpt: string | null;
  failure_json: string | null;
  /** Read side only (getAgents): the length of the stored full text, null when there is none. */
  prompt_chars?: number | null;
  answer_chars?: number | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  text: string;
  data_json: string | null;
}

export interface BlowoutRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  tokens_before: number | null;
  tokens_after: number | null;
}

export interface SampleRow {
  session_id: string;
  t: number;
  tokens_total: number;
  tokens_delta: number;
  peak_context: number;
  running_agents: number;
  cost_usd: number | null;
  /** The session's `usage_json` when the sample was taken; absent or NULL when the reporter sent none. */
  usage_json?: string | null;
}

/** A sample's `usage_json` when the usage is the same as the sample before's (issue #270). */
export const SAME_USAGE = '=';

/** What a cost query reads of a session row. */
export interface CostRow {
  cost_usd: number | null;
  usage_json: string | null;
}
export type CostOf = (row: CostRow) => number | null;
const storedCost: CostOf = (r) => r.cost_usd;

export interface RetentionPolicy {
  samplesMs: number;
  eventsMs: number;
  sessionsMs: number;
  /** Admin log rows older than this go, except the newest `ADMIN_LOG_KEEP` (#303). */
  adminLogMs: number;
}

/** The admin log always keeps this many of its newest rows, however old, so a quiet server keeps some history. */
export const ADMIN_LOG_KEEP = 100;

/** Opens (and migrates) a database. `:memory:` for tests; a file path gets WAL and its folder made. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

type Params = Record<string, string | number | null>;

/** Typed, prepared queries over one database. */
export class FleetDb {
  private readonly stmts = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` in one transaction; rolls back if it throws. */
  tx<T>(fn: () => T): T {
    const savepoint = `fleet_${this.transactionDepth++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- sessions -------------------------------------------------------------------------------

  upsertSession(row: SessionRow): void {
    const cols = Object.keys(row) as (keyof SessionRow)[];
    const sql =
      `INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
    this.stmt(sql).run(row as unknown as Params);
  }

  getSession(id: string): SessionRow | undefined {
    return this.stmt('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  /** Sessions that may be in the live set: not dropped, and either not ended or ended after `endedAfter`. */
  liveCandidates(endedAfter: number): SessionRow[] {
    return this.stmt(
      'SELECT * FROM sessions WHERE dropped_at IS NULL AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at',
    ).all(endedAfter) as unknown as SessionRow[];
  }

  setDropped(id: string, at: number): void {
    this.stmt('UPDATE sessions SET dropped_at = ? WHERE id = ?').run(at, id);
  }

  deleteSession(id: string): boolean {
    return this.tx(() => {
      this.stmt('DELETE FROM events WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM blowouts WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM samples WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM agents WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM agent_texts WHERE session_id = ?').run(id);
      return Number(this.stmt('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
    });
  }

  /** The session that continued `id` after a /clear, if any (the newest when there are several). */
  clearedInto(id: string): string | null {
    const r = this.stmt('SELECT id FROM sessions WHERE cleared_from = ? ORDER BY started_at DESC LIMIT 1').get(id) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Sessions that ended (or were dropped) in [from, to). */
  endedBetween(from: number, to: number): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions WHERE (dropped_at >= :from AND dropped_at < :to)
         OR (dropped_at IS NULL AND ended_at >= :from AND ended_at < :to) ORDER BY started_at`,
    ).all({ from, to }) as unknown as SessionRow[];
  }

  /**
   * What each session spent at or after `since`, with its owner and the owner's group. A session that started
   * after `since` counts whole. One that started before counts the share of its cost that came after the ledger's
   * last sample before `since` (samples are cumulative), so a session left running over midnight adds only today's
   * spend. One first heard of after `since` has no sample before it and counts what it spent since its first sample; one with
   * no sample at all adds nothing. `cost` says what a session costs in all (the Admin's
   * prices repriced from its usage); by default its stored cost_usd. That total is scaled by the ledger's share.
   */
  private spendSince(since: number, cost: CostOf): { owner: string | null; grp: string | null; usd: number }[] {
    const rows = this.stmt(
      `SELECT s.id AS id, s.owner AS owner, g.name AS grp, s.cost_usd AS cost_usd, s.usage_json AS usage_json, s.started_at AS started_at,
         COALESCE(
           (SELECT m.cost_usd FROM samples m WHERE m.session_id = s.id AND m.t < :sec AND m.cost_usd IS NOT NULL ORDER BY m.t DESC LIMIT 1),
           (SELECT m.cost_usd FROM samples m WHERE m.session_id = s.id AND m.cost_usd IS NOT NULL ORDER BY m.t ASC LIMIT 1)
         ) AS base
       FROM sessions s LEFT JOIN people p ON p.name = s.owner LEFT JOIN groups g ON g.id = p.group_id
       WHERE s.started_at >= :since OR s.ended_at IS NULL OR s.ended_at >= :since`,
    ).all({ since, sec: Math.floor(since / 1000) }) as unknown as (CostRow & {
      id: string;
      owner: string | null;
      grp: string | null;
      started_at: number;
      base: number | null;
    })[];
    return rows.map((r) => {
      const total = cost(r) ?? 0;
      if (r.started_at >= since) return { owner: r.owner, grp: r.grp, usd: total };
      // No ledger figure now (the mod sends none on a local model): split by the priced usage on the sample before
      // `since` instead, so the Claude spend of an earlier part of the day is not lost (#286).
      if (r.cost_usd === null) return { owner: r.owner, grp: r.grp, usd: Math.max(0, total - this.pricedUsageAt(r.id, since, cost)) };
      const ledger = r.cost_usd;
      const share = r.base === null || ledger <= 0 ? 0 : Math.max(0, ledger - r.base) / ledger;
      return { owner: r.owner, grp: r.grp, usd: total * share };
    });
  }

  /**
   * What a session had cost, priced from its usage, at its last sample before `since`; its first sample when it has
   * none before (a session first heard of after `since`, as in `spendSince`). 0 when no sample kept any usage, so a
   * session from a reporter older than 0.12.0 on a local model still counts nothing today. A sample may hold
   * `SAME_USAGE` for the usage of the one before it, so the usage is the newest one stored in full at or before it.
   */
  private pricedUsageAt(sessionId: string, since: number, cost: CostOf): number {
    const sec = Math.floor(since / 1000);
    const at =
      (this.stmt('SELECT t, usage_json FROM samples WHERE session_id = ? AND t < ? AND usage_json IS NOT NULL ORDER BY t DESC LIMIT 1').get(sessionId, sec) as
        | { t: number; usage_json: string }
        | undefined) ??
      (this.stmt('SELECT t, usage_json FROM samples WHERE session_id = ? AND usage_json IS NOT NULL ORDER BY t ASC LIMIT 1').get(sessionId) as
        | { t: number; usage_json: string }
        | undefined);
    if (!at) return 0;
    let usage: string | null = at.usage_json;
    if (usage === SAME_USAGE) {
      const full = this.stmt('SELECT usage_json FROM samples WHERE session_id = ? AND t <= ? AND usage_json IS NOT NULL AND usage_json != ? ORDER BY t DESC LIMIT 1').get(
        sessionId,
        at.t,
        SAME_USAGE,
      ) as { usage_json: string } | undefined;
      usage = full?.usage_json ?? null;
    }
    return usage === null ? 0 : (cost({ cost_usd: null, usage_json: usage }) ?? 0);
  }

  /** Σ spend at or after `since` (see `spendSince`). */
  costSince(since: number, cost: CostOf = storedCost): number {
    return this.spendSince(since, cost).reduce((n, r) => n + r.usd, 0);
  }

  /** `costSince` split by owner, with the group each owner is in (Admin, no owner and no group give null), largest first. */
  costByOwnerSince(since: number, cost: CostOf = storedCost): { owner: string | null; group: string | null; costUsd: number }[] {
    return this.spendBy(this.spendSince(since, cost));
  }

  /** `costSince` and `costByOwnerSince` from one pass over the sessions, so the total is the sum of the split. */
  spendTotals(since: number, cost: CostOf = storedCost): { total: number; byOwner: { owner: string | null; group: string | null; costUsd: number }[] } {
    const rows = this.spendSince(since, cost);
    return { total: rows.reduce((n, r) => n + r.usd, 0), byOwner: this.spendBy(rows) };
  }

  private spendBy(rows: { owner: string | null; grp: string | null; usd: number }[]): { owner: string | null; group: string | null; costUsd: number }[] {
    const by = new Map<string, { owner: string | null; group: string | null; costUsd: number }>();
    for (const r of rows) {
      const k = `${r.owner ?? ''}\u0000${r.grp ?? ''}`;
      const e = by.get(k) ?? { owner: r.owner, group: r.grp, costUsd: 0 };
      e.costUsd += r.usd;
      by.set(k, e);
    }
    return [...by.values()].sort((a, b) => b.costUsd - a.costUsd || (a.owner ?? '').localeCompare(b.owner ?? ''));
  }

  /** The group a session owner is in; null for Admin, an unknown name or a person with no group. */
  groupOfOwner(owner: string | null): string | null {
    if (owner === null) return null;
    const r = this.stmt('SELECT g.name AS grp FROM people p JOIN groups g ON g.id = p.group_id WHERE p.name = ?').get(owner) as { grp: string } | undefined;
    return r?.grp ?? null;
  }

  distinctReporterVersions(): string[] {
    return (
      this.stmt('SELECT DISTINCT reporter_version AS v FROM sessions WHERE reporter_version IS NOT NULL').all() as {
        v: string;
      }[]
    ).map((r) => r.v);
  }

  // ---- agents ---------------------------------------------------------------------------------

  upsertAgent(row: AgentRow): void {
    const cols = Object.keys(row) as (keyof AgentRow)[];
    const sql =
      `INSERT INTO agents (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')}) ` +
      `ON CONFLICT(session_id, id) DO UPDATE SET ${cols
        .filter((c) => c !== 'id' && c !== 'session_id')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ')}`;
    this.stmt(sql).run(row as unknown as Params);
  }

  getAgents(sessionId: string): AgentRow[] {
    return this.stmt(
      'SELECT a.*, length(t.prompt_text) AS prompt_chars, length(t.answer_text) AS answer_chars FROM agents a ' +
        'LEFT JOIN agent_texts t ON t.session_id = a.session_id AND t.agent_id = a.id ' +
        'WHERE a.session_id = ? ORDER BY a.started_at, a.id',
    ).all(sessionId) as unknown as AgentRow[];
  }

  /** Keeps the full texts a report carried; a text the report leaves out is left as it was. */
  upsertAgentTexts(sessionId: string, agentId: string, t: { prompt?: string; answer?: string }): void {
    this.stmt(
      'INSERT INTO agent_texts (session_id, agent_id, prompt_text, answer_text) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(session_id, agent_id) DO UPDATE SET ' +
        'prompt_text = COALESCE(excluded.prompt_text, prompt_text), answer_text = COALESCE(excluded.answer_text, answer_text)',
    ).run(sessionId, agentId, t.prompt ?? null, t.answer ?? null);
  }

  getAgentTexts(sessionId: string, agentId: string): { prompt: string | null; answer: string | null } | null {
    const r = this.stmt('SELECT prompt_text, answer_text FROM agent_texts WHERE session_id = ? AND agent_id = ?').get(
      sessionId,
      agentId,
    ) as { prompt_text: string | null; answer_text: string | null } | undefined;
    return r ? { prompt: r.prompt_text, answer: r.answer_text } : null;
  }

  /** Marks every running or queued agent of a session aborted. */
  abortOpenAgents(sessionId: string, at: number): void {
    this.stmt(
      `UPDATE agents SET status = 'aborted', ended_at = COALESCE(ended_at, ?)
       WHERE session_id = ? AND status IN ('running', 'queued')`,
    ).run(at, sessionId);
  }

  // ---- events ---------------------------------------------------------------------------------

  /** Inserts an event unless its id exists. Returns true when it was new. */
  insertEvent(row: EventRow): boolean {
    const r = this.stmt(
      `INSERT OR IGNORE INTO events (id, session_id, agent_id, t, kind, text, data_json)
       VALUES (:id, :session_id, :agent_id, :t, :kind, :text, :data_json)`,
    ).run(row as unknown as Params);
    return Number(r.changes) > 0;
  }

  /** Newest first. `before` is exclusive on event time. */
  listEvents(opts: { sessionId?: string | null; before?: number | null; limit: number }): EventRow[] {
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    if (opts.sessionId) {
      return this.stmt(
        'SELECT * FROM events WHERE session_id = ? AND t < ? ORDER BY t DESC, id DESC LIMIT ?',
      ).all(opts.sessionId, before, opts.limit) as unknown as EventRow[];
    }
    return this.stmt('SELECT * FROM events WHERE t < ? ORDER BY t DESC, id DESC LIMIT ?').all(
      before,
      opts.limit,
    ) as unknown as EventRow[];
  }

  countEvents(sessionId?: string): number {
    const r = (
      sessionId
        ? this.stmt('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId)
        : this.stmt('SELECT COUNT(*) AS n FROM events').get()
    ) as { n: number };
    return r.n;
  }

  // ---- blowouts -------------------------------------------------------------------------------

  insertBlowout(row: Omit<BlowoutRow, 'id'>): void {
    this.stmt(
      `INSERT OR IGNORE INTO blowouts (session_id, agent_id, t, kind, tokens_before, tokens_after)
       VALUES (:session_id, :agent_id, :t, :kind, :tokens_before, :tokens_after)`,
    ).run(row as unknown as Params);
  }

  getBlowouts(sessionId: string): BlowoutRow[] {
    return this.stmt('SELECT * FROM blowouts WHERE session_id = ? ORDER BY t').all(sessionId) as unknown as BlowoutRow[];
  }

  countBlowouts(sessionId?: string): number {
    const r = (
      sessionId
        ? this.stmt('SELECT COUNT(*) AS n FROM blowouts WHERE session_id = ?').get(sessionId)
        : this.stmt('SELECT COUNT(*) AS n FROM blowouts').get()
    ) as { n: number };
    return r.n;
  }

  // ---- samples --------------------------------------------------------------------------------

  /** The latest sample strictly before second `t`. */
  sampleBefore(sessionId: string, t: number): SampleRow | undefined {
    return this.stmt('SELECT * FROM samples WHERE session_id = ? AND t < ? ORDER BY t DESC LIMIT 1').get(
      sessionId,
      t,
    ) as SampleRow | undefined;
  }

  latestSample(sessionId: string): SampleRow | undefined {
    return this.stmt('SELECT * FROM samples WHERE session_id = ? ORDER BY t DESC LIMIT 1').get(sessionId) as
      | SampleRow
      | undefined;
  }

  /** Writes the sample for second `t`, replacing one already there (at most one per second). */
  upsertSample(row: SampleRow): void {
    this.stmt(
      `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd, usage_json)
       VALUES (:session_id, :t, :tokens_total, :tokens_delta, :peak_context, :running_agents, :cost_usd, :usage_json)
       ON CONFLICT(session_id, t) DO UPDATE SET tokens_total = excluded.tokens_total,
         tokens_delta = excluded.tokens_delta, peak_context = excluded.peak_context,
         running_agents = excluded.running_agents, cost_usd = excluded.cost_usd,
         usage_json = CASE WHEN excluded.usage_json = '=' THEN samples.usage_json ELSE excluded.usage_json END`,
    ).run({ ...row, usage_json: row.usage_json ?? null } as unknown as Params);
  }

  /** Writes a sample only if that second has none yet. */
  insertSampleIfAbsent(row: SampleRow): void {
    this.stmt(
      `INSERT OR IGNORE INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd, usage_json)
       VALUES (:session_id, :t, :tokens_total, :tokens_delta, :peak_context, :running_agents, :cost_usd, :usage_json)`,
    ).run({ ...row, usage_json: row.usage_json ?? null } as unknown as Params);
  }

  samplesSince(sessionId: string, fromT: number): SampleRow[] {
    return this.stmt('SELECT * FROM samples WHERE session_id = ? AND t >= ? ORDER BY t').all(
      sessionId,
      fromT,
    ) as unknown as SampleRow[];
  }

  /** Σ tokens_delta per second across all sessions, for seconds >= fromT. */
  fleetTokensPerSecond(fromT: number): { t: number; v: number }[] {
    return this.stmt('SELECT t, SUM(tokens_delta) AS v FROM samples WHERE t >= ? GROUP BY t ORDER BY t').all(
      fromT,
    ) as unknown as { t: number; v: number }[];
  }

  /** Positive cost increase per minute across all sessions, for seconds >= fromT (minute = floor(t/60)). */
  fleetCostPerMinute(fromT: number, cost: CostOf = storedCost): { m: number; v: number }[] {
    const rows = this.stmt('SELECT session_id, t, cost_usd, usage_json FROM samples WHERE t >= ? ORDER BY session_id, t').all(
      fromT,
    ) as unknown as { session_id: string; t: number; cost_usd: number | null; usage_json: string | null }[];
    const by = new Map<number, number>();
    let session = '';
    let prev = 0;
    let hadUsage = false;
    let carried: string | null = null; // the last usage a sample of this session stored in full
    let lastUsage: string | null = null;
    let lastStored: number | null = null;
    let lastCost: number | null = null;
    for (const r of rows) {
      if (r.session_id !== session) carried = null;
      const usage: string | null = r.usage_json === SAME_USAGE ? carried : r.usage_json;
      carried = usage;
      // Cost depends only on the usage and the stored figure, which hardly change from one sample to the next.
      if (lastCost === null || usage === null || usage !== lastUsage || r.cost_usd !== lastStored) {
        lastCost = cost({ cost_usd: r.cost_usd, usage_json: usage });
        lastUsage = usage;
        lastStored = r.cost_usd;
      }
      const c = lastCost ?? 0;
      // The first sample in the window, or one where the source of the figure changes (an older sample priced from
      // the ledger next to a newer one priced from usage), has nothing comparable before it.
      const d = r.session_id !== session || (usage !== null) !== hadUsage ? 0 : Math.max(0, c - prev);
      session = r.session_id;
      hadUsage = usage !== null;
      prev = c;
      const m = Math.floor(r.t / 60);
      by.set(m, (by.get(m) ?? 0) + d);
    }
    return [...by].sort((a, b) => a[0] - b[0]).map(([m, v]) => ({ m, v }));
  }

  // ---- retention ------------------------------------------------------------------------------

  /** Deletes old samples, events, ended sessions (with their rows) and admin log rows. Returns what was deleted. */
  retain(now: number, p: RetentionPolicy): { samples: number; events: number; sessions: number; adminLog: number } {
    return this.tx(() => {
      const samples = Number(this.stmt('DELETE FROM samples WHERE t < ?').run(Math.floor((now - p.samplesMs) / 1000)).changes);
      const events = Number(this.stmt('DELETE FROM events WHERE t < ?').run(now - p.eventsMs).changes);
      const cutoff = now - p.sessionsMs;
      const old = this.stmt(
        'SELECT id FROM sessions WHERE (ended_at IS NOT NULL AND ended_at < ?) OR (dropped_at IS NOT NULL AND dropped_at < ?)',
      ).all(cutoff, cutoff) as { id: string }[];
      for (const { id } of old) {
        this.stmt('DELETE FROM events WHERE session_id = ?').run(id);
        this.stmt('DELETE FROM blowouts WHERE session_id = ?').run(id);
        this.stmt('DELETE FROM samples WHERE session_id = ?').run(id);
        this.stmt('DELETE FROM agents WHERE session_id = ?').run(id);
        this.stmt('DELETE FROM agent_texts WHERE session_id = ?').run(id);
        this.stmt('DELETE FROM sessions WHERE id = ?').run(id);
      }
      const adminLog = Number(
        this.stmt('DELETE FROM admin_log WHERE t < ? AND id NOT IN (SELECT id FROM admin_log ORDER BY id DESC LIMIT ?)').run(now - p.adminLogMs, ADMIN_LOG_KEEP).changes,
      );
      return { samples, events, sessions: old.length, adminLog };
    });
  }
}
