import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
};
function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.podium-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const OWNED = '// Installed by Podium reporter installer.\n';

export function installReporter(action, engine, flags = {}, home = os.homedir()) {
  if (!['install', 'uninstall'].includes(action) || !['codex', 'copilot', 'opencode'].includes(engine)) throw new Error('Usage: podiumctl reporter install|uninstall codex|copilot|opencode [--project PATH]');
  const project = flags.project ? path.resolve(flags.project) : null;
  const runtime = process.env.PODIUMCTL_HOME ?? path.join(home, '.podium');
  const configFile = process.env.PODIUM_REPORTER_CONFIG ?? path.join(runtime, 'reporters.json');
  if (action === 'install') {
    const cfg = read(configFile);
    if (!fs.existsSync(configFile)) write(configFile, JSON.stringify({ serverUrl: 'http://127.0.0.1:4317', tokenFile: path.join(runtime, 'config.env'), enrichment: false, activityFeed: false, ...cfg }, null, 2) + '\n');
  }
  const env = `PODIUM_REPORTER_CONFIG=${quote(configFile)}`;
  const hook = path.join(ROOT, 'hook.mjs');
  if (engine === 'codex') {
    const file = path.join(project ?? process.env.CODEX_HOME ?? path.join(home, '.codex'), project ? '.codex/hooks.json' : 'hooks.json');
    const cfg = read(file);
    cfg.hooks ??= {};
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'PostCompact', 'Stop', 'Interrupt']) {
      const groups = cfg.hooks[event] ?? [];
      const command = `${env} node ${quote(hook)} codex ${event}`;
      const keep = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(`${quote(hook)} codex `)) })).filter((g) => g.hooks.length);
      if (action === 'install') keep.push({ hooks: [{ type: 'command', command, timeout: 3 }] });
      if (keep.length) cfg.hooks[event] = keep; else delete cfg.hooks[event];
    }
    if (action === 'install' || fs.existsSync(file)) write(file, JSON.stringify(cfg, null, 2) + '\n');
    return { engine, config: configFile, files: [file], note: action === 'install' ? 'Review and trust the new hooks with /hooks in Codex; restart existing sessions.' : 'Podium hooks removed; unrelated hooks preserved.' };
  }
  const files = [];
  if (engine === 'copilot') {
    const dir = project ? path.join(project, '.github') : process.env.COPILOT_HOME ?? path.join(home, '.copilot');
    const file = path.join(dir, 'hooks', 'podium-reporter.json');
    const existing = read(file);
    if (fs.existsSync(file) && existing.podiumReporter !== true) throw new Error(`Refusing to replace a file not owned by Podium: ${file}`);
    if (action === 'install') {
      const hooks = {};
      for (const event of ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'subagentStart', 'subagentStop', 'agentStop', 'errorOccurred', 'notification']) {
        hooks[event] = [{ type: 'command', bash: `${env} node ${quote(hook)} copilot ${event}`, timeoutSec: 3 }];
      }
      write(file, JSON.stringify({ version: 1, podiumReporter: true, hooks }, null, 2) + '\n');
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
    files.push(file);
    const extension = path.join(dir, 'extensions', 'podium-reporter', 'extension.mjs');
    ownedFile(extension, action, `process.env.PODIUM_REPORTER_CONFIG ??= ${JSON.stringify(configFile)};\nawait import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'copilot/extension.mjs')).href)});\n`);
    files.push(extension);
  } else {
    const file = project ? path.join(project, '.opencode/plugins/podium-reporter.js')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode/plugins/podium-reporter.js');
    ownedFile(file, action, `export const PodiumReporter = async (ctx) => {\n  process.env.PODIUM_REPORTER_CONFIG ??= ${JSON.stringify(configFile)};\n  const mod = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'opencode/plugin.mjs')).href)});\n  return mod.PodiumReporter(ctx);\n};\n`);
    files.push(file);
  }
  return { engine, config: configFile, files, note: engine === 'copilot' ? 'Restart Copilot. Use --experimental for rich extension telemetry; hooks provide the reduced fallback.' : 'Restart OpenCode to load the plugin.' };
}

function ownedFile(file, action, contents) {
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(OWNED)) throw new Error(`Refusing to replace a file not owned by Podium: ${file}`);
  if (action === 'install') write(file, OWNED + contents);
  else if (fs.existsSync(file)) fs.unlinkSync(file);
}
