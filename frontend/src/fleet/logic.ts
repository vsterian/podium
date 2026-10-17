// Pure presentation logic: sorting, filtering, plan progress, agent counts and the agent tree.
import { MAIN_LOOP } from "../../../server/src/fleet/protocol";
import type { AgentView, Effort, ModelFamily, Plan, PlanStep, SessionView } from "./types";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The orchestrator's own row in the agent tree; the same key the server uses for its main loop (MAIN_LOOP). */
export const ORCHESTRATOR_ROW = MAIN_LOOP;

export type SortKey = "status" | "model" | "blow" | "ctx" | "cost" | "newest";
export const SORTS: Record<SortKey, string> = {
  status: "Status",
  model: "Model",
  blow: "Context blowouts",
  ctx: "Context used",
  cost: "Cost",
  newest: "Newest",
};

export type StatusFilter = "all" | "running" | "waiting" | "stale" | "blow";
export const STATUS_FILTERS: Record<StatusFilter, string> = {
  all: "All",
  running: "Running",
  waiting: "Waiting",
  stale: "Stale",
  blow: "Blowouts",
};

/** Model order for sorting: alphabetical by family, unknown models last. */
export const MODEL_ORDER: readonly ModelFamily[] = ["fable", "haiku", "opus", "sonnet", "other"];

const STATUS_ORDER: Record<SessionView["status"], number> = { running: 0, waiting: 1, stale: 2, done: 3 };

function byStatus(a: SessionView, b: SessionView): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
}

function byName(a: SessionView, b: SessionView): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortSessions(list: readonly SessionView[], key: SortKey): SessionView[] {
  const cmp: Record<SortKey, (a: SessionView, b: SessionView) => number> = {
    status: byStatus,
    model: (a, b) => MODEL_ORDER.indexOf(a.modelFamily) - MODEL_ORDER.indexOf(b.modelFamily) || byStatus(a, b),
    blow: (a, b) => b.blowouts.total - a.blowouts.total || byStatus(a, b),
    ctx: (a, b) => (b.context.percent ?? -1) - (a.context.percent ?? -1),
    cost: (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1),
    newest: (a, b) => b.startedAt - a.startedAt,
  };
  const c = cmp[key];
  return list.slice().sort((a, b) => c(a, b) || byName(a, b));
}

export function filterSessions(list: readonly SessionView[], filter: { status: StatusFilter; q: string; engine?: string }): SessionView[] {
  const q = filter.q.trim().toLowerCase();
  return list.filter((s) => {
    if (filter.engine && filter.engine !== "all" && (s.integration?.engine ?? "claude-code") !== filter.engine) return false;
    if (filter.status === "blow") {
      if (!s.blowouts.total) return false;
    } else if (filter.status !== "all" && s.status !== filter.status) return false;
    if (q) {
      const hay = `${s.name}\n${s.project}\n${s.git?.branch ?? ""}\n${s.integration?.engine ?? "claude-code"}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Sessions nobody is attached to stay on the wall, dimmed, until their `hideAt`; after that they are set
 * aside (still live, still counted) unless the person asked to see them. A session that never said whether
 * a client is attached has no `hideAt` and is always shown.
 */
export function splitDetached(list: readonly SessionView[], now: number, showHidden: boolean): { shown: SessionView[]; hidden: SessionView[] } {
  const hidden = list.filter((s) => s.attached === false && s.hideAt !== null && now >= s.hideAt);
  const set = new Set(hidden);
  return { shown: showHidden ? list.slice() : list.filter((s) => !set.has(s)), hidden };
}

export interface PlanProgress {
  done: number;
  total: number;
  pct: number;
}

export function planProgress(plan: Plan | null): PlanProgress | null {
  if (!plan || !plan.steps.length) return null;
  const done = plan.steps.filter((s) => s.state === "done").length;
  return { done, total: plan.steps.length, pct: done / plan.steps.length };
}

/** The step being worked on now: the first active step, its active wording when it has one. */
export function currentStep(plan: Plan | null): string | null {
  const s = plan?.steps.find((x) => x.state === "active");
  return s ? s.text : null;
}

/** Display only: with no step active, the first pending step in plan order, which Claude has yet to mark in progress. Null when a step is active or none is pending. */
export function inferredStep(plan: Plan | null): PlanStep | null {
  if (!plan || plan.steps.some((x) => x.state === "active")) return null;
  return plan.steps.find((x) => x.state === "pending") ?? null;
}

/** A plan with steps, every one of them done. */
export function planComplete(plan: Plan | null): boolean {
  return !!plan && plan.steps.length > 0 && plan.steps.every((x) => x.state === "done");
}

export interface AgentCounts {
  running: number;
  done: number;
  failed: number;
  queued: number;
  aborted: number;
  all: number;
}

export function agentCounts(agents: readonly AgentView[]): AgentCounts {
  const c: AgentCounts = { running: 0, done: 0, failed: 0, queued: 0, aborted: 0, all: agents.length };
  for (const a of agents) {
    if (a.status === "running") c.running++;
    else if (a.status === "done") c.done++;
    else if (a.status === "failed") c.failed++;
    else if (a.status === "queued") c.queued++;
    else c.aborted++;
  }
  return c;
}

/** `agentCounts` with the orchestrator counted too: running while its session is, done once the session is, and neither while it has gone quiet (stale). */
export function sessionCounts(s: SessionView): AgentCounts {
  const c = agentCounts(s.agents);
  if (s.status === "done") c.done++;
  else if (s.status === "stale") c.aborted++;
  else c.running++;
  c.all++;
  return c;
}

export type Guide = "mid" | "last" | "blank";
export interface TreeRow {
  agent: AgentView;
  guides: Guide[];
}

/**
 * Agents nested under their parent, at any depth. Each row carries one guide per level: `last` for the
 * final child at its level (an elbow), `mid` for others (a tee), and above them `blank` where the ancestor
 * at that level was a last child (no line) or `mid` where it was not (a continuing line). An agent whose
 * parent is not in the list is shown at the top level. With `order`, the children of each parent (and the
 * top-level agents) are sorted by it, so a sorted table keeps every child under its parent (#101); without
 * it they stay in launch order.
 */
export function buildTree(agents: readonly AgentView[], order?: (a: AgentView, b: AgentView) => number): TreeRow[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string | null, AgentView[]>();
  for (const a of agents) {
    const p = a.parentId && ids.has(a.parentId) && a.parentId !== a.id ? a.parentId : null;
    const list = kids.get(p) ?? [];
    list.push(a);
    kids.set(p, list);
  }
  if (order) for (const list of kids.values()) list.sort(order);
  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const walk = (pid: string | null, guides: Guide[]) => {
    const ks = kids.get(pid) ?? [];
    ks.forEach((a, i) => {
      if (visited.has(a.id)) return;
      visited.add(a.id);
      const last = i === ks.length - 1;
      rows.push({ agent: a, guides: [...guides, last ? "last" : "mid"] });
      walk(a.id, [...guides, last ? "blank" : "mid"]);
    });
  };
  walk(null, []);
  // Anything unreachable (a parent cycle) still shows, at the top level.
  for (const a of agents) if (!visited.has(a.id)) rows.push({ agent: a, guides: ["last"] });
  return rows;
}

/** How many levels deep the tree goes: 1 when every agent was launched by the orchestrator. */
export function treeDepth(rows: readonly TreeRow[]): number {
  return rows.reduce((n, r) => Math.max(n, r.guides.length), 0);
}

/** Agents in tree order (a parent, then everything under it), for the card's agent strip. */
export function treeOrder(agents: readonly AgentView[]): AgentView[] {
  return buildTree(agents).map((r) => r.agent);
}

/** The agent that launched this one; null when the orchestrator did, or the parent is not in the list. */
export function parentOf(agents: readonly AgentView[], a: AgentView): AgentView | null {
  if (!a.parentId || a.parentId === a.id) return null;
  return agents.find((x) => x.id === a.parentId) ?? null;
}

export interface BranchTotals {
  /** Agents under this one, at every depth (not counting itself). */
  agents: number;
  /** Its own estimated cost plus each one's under it; unpriced agents add nothing and are counted in `unpriced`. */
  costUsd: number;
  unpriced: number;
  /** Its own Tokens figure plus each one's under it (the context each holds now, as the rows show). */
  tokens: number;
}

/** An agent's branch: itself and every agent under it, each counted once, a parent cycle included. */
export function branchTotals(agents: readonly AgentView[], id: string): BranchTotals {
  const kids = new Map<string, AgentView[]>();
  for (const a of agents) {
    if (!a.parentId || a.parentId === a.id) continue;
    const list = kids.get(a.parentId) ?? [];
    list.push(a);
    kids.set(a.parentId, list);
  }
  const out: BranchTotals = { agents: 0, costUsd: 0, unpriced: 0, tokens: 0 };
  const seen = new Set<string>([id]);
  const self = agents.find((a) => a.id === id);
  const queue: AgentView[] = self ? [self] : [];
  while (queue.length) {
    const a = queue.shift()!;
    if (a.id !== id) out.agents++;
    if (a.costUsdEst === null) out.unpriced++;
    else out.costUsd += a.costUsdEst;
    out.tokens += agentTokens(a);
    for (const k of kids.get(a.id) ?? []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      queue.push(k);
    }
  }
  return out;
}

export const COST_HINT_SESSION = "The whole session: the orchestrator and every agent, nested ones included. Claude Code's own figure. The rows in the agent table add up to it, give or take the agents' estimates.";
export const AGENTS_HINT = "Every agent counted once, including those launched by other agents, and the orchestrator itself: running while the session runs, done once it is done.";
export const AGENT_TIME_HINT = "The orchestrator's time plus every agent's own. It can be longer than Running for when agents run at the same time.";
export const COST_HINT_ORCHESTRATOR = "The orchestrator's own share: the session's cost less each agent's estimate. With the agents' rows it adds up to the session figure, unless the estimates overshoot it (then this is $0) or an agent has no price (it counts as $0, so its cost lands here).";
export const COST_HINT_AGENT = "This agent's own estimated cost. The agents it launched are not included; their total is in the side panel.";
export const COST_HINT_HEADER = "An agent's row is its own estimated cost. The orchestrator's row is its own share, the session's cost less the agents', so the rows add up to the session figure.";

/**
 * Rows that are waiting on agents they launched, keyed by agent id (`ORCHESTRATOR_ROW` for the
 * orchestrator): a row whose own status is `running` and that has running direct children. Display-only;
 * Podium cannot tell a foreground launch from a background one, so any running child counts. A child
 * whose parent is missing counts for the orchestrator, as `buildTree` places it at the top level. While the
 * session itself is not `running` (waiting on the user, stale, done) nothing is returned, its own status wins.
 */
export function waitingOnByRow(s: Pick<SessionView, "status" | "agents">): Map<string, AgentView[]> {
  const out = new Map<string, AgentView[]>();
  if (s.status !== "running") return out;
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  for (const a of s.agents) {
    if (a.status !== "running") continue;
    const p = a.parentId && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : ORCHESTRATOR_ROW;
    if (p !== ORCHESTRATOR_ROW && byId.get(p)!.status !== "running") continue;
    const list = out.get(p) ?? [];
    list.push(a);
    out.set(p, list);
  }
  return out;
}

/** The tooltip and screen-reader detail for a delegating row. A string, so memoised rows stay equal between renders. */
export function delegateText(children: readonly AgentView[]): string {
  const n = children.length;
  return `Waiting on ${n} agent${n === 1 ? "" : "s"}: ${children.map((a) => a.description).join(", ")}. Not waiting on you.`;
}

export type AgentSortKey = "model" | "effort" | "ctx" | "tok" | "cost" | "time" | "status";

const AGENT_STATUS_ORDER: Record<AgentView["status"], number> = { running: 0, failed: 1, queued: 2, aborted: 3, done: 4 };

/** What Claude Code's own agent line shows: the context the agent holds now, not a running total (which would count every cache re-read again). */
export function agentTokens(a: AgentView): number {
  return a.context.tokens ?? 0;
}

/** The orchestrator's context plus each agent's, so the rows of one session add up. */
export function sessionTokens(s: SessionView): number {
  if (s.integration) return s.tokensTotal;
  return (s.context.tokens ?? 0) + s.agents.reduce((n, a) => n + agentTokens(a), 0);
}

export const NATIVE_TOKENS_HINT = "Cumulative usage reported by this CLI, including observed agent usage.";

export const TOKENS_HINT = "Tokens in the context window now: input, cache read and cache write of the latest request. The same figure Claude Code shows. A running total is in the side panel.";

export function agentElapsedSec(a: AgentView, now: number): number {
  return Math.max(0, ((a.endedAt ?? now) - a.startedAt) / 1000);
}

/** Default direction when a header is first clicked: names ascend, quantities descend. */
export function defaultAgentDir(key: AgentSortKey): 1 | -1 {
  return key === "model" || key === "effort" || key === "status" ? 1 : -1;
}

/** Compares two agents by a column, ties by id; what `sortAgents` sorts with and `buildTree` orders siblings by. */
export function agentOrder(key: AgentSortKey, dir: 1 | -1, now: number): (a: AgentView, b: AgentView) => number {
  const val: Record<AgentSortKey, (a: AgentView) => number> = {
    model: (a) => MODEL_ORDER.indexOf(a.modelFamily),
    effort: (a) => (a.effort ? EFFORTS.indexOf(a.effort) : -1),
    ctx: (a) => a.context.percent ?? -1,
    tok: agentTokens,
    cost: (a) => a.costUsdEst ?? -1,
    time: (a) => agentElapsedSec(a, now),
    status: (a) => AGENT_STATUS_ORDER[a.status],
  };
  const f = val[key];
  return (a, b) => (f(a) - f(b)) * dir || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortAgents(agents: readonly AgentView[], key: AgentSortKey, dir: 1 | -1, now: number): AgentView[] {
  return agents.slice().sort(agentOrder(key, dir, now));
}

/** Seconds since the session started, frozen once it is done. */
export function sessionElapsedSec(s: SessionView, now: number): number {
  return Math.max(0, ((s.status === "done" ? s.lastSeenAt : now) - s.startedAt) / 1000);
}

/** The orchestrator's time plus every agent's own, so it can pass the wall-clock time when agents run in parallel. */
export function sessionAgentSec(s: SessionView, now: number): number {
  return sessionElapsedSec(s, now) + s.agents.reduce((n, a) => n + agentElapsedSec(a, now), 0);
}

/** The orchestrator's own share of the session's cost: the ledger less each agent's estimate, so the rows add up to it. Null with no ledger figure. */
export function orchestratorCostUsd(s: SessionView): number | null {
  if (s.costUsd === null) return null;
  return Math.max(0, s.costUsd - s.agents.reduce((n, a) => n + (a.costUsdEst ?? 0), 0));
}

/** "fork" or the agent type, then the model's short name and the effort: "Explore · Haiku low". */
export function agentLabel(a: AgentView): string {
  return `${a.kind === "fork" ? "fork" : a.type} · ${familyName(a.modelFamily, a.model)}${a.effort ? ` ${a.effort}` : ""}`;
}

/**
 * The version in a Claude model id, "5.5" for `claude-sonnet-5-5`, "4" for `claude-opus-4-20250514`, "3.5" for
 * `claude-3-5-sonnet-20241022`. Null for an alias (`sonnet`, `opus[1m]`), a non-Claude name and anything with no
 * version digits: it never invents one. Version parts are one or two digits, so a date stamp is not one.
 */
export function modelVersion(model: string | null | undefined): string | null {
  const m = (model ?? "").toLowerCase();
  if (!m.includes("claude")) return null;
  const fam = "(?:opus|sonnet|haiku|fable)";
  const ver = "(\\d{1,2}(?:-\\d{1,2})?)";
  const v = new RegExp(`${fam}-${ver}(?!\\d)`).exec(m)?.[1] ?? new RegExp(`claude-${ver}-${fam}`).exec(m)?.[1];
  return v ? v.replace("-", ".") : null;
}

/** "Sonnet 5.5": the family and, when the id carries one, the version. An alias is the family alone; a non-Claude model its raw name. */
export function familyName(f: ModelFamily, model: string | null): string {
  if (f === "other") return model ?? "unknown";
  const name = f[0]!.toUpperCase() + f.slice(1);
  const v = modelVersion(model);
  return v ? `${name} ${v}` : name;
}

/** When a heartbeat-lost session goes away by itself: the server's `dropAt`, else counted from the last heartbeat. */
export function dropAtOf(s: Pick<SessionView, "dropAt" | "lastSeenAt">, config: { staleAfterMs: number; dropAfterMs: number }): number {
  return s.dropAt ?? s.lastSeenAt + config.staleAfterMs + config.dropAfterMs;
}

/** True for a mod older than 0.<minor>. A hooks session has no mod to update, and an unparsable version says nothing. */
export function reporterBelow(s: Pick<SessionView, "reporter" | "reporterVersion">, minor: number): boolean {
  if (s.reporter !== "mod" || !s.reporterVersion) return false;
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(s.reporterVersion);
  return m !== null && m[1] === "0" && Number(m[2]) < minor;
}
