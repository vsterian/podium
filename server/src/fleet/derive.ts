// Pure derivation (SPEC 7.3, 7.4): SessionView, blowout level, series, KPIs. No I/O here: callers
// pass rows in and get views out, so every rule is unit-tested without a database.
import type { AgentRow, BlowoutRow, EventRow, SampleRow, SessionRow } from './db.js';
import { checkReporter } from './compat.js';
import { idleOnBackground } from './protocol.js';
import { tokenSum } from './ingest.js';
import type { ModelUsage, Pricing } from './pricing.js';
import type {
  ActivityView,
  AgentView,
  AskSummary,
  BackgroundWait,
  EventKind,
  Failure,
  FilesReport,
  GitInfo,
  Kpis,
  LoopReport,
  MachineInfo,
  ModelFamily,
  OwnerSpend,
  Plan,
  RespondInfo,
  SessionStatusView,
  SessionView,
} from './protocol.js';

export const SERIES_POINTS = 60;

/** Model family by case-insensitive substring, for Claude models only (SPEC 6.5); mirrors the mod. */
export function family(model: string | null | undefined): ModelFamily {
  const m = (model ?? '').toLowerCase();
  if (!/^(opus|sonnet|haiku|fable|opusplan)(\[[^\]]*\])?$/.test(m) && !m.includes('claude')) return 'other';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'other';
}

/**
 * 0: no blowout anywhere. 2 ("likely losing context"): the orchestrator has 2 or more, any single
 * agent has 2 or more, or the total is 3 or more. 1 ("context exceeded"): anything else above zero.
 */
export function blowoutLevel(orchestrator: number, agents: readonly number[]): 0 | 1 | 2 {
  const total = orchestrator + agents.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  if (orchestrator >= 2 || agents.some((n) => n >= 2) || total >= 3) return 2;
  return 1;
}

/** Replaces a leading home directory with `~`. */
export function shortenHome(p: string, home: string): string {
  if (!home) return p;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (p === h) return '~';
  if (p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return p;
}

/** Quotes a path for a POSIX shell when it holds anything but safe characters. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function resumeCommand(cwd: string, resumeId: string | null, id: string, integration?: SessionView['integration']): string {
  const native = shellQuote(integration?.nativeId ?? resumeId ?? id);
  const engine = integration?.engine;
  const command = engine === 'codex' ? `codex resume ${native}` : engine === 'copilot' ? `copilot --resume ${native}` : engine === 'opencode' ? `opencode --session ${native}` : `claude --resume ${native}`;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * A stored cost, repriced from the per-model usage the reporter sent (issue #117). A row with no usage, from an
 * older reporter, or whose usage holds a model nobody priced, keeps the cost it was stored with.
 */
export function repriced(pricing: Pricing | undefined, usageJson: string | null, stored: number | null): number | null {
  if (!pricing || !usageJson) return stored;
  const usage = parse<ModelUsage[] | null>(usageJson, null);
  if (!usage?.length) return stored;
  return pricing.costOf(usage) ?? stored;
}

export function agentView(a: AgentRow, pricing?: Pricing): AgentView {
  return {
    id: a.id,
    parentId: a.parent_id,
    kind: a.kind as AgentView['kind'],
    type: a.type,
    name: a.name,
    description: a.description,
    model: a.model,
    effort: a.effort as AgentView['effort'],
    effortSource: (a.effort_source ?? 'unknown') as AgentView['effortSource'],
    status: a.status as AgentView['status'],
    startedAt: a.started_at,
    endedAt: a.ended_at,
    context: { tokens: a.context_tokens, window: a.context_window, percent: a.context_percent },
    tokens: { input: a.tok_in, output: a.tok_out, cacheRead: a.tok_cr, cacheWrite: a.tok_cw },
    costUsdEst: repriced(pricing, a.usage_json, a.cost_usd_est),
    skills: parse<string[]>(a.skills_json, []),
    lastTool: a.last_tool,
    toolCalls: a.tool_calls,
    toolCounts: parse<Record<string, number> | null>(a.tool_counts_json, null),
    blowouts: a.blowouts,
    steps: a.steps_done === null ? null : { done: a.steps_done, total: a.steps_total },
    promptExcerpt: a.prompt_excerpt ?? '',
    answerExcerpt: a.answer_excerpt,
    promptChars: a.prompt_chars ?? null,
    answerChars: a.answer_chars ?? null,
    failure: parse<Failure | null>(a.failure_json, null),
    modelFamily: family(a.model),
  };
}

/**
 * The last whole second before `now`: the newest series point. The second in progress is left out
 * because its sample is still partial (it would always read as a dip).
 */
export function lastCompleteSecond(now: number): number {
  return Math.floor(now / 1000) - 1;
}

/** Sixty one-second points ending at the last complete second, oldest first, missing seconds zero-filled. */
export function buildSeries(samples: readonly SampleRow[], blowouts: readonly Pick<BlowoutRow, 't'>[], now: number): SessionView['series'] {
  const endSec = lastCompleteSecond(now);
  const first = endSec - (SERIES_POINTS - 1);
  const tokensPerSec = new Array<number>(SERIES_POINTS).fill(0);
  const peakContext = new Array<number>(SERIES_POINTS).fill(0);
  const running = new Array<number>(SERIES_POINTS).fill(0);
  for (const s of samples) {
    const i = s.t - first;
    if (i < 0 || i >= SERIES_POINTS) continue;
    tokensPerSec[i] = Math.max(0, s.tokens_delta);
    peakContext[i] = Math.max(0, Math.min(1, s.peak_context));
    running[i] = Math.max(0, s.running_agents);
  }
  // Age counts back from the newest point; a blowout in the second in progress counts as age 0.
  const blowoutSecondsAgo = blowouts
    .map((b) => endSec - Math.floor(b.t / 1000))
    .filter((age) => age >= -1 && age < SERIES_POINTS)
    .map((age) => Math.max(0, age))
    .sort((a, b) => a - b);
  return { tokensPerSec, peakContext, running, blowoutSecondsAgo };
}

export interface DeriveConfig {
  staleAfterMs: number;
  /** For sessions known only from settings hooks (no heartbeat); falls back to `staleAfterMs`. */
  hookStaleAfterMs?: number;
  home: string;
}

/**
 * A session that has done nothing yet: not running, and no tokens, cost, context, blowouts, agents or
 * plan. Claude Code's daemon runs such sessions nobody asked for (a parked twin of an interactive window,
 * a pre-warmed spare), and each reports through the mod. They stay off the wall until they do something.
 * Hook-only sessions are never unused: hooks carry no usage, so they could never leave this state.
 * `agentCount` may be a function, so the lookup runs only for a row that passes every other test.
 */
export function isUnused(row: SessionRow, agentCount: number | (() => number)): boolean {
  return (
    !row.integration_json &&
    row.reporter_version !== 'hooks' &&
    row.status !== 'running' &&
    !row.cost_usd &&
    tokenSum(row) === 0 &&
    !row.context_tokens &&
    row.blowouts === 0 &&
    row.plan_json === null &&
    (typeof agentCount === 'function' ? agentCount() : agentCount) === 0
  );
}

/** How long a session may stay silent before it shows as stale: hook-only sessions have no heartbeat. */
export function staleAfterFor(row: SessionRow, cfg: DeriveConfig): number {
  return row.reporter_version === 'hooks' || parse<SessionView['integration']>(row.integration_json ?? null, undefined)?.mode === 'hooks' ? (cfg.hookStaleAfterMs ?? cfg.staleAfterMs) : cfg.staleAfterMs;
}

export interface SessionInput {
  row: SessionRow;
  agents: readonly AgentRow[];
  blowouts: readonly BlowoutRow[];
  samples: readonly SampleRow[];
  /** False until the session reports after a server start: such a session shows as stale. */
  heard: boolean;
  /** From the fleet, which knows the drop window and when the server started. Null when not stale. */
  dropAt?: number | null;
  /** From the fleet, which knows the delay. Null while a client is attached or the reporter does not say. */
  hideAt?: number | null;
  /** From the people table: the group the session's owner is in. */
  ownerGroup?: string | null;
  /** The Admin's prices; a cost is repriced from the usage the reporter sent. */
  pricing?: Pricing;
  /** Whether the reporter has the activityFeed option on, from the activity store; null when unknown. */
  activityFeed?: boolean | null;
  /** Report.session.respond as last reported (#206), held in memory; null when unknown. */
  respond?: RespondInfo | null;
  /** The session's asks without their content, from the respond store. */
  asks?: AskSummary[];
}

export function sessionStatus(row: SessionRow, heard: boolean, now: number, staleAfterMs: number): SessionStatusView {
  if (row.status === 'done') return 'done';
  if (!heard || now - row.last_seen_at > staleAfterMs) return 'stale';
  return row.status;
}

export function sessionView(input: SessionInput, now: number, cfg: DeriveConfig): SessionView {
  const { row } = input;
  const agents = input.agents.map((a) => agentView(a, input.pricing));
  const agentBlows = agents.map((a) => a.blowouts);
  const agentTotal = agentBlows.reduce((a, b) => a + b, 0);
  return {
    id: row.id,
    name: row.name,
    ...(row.integration_json ? { integration: JSON.parse(row.integration_json) } : {}),
    reporter: row.reporter_version === 'hooks' ? 'hooks' : 'mod',
    reporterVersion: row.reporter_version === 'hooks' ? null : row.reporter_version,
    compat: row.integration_json || row.reporter_version === 'hooks' ? 'unknown' : checkReporter(row.reporter_version),
    project: shortenHome(row.project_root ?? row.cwd, cfg.home),
    cwd: shortenHome(row.cwd, cfg.home),
    repoName: row.repo_name,
    resumeCommand: resumeCommand(row.cwd, row.resume_id, row.id, parse(row.integration_json ?? null, undefined)),
    git: parse<GitInfo | null>(row.git_json, null),
    model: row.model,
    modelFamily: family(row.model),
    effort: row.effort,
    status: sessionStatus(row, input.heard, now, staleAfterFor(row, cfg)),
    waitReason: row.wait_reason === 'permission' || row.wait_reason === 'input' ? row.wait_reason : null,
    waitNote: row.wait_note,
    endReason: row.end_reason,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    secondsSinceSeen: Math.max(0, Math.floor((now - row.last_seen_at) / 1000)),
    dropAt: input.dropAt ?? null,
    context: { tokens: row.context_tokens, window: row.context_window, percent: row.context_percent },
    costUsd: repriced(input.pricing, row.usage_json, row.cost_usd),
    tokensTotal: tokenSum(row) + input.agents.reduce((n, a) => n + tokenSum(a), 0),
    blowouts: {
      orchestrator: row.blowouts,
      agents: agentTotal,
      total: row.blowouts + agentTotal,
      level: blowoutLevel(row.blowouts, agentBlows),
      loopsHit: (row.blowouts > 0 ? 1 : 0) + agentBlows.filter((n) => n > 0).length,
      loopsTotal: agents.length + 1,
      log: input.blowouts.map((b) => ({
        t: b.t,
        agentId: b.agent_id,
        kind: b.kind,
        tokensBefore: b.tokens_before,
        tokensAfter: b.tokens_after,
      })),
    },
    plan: parse<Plan | null>(row.plan_json, null),
    loop: parse<LoopReport | null>(row.loop_json, null),
    files: parse<FilesReport | null>(row.files_json, null),
    background: parse<BackgroundWait | null>(row.background_json, null),
    attached: row.attached === null ? null : row.attached === 1,
    hideAt: input.hideAt ?? null,
    owner: row.owner,
    ownerGroup: input.ownerGroup ?? null,
    machine: parse<MachineInfo | null>(row.machine_json, null),
    activityFeed: input.activityFeed ?? null,
    respond: input.respond ?? null,
    asks: input.asks ?? [],
    clearedFrom: row.cleared_from ?? null,
    agents,
    series: buildSeries(input.samples, input.blowouts, now),
  };
}

export function activityView(e: EventRow, session: { name: string; model: string | null } | undefined): ActivityView {
  return {
    id: e.id,
    sessionId: e.session_id,
    sessionName: session?.name ?? 'session',
    modelFamily: family(session?.model),
    agentId: e.agent_id,
    t: e.t,
    kind: e.kind as EventKind,
    text: e.text,
    data: parse<Record<string, unknown> | null>(e.data_json, null),
  };
}

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface KpiInput {
  views: readonly SessionView[];
  /** Σ cost_usd of every session (live or ended) that started today. */
  costToday: number;
  /** Fleet Σ tokens_delta per second. */
  tokensPerSecond: readonly { t: number; v: number }[];
  /** Fleet cost added per minute (minute = floor(seconds / 60)). */
  costPerMinute: readonly { m: number; v: number }[];
  /** `costToday` split by owner, largest first. */
  costTodayByOwner?: readonly OwnerSpend[];
}

export function computeKpis(input: KpiInput, now: number): Kpis {
  const k: Kpis = {
    live: input.views.length,
    running: 0,
    waiting: 0,
    stale: 0,
    agentsRunning: 0,
    agentsTotal: 0,
    planDone: 0,
    planTotal: 0,
    costToday: input.costToday,
    unpricedSessions: 0,
    tokensLastMinute: 0,
    blowoutsTotal: 0,
    sessionsAtLevel2: 0,
    costPerMinute: new Array<number>(SERIES_POINTS).fill(0),
    tokensPerSec: new Array<number>(SERIES_POINTS).fill(0),
    costTodayByOwner: (input.costTodayByOwner ?? []).map((r) => ({ ...r })),
  };
  for (const v of input.views) {
    if (v.status === 'running') k.running++;
    // A session idle on background work is not waiting on the person (#119).
    else if (v.status === 'waiting' && !idleOnBackground(v)) k.waiting++;
    else if (v.status === 'stale') k.stale++;
    k.agentsTotal += v.agents.length;
    k.agentsRunning += v.agents.filter((a) => a.status === 'running').length;
    if (v.plan) {
      k.planTotal += v.plan.steps.length;
      k.planDone += v.plan.steps.filter((s) => s.state === 'done').length;
    }
    // Unpriced means a non-Claude model nobody has priced: once the Admin does, the session has a cost and drops out.
    if (v.integration && !v.integration.metrics.includes('tokens')) k.incompleteSessions = (k.incompleteSessions ?? 0) + 1;
    if ((v.integration || (v.modelFamily === 'other' && v.model)) && v.costUsd === null) k.unpricedSessions++;
    k.blowoutsTotal += v.blowouts.total;
    if (v.blowouts.level === 2) k.sessionsAtLevel2++;
  }
  const endSec = lastCompleteSecond(now);
  const firstSec = endSec - (SERIES_POINTS - 1);
  for (const { t, v } of input.tokensPerSecond) {
    const i = t - firstSec;
    if (i >= 0 && i < SERIES_POINTS) k.tokensPerSec[i] = v;
  }
  k.tokensLastMinute = k.tokensPerSec.reduce((a, b) => a + b, 0);
  const nowMin = Math.floor(now / 60_000);
  const firstMin = nowMin - (SERIES_POINTS - 1);
  for (const { m, v } of input.costPerMinute) {
    const i = m - firstMin;
    if (i >= 0 && i < SERIES_POINTS) k.costPerMinute[i] = v;
  }
  return k;
}
