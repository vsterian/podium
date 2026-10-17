#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, Reporter, hookEvents, tokens, gitInfo } from './core.mjs';

/** Bounded, opt-in metadata extraction. Transcript formats are not public stable APIs. */
export function transcriptEvents(engine, file, sessionId) {
  if (!file || !path.isAbsolute(file)) return [];
  const fd = fs.openSync(file, 'r');
  let lines;
  try {
    if (!fs.fstatSync(fd).isFile()) return [];
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 512 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    lines = buffer.toString('utf8').split('\n');
    if (offset) lines.shift();
  } finally { fs.closeSync(fd); }
  const events = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (engine === 'codex') {
      if (record.type === 'session_meta' && record.payload?.id && record.payload.id !== sessionId) return [];
      if (record.type === 'turn_context' && record.payload?.model) events.push({ kind: 'metadata', model: record.payload.model, effort: record.payload.effort });
      const p = record.type === 'event_msg' && record.payload?.type === 'token_count' ? record.payload : null;
      if (!p?.info?.total_token_usage) continue;
      const info = p.info;
      const current = info.last_token_usage?.input_tokens;
      events.push({ kind: 'usage', usage: { key: 'codex:cumulative', model: null, tokens: tokens(info.total_token_usage, true) },
        context: { tokens: current ?? null, window: info.model_context_window ?? null,
          percent: current != null && info.model_context_window ? 100 * current / info.model_context_window : null } });
    } else if (engine === 'copilot') {
      if (record.type === 'session.start' && record.data?.sessionId && record.data.sessionId !== sessionId) return [];
      if (record.type === 'session.start') events.push({ kind: 'metadata', model: record.data?.selectedModel, effort: record.data?.reasoningEffort });
      if (record.type === 'session.model_change') events.push({ kind: 'metadata', model: record.data?.newModel, effort: record.data?.reasoningEffort });
      // Live assistant.usage is ephemeral. Only use persisted shutdown totals, never invent live totals.
      if (record.type === 'session.shutdown') for (const [model, metrics] of Object.entries(record.data?.modelMetrics ?? {})) {
        events.push({ kind: 'usage', model, usage: { key: `copilot:shutdown:${model}`, model, tokens: tokens(metrics.usage), costUsd: null } });
      }
    }
  }
  // A cumulative snapshot supersedes earlier snapshots; read a bounded tail, not the conversation.
  const latest = new Map();
  for (const event of events) latest.set(event.usage?.key ?? event.kind, event);
  return [...latest.values()].map((e) => ({ ...e, sessionId }));
}

export async function main(engine, eventName, stdin = process.stdin) {
  if (!['codex', 'copilot'].includes(engine)) return;
  let input = '';
  for await (const part of stdin) {
    input += part;
    if (Buffer.byteLength(input) > 1024 * 1024) return;
  }
  const payload = JSON.parse(input);
  const cfg = config();
  const reporter = new Reporter(engine, 'hooks', cfg);
  for (const event of hookEvents(engine, payload, eventName)) {
    if (event.kind === 'start' && event.cwd) event.git = gitInfo(event.cwd);
    await reporter.emit(event);
  }
  if (cfg.enrichment === true) {
    const sessionId = payload.session_id ?? payload.sessionId;
    // Only paths handed to this hook for this session; no discovery or historical scans.
    const file = payload.transcript_path ?? payload.transcriptPath;
    if (sessionId && file) {
      try { for (const event of transcriptEvents(engine, file, sessionId)) await reporter.emit(event); }
      catch { console.error('podium: transcript metadata unavailable'); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Observability must never block, approve, deny or inject context into a CLI session.
  main(process.argv[2], process.argv[3]).catch(() => console.error('podium: hook metadata unavailable'));
}
