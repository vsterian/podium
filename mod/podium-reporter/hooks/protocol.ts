// Report types for the Podium reporter (SPEC 6.2). Types only.
// The block between the PROTOCOL markers is identical to the one in server/src/fleet/protocol.ts;
// a server test compares the two after whitespace normalization, so edit both together.

// <protocol:begin>
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted';

export type FailureClass =
  | 'Tool error'
  | 'Blocked by permission'
  | 'Model API error'
  | 'Refusal'
  | 'Context window exhausted'
  | 'Aborted'
  | 'Unknown';

export type EventKind =
  | 'start' | 'end' | 'spawn' | 'skill' | 'done' | 'fail' | 'blow' | 'compact' | 'plan' | 'wait' | 'note';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** `cacheWrite` is the 5-minute cache write; `cacheWrite1h` the 1-hour one (0 when the reporter cannot split them). */
export interface UsageTokens extends TokenCounts {
  cacheWrite1h: number;
}

/**
 * One model's token totals, so the server prices them with the Admin's prices (issue #117). `tier` is `long`
 * for requests whose prompt (input + cache reads + cache writes) is over 100,000 tokens.
 */
export interface ModelUsage {
  model: string;
  tier: 'std' | 'long';
  tokens: UsageTokens;
}

export interface ContextFill {
  tokens: number | null;
  window: number | null;
  percent: number | null;
}

export interface GitInfo {
  branch: string | null;
  detached: boolean;
  isWorktree: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
  dirty: number;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file the session changed. `added` and `removed` are null for a binary file. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  added: number | null;
  removed: number | null;
  /** The old path of a renamed file. */
  from: string | null;
}

/**
 * What the session changed in its repository: the files (at most 200, by path) and the totals over
 * all of them. `since` says what the diff is against: the commit HEAD was at when the session began,
 * the merge base with the upstream branch when that commit is gone, or HEAD alone.
 */
export interface FilesReport {
  files: ChangedFile[];
  total: number;
  added: number;
  removed: number;
  since: 'start' | 'upstream' | 'worktree';
}

export interface RateLimit {
  kind: string;
  percentUsed: number;
  resetsAt: string | null;
}

export interface PlanStep {
  id: string;
  text: string;
  state: 'pending' | 'active' | 'done' | 'blocked';
  activeText: string | null;
  ownerAgentId: string | null;
  ownerLabel: string | null;
}

export interface Plan {
  title: string | null;
  source: 'TaskCreate' | 'TodoWrite' | 'podium_plan';
  steps: PlanStep[];
}

export interface Failure {
  class: FailureClass;
  at: number;
  tool: string | null;
  call: string | null;
  exitCode: number | null;
  outputTail: string[];
  evidence: string[];
  explanation: string | null;
  retriedAs: string | null;
}

/**
 * What the orchestrator's main loop reports about its own work, in the shapes an AgentReport uses for
 * the fields of the same name. Calls made by agents it launched are not counted here.
 */
export interface LoopReport {
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;
  steps: { done: number; total: null };
}

/** The loop key of the orchestrator's own feed, in the report reply's `watch` list and the activity route (#118). Engine agent ids never start with `@`. */
export const MAIN_LOOP = '@orchestrator';

/** `reasoning` is reserved for the model's thinking; the reporter does not send it. */
export type ActivityKind = 'tool' | 'text' | 'reasoning';

/**
 * One entry of a loop's activity feed (#118): a tool call (the tool's name, a space, and a short summary of its
 * arguments) or the text the model wrote in one step. Redacted and cut to 300 characters by the reporter. Sent only
 * with the `activityFeed` option on, and only for a loop the server's reply lists as watched.
 */
export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  text: string;
}

export interface AgentReport {
  id: string;
  parentId: string | null;
  kind: 'subagent' | 'fork' | 'teammate';
  type: string;
  name: string | null;
  description: string;
  model: string | null;
  effort: Effort | null;
  effortSource: 'requested' | 'observed' | 'inherited' | 'unknown';
  status: AgentStatus;
  startedAt: number;
  endedAt: number | null;
  context: ContextFill;
  tokens: TokenCounts;
  costUsdEst: number | null;
  /** Tokens per model and prompt-size tier. Absent when the reporter is too old to send it. */
  usageByModel?: ModelUsage[];
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  /** Finished calls per tool name. null when the reporter is too old to send it. */
  toolCounts: Record<string, number> | null;
  blowouts: number;
  steps: { done: number; total: number | null } | null;
  promptExcerpt: string;
  answerExcerpt: string | null;
  /**
   * The whole task prompt and final answer, redacted, line breaks kept. Sent only when the reporter's
   * `fullPrompts` option is on, and only once per text (the server keeps what it was given).
   */
  promptText?: string;
  answerText?: string;
  /** The agent's last 20 activity entries, oldest first: only while someone watches it, with the `activityFeed` option on (0.13.0 and later). */
  activity?: ActivityEntry[];
  failure: Failure | null;
}

export interface ActivityEvent {
  id: string;
  t: number;
  kind: EventKind;
  agentId: string | null;
  text: string;
  data: Record<string, unknown> | null;
}

/** What a session idle between turns is still waiting on: background work in flight, or a scheduled wake-up (#119). */
export type BackgroundKind = 'shell' | 'agent' | 'monitor' | 'workflow' | 'wakeup' | 'other';

export interface BackgroundTask {
  type: BackgroundKind;
  /** A short description; never a whole shell command. */
  description: string;
  status: string;
}

export interface BackgroundWait {
  tasks: BackgroundTask[];
  /** When the next scheduled wake-up fires (epoch ms); null when there is none or its time is unknown. */
  wakeAt: number | null;
}

export interface IntegrationInfo {
  engine: 'claude-code' | 'codex' | 'copilot' | 'opencode';
  nativeId: string;
  mode: 'hooks' | 'extension' | 'plugin';
  metrics: ('tokens' | 'context' | 'cost' | 'plan' | 'agents' | 'blowouts')[];
}

export interface SessionReport {
  /** Absent on legacy Claude reports. Metrics list observed data, not assumed zeroes. */
  integration?: IntegrationInfo;
  id: string;
  name: string;
  status: 'running' | 'waiting' | 'done';
  waitReason: 'permission' | 'input' | null;
  waitNote: string | null;
  endReason: string | null;
  resumeId: string | null;
  startedAt: number;
  cwd: string;
  projectRoot: string | null;
  repoName: string | null;
  git: GitInfo | null;
  model: string | null;
  effort: Effort | null;
  context: ContextFill;
  costUsd: number | null;
  tokens: TokenCounts;
  /** Tokens per model and tier for the whole session, agents included. Absent when the reporter is too old to send it. */
  usageByModel?: ModelUsage[];
  rateLimits: RateLimit[];
  blowouts: number;
  plan: Plan | null;
  /** The main loop's steps, tools and skills. null when the reporter is too old to send it. */
  loop: LoopReport | null;
  /** The files the session changed. null when the reporter is too old to send it. */
  files: FilesReport | null;
  /** Whether any client (a terminal, a phone) is attached. false for a background session left running after /exit. null when unknown: a reporter too old to send it. */
  attached: boolean | null;
  /** Background work the session is idle on. Absent from a reporter older than 0.11.0 and when there is none. */
  background?: BackgroundWait | null;
  /** Whether the reporter's `activityFeed` option is on. Absent from a reporter older than 0.13.0. */
  activityFeed?: boolean;
  /** The main loop's last 20 activity entries, as on an agent: only while someone watches the orchestrator. */
  activity?: ActivityEntry[];
  /** Whether and how far the session can be answered from Podium (#206). Absent from a reporter older than 0.14.0. */
  respond?: RespondInfo;
  /** The asks open now, at most 8; sent only while the last reply said `respond: true`. */
  asks?: Ask[];
  /** The session id this one continues after a /clear (SPEC 5.8). */
  clearedFrom?: string | null;
}

export interface Report {
  v: 1;
  sentAt: number;
  reporter: { name: 'podium-reporter'; version: string; engineVersion: string | null; hostSurface: string | null };
  session: SessionReport;
  agents: AgentReport[];
  events: ActivityEvent[];
  /** The person this reporter is configured as. The server checks it against the token's owner and refuses a mismatch. Omitted or null when none is set. */
  userName?: string | null;
  /** The machine the session runs on. Sent only with a userName, so nothing identifying leaves an unnamed reporter. Omitted or null from a reporter older than 0.9.0. */
  machine?: MachineInfo | null;
}

/** Which machine a session runs on: its host name, and a random id the reporter keeps so two machines with one host name stay apart. */
export interface MachineInfo {
  name: string;
  id: string;
}
/** "1 shell, 1 agent": the counts of a background wait by kind. The activity feed's wait row is read from it. */
export function backgroundSummary(b: BackgroundWait): string {
  const n = new Map<string, number>();
  for (const t of b.tasks) n.set(t.type, (n.get(t.type) ?? 0) + 1);
  return [...n].map(([k, c]) => `${c} ${k}`).join(', ');
}

/** A waiting session whose only wait is on background work or a wake-up, not on the person (#119). */
export function idleOnBackground<T extends { status: string; waitReason: string | null; background?: BackgroundWait | null }>(s: T): s is T & { background: BackgroundWait } {
  return s.status === 'waiting' && s.waitReason === null && !!s.background;
}

// ---- Responding (#206, SPEC 5.3, 6.2, 7.1) --------------------------------------------------

/** The reporter's `respond` option: what this session accepts from Podium. */
export type RespondLevel = 'off' | 'questions' | 'questions-and-plans' | 'everything';
export const RESPOND_LEVELS: readonly RespondLevel[] = ['off', 'questions', 'questions-and-plans', 'everything'];

/** One kind of answer a session can take from Podium. */
export type RespondKind = 'question' | 'plan-approve' | 'plan-feedback' | 'permission' | 'message' | 'command';
export const RESPOND_KINDS: readonly RespondKind[] = ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'];

/** Why a kind the level allows is missing from `accepts`. */
export type RespondLimit = 'no-permission-hooks' | 'not-interactive';
export const RESPOND_LIMIT_NAMES: readonly RespondLimit[] = ['no-permission-hooks', 'not-interactive'];

/** The kinds each level allows. Each level allows what the one before it does. */
export const LEVEL_KINDS: Record<RespondLevel, readonly RespondKind[]> = {
  off: [],
  questions: ['question', 'message'],
  'questions-and-plans': ['question', 'message', 'plan-approve', 'plan-feedback'],
  everything: ['question', 'message', 'plan-approve', 'plan-feedback', 'permission', 'command'],
};

/** Whether and how far a session can be answered from Podium (Report.session.respond). */
export interface RespondInfo {
  level: RespondLevel;
  /** What the session takes now: the level's kinds, less what `limits` removes; empty while the activityFeed option is off. */
  accepts: RespondKind[];
  limits: RespondLimit[];
}

/** The kinds a level allows once the limits are applied. */
export function acceptsFor(level: RespondLevel, limits: readonly RespondLimit[], activityFeed: boolean): RespondKind[] {
  if (!activityFeed || limits.includes('not-interactive')) return [];
  const drop: RespondKind[] = limits.includes('no-permission-hooks') ? ['plan-approve', 'permission'] : [];
  return LEVEL_KINDS[level].filter((k) => !drop.includes(k));
}

export type AskKind = 'question' | 'plan' | 'permission';

export interface AskOption {
  label: string;
  description: string;
  preview: string | null;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/**
 * One thing a session waits on its person for that Podium can answer. Its id is the tool call's `tool_use_id`.
 * Redacted by the reporter, and cut to RESPOND_LIMITS with a visible marker.
 */
export interface Ask {
  id: string;
  kind: AskKind;
  /** The loop that asked: set for a subagent's permission prompt; null for the main loop. */
  agentId: string | null;
  openedAt: number;
  questions?: AskQuestion[];
  plan?: { text: string; filePath: string | null };
  /** The tool and its arguments; `cut` when anything was cut off, and then Podium cannot allow it. */
  tool?: { name: string; input: Record<string, unknown>; cut: boolean };
}

export const RESPOND_LIMITS = {
  asks: 8,
  questions: 4,
  options: 4,
  question: 1000,
  header: 40,
  label: 200,
  description: 1000,
  preview: 4000,
  plan: 40_000,
  toolInput: 20_000,
  /** A typed answer, a deny reason, a close's answer summary. */
  answer: 2000,
  /** A message, a reply in place of an answer, plan feedback. */
  message: 20_000,
  /** Messages and commands waiting for one session. */
  deliveries: 20,
  /** The longest a held request for an answer waits, in seconds ($.http.fetch gives up at 30). */
  holdSeconds: 20,
} as const;

/** What a delivery carries. `reply` is a message sent in place of an answer. */
export type DeliveryKind = 'question' | 'reply' | 'plan-approve' | 'plan-feedback' | 'allow-once' | 'deny' | 'message' | 'command';
export const DELIVERY_KINDS: readonly DeliveryKind[] = ['question', 'reply', 'plan-approve', 'plan-feedback', 'allow-once', 'deny', 'message', 'command'];

/** One question's answer by position: the chosen options' indexes, a typed answer, or null for skipped. */
export type QuestionAnswer = { options: number[] } | { text: string } | null;

export type PlanMode = 'auto' | 'acceptEdits' | 'default';
export const PLAN_MODES: readonly PlanMode[] = ['auto', 'acceptEdits', 'default'];

export type PodiumCommand = 'clear' | 'compact';
export const PODIUM_COMMANDS: readonly PodiumCommand[] = ['clear', 'compact'];

/** One answer or message sent from Podium, as the server hands it to the mod. */
export interface Delivery {
  id: string;
  /** The ask it answers; null for a message or a command. */
  askId: string | null;
  /** Who sent it: a person's name, or `Admin` for the admin secret. */
  by: string;
  at: number;
  kind: DeliveryKind;
  answers?: QuestionAnswer[];
  mode?: PlanMode;
  text?: string;
  command?: PodiumCommand;
}

/** What became of a delivery, as the mod reports it. */
export type DeliveryResult = 'took' | 'queued' | 'not-taken' | 'refused' | 'closed';
export const DELIVERY_RESULTS: readonly DeliveryResult[] = ['took', 'queued', 'not-taken', 'refused', 'closed'];

/** How an ask closed without an answer from Podium. */
export type AskCloseOutcome = 'terminal' | 'closed' | 'ended';

export interface AskClose {
  outcome: AskCloseOutcome;
  at: number;
  /** A short summary of the terminal's answer: a question's answers joined with "; ", `No, keep planning`, `allowed` or `denied`. */
  answer?: string | null;
  /** True for a plan approved in the terminal (which mode is not known). */
  planApproved?: boolean;
}

/** The reply to an accepted report. Older servers send only some of it. */
export interface ReportReply {
  ok: true;
  serverTime: number;
  ackedEvents: number;
  sessionId: string;
  liveSessions: number;
  serverVersion: string;
  reporterSupport: { min: string; max: string };
  reporterCompat: 'ok' | 'outdated' | 'newer' | 'unknown';
  watch: string[];
  /** Whether the server takes answers for this session now; the mod announces asks only while it is true. */
  respond: boolean;
  /** Messages and commands from Podium waiting for this session, oldest first; empty while `respond` is false. */
  deliveries: Delivery[];
}

// <protocol:end>
