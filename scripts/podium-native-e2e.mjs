#!/usr/bin/env node
// Real CLI smoke test. Auth stays in a private temporary directory; evidence contains metadata only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installReporter } from '../reporters/install.mjs';
import { redact, config } from '../reporters/core.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/podium-native-e2e.mjs [--engine codex|copilot|opencode|both|all] [--output FILE] [--copilot-github|--copilot-fixture] [--live-server]\nRequires Node 24 and a built Podium. Runs one harmless tool turn per CLI. OpenCode uses a deterministic local model. Fixture mode does not test backend authentication.');
  process.exit(0);
}
const option = (name, fallback) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const engine = process.argv.includes('--engine') ? option('--engine') : 'both';
if (!['codex', 'copilot', 'opencode', 'both', 'all'].includes(engine)) throw new Error('invalid --engine');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-native-e2e-'));
fs.chmodSync(tmp, 0o700);
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
execFileSync('git', ['init', '-q', work]);
const live = process.argv.includes('--live-server') ? config() : null;
const token = live?.token ?? randomBytes(24).toString('hex');
const secret = path.join(tmp, 'secret');
fs.writeFileSync(secret, token, { mode: 0o600 });
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = live?.serverUrl ?? `http://127.0.0.1:${port}`;
const cfg = path.join(tmp, 'reporters.json');
fs.writeFileSync(cfg, JSON.stringify({ serverUrl: url, tokenFile: secret, enrichment: true }), { mode: 0o600 });
const env = { ...process.env, PODIUM_REPORTER_CONFIG: cfg, PODIUMCTL_HOME: tmp };
const oldConfig = process.env.PODIUM_REPORTER_CONFIG;
process.env.PODIUM_REPORTER_CONFIG = cfg;
const children = [];
const server = live ? null : spawn(process.execPath, ['server/dist/index.js'], { cwd: root,
  env: { ...env, PORT: String(port), HOST: '127.0.0.1', PODIUM_DB: path.join(tmp, 'fleet.sqlite'), PODIUM_TOKEN: token, PODIUM_LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'] });
if (server) children.push(server);
let serverLog = '';
server?.stderr.on('data', (data) => { serverLog = (serverLog + redact(data.toString(), [token])).slice(-4000); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function childExit(child) {
  let timer;
  try {
    return await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 120_000); })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(fn, label, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch { /* startup/network delay */ }
    await pause(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const state = async () => (await fetch(`${url}/api/fleet/state`)).json();
const results = { at: new Date().toISOString(), sessions: [], server: live ? 'configured server' : 'loopback isolated', checks: [] };
let fixture;
try {
  await waitFor(async () => (await fetch(`${url}/api/fleet/health`)).ok, 'server startup', 15_000);
  results.checks.push('server health');
  if (['codex', 'both', 'all'].includes(engine)) {
    const home = path.join(tmp, 'codex'); fs.mkdirSync(home);
    fs.copyFileSync(path.join(os.homedir(), '.codex/auth.json'), path.join(home, 'auth.json'));
    fs.chmodSync(path.join(home, 'auth.json'), 0o600);
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n', { mode: 0o600 });
    const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
    installReporter('install', 'codex');
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    const child = spawn('codex', ['exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', work,
      'This is a telemetry smoke test. Run exactly one shell tool command: pwd. Do not read or edit any files. Then reply PODIUM_E2E_DONE.'],
    { env: { ...env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let log = ''; child.stdout.on('data', (data) => { log = (log + redact(data.toString(), [token])).slice(-8000); });
    child.stderr.on('data', (data) => { log = (log + redact(data.toString(), [token])).slice(-8000); });
    const code = await childExit(child);
    if (code !== 0) throw new Error(`Codex probe failed (${code}): ${log.slice(-2500)}`);
    const session = await waitFor(async () => (await state()).sessions.find((s) => s.cwd === work && s.integration?.engine === 'codex' && s.loop?.toolCalls > 0), 'Codex report');
    if (!session.resumeCommand.includes('codex resume')) throw new Error('wrong Codex resume command');
    if (!session.integration.metrics.includes('tokens')) throw new Error('Codex enrichment missing');
    results.sessions.push({ engine: 'codex', id: session.id, status: session.status, tools: session.loop.toolCalls, tokens: session.tokensTotal, mode: session.integration.mode });
    console.log('PASS Codex: real tool, usage enrichment and native resume command');
  }
  if (['copilot', 'both', 'all'].includes(engine)) {
    const home = path.join(tmp, 'copilot'); fs.mkdirSync(home);
    const userConfig = path.join(os.homedir(), '.copilot/config.json');
    if (!process.argv.includes('--copilot-github') && !process.argv.includes('--copilot-fixture') && fs.existsSync(userConfig)) { fs.copyFileSync(userConfig, path.join(home, 'config.json')); fs.chmodSync(path.join(home, 'config.json'), 0o600); }
    const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
    installReporter('install', 'copilot');
    if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous;
    const copilotEnv = { ...env, COPILOT_HOME: home };
    if (process.argv.includes('--copilot-fixture')) {
      for (const key of Object.keys(copilotEnv)) if (key.startsWith('COPILOT_PROVIDER_') || ['COPILOT_MODEL', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)) delete copilotEnv[key];
      fixture = await modelFixture();
      Object.assign(copilotEnv, { COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: fixture.url,
        COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gpt-4o', COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '128000', COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '2000' });
      results.copilotProvider = 'local deterministic model fixture; backend authentication not tested';
    }
    if (process.argv.includes('--copilot-github')) {
      for (const key of Object.keys(copilotEnv)) if (key.startsWith('COPILOT_PROVIDER_') || key === 'COPILOT_MODEL') delete copilotEnv[key];
      const credential = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com', '--show-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const match = `${credential.stdout}\n${credential.stderr}`.match(/Token:\s*(\S+)/);
      if (credential.status !== 0 || !match) throw new Error('GitHub CLI credential unavailable');
      copilotEnv.COPILOT_GITHUB_TOKEN = match[1];
      results.copilotAuth = 'GitHub CLI credential, isolated environment';
    }
    const child = spawn('copilot', ['-p', 'Telemetry smoke test: run exactly one shell command pwd. Do not read or edit files. Then reply PODIUM_E2E_DONE.',
      '--experimental', '--allow-tool=shell(pwd)', '--disable-builtin-mcps'], { cwd: work, env: copilotEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let log = ''; child.stdout.on('data', (data) => { log = (log + redact(data.toString(), [token])).slice(-8000); });
    child.stderr.on('data', (data) => { log = (log + redact(data.toString(), [token])).slice(-8000); });
    const code = await childExit(child);
    if (code !== 0) throw new Error(`Copilot probe failed (${code}): ${log.slice(-2500)}`);
    const session = await waitFor(async () => (await state()).sessions.find((s) => s.cwd === work && s.integration?.engine === 'copilot' && s.loop?.toolCalls > 0), 'Copilot report');
    if (!session.resumeCommand.includes('copilot --resume')) throw new Error('wrong Copilot resume command');
    if (process.argv.includes('--copilot-fixture') && (session.integration.mode !== 'extension' || session.tokensTotal !== 220)) throw new Error('Copilot extension usage did not match fixture totals');
    results.sessions.push({ engine: 'copilot', id: session.id, status: session.status, tools: session.loop.toolCalls, tokens: session.integration.metrics.includes('tokens') ? session.tokensTotal : null, mode: session.integration.mode });
    console.log(`PASS Copilot: real tool and native resume command (${session.integration.mode})`);
  }
  if (['opencode', 'all'].includes(engine)) {
    fixture ??= await modelFixture();
    installReporter('install', 'opencode', { project: work });
    const opencodeCfg = path.join(tmp, 'opencode.json');
    fs.writeFileSync(opencodeCfg, JSON.stringify({ provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Podium local fixture',
      options: { baseURL: fixture.url }, models: { 'gpt-4o': { name: 'Podium fixture', limit: { context: 128000, output: 2000 } } } } } }), { mode: 0o600 });
    const child = spawn('opencode', ['run', '--format', 'json', '--model', 'fixture/gpt-4o', 'Run pwd once, then reply PODIUM_E2E_DONE.'], {
      cwd: work, env: { ...env, OPENCODE_CONFIG: opencodeCfg, XDG_CONFIG_HOME: path.join(tmp, 'xdg-config'), XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
        XDG_STATE_HOME: path.join(tmp, 'xdg-state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { log = (log + redact(data.toString(), [token])).slice(-8000); });
    const code = await childExit(child);
    if (code !== 0) throw new Error(`OpenCode probe failed (${code}): ${log.slice(-2500)}`);
    const session = await waitFor(async () => (await state()).sessions.find((s) => s.cwd === work && s.integration?.engine === 'opencode' && s.loop?.toolCalls > 0), 'OpenCode report', 10_000);
    if (!session.resumeCommand.includes('opencode --session')) throw new Error('wrong OpenCode resume command');
    if (!session.integration.metrics.includes('tokens')) throw new Error('OpenCode usage missing');
    if (session.status !== 'done') throw new Error('OpenCode final session state was not flushed');
    results.sessions.push({ engine: 'opencode', id: session.id, status: session.status, tools: session.loop.toolCalls, tokens: session.tokensTotal, mode: session.integration.mode });
    results.opencodeProvider = 'local deterministic model fixture; backend authentication not tested';
    console.log('PASS OpenCode: real tool, plugin usage and native resume command');
  }
  const date = new Date().toLocaleDateString('en-CA');
  const history = await (await fetch(`${url}/api/fleet/history?day=${date}`)).json();
  results.checks.push('native session API and bounded telemetry');
  results.historyCount = history.sessions?.length ?? 0;
  results.ok = true;
} catch (err) {
  results.ok = false; results.error = redact(err.message, [token]);
  try { results.observed = (await state()).sessions.map((s) => ({ engine: s.integration?.engine, mode: s.integration?.mode, tools: s.loop?.toolCalls, status: s.status })); } catch {}
  if (serverLog) results.serverError = serverLog;
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await pause(500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
  const output = process.argv.includes('--output') ? path.resolve(option('--output')) : path.join(os.homedir(), '.podium/evidence/native-e2e.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(results, null, 2));
  if (oldConfig === undefined) delete process.env.PODIUM_REPORTER_CONFIG; else process.env.PODIUM_REPORTER_CONFIG = oldConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Two-turn OpenAI-compatible fixture: request pwd once, then finish after its actual tool result. */
async function modelFixture() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-4o', object: 'model' }] })); return; }
      let input = ''; for await (const part of req) { input += part; if (input.length > 2_000_000) throw new Error('fixture input too large'); }
      const body = JSON.parse(input);
      const done = body.messages?.some((m) => m.role === 'tool');
      const tool = body.tools?.find((t) => /^(bash|shell)$/.test(t.function?.name))?.function;
      if (!done && !tool) throw new Error('Copilot did not expose its shell tool');
      const call = { id: 'call_podium_pwd', type: 'function', function: { name: tool?.name ?? 'bash', arguments: JSON.stringify({ command: 'pwd', description: 'Telemetry smoke test', mode: 'sync' }) } };
      const message = done ? { role: 'assistant', content: 'PODIUM_E2E_DONE' } : { role: 'assistant', content: null, tool_calls: [call] };
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } };
      const base = { id: `chatcmpl-podium-${done ? 2 : 1}`, model: 'gpt-4o', created: Math.floor(Date.now() / 1000) };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = (chunk) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...chunk })}\n\n`);
        const delta = done ? { role: 'assistant', content: 'PODIUM_E2E_DONE' } : { role: 'assistant', tool_calls: [{ ...call, index: 0 }] };
        emit({ choices: [{ index: 0, delta, finish_reason: null }] });
        emit({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }], usage });
        res.end('data: [DONE]\n\n');
      } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }], usage })); }
    } catch { res.writeHead(400); res.end('Invalid model-fixture request'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}
