import { config, Reporter, opencodeEvents, gitInfo } from '../core.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PodiumReporter = async ({ directory }) => {
  let reporter;
  try { reporter = new Reporter('opencode', 'plugin', config()); }
  catch { return {}; }
  const stop = reporter.heartbeat();
  const finish = () => {
    stop();
    if (!reporter.sessions.size && !reporter.pending.length) return;
    // Bun can exit before async callbacks finish; a bounded child flush preserves final events.
    spawnSync('node', [fileURLToPath(new URL('../exit.mjs', import.meta.url))], {
      input: JSON.stringify({ events: reporter.pending, sessions: [...reporter.sessions] }), timeout: 2000, stdio: ['pipe', 'ignore', 'ignore'],
    });
  };
  process.once('exit', finish);
  const parents = new Map();
  return {
    event: async ({ event }) => {
      try {
        if (event.type === 'server.instance.disposed') {
          stop();
          await Promise.all([...reporter.sessions].map((sessionId) => reporter.emit({ sessionId, kind: 'end' })));
          return;
        }
        const info = event.properties?.info;
        if (info?.parentID && info.id) parents.set(info.id, info.parentID);
        for (const value of opencodeEvents(event)) {
          const parent = parents.get(value.sessionId);
          if (parent) { value.agentId = value.sessionId; value.sessionId = parent; }
          value.cwd ??= directory;
          if (value.kind === 'start') value.git = gitInfo(directory);
          if (parent && ['idle', 'end'].includes(value.kind)) value.kind = 'agent-end';
          // Never await network reporting inside the agent loop.
          void reporter.emit(value);
        }
      } catch { /* A telemetry error must not affect OpenCode. */ }
    },
  };
};
