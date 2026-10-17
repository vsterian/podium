// The wire types are defined once, in the server (SPEC 7.4). The UI imports them as types, and a few pure helpers
// that must agree with the server (`idleOnBackground`) as values.
export type {
  IntegrationInfo,
  ActivityEntry,
  ActivityView,
  AgentView,
  BackgroundTask,
  BackgroundWait,
  BlowoutLogEntry,
  ChangedFile,
  Effort,
  Failure,
  FilesReport,
  GitInfo,
  HistoryRow,
  Kpis,
  LifecycleConfig,
  MachineInfo,
  ModelFamily,
  OwnerSpend,
  Plan,
  PlanStep,
  RemovedReason,
  SessionStatusView,
  SessionView,
  StateBody,
  WallSettingsView,
  Ask,
  AskDetail,
  AskKind,
  AskQuestion,
  AskState,
  AskSummary,
  Delivery,
  DeliveryKind,
  DeliveryView,
  PlanMode,
  QuestionAnswer,
  RespondInfo,
  RespondKind,
  RespondMe,
} from "../../../server/src/fleet/protocol";
export type { ActivityEntryView, ActivityReply } from "../../../server/src/fleet/activity";

/** The product name, kept in one place so it can change (SPEC 12.10). */
export const APP_NAME = "Podium";
export const COPYRIGHT = "© 2026 Ed Engelking";
const REPO = "https://github.com/vsterian/podium/blob/feat/multi-cli-support";
export const LICENSE_URL = `${REPO}/LICENSE`;
export const NOTICES_URL = `${REPO}/docs/THIRD_PARTY_NOTICES.md`;
