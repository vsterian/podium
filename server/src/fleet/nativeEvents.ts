// Native CLI events share the existing report validator, storage, ownership and SSE path.
import { createHash } from 'node:crypto';
import type { Fleet } from './fleet.js';
import { OwnerConflict } from './ingest.js';
import { scrub } from '../logging/redact.js';
import { MAIN_LOOP, validateReport, type AgentReport, type IntegrationInfo, type ModelUsage, type Report, type TokenCounts } from './protocol.js';

type Engine = Exclude<IntegrationInfo['engine'], 'claude-code'>;
type Kind = 'start' | 'prompt' | 'idle' | 'end' | 'tool-start' | 'tool-end' | 'agent-start' | 'agent-end' | 'plan' | 'usage' | 'context' | 'metadata' | 'heartbeat' | 'compact' | 'error' | 'wait' | 'text';
export interface NativeEvent {
  engine: Engine;
  sessionId: string;
  id: string;
  at: number;
  kind: Kind;
  mode: IntegrationInfo['mode'];
  cwd?: string;
  name?: string;
  model?: string;
  effort?: string;
  userName?: string;
  engineVersion?: string;
  activityFeed?: boolean;
  agentId?: string;
  parentId?: string;
  agentType?: string;
  tool?: string;
  toolId?: string;
  error?: string;
  text?: string;
  plan?: Report['session']['plan'];
  git?: Report['session']['git'];
  context?: Report['session']['context'];
  usage?: { key: string; model: string | null; tokens: TokenCounts; costUsd?: number | null };
}
interface Saved { report: Report; lifecycleAt: number }
interface StoredUsage { usage_id: string; model: string | null; agent_id: string | null; tokens_json: string; cost_usd: number | null; at: number }
const ENGINES = ['codex', 'copilot', 'opencode'];
const KINDS: Kind[] = ['start', 'prompt', 'idle', 'end', 'tool-start', 'tool-end', 'agent-start', 'agent-end', 'plan', 'usage', 'context', 'metadata', 'heartbeat', 'compact', 'error', 'wait', 'text'];
const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const clean = (v: string, n = 240) => scrub(v, []).slice(0, n);

function check(body: unknown): NativeEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected an event object');
  const e = body as NativeEvent;
  if (!ENGINES.includes(e.engine) || !KINDS.includes(e.kind) || !['hooks', 'plugin', 'extension'].includes(e.mode)) throw new Error('invalid engine, kind or mode');
  for (const k of ['sessionId', 'id'] as const) if (typeof e[k] !== 'string' || !e[k] || e[k].length > 160 || /[\u0000-\u001f]/.test(e[k])) throw new Error(`invalid ${k}`);
  if (!Number.isFinite(e.at) || e.at < 0) throw new Error('invalid event timestamp');
  for (const k of ['cwd', 'name', 'model', 'effort', 'agentId', 'parentId', 'agentType', 'tool', 'toolId', 'error', 'text', 'userName', 'engineVersion'] as const) {
    if (e[k] !== undefined && typeof e[k] !== 'string') throw new Error(`invalid ${k}`);
  }
  if (e.activityFeed !== undefined && typeof e.activityFeed !== 'boolean') throw new Error('invalid activityFeed');
  if (e.usage) {
    if (typeof e.usage.key !== 'string' || !e.usage.key || e.usage.key.length > 200 || (e.usage.model !== null && typeof e.usage.model !== 'string')) throw new Error('invalid usage identity');
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (!Number.isSafeInteger(e.usage.tokens?.[k]) || e.usage.tokens[k] < 0) throw new Error('invalid token count');
    if (e.usage.costUsd != null && (!Number.isFinite(e.usage.costUsd) || e.usage.costUsd < 0)) throw new Error('invalid cost');
  }
  return e;
}

function initial(e: NativeEvent, id: string, now: number): Saved {
  const cwd = clean(e.cwd ?? '/', 1024);
  return { lifecycleAt: 0, report: {
    v: 1, sentAt: now,
    reporter: { name: 'podium-reporter', version: `native-${e.engine}-1.1.0`, engineVersion: e.engineVersion ?? null, hostSurface: e.mode },
    session: {
      id, integration: { engine: e.engine, nativeId: e.sessionId, mode: e.mode, metrics: [] },
      name: clean(e.name ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.engine, 80),
      cwd, projectRoot: null, repoName: null, git: null, status: 'waiting', waitReason: 'input', waitNote: null,
      endReason: null, resumeId: e.sessionId, startedAt: now, model: null, effort: null,
      context: { tokens: null, window: null, percent: null }, costUsd: null, tokens: zero(),
      rateLimits: [], blowouts: 0, plan: null, loop: { skills: [], lastTool: null, toolCalls: 0, toolCounts: {}, steps: { done: 0, total: null } },
      files: null, attached: null, activityFeed: e.activityFeed ?? false,
    }, agents: [], events: [], userName: e.userName,
  } };
}

function newAgent(e: NativeEvent, now: number): AgentReport {
  return {
    id: e.agentId!, parentId: e.parentId ?? null, kind: 'subagent', type: clean(e.agentType ?? 'agent', 120), name: null,
    description: clean(e.agentType ?? 'agent'), model: e.model ?? null, effort: null, effortSource: 'unknown',
    status: 'running', startedAt: now, endedAt: null, context: { tokens: null, window: null, percent: null },
    tokens: zero(), costUsdEst: null, skills: [], lastTool: null, toolCalls: 0, toolCounts: {}, blowouts: 0,
    steps: null, promptExcerpt: '', answerExcerpt: null, failure: null,
  };
}

/** Validates and reduces one event synchronously; concurrent HTTP requests cannot race a read/merge/write. */
function reduceNativeEvent(fleet: Fleet, body: unknown, owner: string | null) {
  let e: NativeEvent;
  try { e = check(body); } catch (err) { return { ok: false as const, error: (err as Error).message, path: '$' }; }
  const id = `${e.engine}:${e.sessionId}`;
  const row = fleet.db.getSession(id);
  if (row?.owner && owner !== null && row.owner !== owner) throw new OwnerConflict('session belongs to another owner');
  const saved = fleet.db.db.prepare('SELECT state_json FROM native_state WHERE session_id = ?').get(id) as { state_json: string } | undefined;
  const state: Saved = saved ? JSON.parse(saved.state_json) : initial(e, id, fleet.now());
  const report = state.report;
  const s = report.session;
  const info = s.integration!;
  // A reduced fallback must never blank an extension's usage or double-count its tool events.
  if (info.mode !== 'hooks' && e.mode === 'hooks') return { ok: true as const, sessionId: id, ignored: true };
  const eventId = `${id}:${createHash('sha256').update(e.id).digest('hex')}`;
  if (fleet.db.db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) return { ok: true as const, sessionId: id, duplicate: true };
  const promote = info.mode === 'hooks' && e.mode !== 'hooks';
  info.mode = e.mode;
  if (promote && s.loop) { s.loop.toolCalls = 0; s.loop.toolCounts = {}; }
  report.sentAt = fleet.now();
  report.reporter.hostSurface = e.mode;
  report.reporter.engineVersion = e.engineVersion ?? report.reporter.engineVersion;
  report.userName = e.userName ?? report.userName;
  if (e.cwd) s.cwd = clean(e.cwd, 1024);
  if (e.name) s.name = clean(e.name, 80);
  if (e.model && !e.agentId) s.model = clean(e.model, 120);
  if (!e.agentId && ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.effort ?? '')) s.effort = e.effort as Report['session']['effort'];
  if (e.git) s.git = e.git;
  if (e.activityFeed !== undefined) s.activityFeed = e.activityFeed;
  const metric = (m: IntegrationInfo['metrics'][number]) => { if (!info.metrics.includes(m)) info.metrics.push(m); };
  let a = e.agentId ? report.agents.find((a) => a.id === e.agentId) : undefined;
  if (!a && e.agentId && report.agents.length < 200) { a = newAgent(e, e.at); report.agents.push(a); }
  if (a) metric('agents');
  if (a && e.model) a.model = clean(e.model, 120);
  if (e.parentId && a) a.parentId = e.parentId;
  const lifecycle = !e.agentId && ['start', 'prompt', 'idle', 'end', 'wait', 'tool-start'].includes(e.kind);
  if (lifecycle && e.at >= state.lifecycleAt && (s.status !== 'done' || ['start', 'prompt', 'end'].includes(e.kind))) {
    state.lifecycleAt = e.at;
    if (e.kind === 'end') { s.status = 'done'; s.endReason = clean(e.error ?? 'complete', 120); s.waitReason = null; }
    else if (['prompt', 'tool-start'].includes(e.kind)) { s.status = 'running'; s.waitReason = null; s.waitNote = null; s.endReason = null; }
    else { s.status = 'waiting'; s.waitReason = e.kind === 'wait' ? 'permission' : 'input'; s.waitNote = e.kind === 'wait' ? clean(e.tool ?? 'Permission requested', 160) : null; s.endReason = null; }
  }
  if (e.kind === 'agent-end' && a) { a.status = e.error ? 'failed' : 'done'; a.endedAt = e.at; }
  if (e.kind === 'agent-start' && a && (a.endedAt === null || e.at > a.endedAt)) { a.status = 'running'; a.endedAt = null; }
  if (e.kind === 'tool-end' && e.tool) {
    const loop = a ?? s.loop!;
    loop.toolCalls++;
    loop.lastTool = clean(e.tool, 120);
    const counts = loop.toolCounts ?? {};
    if (Object.keys(counts).length < 100 || Object.hasOwn(counts, loop.lastTool)) {
      Object.defineProperty(counts, loop.lastTool, { value: (Object.hasOwn(counts, loop.lastTool) ? counts[loop.lastTool] : 0) + 1, enumerable: true, configurable: true, writable: true });
    }
    loop.toolCounts = counts;
    if (e.error && a) a.failure = { class: 'Tool error', at: e.at, tool: clean(e.tool, 120), call: null, exitCode: null, outputTail: [clean(e.error)], evidence: [], explanation: null, retriedAs: null };
  }
  if (e.plan) {
    if (a) a.steps = { done: e.plan.steps.filter((step) => step.state === 'done').length, total: e.plan.steps.length };
    else { s.plan = e.plan; metric('plan'); }
  }
  if (e.context) { (a ?? s).context = e.context; metric('context'); }
  if (e.kind === 'compact') {
    // Compaction is normal context maintenance, not evidence of context exhaustion.
  }
  report.events = ['heartbeat', 'text'].includes(e.kind) ? [] : [{ id: eventId, t: e.at, agentId: a?.id ?? null,
    kind: e.kind === 'end' ? 'end' : e.kind === 'start' ? 'start' : e.error ? 'fail' : e.kind === 'compact' ? 'compact' : 'note',
    text: clean(`${e.engine} ${e.kind}${e.tool ? ` · ${e.tool}` : ''}${e.error ? ` · ${e.error}` : ''}`), data: { engine: e.engine } }];
  // Feed text is transient and only accepted while the viewer lease exists; never checkpoint it.
  delete s.activity;
  for (const agent of report.agents) delete agent.activity;
  const key = a?.id ?? MAIN_LOOP;
  if (s.activityFeed && e.text && fleet.activity.watched(id).includes(key)) {
    (a ?? s).activity = [{ at: e.at, kind: e.kind === 'text' ? 'text' : 'tool', text: clean(e.text, 300) }];
  }
  // Validate before touching usage rows, so an invalid event has no partial database effects.
  const before = validateReport(report);
  if (!before.ok) return before;
  if (e.usage) {
    const u = e.usage;
    fleet.db.db.prepare(`INSERT INTO native_usage (session_id, usage_id, model, agent_id, tokens_json, cost_usd, at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, usage_id) DO UPDATE SET
      model=excluded.model, agent_id=excluded.agent_id, tokens_json=excluded.tokens_json, cost_usd=excluded.cost_usd, at=excluded.at
      WHERE excluded.at >= native_usage.at`).run(id, u.key, u.model ? clean(u.model, 100) : null, a?.id ?? null, JSON.stringify(u.tokens), e.engine === 'copilot' ? null : u.costUsd ?? null, e.at);
    const usages = fleet.db.db.prepare('SELECT * FROM native_usage WHERE session_id = ?').all(id) as unknown as StoredUsage[];
    const totals = (agentId: string | null) => usages.filter((u) => u.agent_id === agentId).reduce((sum, u) => {
      const t: TokenCounts = JSON.parse(u.tokens_json);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) sum[k] += t[k];
      return sum;
    }, zero());
    s.tokens = totals(null);
    for (const agent of report.agents) {
      agent.tokens = totals(agent.id);
      const own = usages.filter((u) => u.agent_id === agent.id);
      agent.costUsdEst = own.length && own.every((u) => u.cost_usd !== null) ? own.reduce((n, u) => n + u.cost_usd!, 0) : null;
    }
    const byModel = new Map<string, ModelUsage>();
    for (const u of usages) {
      if (!u.model) continue;
      const model = `${e.engine}/${u.model}`;
      const entry = byModel.get(model) ?? { model, tier: 'std' as const, tokens: { ...zero(), cacheWrite1h: 0 } };
      const t: TokenCounts = JSON.parse(u.tokens_json);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) entry.tokens[k] += t[k];
      byModel.set(model, entry);
    }
    s.usageByModel = [...byModel.values()].slice(0, 40);
    s.costUsd = usages.every((u) => u.cost_usd !== null) ? usages.reduce((n, u) => n + u.cost_usd!, 0) : null;
    metric('tokens');
    if (s.costUsd !== null) metric('cost');
  }
  const result = validateReport(report);
  if (!result.ok) return result;
  fleet.ingest(result.report, owner);
  delete report.session.activity;
  for (const agent of report.agents) delete agent.activity;
  // Checkpoint only the validated report; unexpected or oversized input never survives a restart.
  const checkpoint = structuredClone(result.report);
  delete checkpoint.session.activity;
  for (const agent of checkpoint.agents) delete agent.activity;
  fleet.db.db.prepare('INSERT INTO native_state (session_id, state_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json')
    .run(id, JSON.stringify({ report: checkpoint, lifecycleAt: state.lifecycleAt }));
  return { ok: true as const, sessionId: id, watch: fleet.activity.watched(id) };
}

class Rejected extends Error {
  constructor(readonly result: { ok: false; error: string; path: string }) { super(result.error); }
}

export function ingestNativeEvent(fleet: Fleet, body: unknown, owner: string | null) {
  try {
    return fleet.db.tx(() => {
      const result = reduceNativeEvent(fleet, body, owner);
      if (!result.ok) throw new Rejected(result);
      return result;
    });
  } catch (err) {
    if (err instanceof Rejected) return err.result;
    throw err;
  }
}
