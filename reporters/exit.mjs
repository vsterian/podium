// OpenCode can terminate before asynchronous plugin callbacks drain. Run only during process exit.
import { Reporter, config } from './core.mjs';

try {
  let input = '';
  for await (const part of process.stdin) { input += part; if (input.length > 1024 * 1024) throw new Error('exit queue too large'); }
  const data = JSON.parse(input);
  const reporter = new Reporter('opencode', 'plugin', config());
  reporter.pending = Array.isArray(data.events) ? data.events.slice(0, 200) : [];
  for (const sessionId of (Array.isArray(data.sessions) ? data.sessions : []).slice(0, 200)) await reporter.emit({ sessionId, kind: 'end' });
  await reporter.flush();
} catch { /* Exit reporting is advisory, including when the server is offline. */ }
