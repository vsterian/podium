// Podium wire protocol: the Report the reporter mod POSTs (SPEC 6.2), the view types the server
// sends to the UI (SPEC 7.4), and a hand-written validator that enforces the limits in SPEC 7.7.
//
// The block between the PROTOCOL markers is copied verbatim into
// mod/podium-reporter/hooks/protocol.ts. A test compares the two after whitespace normalization,
// so edit both together.

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

/** USD per million tokens for one model (issue #117). `cacheWrite` is the 5-minute rate, `cacheWrite1h` the 1-hour rate. */
export interface ModelPriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** One row of Admin > Settings > Model prices: the price in force, and the built-in one it can be reset to. */
export interface ModelPriceRow {
  /** The key the row is saved under: a built-in row's key, or an Admin-added model id. */
  key: string;
  label: string;
  /** A row Podium ships a price for; an Admin-added model id is not. */
  builtin: boolean;
  /** The Admin changed something on this row. */
  overridden: boolean;
  std: ModelPriceSet;
  /** Prices for a prompt over 100,000 tokens; only some models have a second set. */
  long?: ModelPriceSet;
  builtinStd?: ModelPriceSet;
  builtinLong?: ModelPriceSet;
}

export interface ModelPricesView {
  /** The date the built-in table was taken from Anthropic's pricing sheet. */
  asOf: string;
  models: ModelPriceRow[];
}

// ---------------------------------------------------------------------------------------------
// View types (server -> UI). The UI imports these with `import type`.
// ---------------------------------------------------------------------------------------------

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other';

export type SessionStatusView = 'running' | 'waiting' | 'stale' | 'done';

export interface AgentView extends Omit<AgentReport, 'promptText' | 'answerText' | 'activity'> {
  modelFamily: ModelFamily;
  /** Length of the full prompt / answer the server holds, null when it has none (served by the text endpoint). */
  promptChars: number | null;
  answerChars: number | null;
}

export interface BlowoutLogEntry {
  t: number;
  agentId: string | null;
  kind: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/** `outdated`: below the supported range, update the mod. `newer`: above it, upgrade the server. `unknown`: unreadable, no warning. */
export type ReporterCompat = 'ok' | 'outdated' | 'newer' | 'unknown';

/** The reporter versions a server reads correctly (major.minor compared; patch ignored). */
export interface ReporterSupport {
  min: string;
  max: string;
}

export interface SessionView {
  integration?: IntegrationInfo;
  id: string;
  name: string;
  /** `mod`: the reporter mod (full detail); `hooks`: classic settings hooks only (no usage, cost, plan). */
  reporter: 'mod' | 'hooks';
  /** The mod's version as it reported it; null for a hooks-only session, which has no mod. */
  reporterVersion: string | null;
  /** How that version sits against the range this server supports. Always `unknown` for hooks. */
  compat: ReporterCompat;
  project: string;
  /** The session's working directory, home shortened to `~`. */
  cwd: string;
  repoName: string | null;
  resumeCommand: string;
  git: GitInfo | null;
  model: string | null;
  modelFamily: ModelFamily;
  effort: string | null;
  status: SessionStatusView;
  waitReason: 'permission' | 'input' | null;
  waitNote: string | null;
  endReason: string | null;
  startedAt: number;
  lastSeenAt: number;
  secondsSinceSeen: number;
  /** When a heartbeat-lost session leaves the wall on its own (epoch ms); null while it is not stale. */
  dropAt: number | null;
  context: ContextFill;
  costUsd: number | null;
  tokensTotal: number;
  blowouts: {
    orchestrator: number;
    agents: number;
    total: number;
    level: 0 | 1 | 2;
    loopsHit: number;
    loopsTotal: number;
    log: BlowoutLogEntry[];
  };
  plan: Plan | null;
  /** The main loop's steps, tools and skills; null from a reporter older than 0.4.0 and for a hooks-only session. */
  loop: LoopReport | null;
  /** The files the session changed; null from a reporter older than 0.6.0 and for a hooks-only session. */
  files: FilesReport | null;
  /** What the session is idle on: background work or a scheduled wake-up. null when it waits on nothing. Not a wait on the person. */
  background: BackgroundWait | null;
  /** Whether any client is attached; null from a reporter older than 0.7.0 and for a hooks-only session, which counts as attached. */
  attached: boolean | null;
  /** When a session nobody is attached to leaves the wall: the first detached report plus DETACHED_HIDE_AFTER_MS. null while attached or unknown. */
  hideAt: number | null;
  /** Who the server decided this session belongs to, from the token: a person's name, `Admin` for the admin secret, null when auth is off or the session predates tokens. */
  owner: string | null;
  /** The group the owner is in, from Admin; null for Admin, no owner, or a person with no group. */
  ownerGroup: string | null;
  /** The machine the session runs on, as the reporter sent it; null when it sent none (no userName, or older than 0.9.0). */
  machine: MachineInfo | null;
  /**
   * Whether the reporter's activityFeed option is on (#118). null when the server does not know: a reporter older
   * than 0.13.0, a settings-hooks session, or no report since the server started. Held in memory, not stored.
   */
  activityFeed: boolean | null;
  /** Report.session.respond (#206); null for a reporter older than 0.14.0, a settings-hooks session, or no report since the server started (held in memory). */
  respond: RespondInfo | null;
  /** The session's asks, open or closed in the last 10 minutes, without their content (served only to the owner or an Admin). */
  asks: AskSummary[];
  /** The session this one continues after a /clear. */
  clearedFrom: string | null;
  agents: AgentView[];
  series: { tokensPerSec: number[]; peakContext: number[]; running: number[]; blowoutSecondsAgo: number[] };
}

/** Where an ask stands: open, an answer taken but not yet confirmed, an approval Claude Code did not take, or closed. */
export type AskState = 'open' | 'pending' | 'not-taken' | 'closed';

/** An ask as the state and the stream carry it: no question, plan or tool input (#206). */
export interface AskSummary {
  id: string;
  kind: AskKind;
  agentId: string | null;
  openedAt: number;
  /** The questions in a question ask (the Respond button's number); 1 otherwise. */
  count: number;
  state: AskState;
}

/** How an ask closed, as the modal shows it. `podium` is an answer from Podium that the session took. */
export type AskOutcome = 'podium' | 'terminal' | 'closed' | 'ended';

/** One delivery as the modal reads it back: what was sent, by whom, and what became of it. */
export interface DeliveryView extends Delivery {
  result: DeliveryResult | null;
  /** Whether the signed-in person sent it. */
  mine: boolean;
  /** Whether the mod has been handed it (it can no longer be discarded). */
  handedOver: boolean;
}

/** GET /api/fleet/respond/sessions/:id/asks/:askId: the whole ask, for its owner or an Admin. */
export interface AskDetail {
  ask: Ask;
  state: AskState;
  delivery: DeliveryView | null;
  closed: { outcome: AskOutcome; at: number; by: string | null; answer: string | null; planApproved: boolean } | null;
  lastSeenAt: number;
}

/** GET /api/fleet/respond/me. */
export interface RespondMe {
  /** Authentication on and the Admin's respond flag on. */
  enabled: boolean;
  signedIn: boolean;
  /** The signed-in person's name, or `Admin`. */
  name: string | null;
  /** The admin secret, or a person in Administrators. */
  admin: boolean;
}

/** One stored activity event as the UI shows it: the event plus who it is about. */
export interface ActivityView {
  id: string;
  sessionId: string;
  sessionName: string;
  modelFamily: ModelFamily;
  agentId: string | null;
  t: number;
  kind: EventKind;
  text: string;
  data: Record<string, unknown> | null;
}

export interface Kpis {
  /** Live native sessions without observed usage; aggregate token charts are incomplete. */
  incompleteSessions?: number;
  live: number;
  running: number;
  waiting: number;
  stale: number;
  agentsRunning: number;
  agentsTotal: number;
  planDone: number;
  planTotal: number;
  costToday: number;
  /** Live sessions on a model with no price (not a Claude model); their cost is left out of `costToday`. */
  unpricedSessions: number;
  tokensLastMinute: number;
  blowoutsTotal: number;
  sessionsAtLevel2: number;
  /** Fleet cost per minute for the last 60 minutes, oldest first (USD). */
  costPerMinute: number[];
  /** Fleet tokens per second for the last 60 seconds, oldest first. */
  tokensPerSec: number[];
  /** `costToday` split by owner (null for sessions with no owner), with each owner's group, largest first. */
  costTodayByOwner: OwnerSpend[];
}

/** One owner's share of today's estimated spend. */
export interface OwnerSpend {
  owner: string | null;
  group: string | null;
  costUsd: number;
}

/** The server's lifecycle timings, so the UI can say when a stale session will be dropped. */
export interface LifecycleConfig {
  staleAfterMs: number;
  dropAfterMs: number;
  lingerMs: number;
  detachedHideAfterMs: number;
}

/** The wall's display settings, set in Admin > Settings (SPEC 8.1). Notices default on; background sessions default off. */
export interface WallSettingsView {
  /** One switch per informational notice, by id. */
  notices: Record<string, boolean>;
  showBackgroundSessions: boolean;
}

export interface StateBody {
  serverTime: number;
  config: LifecycleConfig;
  sessions: SessionView[];
  kpis: Kpis;
  clearedToday: number;
  events: ActivityView[];
  /** The server's own version and the reporter range it supports, for the mismatch notice. */
  server: { version: string; reporterSupport: ReporterSupport };
  wall: WallSettingsView;
  /** The Admin's feature flags by id (Admin > Settings > Feature flags), each on unless the Admin turned it off. */
  features: Record<string, boolean>;
}

export type RemovedReason = 'done' | 'dropped' | 'deleted';

/** One ended or dropped session, as GET /api/fleet/history lists it. */
export interface HistoryRow {
  integration?: IntegrationInfo;
  id: string;
  name: string;
  project: string;
  model: string | null;
  modelFamily: ModelFamily;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  costUsd: number | null;
  blowouts: number;
  agents: number;
  endReason: string | null;
  /** The session this one continues after a /clear, and the one that continued it (#206). */
  clearedFrom: string | null;
  clearedInto: string | null;
}

// ---------------------------------------------------------------------------------------------
// Validation (SPEC 7.7). Hand-written: strings are clamped, arrays over their limit are rejected.
// ---------------------------------------------------------------------------------------------

export const LIMITS = {
  name: 80,
  text: 240,
  excerpt: 400,
  /** promptText / answerText: the 20,000-character cap plus room for the mod's cut-off marker. */
  fullText: 20_100,
  waitNote: 160,
  call: 300,
  line: 240,
  outputLines: 12,
  evidenceLines: 5,
  id: 200,
  path: 1024,
  short: 120,
  agents: 200,
  events: 100,
  planSteps: 100,
  skills: 50,
  toolNames: 100,
  usageModels: 40,
  backgroundTasks: 20,
  backgroundDescription: 120,
  rateLimits: 10,
  blowoutLog: 50,
  files: 200,
  filePath: 300,
  machineName: 64,
  /** One loop's activity feed (#118): entries kept, characters per entry, and characters over the whole report. */
  activityEntries: 20,
  activityText: 300,
  activityChars: 60_000,
} as const;

/** Room past a respond limit for the reporter's "[cut off at N characters]" marker. */
const CUT_MARKER_ROOM = 60;

export type ValidateResult = { ok: true; report: Report } | { ok: false; error: string; path: string };

class Invalid extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

// Control characters other than tab are removed from every string.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

// The full prompt and answer keep their line breaks: only the other control characters go.
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clampText(v: string, max: number): string {
  const clean = v.replace(CONTROL_KEEP_NEWLINE, ' ');
  return clean.length > max ? clean.slice(0, max) : clean;
}

function clampStr(v: string, max: number): string {
  const clean = v.replace(CONTROL, ' ');
  return clean.length > max ? clean.slice(0, max) : clean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) throw new Invalid(path, 'expected an object');
  return v;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(path, 'expected a string');
  return clampStr(v, max);
}

function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(path, 'expected a string');
  return clampText(v, max);
}

function strOrNull(v: unknown, path: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  return str(v, path, max);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(path, 'expected a finite number');
  return v;
}

function numOrNull(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  return num(v, path);
}

function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (n < 0) throw new Invalid(path, 'expected a non-negative number');
  return Math.round(n);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(path, 'expected a boolean');
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Invalid(path, `expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function oneOfOrNull<T extends string>(v: unknown, path: string, allowed: readonly T[]): T | null {
  if (v === null || v === undefined) return null;
  return oneOf(v, path, allowed);
}

/** Calls per tool name: names clipped, counts non-negative integers, the most used `max` names kept. */
function countsOrNull(v: unknown, path: string, max: number): Record<string, number> | null {
  if (v === null || v === undefined) return null;
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(obj(v, path))) {
    const name = clampStr(k, LIMITS.short);
    merged.set(name, (merged.get(name) ?? 0) + int(n, `${path}.${k}`));
  }
  const top = [...merged].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max);
  return Object.fromEntries(top);
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(path, 'expected an array');
  if (v.length > max) throw new Invalid(path, `at most ${max} items allowed`);
  return v;
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_STATUSES: readonly AgentStatus[] = ['queued', 'running', 'done', 'failed', 'aborted'];
const EVENT_KINDS: readonly EventKind[] = ['start', 'end', 'spawn', 'skill', 'done', 'fail', 'blow', 'compact', 'plan', 'wait', 'note'];
const FAILURE_CLASSES: readonly FailureClass[] = [
  'Tool error',
  'Blocked by permission',
  'Model API error',
  'Refusal',
  'Context window exhausted',
  'Aborted',
  'Unknown',
];

function tokens(v: unknown, path: string): TokenCounts {
  const o = obj(v, path);
  return {
    input: int(o.input, `${path}.input`),
    output: int(o.output, `${path}.output`),
    cacheRead: int(o.cacheRead, `${path}.cacheRead`),
    cacheWrite: int(o.cacheWrite, `${path}.cacheWrite`),
  };
}

/** Absent stays absent: an older reporter sends none, and the server falls back to the cost it was sent. */
function usageByModel(v: unknown, path: string): { usageByModel?: ModelUsage[] } {
  if (v === undefined || v === null) return {};
  return {
    usageByModel: arr(v, path, LIMITS.usageModels).map((r, i) => {
      const p = `${path}[${i}]`;
      const o = obj(r, p);
      const t = obj(o.tokens, `${p}.tokens`);
      return {
        model: str(o.model, `${p}.model`, LIMITS.short),
        tier: oneOf(o.tier, `${p}.tier`, ['std', 'long'] as const),
        tokens: {
          input: int(t.input, `${p}.tokens.input`),
          output: int(t.output, `${p}.tokens.output`),
          cacheRead: int(t.cacheRead, `${p}.tokens.cacheRead`),
          cacheWrite: int(t.cacheWrite, `${p}.tokens.cacheWrite`),
          cacheWrite1h: t.cacheWrite1h === undefined || t.cacheWrite1h === null ? 0 : int(t.cacheWrite1h, `${p}.tokens.cacheWrite1h`),
        },
      };
    }),
  };
}

function context(v: unknown, path: string): ContextFill {
  const o = obj(v, path);
  const percent = numOrNull(o.percent, `${path}.percent`);
  return {
    tokens: numOrNull(o.tokens, `${path}.tokens`),
    window: numOrNull(o.window, `${path}.window`),
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
  };
}

function git(v: unknown, path: string): GitInfo | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  return {
    branch: strOrNull(o.branch, `${path}.branch`, LIMITS.short),
    detached: bool(o.detached, `${path}.detached`),
    isWorktree: bool(o.isWorktree, `${path}.isWorktree`),
    worktreePath: strOrNull(o.worktreePath, `${path}.worktreePath`, LIMITS.path),
    ahead: int(o.ahead, `${path}.ahead`),
    behind: int(o.behind, `${path}.behind`),
    dirty: int(o.dirty, `${path}.dirty`),
  };
}

function plan(v: unknown, path: string): Plan | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const steps = arr(o.steps, `${path}.steps`, LIMITS.planSteps).map((s, i) => {
    const p = `${path}.steps[${i}]`;
    const so = obj(s, p);
    return {
      id: str(so.id, `${p}.id`, LIMITS.id),
      text: str(so.text, `${p}.text`, LIMITS.text),
      state: oneOf(so.state, `${p}.state`, ['pending', 'active', 'done', 'blocked'] as const),
      activeText: strOrNull(so.activeText, `${p}.activeText`, LIMITS.text),
      ownerAgentId: strOrNull(so.ownerAgentId, `${p}.ownerAgentId`, LIMITS.id),
      ownerLabel: strOrNull(so.ownerLabel, `${p}.ownerLabel`, LIMITS.short),
    };
  });
  return {
    title: strOrNull(o.title, `${path}.title`, LIMITS.text),
    source: oneOf(o.source, `${path}.source`, ['TaskCreate', 'TodoWrite', 'podium_plan'] as const),
    steps,
  };
}

function lines(v: unknown, path: string, keep: number, fromEnd: boolean): string[] {
  if (!Array.isArray(v)) throw new Invalid(path, 'expected an array');
  if (v.length > 1000) throw new Invalid(path, 'at most 1000 items allowed');
  const all = v.map((l, i) => str(l, `${path}[${i}]`, LIMITS.line));
  return fromEnd ? all.slice(-keep) : all.slice(0, keep);
}

function failure(v: unknown, path: string): Failure | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const exit = numOrNull(o.exitCode, `${path}.exitCode`);
  return {
    class: oneOf(o.class, `${path}.class`, FAILURE_CLASSES),
    at: num(o.at, `${path}.at`),
    tool: strOrNull(o.tool, `${path}.tool`, LIMITS.short),
    call: strOrNull(o.call, `${path}.call`, LIMITS.call),
    exitCode: exit === null ? null : Math.round(exit),
    outputTail: lines(o.outputTail, `${path}.outputTail`, LIMITS.outputLines, true),
    evidence: lines(o.evidence, `${path}.evidence`, LIMITS.evidenceLines, false),
    explanation: strOrNull(o.explanation, `${path}.explanation`, LIMITS.excerpt),
    retriedAs: strOrNull(o.retriedAs, `${path}.retriedAs`, LIMITS.id),
  };
}

function agent(v: unknown, path: string): AgentReport {
  const o = obj(v, path);
  let steps: AgentReport['steps'] = null;
  if (o.steps !== null && o.steps !== undefined) {
    const so = obj(o.steps, `${path}.steps`);
    const total = numOrNull(so.total, `${path}.steps.total`);
    steps = { done: int(so.done, `${path}.steps.done`), total: total === null ? null : Math.max(0, Math.round(total)) };
  }
  return {
    id: str(o.id, `${path}.id`, LIMITS.id),
    parentId: strOrNull(o.parentId, `${path}.parentId`, LIMITS.id),
    kind: oneOf(o.kind, `${path}.kind`, ['subagent', 'fork', 'teammate'] as const),
    type: str(o.type, `${path}.type`, LIMITS.short),
    name: strOrNull(o.name, `${path}.name`, LIMITS.name),
    description: str(o.description, `${path}.description`, LIMITS.text),
    model: strOrNull(o.model, `${path}.model`, LIMITS.short),
    effort: oneOfOrNull(o.effort, `${path}.effort`, EFFORTS),
    effortSource: oneOf(o.effortSource, `${path}.effortSource`, ['requested', 'observed', 'inherited', 'unknown'] as const),
    status: oneOf(o.status, `${path}.status`, AGENT_STATUSES),
    startedAt: num(o.startedAt, `${path}.startedAt`),
    endedAt: numOrNull(o.endedAt, `${path}.endedAt`),
    context: context(o.context, `${path}.context`),
    tokens: tokens(o.tokens, `${path}.tokens`),
    costUsdEst: (() => {
      const c = numOrNull(o.costUsdEst, `${path}.costUsdEst`);
      return c === null ? null : Math.max(0, c);
    })(),
    ...usageByModel(o.usageByModel, `${path}.usageByModel`),
    skills: arr(o.skills, `${path}.skills`, LIMITS.skills).map((s, i) => str(s, `${path}.skills[${i}]`, LIMITS.short)),
    lastTool: strOrNull(o.lastTool, `${path}.lastTool`, LIMITS.short),
    toolCalls: int(o.toolCalls, `${path}.toolCalls`),
    toolCounts: countsOrNull(o.toolCounts, `${path}.toolCounts`, LIMITS.toolNames),
    blowouts: int(o.blowouts, `${path}.blowouts`),
    steps,
    promptExcerpt: str(o.promptExcerpt, `${path}.promptExcerpt`, LIMITS.excerpt),
    answerExcerpt: strOrNull(o.answerExcerpt, `${path}.answerExcerpt`, LIMITS.excerpt),
    ...(o.promptText === undefined || o.promptText === null ? {} : { promptText: text(o.promptText, `${path}.promptText`, LIMITS.fullText) }),
    ...(o.answerText === undefined || o.answerText === null ? {} : { answerText: text(o.answerText, `${path}.answerText`, LIMITS.fullText) }),
    ...activity(o.activity, `${path}.activity`),
    failure: failure(o.failure, `${path}.failure`),
  };
}

function event(v: unknown, path: string): ActivityEvent {
  const o = obj(v, path);
  let data: Record<string, unknown> | null = null;
  if (o.data !== null && o.data !== undefined) {
    data = obj(o.data, `${path}.data`);
    if (JSON.stringify(data).length > 4096) throw new Invalid(`${path}.data`, 'at most 4096 characters of data allowed');
  }
  return {
    id: str(o.id, `${path}.id`, LIMITS.id),
    t: num(o.t, `${path}.t`),
    kind: oneOf(o.kind, `${path}.kind`, EVENT_KINDS),
    agentId: strOrNull(o.agentId, `${path}.agentId`, LIMITS.id),
    text: str(o.text, `${path}.text`, LIMITS.text),
    data,
  };
}

function loop(v: unknown, path: string): LoopReport | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const steps = obj(o.steps, `${path}.steps`);
  return {
    skills: arr(o.skills, `${path}.skills`, LIMITS.skills).map((s, i) => str(s, `${path}.skills[${i}]`, LIMITS.short)),
    lastTool: strOrNull(o.lastTool, `${path}.lastTool`, LIMITS.short),
    toolCalls: int(o.toolCalls, `${path}.toolCalls`),
    toolCounts: countsOrNull(o.toolCounts, `${path}.toolCounts`, LIMITS.toolNames) ?? {},
    steps: { done: int(steps.done, `${path}.steps.done`), total: null },
  };
}

const FILE_STATUSES: readonly FileStatus[] = ['added', 'modified', 'deleted', 'renamed'];

function intOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : int(v, path);
}

/** Keeps the first LIMITS.files entries rather than rejecting a longer list; `total` never falls below what is listed. */
function filesReport(v: unknown, path: string): FilesReport | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const listed = arr(o.files, `${path}.files`, 1000).slice(0, LIMITS.files);
  const files = listed.map((f, i) => {
    const p = `${path}.files[${i}]`;
    const fo = obj(f, p);
    return {
      path: str(fo.path, `${p}.path`, LIMITS.filePath),
      status: oneOf(fo.status, `${p}.status`, FILE_STATUSES),
      added: intOrNull(fo.added, `${p}.added`),
      removed: intOrNull(fo.removed, `${p}.removed`),
      from: strOrNull(fo.from, `${p}.from`, LIMITS.filePath),
    };
  });
  return {
    files,
    total: Math.max(int(o.total, `${path}.total`), files.length),
    added: int(o.added, `${path}.added`),
    removed: int(o.removed, `${path}.removed`),
    since: oneOf(o.since, `${path}.since`, ['start', 'upstream', 'worktree'] as const),
  };
}

function session(v: unknown, path: string): SessionReport {
  const o = obj(v, path);
  const id = str(o.id, `${path}.id`, LIMITS.id);
  if (!id) throw new Invalid(`${path}.id`, 'must not be empty');
  const bg = background(o.background, `${path}.background`);
  return {
    ...(o.integration == null ? {} : { integration: integration(o.integration, `${path}.integration`) }),
    id,
    name: str(o.name, `${path}.name`, LIMITS.name),
    status: oneOf(o.status, `${path}.status`, ['running', 'waiting', 'done'] as const),
    waitReason: oneOfOrNull(o.waitReason, `${path}.waitReason`, ['permission', 'input'] as const),
    waitNote: strOrNull(o.waitNote, `${path}.waitNote`, LIMITS.waitNote),
    endReason: strOrNull(o.endReason, `${path}.endReason`, LIMITS.short),
    resumeId: strOrNull(o.resumeId, `${path}.resumeId`, LIMITS.id),
    startedAt: num(o.startedAt, `${path}.startedAt`),
    cwd: str(o.cwd, `${path}.cwd`, LIMITS.path),
    projectRoot: strOrNull(o.projectRoot, `${path}.projectRoot`, LIMITS.path),
    repoName: strOrNull(o.repoName, `${path}.repoName`, LIMITS.short),
    git: git(o.git, `${path}.git`),
    model: strOrNull(o.model, `${path}.model`, LIMITS.short),
    effort: oneOfOrNull(o.effort, `${path}.effort`, EFFORTS),
    context: context(o.context, `${path}.context`),
    costUsd: (() => {
      const c = numOrNull(o.costUsd, `${path}.costUsd`);
      return c === null ? null : Math.max(0, c);
    })(),
    tokens: tokens(o.tokens, `${path}.tokens`),
    ...usageByModel(o.usageByModel, `${path}.usageByModel`),
    rateLimits: arr(o.rateLimits, `${path}.rateLimits`, LIMITS.rateLimits).map((r, i) => {
      const p = `${path}.rateLimits[${i}]`;
      const ro = obj(r, p);
      return {
        kind: str(ro.kind, `${p}.kind`, LIMITS.short),
        percentUsed: num(ro.percentUsed, `${p}.percentUsed`),
        resetsAt: strOrNull(ro.resetsAt, `${p}.resetsAt`, LIMITS.short),
      };
    }),
    blowouts: int(o.blowouts, `${path}.blowouts`),
    plan: plan(o.plan, `${path}.plan`),
    loop: loop(o.loop, `${path}.loop`),
    files: filesReport(o.files, `${path}.files`),
    attached: o.attached === undefined || o.attached === null ? null : bool(o.attached, `${path}.attached`),
    ...(bg ? { background: bg } : {}),
    ...(o.activityFeed === undefined || o.activityFeed === null ? {} : { activityFeed: bool(o.activityFeed, `${path}.activityFeed`) }),
    ...activity(o.activity, `${path}.activity`),
    ...respondInfo(o.respond, `${path}.respond`),
    ...(o.asks === undefined || o.asks === null ? {} : { asks: asks(o.asks, `${path}.asks`) }),
    ...(o.clearedFrom === undefined ? {} : { clearedFrom: strOrNull(o.clearedFrom, `${path}.clearedFrom`, LIMITS.id) }),
  };
}

function integration(v: unknown, path: string): IntegrationInfo {
  const o = obj(v, path);
  return {
    engine: oneOf(o.engine, `${path}.engine`, ['claude-code', 'codex', 'copilot', 'opencode'] as const),
    nativeId: str(o.nativeId, `${path}.nativeId`, LIMITS.id),
    mode: oneOf(o.mode, `${path}.mode`, ['hooks', 'extension', 'plugin'] as const),
    metrics: arr(o.metrics, `${path}.metrics`, 6).map((m, i) => oneOf(m, `${path}.metrics[${i}]`, ['tokens', 'context', 'cost', 'plan', 'agents', 'blowouts'] as const)),
  };
}

/** Report.session.respond. `accepts` is kept only where the level allows it, so a reporter cannot claim more than its level. */
function respondInfo(v: unknown, path: string): { respond?: RespondInfo } {
  if (v === undefined || v === null) return {};
  const o = obj(v, path);
  const level = oneOf(o.level, `${path}.level`, RESPOND_LEVELS);
  const accepts = arr(o.accepts, `${path}.accepts`, RESPOND_KINDS.length).map((k, i) => oneOf(k, `${path}.accepts[${i}]`, RESPOND_KINDS));
  const limits = arr(o.limits, `${path}.limits`, RESPOND_LIMIT_NAMES.length).map((k, i) => oneOf(k, `${path}.limits[${i}]`, RESPOND_LIMIT_NAMES));
  const allowed = LEVEL_KINDS[level];
  return { respond: { level, accepts: [...new Set(accepts)].filter((k) => allowed.includes(k)), limits: [...new Set(limits)] } };
}

function asks(v: unknown, path: string): Ask[] {
  return arr(v, path, RESPOND_LIMITS.asks).map((a, i) => ask(a, `${path}[${i}]`));
}

/** One ask (6.2): strings clamped to their limits (with room for the cut-off marker), lists over their limit rejected. */
function ask(v: unknown, path: string): Ask {
  const o = obj(v, path);
  const id = str(o.id, `${path}.id`, LIMITS.id);
  if (!id) throw new Invalid(`${path}.id`, 'must not be empty');
  const kind = oneOf(o.kind, `${path}.kind`, ['question', 'plan', 'permission'] as const);
  const out: Ask = { id, kind, agentId: strOrNull(o.agentId, `${path}.agentId`, LIMITS.id), openedAt: num(o.openedAt, `${path}.openedAt`) };
  const room = (n: number) => n + CUT_MARKER_ROOM;
  if (kind === 'question') {
    const qs = arr(o.questions, `${path}.questions`, RESPOND_LIMITS.questions);
    if (!qs.length) throw new Invalid(`${path}.questions`, 'expected at least one question');
    out.questions = qs.map((q, i) => {
      const p = `${path}.questions[${i}]`;
      const qo = obj(q, p);
      const opts = arr(qo.options, `${p}.options`, RESPOND_LIMITS.options);
      if (!opts.length) throw new Invalid(`${p}.options`, 'expected at least one option');
      return {
        question: text(qo.question, `${p}.question`, room(RESPOND_LIMITS.question)),
        header: str(qo.header, `${p}.header`, RESPOND_LIMITS.header),
        multiSelect: bool(qo.multiSelect, `${p}.multiSelect`),
        options: opts.map((op, j) => {
          const pp = `${p}.options[${j}]`;
          const oo = obj(op, pp);
          const preview = oo.preview === undefined || oo.preview === null ? null : text(oo.preview, `${pp}.preview`, room(RESPOND_LIMITS.preview));
          return { label: str(oo.label, `${pp}.label`, room(RESPOND_LIMITS.label)), description: text(oo.description, `${pp}.description`, room(RESPOND_LIMITS.description)), preview };
        }),
      };
    });
  } else if (kind === 'plan') {
    const po = obj(o.plan, `${path}.plan`);
    out.plan = { text: text(po.text, `${path}.plan.text`, room(RESPOND_LIMITS.plan)), filePath: strOrNull(po.filePath, `${path}.plan.filePath`, LIMITS.path) };
  } else {
    const to = obj(o.tool, `${path}.tool`);
    const input = obj(to.input, `${path}.tool.input`);
    if (JSON.stringify(input).length > room(RESPOND_LIMITS.toolInput)) throw new Invalid(`${path}.tool.input`, `at most ${RESPOND_LIMITS.toolInput} characters of input allowed`);
    out.tool = { name: str(to.name, `${path}.tool.name`, LIMITS.short), input, cut: bool(to.cut, `${path}.tool.cut`) };
  }
  return out;
}

/** Validates one ask as the mod announces it (PUT …/asks/:askId). Never throws. */
export function validateAsk(body: unknown): { ok: true; ask: Ask } | { ok: false; error: string; path: string } {
  try {
    return { ok: true, ask: ask(body, '$') };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid ask', path: '$' };
  }
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ['tool', 'text', 'reasoning'];

/** A loop's activity feed (#118). Absent stays absent; each entry is cut to its limit, a longer list is rejected. */
function activity(v: unknown, path: string): { activity?: ActivityEntry[] } {
  if (v === undefined || v === null) return {};
  return {
    activity: arr(v, path, LIMITS.activityEntries).map((e, i) => {
      const p = `${path}[${i}]`;
      const o = obj(e, p);
      return { at: num(o.at, `${p}.at`), kind: oneOf(o.kind, `${p}.kind`, ACTIVITY_KINDS), text: str(o.text, `${p}.text`, LIMITS.activityText) };
    }),
  };
}

/** Keeps the report's activity within LIMITS.activityChars: the orchestrator's first, then the agents' in order. A loop that does not fit loses its feed for this report. */
function withinActivityBudget(r: Report): void {
  let left: number = LIMITS.activityChars;
  const fits = (list: ActivityEntry[]) => {
    const n = list.reduce((sum, e) => sum + e.text.length, 0);
    if (n > left) return false;
    left -= n;
    return true;
  };
  if (r.session.activity && !fits(r.session.activity)) delete r.session.activity;
  for (const a of r.agents) if (a.activity && !fits(a.activity)) delete a.activity;
}

const BACKGROUND_KINDS = ['shell', 'agent', 'monitor', 'workflow', 'wakeup', 'other'] as const;

/** What a session idle between turns still waits on (#119). An empty list is no background work at all. */
function background(v: unknown, path: string): BackgroundWait | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const tasks = arr(o.tasks, `${path}.tasks`, LIMITS.backgroundTasks).map((t, i) => {
    const p = `${path}.tasks[${i}]`;
    const to = obj(t, p);
    return {
      type: oneOf(to.type, `${p}.type`, BACKGROUND_KINDS),
      description: str(to.description, `${p}.description`, LIMITS.backgroundDescription),
      status: str(to.status, `${p}.status`, 40),
    };
  });
  const wakeAt = numOrNull(o.wakeAt, `${path}.wakeAt`);
  return tasks.length ? { tasks, wakeAt } : null;
}

/** A reporter's machine: a host name (clamped) and its own random id (letters, digits, `-` and `_`, at most 32). */
function machine(v: unknown, path: string): MachineInfo | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  const name = str(o.name, `${path}.name`, LIMITS.machineName).trim();
  if (!name) throw new Invalid(`${path}.name`, 'expected a host name');
  const id = str(o.id, `${path}.id`, 64);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Invalid(`${path}.id`, 'expected 1 to 32 letters, digits, - or _');
  return { name, id };
}

/**
 * Validates an untrusted body as a Report. Never throws. Strings are clamped to their limits and
 * stripped of control characters; arrays over their limit, wrong types and unknown enum values are
 * rejected with the path of the first offending field. Unknown fields are dropped.
 */
export function validateReport(body: unknown): ValidateResult {
  try {
    const o = obj(body, '$');
    if (o.v === undefined) throw new Invalid('$.v', 'missing protocol version');
    if (o.v !== 1) throw new Invalid('$.v', 'unsupported protocol version');
    const r = obj(o.reporter, '$.reporter');
    const report: Report = {
      v: 1,
      sentAt: num(o.sentAt, '$.sentAt'),
      reporter: {
        name: oneOf(r.name, '$.reporter.name', ['podium-reporter'] as const),
        version: str(r.version, '$.reporter.version', LIMITS.short),
        engineVersion: strOrNull(r.engineVersion, '$.reporter.engineVersion', LIMITS.short),
        hostSurface: strOrNull(r.hostSurface, '$.reporter.hostSurface', LIMITS.short),
      },
      session: session(o.session, '$.session'),
      agents: arr(o.agents, '$.agents', LIMITS.agents).map((a, i) => agent(a, `$.agents[${i}]`)),
      events: arr(o.events, '$.events', LIMITS.events).map((e, i) => event(e, `$.events[${i}]`)),
    };
    const userName = strOrNull(o.userName, '$.userName', LIMITS.name);
    if (userName !== null) report.userName = userName;
    const m = machine(o.machine, '$.machine');
    if (m !== null) report.machine = m;
    withinActivityBudget(report);
    return { ok: true, report };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message, path: err.path };
    return { ok: false, error: 'invalid report', path: '$' };
  }
}
