// Small shared pieces: model chip, effort meter, status chip, blowout badge, git line.
import type { CSSProperties, ReactElement } from "react";
import { fmtUsd } from "../format";
import { EFFORTS, familyName, ORCHESTRATOR_ROW, waitingOnByRow } from "../logic";
import type { AgentView, BackgroundWait, GitInfo, ModelFamily, SessionView } from "../types";
import { backgroundStatus, backgroundTitle, idleOnBackground } from "../waiting";
import { IconBranch, IconCheck, IconClock, IconDown, IconMod, IconTree, IconUp, IconWarn, IconX } from "./Icons";

export const FAMILY_COLOR: Record<ModelFamily, string> = {
  opus: "var(--opus)",
  sonnet: "var(--sonnet)",
  haiku: "var(--haiku)",
  fable: "var(--fable)",
  other: "var(--other)",
};

export function cssVar(c: string): CSSProperties {
  return { ["--c" as string]: c } as CSSProperties;
}

export const NO_PRICE_TITLE = "No USD usage or configured price is available; subscription credits are not dollars";

/** A cost figure. A non-Claude model has no price: it reads "n/a" with the reason, not a made-up dollar amount. */
export function Cost({ usd, family }: { usd: number | null; family: ModelFamily }) {
  if (usd === null && family === "other") return <span title={NO_PRICE_TITLE}>n/a</span>;
  return <>{fmtUsd(usd)}</>;
}

export function ModelChip({ family, model }: { family: ModelFamily; model?: string | null }) {
  const title = family === "other" && model ? `${model} (not a Claude model)` : (model ?? undefined);
  return (
    <span className="chip" style={cssVar(FAMILY_COLOR[family])} title={title}>
      <i />
      {familyName(family, model ?? null)}
    </span>
  );
}

/** Five bars filled one to five, colored by level; the level is the tooltip and the accessible name, not text. */
export function EffortMeter({ effort }: { effort: string | null }) {
  const n = effort ? EFFORTS.indexOf(effort as (typeof EFFORTS)[number]) + 1 : 0;
  const label = n ? `Effort: ${effort}` : "Effort not reported";
  return (
    <span className={`eff eff-${n ? effort : "none"}`} role="img" aria-label={label} title={label}>
      {[1, 2, 3, 4, 5].map((i) => (
        <b key={i} className={i <= n ? "on" : ""} />
      ))}
    </span>
  );
}

export type StatusKind = "running" | "waiting" | "stale" | "done" | "failed" | "queued" | "aborted";

export const STATUS_LABEL: Record<StatusKind, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  queued: "queued",
  waiting: "waiting on you",
  stale: "heartbeat lost",
  aborted: "aborted",
};

export function StatusIcon({ status }: { status: StatusKind }) {
  if (status === "running") return <i className="dot running" aria-hidden="true" />;
  if (status === "done") return <IconCheck />;
  if (status === "failed" || status === "aborted") return <IconX />;
  if (status === "waiting") return <i className="dot waiting" aria-hidden="true" />;
  if (status === "stale") return <IconWarn />;
  return <IconClock />;
}

/** The state a card shows: its own shape and color, so state is never color alone (#144). */
export type CardKind = "running" | "waiting" | "bg" | "stale" | "done";

export function cardKind(s: Pick<SessionView, "status" | "waitReason" | "background">): CardKind {
  if (idleOnBackground(s)) return "bg";
  if (s.status === "running" || s.status === "waiting" || s.status === "stale") return s.status;
  return "done";
}

/** The card's kinds plus delegating (SPEC 8.1, #98, #287): display-only, shown wherever a session's state is shown. */
export type StateKind = CardKind | "deleg";

/** The running direct children of a running orchestrator: what it is delegating to. One function for the card, the rail, the wall and the orchestrator page. */
export function delegatesOf(s: Pick<SessionView, "status" | "agents">): AgentView[] {
  return waitingOnByRow(s).get(ORCHESTRATOR_ROW) ?? [];
}

/** The state a session shows everywhere: its card kind, or delegating while it is running and has a running child. */
export function stateKind(s: Pick<SessionView, "status" | "waitReason" | "background" | "agents">, delegates: readonly AgentView[] = delegatesOf(s)): StateKind {
  const kind = cardKind(s);
  return kind === "running" && delegates.length ? "deleg" : kind;
}

const STATE_SHAPE: Record<StateKind, ReactElement> = {
  deleg: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  running: <path d="M5 3.2v9.6l7.6-4.8z" fill="currentColor" stroke="none" />,
  waiting: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.8M8 11v.1" strokeWidth="1.9" />
    </>
  ),
  bg: (
    <>
      <circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.2" />
      <path d="M8 5v3.2l2 1.2" />
    </>
  ),
  stale: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.4" />
    </>
  ),
  done: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.2 8.2l2 2 3.6-4" />
    </>
  ),
};

/** One shape per state: a play mark, a "!" ring, a dashed clock ring, a clock, a check, and a ring with a dot for delegating. */
export function StateIcon({ kind }: { kind: StateKind }) {
  return (
    <svg className={`si si-${kind}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {STATE_SHAPE[kind]}
    </svg>
  );
}

/**
 * `delegating` (the tooltip text, from `delegateText`) swaps a running row for the display-only
 * "delegating" state: the row is idle while agents it launched run. It is not a session status.
 */
/** The dot class for a session: the pulsing blue ring while it is idle on background work (#119), the still blue ring while it delegates (#287), else its status. */
export function sessionDot(s: Pick<SessionView, "status" | "waitReason" | "background">, kind: StateKind): string {
  if (idleOnBackground(s)) return "dot ring bgwait";
  return kind === "deleg" ? "dot ring" : `dot ${s.status}`;
}

/** The background wait to hand to StatusChip, or undefined when the session waits on the person or is not waiting. */
export function backgroundOf(s: Pick<SessionView, "status" | "waitReason" | "background">): BackgroundWait | undefined {
  return idleOnBackground(s) ? s.background : undefined;
}

export function StatusChip({ status, delegating, background }: { status: StatusKind; delegating?: string; background?: BackgroundWait }) {
  if (background && status === "waiting") {
    const title = backgroundTitle(background);
    return (
      <span className="st bg" title={title}>
        <i className="dot ring bgwait" aria-hidden="true" />
        {backgroundStatus(background)}
        <span className="vh">. Not waiting on you.</span>
      </span>
    );
  }
  if (delegating && status === "running") {
    return (
      <span className="st deleg" title={delegating}>
        <i className="dot ring" aria-hidden="true" />
        delegating
        <span className="vh">. {delegating}</span>
      </span>
    );
  }
  return (
    <span className={`st ${status}`}>
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** `n` blowouts; red when `level` is 2 (a session's level), else when this one loop has 2 or more. */
export function BlowBadge({ n, level }: { n: number; level?: 0 | 1 | 2 }) {
  if (!n) return null;
  const red = level !== undefined ? level === 2 : n >= 2;
  const title = `Context window exceeded ${n} time${n > 1 ? "s" : ""}${red ? ". Earlier work was compacted away; output may be unreliable." : ""}`;
  return (
    <span className={`blow${red ? " l2" : ""}`} title={title}>
      <IconWarn />
      {n}×<span className="vh"> context blowouts</span>
    </span>
  );
}

/** Branch, worktree or main checkout, ahead/behind, modified count or clean. Nothing for `git: null`. */
export function GitLine({ git }: { git: GitInfo | null }) {
  if (!git) return null;
  const wtName = git.worktreePath ? git.worktreePath.split("/").filter(Boolean).pop() : null;
  return (
    <div className="git">
      <span className="br" title={`${git.detached ? "Detached HEAD" : "Branch"}: ${git.branch ?? "unknown"}`}>
        <IconBranch />
        <span className="brn">
          {git.branch ?? "unknown"}
          {git.detached ? " (detached)" : ""}
        </span>
      </span>
      {git.isWorktree ? (
        <span className="wt" title={`Git worktree at ${git.worktreePath ?? "unknown path"}`}>
          <IconTree />
          <span className="wtn">worktree{wtName ? ` · ${wtName}` : ""}</span>
        </span>
      ) : (
        <span className="wt no" title="Working in the main checkout">
          main checkout
        </span>
      )}
      {git.ahead > 0 && (
        <span title="Commits ahead of origin">
          <IconUp />
          {git.ahead}
          <span className="vh"> ahead</span>
        </span>
      )}
      {git.behind > 0 && (
        <span title="Commits behind origin">
          <IconDown />
          {git.behind}
          <span className="vh"> behind</span>
        </span>
      )}
      {git.dirty > 0 ? (
        <span className="dirty" title="Modified files">
          <IconMod />
          {git.dirty} modified
        </span>
      ) : (
        <span title="Clean working tree">clean</span>
      )}
    </div>
  );
}

/** A context bar: amber from 75% to 79%, red at 80% or more, amber fill after one blowout, red stripes after two. */
export function ContextBar({ percent, blowouts, width }: { percent: number | null; blowouts: number; width?: number }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const crit = Math.round(p) >= 80;
  const cls = `bar ctx${crit ? " crit" : p >= 75 ? " hot" : ""}${blowouts >= 2 ? " bx2" : blowouts ? " bx" : ""}`;
  return (
    <div className={cls} style={width ? { width } : undefined} role="img" aria-label={`Context ${percent === null ? "unknown" : `${Math.round(p)}%${crit ? ", nearly full" : ""}`}`} title={percent === null ? "Context window unknown" : undefined}>
      <i style={{ width: `${p}%` }} />
    </div>
  );
}

export function PlanBar({ pct }: { pct: number }) {
  return (
    <div className="bar plan" aria-hidden="true">
      <i style={{ width: `${Math.round(pct * 100)}%` }} />
    </div>
  );
}

export { IconX };
