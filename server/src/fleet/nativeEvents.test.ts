import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FleetDb, openDb } from './db.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { ingestNativeEvent, type NativeEvent } from './nativeEvents.js';
import { createFleetRouter } from './routes.js';
import { fixtureReport } from './testing.js';
import { staleAfterFor } from './derive.js';
import { validateReport } from './protocol.js';
import { ReporterStore } from './reporters.js';

const open: Fleet[] = [];
afterEach(() => { for (const f of open.splice(0)) f.close(); });
function setup() {
  const fleet = new Fleet(new FleetDb(openDb(':memory:')), { ...DEFAULT_CONFIG, dbPath: ':memory:', home: '/home/test' });
  open.push(fleet);
  const send = (overrides: Partial<NativeEvent> = {}, owner = 'Ada') => ingestNativeEvent(fleet, {
    engine: 'codex', sessionId: 'native-id', kind: 'start', mode: 'hooks', id: crypto.randomUUID(), at: Date.now(), cwd: '/home/test/project', ...overrides,
  }, owner);
  return { fleet, send };
}

describe('native CLI events', () => {
  it('keeps child model and plan changes separate from the parent loop', () => {
    const { fleet, send } = setup();
    send({ model: 'parent-model' });
    send({ kind: 'agent-start', agentId: 'child', model: 'child-model' });
    const childPlan = { title: null, source: 'podium_plan' as const, steps: [{ id: '1', text: 'Child work', state: 'active' as const, activeText: null, ownerAgentId: null, ownerLabel: null }] };
    send({ kind: 'plan', agentId: 'child', plan: childPlan });
    send({ kind: 'agent-end', agentId: 'child', model: 'child-final-model' });
    const view = fleet.view('codex:native-id')!;
    expect(view.model).toBe('parent-model');
    expect(view.plan).toBeNull();
    expect(view.agents[0].model).toBe('child-final-model');
    expect(view.agents[0].steps).toEqual({ done: 0, total: 1 });
  });
  it('preserves legacy reports, namespaces engines and generates safe native resume commands', () => {
    const { fleet, send } = setup();
    const legacy = fixtureReport();
    fleet.ingest(legacy);
    expect(fleet.view(legacy.session.id)?.integration).toBeUndefined();
    for (const engine of ['codex', 'copilot', 'opencode'] as const) {
      expect(send({ engine, sessionId: "id'; echo unsafe" }).ok).toBe(true);
      const v = fleet.view(`${engine}:id'; echo unsafe`)!;
      expect(v.integration?.engine).toBe(engine);
      expect(v.resumeCommand).toContain(engine === 'codex' ? 'codex resume' : engine === 'copilot' ? 'copilot --resume' : 'opencode --session');
      expect(v.resumeCommand).toContain("'id'\\''; echo unsafe'");
      expect(v.compat).toBe('unknown');
    }
  });

  it('deduplicates tools, survives a new request and refuses ownership changes', () => {
    const { fleet, send } = setup();
    send();
    const event: Partial<NativeEvent> = { kind: 'tool-end', tool: 'Bash', id: 'same-call' };
    expect(send(event).ok).toBe(true);
    expect(send(event)).toMatchObject({ duplicate: true });
    expect(fleet.view('codex:native-id')?.loop?.toolCounts).toEqual({ Bash: 1 });
    expect(() => send({}, 'Mallory')).toThrow('belongs to another owner');
    expect(fleet.db.db.prepare('SELECT state_json FROM native_state').get()).toBeDefined();
  });

  it('keeps terminal status when tool results arrive late; explicit resume revives it', () => {
    const { fleet, send } = setup();
    const now = Date.now();
    send({ kind: 'prompt', at: now });
    send({ kind: 'end', at: now + 2 });
    send({ kind: 'tool-start', tool: 'Bash', at: now + 1 });
    expect(fleet.view('codex:native-id')?.status).toBe('done');
    send({ kind: 'start', at: now + 3 });
    expect(fleet.view('codex:native-id')?.status).toBe('waiting');
  });

  it('replaces usage snapshots without double-counting cached input and includes child usage once', () => {
    const { fleet, send } = setup();
    const usage = { key: 'message', model: 'openai/gpt-test', tokens: { input: 70, output: 10, cacheRead: 30, cacheWrite: 0 }, costUsd: 0.02 };
    send({ engine: 'opencode', mode: 'plugin', kind: 'usage', usage });
    send({ engine: 'opencode', mode: 'plugin', kind: 'usage', usage });
    send({ engine: 'opencode', mode: 'plugin', kind: 'usage', agentId: 'child', usage: { ...usage, key: 'child-message' } });
    const v = fleet.view('opencode:native-id')!;
    expect(v.tokensTotal).toBe(220);
    expect(v.tokensTotal).toBe(v.agents[0].tokens.input + v.agents[0].tokens.output + v.agents[0].tokens.cacheRead + 110);
    expect(v.costUsd).toBe(0.04);
    expect(v.integration?.metrics).toContain('tokens');
  });

  it('does not mistake Copilot credits or Anthropic model names for reported dollars', () => {
    const { fleet, send } = setup();
    send({ engine: 'copilot', mode: 'extension', kind: 'usage', model: 'claude-sonnet-4', usage: {
      key: 'call', model: 'claude-sonnet-4', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 20,
    } });
    expect(fleet.view('copilot:native-id')?.costUsd).toBeNull();
    expect(fleet.kpis().unpricedSessions).toBe(1);
  });

  it('ignores fallback events after richer integration connects and uses event-only silence allowance', () => {
    const { fleet, send } = setup();
    send({ engine: 'copilot', mode: 'extension', kind: 'tool-end', tool: 'Read' });
    expect(send({ engine: 'copilot', mode: 'hooks', kind: 'tool-end', tool: 'Read' })).toMatchObject({ ignored: true });
    expect(fleet.view('copilot:native-id')?.loop?.toolCalls).toBe(1);
    send();
    expect(staleAfterFor(fleet.db.getSession('codex:native-id')!, { ...DEFAULT_CONFIG, home: '' })).toBe(DEFAULT_CONFIG.hookStaleAfterMs);
  });

  it('rejects malformed metadata atomically and deletes native state with its session', () => {
    const { fleet, send } = setup();
    expect(send({ kind: 'usage', usage: { key: 'x', model: null, tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } } }).ok).toBe(false);
    expect(fleet.db.getSession('codex:native-id')).toBeUndefined();
    send();
    expect(send({ context: { tokens: Number.NaN, window: null, percent: null } }).ok).toBe(false);
    fleet.deleteSession('codex:native-id');
    expect(fleet.db.db.prepare('SELECT COUNT(*) AS n FROM native_state').get()).toEqual({ n: 0 });
  });

  it('keeps full activity out of checkpoints and ignores normal compaction as a blowout', () => {
    const { fleet, send } = setup();
    send({ activityFeed: true });
    fleet.activity.watch('codex:native-id', '@orchestrator', 5);
    send({ kind: 'text', activityFeed: true, text: 'transient activity' });
    expect(fleet.activity.watch('codex:native-id', '@orchestrator', 5).entries).toHaveLength(1);
    expect(JSON.stringify(fleet.db.db.prepare('SELECT * FROM native_state').get())).not.toContain('transient activity');
    send({ kind: 'compact' });
    expect(fleet.view('codex:native-id')?.blowouts.total).toBe(0);
  });
});

it('protects native event ingestion with the existing auth and payload boundary', async () => {
  const { fleet } = setup();
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: 'test-secret' }));
  const body = { engine: 'codex', sessionId: 'id', kind: 'start', mode: 'hooks', id: 'event', at: Date.now() };
  expect((await request(app).post('/api/fleet/event').send(body)).status).toBe(401);
  expect((await request(app).post('/api/fleet/event').set('X-Podium-Token', 'test-secret').send(body)).status).toBe(200);
  expect((await request(app).post('/api/fleet/event').set('X-Podium-Token', 'test-secret').send({ ...body, engine: 'unknown' })).status).toBe(400);
  const old = fixtureReport();
  expect(validateReport(old).ok).toBe(true);
});

it('lists separate native engines in reporter inventory on the same source address', async () => {
  const { fleet } = setup();
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: 'test-secret', reporters: new ReporterStore(fleet.db.db, Date.now()) }));
  for (const engine of ['codex', 'copilot', 'opencode']) {
    expect((await request(app).post('/api/fleet/event').set('X-Podium-Token', 'test-secret').send({
      engine, sessionId: 'same-id', kind: 'start', mode: 'hooks', id: 'start', at: Date.now(),
    })).status).toBe(200);
  }
  const reporters = fleet.db.db.prepare('SELECT key, kind FROM reporters').all();
  expect(reporters).toHaveLength(3);
  expect(reporters.every((row) => row.kind === 'native')).toBe(true);
});
