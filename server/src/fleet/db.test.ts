import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, FleetDb, type SessionRow } from './db.js';
import { PeopleStore } from './people.js';

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', name: 'demo', status: 'running', wait_reason: null, wait_note: null, end_reason: null, resume_id: null,
    started_at: 1000, last_seen_at: 2000, ended_at: null, dropped_at: null, cwd: '/tmp/demo', project_root: null,
    repo_name: null, git_json: null, model: 'opus', effort: 'high', context_tokens: null, context_window: null,
    context_percent: null, cost_usd: 1.5, tok_in: 0, tok_out: 0, tok_cr: 0, tok_cw: 0, rate_limits_json: null,
    blowouts: 0, plan_json: null, reporter_version: '0.1.0', engine_version: null, loop_json: null, files_json: null, attached: null, detached_at: null, owner: null, machine_json: null, background_json: null, usage_json: null, cleared_from: null,
    ...over,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates the schema and records the migration', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['admin_log', 'agent_texts', 'agents', 'blowouts', 'events', 'groups', 'people', 'person_machines', 'reporter_ignores', 'reporter_sessions', 'reporters', 'samples', 'schema_migrations', 'sessions', 'settings']));
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }]);
    db.close();
  });

  it('merges reporter rows that share a session into the oldest one (issue #166)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'fleet.db');
    const old = openDb(file);
    old.exec('DELETE FROM schema_migrations WHERE version BETWEEN 12 AND 13');
    old.exec(`INSERT INTO reporters (key, kind, machine_id, source_address, reporter_version, first_seen_at, last_seen_at) VALUES
      ('addr:10.0.0.1', 'mod', NULL, '10.0.0.1', '0.13.0', 100, 200),
      ('addr:10.0.0.2', 'mod', NULL, '10.0.0.2', '0.13.0', 300, 400),
      ('addr:10.0.0.3', 'mod', NULL, '10.0.0.3', '0.13.0', 500, 600),
      ('abc123abc123', 'mod', 'abc123abc123', '10.0.0.9', '0.13.0', 50, 700)`);
    old.exec(`INSERT INTO reporter_sessions (reporter_key, session_id) VALUES
      ('addr:10.0.0.1', 's1'), ('addr:10.0.0.2', 's1'), ('addr:10.0.0.2', 's2'), ('addr:10.0.0.3', 's3'), ('abc123abc123', 's1')`);
    old.close();
    const db = openDb(file);
    expect(db.prepare('SELECT key, first_seen_at AS f, last_seen_at AS l, source_address AS a FROM reporters ORDER BY key').all()).toEqual([
      { key: 'abc123abc123', f: 50, l: 700, a: '10.0.0.9' },
      { key: 'addr:10.0.0.1', f: 100, l: 400, a: '10.0.0.2' },
      { key: 'addr:10.0.0.3', f: 500, l: 600, a: '10.0.0.3' },
    ]);
    expect(db.prepare("SELECT reporter_key AS k, session_id AS s FROM reporter_sessions WHERE reporter_key LIKE 'addr:%' ORDER BY k, s").all()).toEqual([
      { k: 'addr:10.0.0.1', s: 's1' }, { k: 'addr:10.0.0.1', s: 's2' }, { k: 'addr:10.0.0.3', s: 's3' },
    ]);
    db.close();
  });

  it('follows a chain of shared sessions to one row when merging reporters (issue #166)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'fleet.db');
    const old = openDb(file);
    old.exec('DELETE FROM schema_migrations WHERE version BETWEEN 12 AND 13');
    old.exec(`INSERT INTO reporters (key, kind, machine_id, source_address, reporter_version, first_seen_at, last_seen_at) VALUES
      ('addr:a', 'mod', NULL, 'a', '0.13.0', 100, 200), ('addr:b', 'mod', NULL, 'b', '0.13.0', 300, 400), ('addr:c', 'mod', NULL, 'c', '0.13.0', 500, 600)`);
    old.exec(`INSERT INTO reporter_sessions (reporter_key, session_id) VALUES ('addr:a', 's1'), ('addr:b', 's1'), ('addr:b', 's2'), ('addr:c', 's2')`);
    old.close();
    const db = openDb(file);
    expect(db.prepare('SELECT key, first_seen_at AS f, last_seen_at AS l FROM reporters').all()).toEqual([{ key: 'addr:a', f: 100, l: 600 }]);
    expect(db.prepare('SELECT session_id AS s FROM reporter_sessions ORDER BY s').all()).toEqual([{ s: 's1' }, { s: 's2' }]);
    db.close();
  });

  it('migrates a version 1 database forward and keeps its agent rows, with no tool counts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'podium.sqlite');
    const a = new FleetDb(openDb(file));
    a.upsertSession(session());
    a.close();
    const old = openDb(file);
    old.exec('INSERT INTO agents (session_id, id, kind, type, description, status, started_at, tool_calls) VALUES (\'s1\', \'a\', \'subagent\', \'x\', \'d\', \'done\', 1, 7)');
    old.exec('ALTER TABLE agents DROP COLUMN tool_counts_json');
    old.exec('DROP TABLE native_usage');
    old.exec('DROP TABLE native_state');
    old.exec('ALTER TABLE sessions DROP COLUMN integration_json');
    old.exec('ALTER TABLE sessions DROP COLUMN loop_json');
    old.exec('ALTER TABLE sessions DROP COLUMN files_json');
    old.exec('ALTER TABLE sessions DROP COLUMN attached');
    old.exec('ALTER TABLE sessions DROP COLUMN detached_at');
    old.exec('ALTER TABLE sessions DROP COLUMN owner');
    old.exec('ALTER TABLE sessions DROP COLUMN machine_json');
    old.exec('ALTER TABLE sessions DROP COLUMN background_json');
    old.exec('ALTER TABLE sessions DROP COLUMN usage_json');
    old.exec('ALTER TABLE agents DROP COLUMN usage_json');
    old.exec('ALTER TABLE samples DROP COLUMN usage_json');
    old.exec('DROP INDEX sessions_cleared_from');
    old.exec('ALTER TABLE sessions DROP COLUMN cleared_from');
    for (const t of ['reporter_sessions', 'reporters', 'person_machines', 'people', 'groups', 'admin_log', 'settings', 'agent_texts']) old.exec(`DROP TABLE ${t}`);
    old.exec('DELETE FROM schema_migrations WHERE version >= 2');
    old.close();
    const db = openDb(file);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }]);
    expect(db.prepare("SELECT tool_calls, tool_counts_json FROM agents WHERE id = 'a'").get()).toEqual({ tool_calls: 7, tool_counts_json: null });
    expect(db.prepare("SELECT name, loop_json, files_json, attached, detached_at, owner, machine_json, cleared_from FROM sessions WHERE id = 's1'").get()).toEqual({ name: 'demo', loop_json: null, files_json: null, attached: null, detached_at: null, owner: null, machine_json: null, cleared_from: null });
    db.close();
  });

  it('drops the unread people.token_last4 column and keeps the people it had (issue #277)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'fleet.db');
    // A database made by 1.0.2: people has token_last4 (NOT NULL) and the migration 17 has not run.
    const old = openDb(file);
    if (!(old.prepare('PRAGMA table_info(people)').all() as { name: string }[]).some((c) => c.name === 'token_last4')) {
      old.exec("ALTER TABLE people ADD COLUMN token_last4 TEXT NOT NULL DEFAULT ''");
    }
    old.exec(`INSERT INTO people (name, name_lower, key_id, token_hash, token_last4, created_at)
      VALUES ('Ada', 'ada', 'aabbccddeeff', '${'0'.repeat(64)}', 'wxyz', 1000)`);
    old.exec('DELETE FROM schema_migrations WHERE version = 17');
    old.close();

    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(people)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('token_last4');
    expect(cols).toEqual(expect.arrayContaining(['name', 'key_id', 'token_hash']));
    expect(db.prepare('SELECT name, key_id, token_hash FROM people').all()).toEqual([
      { name: 'Ada', key_id: 'aabbccddeeff', token_hash: '0'.repeat(64) },
    ]);
    // A person can still be made and given a new token, with nothing writing the dropped column.
    const people = new PeopleStore(db);
    const made = people.createPerson('Grace');
    expect(made.token).toMatch(/^pdm_[0-9a-f]{12}_[0-9a-f]{48}$/);
    const rotated = people.rotate(made.person.id);
    expect(rotated?.token).not.toBe(made.token);
    expect(people.findByKeyId('aabbccddeeff')?.name).toBe('Ada');
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 18 });
    db.close();
  });

  it('is idempotent on an existing file and turns WAL on', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'nested', 'podium.sqlite');
    const a = new FleetDb(openDb(file));
    a.upsertSession(session());
    a.close();
    const db = openDb(file);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 18 });
    expect(db.prepare('SELECT name FROM sessions').all()).toEqual([{ name: 'demo' }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it('stores hostile strings as data, never as SQL', () => {
    const f = new FleetDb(openDb(':memory:'));
    const evil = "'); DROP TABLE sessions;--";
    f.upsertSession(session({ name: evil, id: evil }));
    f.insertEvent({ id: evil, session_id: evil, agent_id: null, t: 1, kind: 'note', text: evil, data_json: null });
    expect(f.getSession(evil)?.name).toBe(evil);
    expect(f.listEvents({ sessionId: evil, limit: 10 })[0]?.text).toBe(evil);
    const tables = (f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('sessions');
    f.close();
  });

  it('upserts sessions, ignores duplicate events and deletes a session with its rows', () => {
    const f = new FleetDb(openDb(':memory:'));
    f.upsertSession(session());
    f.upsertSession(session({ name: 'renamed' }));
    expect(f.getSession('s1')?.name).toBe('renamed');
    const ev = { id: 'e1', session_id: 's1', agent_id: null, t: 5, kind: 'note', text: 'x', data_json: null };
    expect(f.insertEvent(ev)).toBe(true);
    expect(f.insertEvent(ev)).toBe(false);
    f.insertBlowout({ session_id: 's1', agent_id: 'a', t: 5, kind: 'auto-compact', tokens_before: 1, tokens_after: 0 });
    f.insertBlowout({ session_id: 's1', agent_id: 'a', t: 5, kind: 'auto-compact', tokens_before: 1, tokens_after: 0 });
    expect(f.countBlowouts('s1')).toBe(1);
    expect(f.deleteSession('s1')).toBe(true);
    expect(f.getSession('s1')).toBeUndefined();
    expect(f.countEvents()).toBe(0);
    expect(f.deleteSession('s1')).toBe(false);
    f.close();
  });

  describe('spend since a moment (#139)', () => {
    const MIDNIGHT = 1_000_000; // ms
    const sample = (f: FleetDb, id: string, tSec: number, cost: number) =>
      f.upsertSample({ session_id: id, t: tSec, tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: cost });

    it('counts only what a session started before the moment spent after it', () => {
      const f = new FleetDb(openDb(':memory:'));
      // Started yesterday, $10 at midnight, $14 now: $4 happened today.
      f.upsertSession(session({ id: 'long', started_at: MIDNIGHT - 3_600_000, cost_usd: 14 }));
      sample(f, 'long', MIDNIGHT / 1000 - 5, 10);
      sample(f, 'long', MIDNIGHT / 1000 + 500, 14);
      // Started today: all of it.
      f.upsertSession(session({ id: 'new', started_at: MIDNIGHT + 1000, cost_usd: 2 }));
      // Ended before midnight, nothing spent after it.
      f.upsertSession(session({ id: 'done', started_at: MIDNIGHT - 7_200_000, ended_at: MIDNIGHT - 60_000, cost_usd: 5 }));
      sample(f, 'done', MIDNIGHT / 1000 - 70, 5);
      expect(f.costSince(MIDNIGHT)).toBeCloseTo(6, 9);
    });

    it('follows repricing in proportion, and the owner split adds up to the total', () => {
      const f = new FleetDb(openDb(':memory:'));
      f.upsertSession(session({ id: 'long', owner: 'Dana K.', started_at: MIDNIGHT - 3_600_000, cost_usd: 10 }));
      sample(f, 'long', MIDNIGHT / 1000 - 5, 5);
      sample(f, 'long', MIDNIGHT / 1000 + 500, 10);
      f.upsertSession(session({ id: 'new', owner: null, started_at: MIDNIGHT + 1000, cost_usd: 1 }));
      const doubled = (r: { cost_usd: number | null }) => (r.cost_usd ?? 0) * 2;
      // Half of the long session's $10 (priced at $20) happened today, plus the new one's $2.
      expect(f.costSince(MIDNIGHT, doubled)).toBeCloseTo(12, 9);
      const by = f.costByOwnerSince(MIDNIGHT, doubled);
      expect(by.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(12, 9);
      expect(by.find((r) => r.owner === 'Dana K.')?.costUsd).toBeCloseTo(10, 9);
      // One pass gives the same total and split.
      const both = f.spendTotals(MIDNIGHT, doubled);
      expect(both.total).toBeCloseTo(f.costSince(MIDNIGHT, doubled), 9);
      expect(both.byOwner).toEqual(by);
    });
  });

  it('splits today\'s cost by owner with each owner\'s group, and finds an owner\'s group', () => {
    const f = new FleetDb(openDb(':memory:'));
    const people = new PeopleStore(f.db);
    const backend = people.createGroup('Backend');
    people.createPerson('Priya N.', backend.id);
    people.createPerson('Dana K.');
    f.upsertSession(session({ id: 'a', owner: 'Priya N.', cost_usd: 2, started_at: 5000 }));
    f.upsertSession(session({ id: 'b', owner: 'Priya N.', cost_usd: 3, started_at: 6000 }));
    f.upsertSession(session({ id: 'c', owner: 'Dana K.', cost_usd: 1, started_at: 6000 }));
    f.upsertSession(session({ id: 'd', owner: 'Admin', cost_usd: 0.5, started_at: 6000 }));
    f.upsertSession(session({ id: 'e', owner: null, cost_usd: 0.25, started_at: 6000 }));
    f.upsertSession(session({ id: 'old', owner: 'Dana K.', cost_usd: 9, started_at: 10 }));
    f.upsertSession(session({ id: 'unpriced', owner: 'Dana K.', cost_usd: null, started_at: 6000 }));
    expect(f.costByOwnerSince(1000)).toEqual([
      { owner: 'Priya N.', group: 'Backend', costUsd: 5 },
      { owner: 'Dana K.', group: null, costUsd: 1 },
      { owner: 'Admin', group: null, costUsd: 0.5 },
      { owner: null, group: null, costUsd: 0.25 },
    ]);
    expect(f.costByOwnerSince(1000).reduce((n, r) => n + r.costUsd, 0)).toBe(f.costSince(1000));
    expect(f.groupOfOwner('Priya N.')).toBe('Backend');
    expect(f.groupOfOwner('Dana K.')).toBeNull();
    expect(f.groupOfOwner('Admin')).toBeNull();
    expect(f.groupOfOwner(null)).toBeNull();
    f.close();
  });
});

describe('admin log retention (#303)', () => {
  const DAY = 24 * 3600_000;
  const policy = { samplesMs: DAY, eventsMs: 30 * DAY, sessionsMs: 30 * DAY, adminLogMs: 90 * DAY };
  const NOW = 1_000 * DAY;

  it('removes rows older than the period and keeps newer ones', () => {
    const f = new FleetDb(openDb(':memory:'));
    const people = new PeopleStore(f.db);
    for (let i = 0; i < 30; i++) people.log('old', `old${i}`, '1.2.3.4', NOW - 91 * DAY - i);
    people.log('new', 'edge', '1.2.3.4', NOW - 89 * DAY);
    for (let i = 0; i < 110; i++) people.log('new', `new${i}`, '1.2.3.4', NOW - i);
    expect(f.retain(NOW, policy).adminLog).toBe(30);
    expect(people.listLog({ page: 1, pageSize: 10 }).total).toBe(111);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM admin_log WHERE kind = 'old'`).get()).toEqual({ n: 0 });
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM admin_log WHERE detail = 'edge'`).get()).toEqual({ n: 1 });
    f.close();
  });

  it('always keeps the newest 100 rows, however old, so a quiet server keeps some history', () => {
    const f = new FleetDb(openDb(':memory:'));
    const people = new PeopleStore(f.db);
    for (let i = 0; i < 120; i++) people.log('old', `n${i}`, '1.2.3.4', NOW - 365 * DAY + i);
    expect(f.retain(NOW, policy).adminLog).toBe(20);
    expect(people.listLog({ page: 1, pageSize: 10 }).total).toBe(100);
    expect(people.listLog({ page: 1, pageSize: 10 }).rows[0]!.detail).toBe('n119');
    expect(f.db.prepare(`SELECT MIN(id) AS m FROM admin_log`).get()).toEqual({ m: 21 });
    f.close();
  });
});
