import { joinSession } from '@github/copilot-sdk/extension';
import { config, Reporter, copilotEvents, gitInfo } from '../core.mjs';

try {
  const reporter = new Reporter('copilot', 'extension', config());
  const session = await joinSession();
  const calls = new Map();
  void reporter.emit({ sessionId: session.sessionId, kind: 'start', cwd: process.cwd(), git: gitInfo(process.cwd()) });
  const stop = reporter.heartbeat();
  session.on((event) => {
    const d = event.data ?? {};
    if (event.type === 'tool.execution_start') calls.set(d.toolCallId, { name: d.toolName, arguments: d.arguments });
    if (event.type === 'tool.execution_complete') {
      const started = calls.get(d.toolCallId);
      event = { ...event, data: { ...d, toolName: d.toolName ?? started?.name, arguments: d.arguments ?? started?.arguments } };
      calls.delete(d.toolCallId);
    }
    for (const value of copilotEvents(event, session.sessionId)) void reporter.emit(value);
    if (event.type === 'assistant.message' && reporter.watch.get(session.sessionId)?.includes('@orchestrator')) {
      void reporter.emit({ sessionId: session.sessionId, kind: 'text', text: d.content });
    }
    if (event.type === 'session.shutdown') stop();
  });
  process.once('SIGTERM', () => {
    stop();
    reporter.emit({ sessionId: session.sessionId, kind: 'end' }).finally(() => process.exit(0));
  });
} catch {
  console.error('podium: Copilot extension unavailable; native hooks can provide reduced monitoring');
}
