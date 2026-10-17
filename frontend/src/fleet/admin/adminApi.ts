// The Admin API client (issue #36). Every call carries the header the server requires of a change, and the session
// cookie is HttpOnly, so nothing here can read it. Tokens and the admin secret live only in component state.

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  rows: T[];
}
export interface PersonRow {
  id: number;
  name: string;
  /** `pdm_<key id>`: how every page names a token. */
  credential: string;
  groupId: number | null;
  groupName: string | null;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastReportAt: number | null;
  machines: string[];
}
export interface GroupRow {
  id: number;
  name: string;
  createdAt: number;
  members: string[];
  /** Administrators: cannot be deleted, and the admin secret is always a member. */
  builtIn: boolean;
}
export interface LogRow {
  id: number;
  t: number;
  kind: string;
  detail: string;
  source: string;
  /** Who made the change: a person's name, or "Admin secret". Null for entries from before it was recorded. */
  actor: string | null;
}
export type ReporterState = "reporting" | "idle" | "silent" | "restart";
export type ReporterSort = "state" | "name" | "who" | "token" | "ver" | "last" | "sessions";
/** Issue #142: one row per machine that has reported, kept after its sessions are deleted. */
export interface ReporterRow {
  key: string;
  state: ReporterState;
  name: string;
  /** False when `name` is made up (newest project or address) because the reporter sends no machine name. */
  named: boolean;
  who: string;
  /** The token's key id, or "admin secret"; null when the server had no authentication. Never a token. */
  credential: string | null;
  /** Reports with the admin secret instead of a person's token (issue #166). */
  adminSecret: boolean;
  version: string;
  compat: "ok" | "outdated" | "newer" | "unknown";
  firstSeenAt: number;
  lastSeenAt: number;
  sessions: number;
  live: number;
}
export interface ReporterList extends Paged<ReporterRow> {
  serverStartedAt: number;
  /** How many reporters use the admin secret, whatever filter is on. */
  adminSecret: number;
  counts: Record<"all" | ReporterState, number>;
  serverTime: number;
}
export interface ReporterDetail extends ReporterRow {
  serverStartedAt: number;
  kind: "mod" | "hooks" | "native";
  machineId: string | null;
  source: string | null;
  engineVersion: string | null;
  recent: { id: string; name: string; status: string; lastSeenAt: number; costUsd: number | null }[];
  /** How many of its sessions the server still holds, and the page of them `recent` is. */
  recentTotal: number;
  recentPage: number;
  recentPageSize: number;
  rejected: { t: number; reason: string }[];
  serverTime: number;
}
/** Issue #167: a rule that turns away the reports of every reporter it matches. `*` in a pattern means "anything". */
export interface IgnoreRule {
  id: number;
  kind: "key" | "address" | "version";
  pattern: string;
  createdAt: number;
}
/** What to remove in one step: these keys, or every reporter a filter holds (past one page). */
export type RemoveBody = { keys: string[] } | { match: { q?: string; state?: ReporterState; admin?: boolean } };
export interface GroupChoice {
  id: number;
  name: string;
  builtIn: boolean;
}

/** USD per million tokens (issue #117). */
export interface PriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
export interface ModelPriceRow {
  key: string;
  label: string;
  builtin: boolean;
  overridden: boolean;
  std: PriceSet;
  long?: PriceSet;
  builtinStd?: PriceSet;
  builtinLong?: PriceSet;
}
export interface ModelPricesView {
  asOf: string;
  models: ModelPriceRow[];
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export type AdminApi = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;

export function makeApi(base = "/api/admin"): AdminApi {
  return async <T,>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: { "X-Podium-Admin": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as { error?: string; retryAfterSec?: number } | null;
    if (!res.ok) throw new AdminError(res.status, data?.error ?? `HTTP ${res.status}`, data?.retryAfterSec);
    return data as T;
  };
}

export function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `?${q}` : "";
}
