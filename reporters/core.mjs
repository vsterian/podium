// Shared native reporters. No runtime dependencies and no transcript contents on the wire.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function config() {
  const file = process.env.PODIUM_REPORTER_CONFIG ?? path.join(os.homedir(), '.podium', 'reporters.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let token = '';
  if (cfg.tokenFile) {
    const contents = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    token = contents.startsWith('PODIUM_TOKEN=') || contents.includes('\nPODIUM_TOKEN=')
      ? contents.split('\n').find((l) => l.startsWith('PODIUM_TOKEN='))?.slice(13) ?? '' : contents;
  }
  const url = new URL(cfg.serverUrl ?? 'http://127.0.0.1:4317');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid reporter serverUrl');
  return { ...cfg, serverUrl: url.origin, token };
}

export function redact(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|pdm_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

const number = (v) => Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
export function tokens(t = {}, inclusiveCache = false) {
  const cacheRead = number(t.cacheRead ?? t.cacheReadTokens ?? t.cached_input_tokens ?? t.cache?.read);
  return { input: Math.max(0, number(t.input ?? t.inputTokens ?? t.input_tokens) - (inclusiveCache ? cacheRead : 0)),
    output: number(t.output ?? t.outputTokens ?? t.output_tokens), cacheRead,
    cacheWrite: number(t.cacheWrite ?? t.cacheWriteTokens ?? t.cache?.write) };
}

export function plan(steps) {
  if (!Array.isArray(steps)) return undefined;
  return { title: null, source: 'podium_plan', steps: steps.slice(0, 100).map((s, i) => ({
    id: String(s.id ?? i), text: redact(s.step ?? s.content ?? s.text ?? s.title ?? '').slice(0, 240),
    state: ['completed', 'done'].includes(s.status) ? 'done' : ['in_progress', 'active'].includes(s.status) ? 'active' : s.status === 'blocked' ? 'blocked' : 'pending',
    activeText: null, ownerAgentId: null, ownerLabel: null,
  })) };
}

function args(v) { try { return typeof v === 'string' ? JSON.parse(v) : v ?? {}; } catch { return {}; } }
function toolPlan(name, input) {
  const a = args(input);
  return ['update_plan', 'update_todo', 'TodoWrite', 'todowrite'].includes(name) ? plan(a.plan ?? a.todos) : undefined;
}

/** Return allowlisted metadata only. Never forward an arbitrary native event or reasoning. */
export function hookEvents(engine, p, eventName) {
  const name = p.hook_event_name ?? eventName;
  const map = { sessionStart: 'start', SessionStart: 'start', sessionEnd: 'end', SessionEnd: 'end',
    userPromptSubmitted: 'prompt', UserPromptSubmit: 'prompt', agentStop: 'idle', Stop: 'idle', Interrupt: 'idle',
    preToolUse: 'tool-start', PreToolUse: 'tool-start', postToolUse: 'tool-end', PostToolUse: 'tool-end',
    postToolUseFailure: 'tool-end', PostToolUseFailure: 'tool-end', subagentStart: 'agent-start', SubagentStart: 'agent-start',
    subagentStop: 'agent-end', SubagentStop: 'agent-end', PermissionRequest: 'wait', notification: 'wait', Notification: 'wait',
    PostCompact: 'compact', errorOccurred: 'error' };
  const kind = map[name];
  const sessionId = p.session_id ?? p.sessionId;
  if (!kind || !sessionId) return [];
  if (kind === 'wait' && name !== 'PermissionRequest' && !/permission|elicitation|idle/i.test(p.notification_type ?? p.notificationType ?? '')) return [];
  const tool = p.tool_name ?? p.toolName;
  const response = p.tool_response ?? p.tool_result ?? p.toolResult;
  const output = typeof response === 'string' ? response : response?.text_result_for_llm ?? response?.textResultForLlm ?? '';
  const exit = /(?:Process exited with code|exit[_ ]code[:=]?)\s*(-?\d+)/i.exec(output);
  const error = p.error ?? (kind === 'tool-end' && exit && Number(exit[1]) !== 0 ? `Process exited with code ${exit[1]}` : undefined);
  const agentId = p.agent_id ?? p.agentId;
  // Some Copilot versions expose only a type at subagent start: do not invent a unique agent identity.
  if (kind.startsWith('agent-') && !agentId) return [];
  return [{ sessionId, kind, cwd: p.cwd, model: p.model, effort: p.effort,
    agentId, parentId: p.parent_agent_id ?? p.parentAgentId, agentType: p.agent_type ?? p.agentType ?? p.agentName,
    tool, toolId: p.tool_use_id, error: typeof error === 'string' ? error : error ? 'Tool failed' : undefined,
    plan: toolPlan(tool, p.tool_input ?? p.toolArgs),
    at: typeof p.timestamp === 'number' ? p.timestamp : Date.parse(p.timestamp) || Date.now(),
    id: randomUUID() }];
}

export function copilotEvents(event, sessionId) {
  const d = event.data ?? {};
  const base = { sessionId, id: event.id ?? randomUUID(), at: Date.parse(event.timestamp) || Date.now() };
  const out = (kind, fields = {}) => [{ ...base, kind, ...fields }];
  switch (event.type) {
    case 'session.start': return out('start', { cwd: d.context?.cwd, model: d.selectedModel, effort: d.reasoningEffort, engineVersion: d.copilotVersion });
    case 'session.model_change': return out('metadata', { model: d.newModel, effort: d.reasoningEffort });
    case 'user.message': return out('prompt');
    case 'session.idle': return out('idle');
    case 'session.shutdown': return out('end', { error: d.errorReason });
    case 'session.error': return out('error', { error: d.message ?? d.errorType ?? 'Session error' });
    case 'tool.execution_start': return out('tool-start', { tool: d.toolName, toolId: d.toolCallId, agentId: d.agentId ?? d.parentToolCallId });
    case 'tool.execution_complete': return out('tool-end', { tool: d.toolName, toolId: d.toolCallId, agentId: d.agentId ?? d.parentToolCallId,
      error: d.success === false ? d.error?.message ?? 'Tool failed' : undefined, plan: toolPlan(d.toolName, d.arguments) });
    case 'assistant.usage': return out('usage', { agentId: d.agentId ?? d.parentToolCallId, model: d.model,
      usage: { key: event.id ?? base.id, model: d.model ?? null, tokens: tokens(d), costUsd: null } });
    case 'session.usage_info': return out('context', { context: { tokens: d.currentTokens ?? null, window: d.tokenLimit ?? null,
      percent: d.tokenLimit ? 100 * d.currentTokens / d.tokenLimit : null } });
    case 'subagent.started': return d.toolCallId ? out('agent-start', { agentId: d.toolCallId, agentType: d.agentName }) : [];
    case 'subagent.completed': case 'subagent.failed': return d.toolCallId ? out('agent-end', { agentId: d.toolCallId, model: d.model, error: event.type.endsWith('failed') ? 'Agent failed' : undefined }) : [];
    case 'session.compaction_complete': return out('compact');
    default: return [];
  }
}

export function opencodeEvents(event) {
  const p = event.properties ?? {};
  const info = p.info ?? {};
  const part = p.part ?? {};
  const sessionId = p.sessionID ?? info.sessionID ?? info.id ?? part.sessionID;
  if (!sessionId) return [];
  const base = { sessionId, at: Date.now() };
  const out = (kind, fields = {}) => {
    const value = { ...base, kind, ...fields };
    // Message/part updates are snapshots: equal updates must not count twice.
    value.id = event.type === 'message.part.updated' ? createHash('sha256').update(JSON.stringify({ ...value, at: undefined })).digest('hex') : randomUUID();
    return [value];
  };
  switch (event.type) {
    case 'session.created': return info.parentID
      ? [{ ...base, sessionId: info.parentID, kind: 'agent-start', agentId: info.id, agentType: 'OpenCode subagent', id: `child:${info.id}:start` }]
      : out('start', { cwd: info.directory, name: info.title });
    case 'session.updated': return info.parentID ? [] : out('metadata', { cwd: info.directory, name: info.title });
    case 'session.deleted': return out('end');
    case 'session.status': return out(p.status?.type === 'busy' ? 'prompt' : 'idle');
    case 'session.idle': return out('idle');
    case 'session.error': return out('error', { error: p.error?.data?.message ?? p.error?.name ?? 'Session error' });
    case 'permission.asked': return out('wait', { tool: p.permission });
    case 'permission.replied': return out('prompt');
    case 'todo.updated': return out('plan', { plan: plan(p.todos) });
    case 'session.compacted': return out('compact');
    case 'message.updated':
      if (info.role !== 'assistant') return [];
      return out(info.finish === 'stop' ? 'idle' : 'usage', { model: `${info.providerID}/${info.modelID}`, usage: { key: info.id,
        model: `${info.providerID}/${info.modelID}`, tokens: tokens(info.tokens), costUsd: typeof info.cost === 'number' ? info.cost : null } });
    case 'message.part.updated':
      if (part.type !== 'tool' || !['running', 'completed', 'error'].includes(part.state?.status)) return [];
      return out(part.state.status === 'running' ? 'tool-start' : 'tool-end', {
        tool: part.tool, toolId: part.callID, error: part.state.status === 'error' ? part.state.error : undefined,
        plan: toolPlan(part.tool, part.state.input),
      });
    default: return [];
  }
}

export function gitInfo(cwd) {
  try {
    const run = (...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = run('branch', '--show-current');
    return { branch: branch || null, detached: !branch, isWorktree: run('rev-parse', '--git-dir') !== '.git', worktreePath: null,
      ahead: 0, behind: 0, dirty: run('status', '--porcelain').split('\n').filter(Boolean).length };
  } catch { return undefined; }
}

export class Reporter {
  constructor(engine, mode, options = config(), fetcher = fetch) {
    this.engine = engine; this.mode = mode; this.options = options; this.fetch = fetcher;
    this.watch = new Map(); this.sessions = new Set(); this.pending = []; this.sending = null; this.warned = false;
  }
  async emit(event) {
    if (!event?.sessionId) return;
    const input = { ...event, engine: this.engine, mode: this.mode, id: event.id ?? randomUUID(), at: event.at ?? Date.now(),
      userName: this.options.userName, activityFeed: this.options.activityFeed === true };
    const sanitize = (v) => typeof v === 'string' ? redact(v, [this.options.token]).slice(0, 1024)
      : Array.isArray(v) ? v.map(sanitize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, sanitize(x)])) : v;
    const value = sanitize(input);
    if (!this.options.activityFeed || !this.watch.get(input.sessionId)?.includes(input.agentId ?? '@orchestrator')) delete value.text;
    this.sessions.add(input.sessionId);
    if (input.kind === 'end') this.sessions.delete(input.sessionId);
    // shortcut: retain 200 events in memory during outages; use a durable spool if offline recovery is required.
    if (this.pending.length >= 200) this.pending.shift();
    this.pending.push(value);
    return this.flush();
  }
  async flush() {
    if (this.sending) return this.sending;
    this.sending = this.drain();
    try { await this.sending; } finally { this.sending = null; }
  }
  async drain() {
    while (this.pending.length) {
      const event = this.pending[0];
      try {
        const res = await this.fetch(`${this.options.serverUrl}/api/fleet/event`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.options.token ? { 'X-Podium-Token': this.options.token } : {}) },
          body: JSON.stringify(event), signal: AbortSignal.timeout(1500) });
        if (!res.ok) {
          if ([400, 401, 403, 409, 413].includes(res.status)) this.pending.shift();
          if (!this.warned) { console.error(`podium: ${this.engine} report refused (${res.status})`); this.warned = true; }
          return;
        }
        const reply = await res.json();
        this.watch.set(event.sessionId, reply.watch ?? []);
        this.pending.shift(); this.warned = false;
      } catch {
        if (!this.warned) { console.error(`podium: ${this.engine} reporter offline`); this.warned = true; }
        return;
      }
    }
  }
  heartbeat() {
    const timer = setInterval(() => { for (const sessionId of this.sessions) void this.emit({ sessionId, kind: 'heartbeat' }); }, 5000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
