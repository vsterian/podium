import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookEvents, copilotEvents, opencodeEvents, plan, tokens, redact, Reporter } from './core.mjs';
import { installReporter } from './install.mjs';
import { transcriptEvents } from './hook.mjs';

const dirs = [];
function temp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-reporter-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('native metadata mapping', () => {
  it('handles Codex failures, plans and subagents without forwarding prompt or reasoning', () => {
    const [e] = hookEvents('codex', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_response: 'Process exited with code 7', prompt: 'private', reasoning: 'private' });
    expect(e).toMatchObject({ kind: 'tool-end', error: 'Process exited with code 7' });
    expect(JSON.stringify(e)).not.toContain('private');
    expect(hookEvents('codex', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'update_plan', tool_input: { plan: [{ step: 'Implement', status: 'in_progress' }] } })[0].plan.steps[0]).toMatchObject({ text: 'Implement', state: 'active' });
    expect(hookEvents('copilot', { sessionId: 's', agentName: 'explore' }, 'subagentStart')).toEqual([]);
    expect(hookEvents('codex', { session_id: 's', agent_id: 'a', agent_type: 'explore' }, 'SubagentStart')[0]).toMatchObject({ kind: 'agent-start', agentId: 'a' });
  });
  it('maps real Copilot SDK event shapes and never treats multiplier as USD', () => {
    const [u] = copilotEvents({ id: 'call', type: 'assistant.usage', data: { model: 'model', inputTokens: 20, outputTokens: 4, cost: 3 } }, 's');
    expect(u.usage.costUsd).toBeNull();
    expect(u.usage.tokens.input).toBe(20);
    expect(copilotEvents({ type: 'subagent.started', data: { toolCallId: 't', agentName: 'explore' } }, 's')[0]).toMatchObject({ agentId: 't', kind: 'agent-start' });
    expect(copilotEvents({ type: 'assistant.reasoning', data: { content: 'secret reasoning' } }, 's')).toEqual([]);
  });
  it('maps OpenCode snapshots, idle transitions and plans', () => {
    const event = { type: 'message.updated', properties: { info: { id: 'm', sessionID: 's', role: 'assistant', modelID: 'model', providerID: 'provider', cost: 0.01, tokens: { input: 10, output: 4, cache: { read: 5, write: 2 } } } } };
    expect(opencodeEvents(event)[0]).toMatchObject({ kind: 'usage', usage: { key: 'm', model: 'provider/model', tokens: { input: 10, cacheRead: 5 } } });
    expect(opencodeEvents({ ...event, properties: { info: { ...event.properties.info, finish: 'stop' } } })[0].kind).toBe('idle');
    const idle = { type: 'session.idle', properties: { sessionID: 's' } };
    expect(opencodeEvents(idle)[0].id).not.toBe(opencodeEvents(idle)[0].id);
    expect(plan([{ content: 'Done', status: 'completed' }]).steps[0].state).toBe('done');
    expect(tokens({ input_tokens: 100, cached_input_tokens: 30 }, true).input).toBe(70);
  });
  it('redacts provider credentials and exact configured token values', () => {
    expect(redact('token=hunter2 Bearer mybearer sk-test_abcdefghijklmnop ghp_abcdefghijklmnop', ['hunter2'])).not.toMatch(/hunter2|mybearer|abcdefghijklmnop/);
  });
});

describe('transport', () => {
  it('sends only redacted allowlisted metadata and hides feed text without a lease', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ watch: [] }) });
    const r = new Reporter('codex', 'hooks', { serverUrl: 'http://127.0.0.1:1', token: 'exact-secret', activityFeed: true }, fetcher);
    await r.emit({ sessionId: 's', kind: 'error', error: 'token=exact-secret', text: 'private activity' });
    const sent = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(sent.error).toContain('[redacted]');
    expect(sent.text).toBeUndefined();
    expect(fetcher.mock.calls[0][1].headers['X-Podium-Token']).toBe('exact-secret');
  });
  it('retains a bounded queue during an outage and retries on the next event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const r = new Reporter('copilot', 'extension', { serverUrl: 'http://127.0.0.1:1' }, fetcher);
    await r.emit({ sessionId: 's', kind: 'start' });
    expect(r.pending).toHaveLength(1);
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ watch: [] }) });
    await r.emit({ sessionId: 's', kind: 'idle' });
    expect(r.pending).toHaveLength(0);
  });
});

describe('install/uninstall', () => {
  it('preserves unrelated hooks and is idempotent for every engine', () => {
    const home = temp();
    const project = temp();
    const hooks = path.join(project, '.codex/hooks.json');
    fs.mkdirSync(path.dirname(hooks));
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }));
    for (const engine of ['codex', 'copilot', 'opencode']) {
      const result = installReporter('install', engine, { project }, home);
      const before = result.files.map((file) => fs.readFileSync(file, 'utf8'));
      installReporter('install', engine, { project }, home);
      expect(result.files.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);
      installReporter('uninstall', engine, { project }, home);
    }
    expect(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo unrelated' }] }]);
  });
  it('refuses to replace a user-owned OpenCode plugin', () => {
    const home = temp(); const project = temp();
    const file = path.join(project, '.opencode/plugins/podium-reporter.js');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'user content');
    expect(() => installReporter('install', 'opencode', { project }, home)).toThrow('not owned');
    expect(fs.readFileSync(file, 'utf8')).toBe('user content');
  });
});

it('extracts only opt-in transcript metadata and handles malformed or partial lines', () => {
  const dir = temp(); const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { id: 's' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 }, last_token_usage: { input_tokens: 50 }, model_context_window: 1000 } } }),
    JSON.stringify({ type: 'response_item', payload: { content: 'raw private prompt' } }), '{partial'].join('\n'));
  const events = transcriptEvents('codex', file, 's');
  expect(events[0]).toMatchObject({ usage: { tokens: { input: 80, cacheRead: 20, output: 5 } }, context: { percent: 5 } });
  expect(JSON.stringify(events)).not.toContain('private');
  expect(transcriptEvents('codex', file, 'another')).toEqual([]);
});
