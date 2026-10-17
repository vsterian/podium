import { fmtCountdown, fmtDur, fmtPct, fmtTok } from "../format";
import { useRespond } from "../useRespond";
import { respondGate } from "../respond";
import { RespondButton } from "./Respond";
import { COST_HINT_SESSION, currentStep, delegateText, dropAtOf, inferredStep, planProgress, sessionCounts, sessionElapsedSec, sessionTokens, NATIVE_TOKENS_HINT, TOKENS_HINT, treeOrder } from "../logic";
import type { AgentView, LifecycleConfig, SessionView } from "../types";
import { BlowBadge, ContextBar, Cost, cssVar, delegatesOf, EffortMeter, FAMILY_COLOR, GitLine, ModelChip, PlanBar, StateIcon, stateKind, type StateKind } from "./Chips";
import { backgroundLead, backgroundTitle, toolOfNote, waitLead } from "../waiting";
import { Sparkline } from "./Sparkline";
import { OwnerLine } from "./People";

export const HOOKS_NOTE = "Reported by Claude Code settings hooks, not the reporter mod: context, cost, tokens, the plan and which agent launched which are unavailable, so every agent shows under the orchestrator.";

/** What to tell the user when the server places this session's reporter outside the range it supports; null when it does not. */
export function versionNote(s: Pick<SessionView, "compat" | "reporterVersion">): { chip: string; label: string; text: string } | null {
  const v = s.reporterVersion ?? "unknown";
  if (s.compat === "outdated") return { chip: `reporter ${v} · update`, label: `${v} · update`, text: `This session's reporter (${v}) is older than the server supports. Update the podium-reporter mod: run claude plugin update podium-reporter@eengelking-marketplace, then /reload-plugins in that session. Reports are still accepted, but newer fields may be missing.` };
  if (s.compat === "newer") return { chip: `reporter ${v} · upgrade server`, label: `${v} · upgrade server`, text: `This session's reporter (${v}) is newer than the server supports. Upgrade the Podium server. Reports are still accepted, but some fields may be ignored.` };
  return null;
}

// The reporter clips a wait note at this many characters (LIMITS.waitNote); a note that long is cut off.
const WAIT_NOTE_LIMIT = 160;

/** The orchestrator page's status band: a plain lead, plus the tool or question as a secondary line when there is one. */
export function waitSummary(s: Pick<SessionView, "waitReason" | "waitNote">): { lead: string; detail: string | null } {
  const note = s.waitNote?.trim() ?? "";
  const tool = toolOfNote(note, s.waitReason);
  const lead = waitLead(s.waitReason, tool);
  if (!note) return { lead, detail: null };
  if (tool) return { lead, detail: `Tool: ${tool}` };
  // Anything else is shown only if it arrived whole; a clipped note would read as the full prompt.
  // Measure the raw note: the clip happens before the trim above.
  return { lead, detail: (s.waitNote?.length ?? 0) >= WAIT_NOTE_LIMIT ? null : note };
}

export function riskText(s: SessionView): string {
  const b = s.blowouts;
  return `Context exceeded ${b.total}× (${b.loopsHit} of ${b.loopsTotal} loops). Likely losing context; check for invented details.`;
}

/** In the people view: the machine label, and whether the card names its owner (not in that owner's own band). */
export interface CardOwner {
  machine: string | null;
  showName: boolean;
}

/** "Delegating to 2 agents." The one sentence the card, the wall and the orchestrator page's band share (SPEC 8.1). */
export function delegatingLead(delegates: readonly AgentView[]): string {
  return `Delegating to ${delegates.length} agent${delegates.length === 1 ? "" : "s"}.`;
}

/** What the status band says. One sentence, the same ones the orchestrator page and the activity feed use. */
export function bandLine(s: SessionView, kind: StateKind, sinceSeen: number, now: number, config: LifecycleConfig, delegates: readonly AgentView[]) {
  if (kind === "deleg") return <span className="bl" title={delegateText(delegates)}>{delegatingLead(delegates)}</span>;
  if (kind === "bg" && s.background) return <span className="bl" title={backgroundTitle(s.background)}>{backgroundLead(s.background)}</span>;
  if (kind === "waiting") return <span className="bl">{waitSummary(s).lead}</span>;
  if (kind === "stale") {
    return (
      <span className="bl">
        {s.integration?.mode === "hooks" ? "Last event" : "Last heartbeat"} <span className="mono">{fmtDur(sinceSeen)}</span> ago. Goes away in <span className="mono">{fmtCountdown((dropAtOf(s, config) - now) / 1000)}</span>.
      </span>
    );
  }
  return <span className="bl">{kind === "running" ? "Running" : "Done"}</span>;
}

export function SessionCard(props: { s: SessionView; now: number; config: LifecycleConfig; entering: boolean; leaving: boolean; onOpen: () => void; onRemove?: () => void; owner?: CardOwner }) {
  const { s, now, config } = props;
  const respond = useRespond();
  // Respond (#206) sits at the right end of the band. The card is one big button, so it is laid over the band from the slot.
  const gate = respond ? respondGate(s, respond.me, respond.flagsOn) : ({ show: "none" } as const);
  const p = planProgress(s.plan);
  const c = sessionCounts(s);
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const active = currentStep(s.plan);
  const inferred = active ? null : inferredStep(s.plan);
  const step = active ?? (inferred ? `${inferred.text} (inferred)` : null);
  const risk = s.blowouts.level === 2;
  const vNote = versionNote(s);
  const detached = s.attached === false;
  const delegates = delegatesOf(s);
  const kind = stateKind(s, delegates);
  // The states that want the person (or say the session is lost) get the heavier tint; a calm state a lighter one. The top line is the same thin line on every band.
  const hot = kind === "waiting" || kind === "stale";
  const hooks = s.reporter === "hooks";
  const cls = `card sc${props.entering ? " enter" : ""}${props.leaving ? " leave" : ""}${risk ? " risk" : ""}${detached ? " detached" : ""}`;
  const sinceSeen = Math.max(0, (now - s.lastSeenAt) / 1000);
  const hasNotes = detached || hooks || vNote !== null;
  // The card is one big button, so Remove sits beside it in a slot rather than inside it.
  return (
    <div className={`card-slot${s.status === "stale" && props.onRemove ? " has-remove" : ""}${gate.show !== "none" ? ` has-respond${gate.show === "dimmed" ? " dimmed" : ""}` : ""}`}>
    <button type="button" className={cls} onClick={props.onOpen} disabled={props.leaving} data-session={s.id}>
      {/* Four layers, always in this order (#144): who, what it is doing, cost and health, then the status band. */}
      <div className="z1">
        <div className="h">
          <span className="sd"><StateIcon kind={kind} /></span>
          <span className="nm">{s.name}</span>
          <span className="chip" title="Session CLI">{s.integration?.engine ?? "claude-code"}</span>
          <span className="mdl">
            <ModelChip family={s.modelFamily} model={s.model} />
            <EffortMeter effort={s.effort} />
          </span>
        </div>
        {props.owner && <OwnerLine owner={s.owner} machine={props.owner.machine} showName={props.owner.showName} />}
        <div className="path mono" title={s.project}>
          <bdi>{s.project}</bdi>
        </div>
        <GitLine git={s.git} />
        {hasNotes && (
          <div className="notes">
            {detached && (
              <span className="chip detached" title="No window is attached to this session. Run claude attach to reopen it.">
                nobody attached
              </span>
            )}
            {detached && s.hideAt !== null && s.hideAt > now && (
              <span className="chip">
                hides in <span className="mono">{fmtCountdown((s.hideAt - now) / 1000)}</span>
              </span>
            )}
            {hooks && (
              <span className="chip" title={HOOKS_NOTE}>
                settings hooks
              </span>
            )}
            {vNote && (
              <span className="chip warn" title={vNote.text}>
                {vNote.chip}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="z2">
        {p ? (
          <div className="plan">
            <div className="t">
              <span>
                {s.plan?.title ?? "Plan"}
                {step ? ` · ${step}` : ""}
              </span>
              <span className="mono">
                {p.done}/{p.total}
              </span>
            </div>
            <PlanBar pct={p.pct} />
          </div>
        ) : (
          <div className="noplan">{s.integration ? "No plan reported." : "No plan reported. Agents were launched ad hoc."}</div>
        )}
        <div className="crew" aria-label={`${c.running} running, ${c.done} done of ${c.all} agents, the orchestrator included`}>
          {treeOrder(s.agents).map((a) => {
            const parent = a.parentId && a.parentId !== a.id ? byId.get(a.parentId) : undefined;
            return (
              <span
                key={a.id}
                className={`a ${a.status === "aborted" ? "done" : a.status}${a.kind === "fork" ? " fork" : ""}`}
                style={cssVar(FAMILY_COLOR[a.modelFamily])}
                title={`${a.description} · ${a.status}${parent ? ` · launched by ${parent.description}` : ""}`}
              />
            );
          })}
          <span className="mono cnt">
            {c.running} running · {c.done} done{c.failed ? ` · ${c.failed} failed` : ""}
          </span>
          <Sparkline values={s.series.tokensPerSec} w={72} h={20} />
        </div>
      </div>
      <div className="z3">
        <div className="c" title={COST_HINT_SESSION}>
          <span className="k">Cost</span>
          <span className="v mono"><Cost usd={s.costUsd} family={s.modelFamily} /></span>
        </div>
        <div className="c" title={s.integration ? NATIVE_TOKENS_HINT : TOKENS_HINT}>
          <span className="k">Tokens</span>
          <span className="v mono">{hooks || (s.integration && !s.integration.metrics.includes("tokens")) ? "—" : fmtTok(sessionTokens(s))}</span>
        </div>
        <div className="c">
          <span className="k">Time</span>
          <span className="v mono">{fmtDur(sessionElapsedSec(s, now))}</span>
        </div>
        <div className={`c ctx${risk ? " hi" : ""}`} title={risk ? riskText(s) : undefined}>
          <span className="k">
            Context
            <BlowBadge n={s.blowouts.total} level={s.blowouts.level} />
          </span>
          <span className="v mono">{fmtPct(s.context.percent)}</span>
          {s.context.percent !== null && <ContextBar percent={s.context.percent} blowouts={s.blowouts.total} />}
        </div>
      </div>
      <div className={`band ${kind}${hot ? " hot" : ""}`}>
        <span className="bi"><StateIcon kind={kind} /></span>
        {bandLine(s, kind, sinceSeen, now, config, delegates)}
      </div>
    </button>
    {gate.show !== "none" && (
      <div className="respond-bar">
        <RespondButton s={s} />
      </div>
    )}
    {s.status === "stale" && props.onRemove && (
      <div className="remove-bar">
      <button type="button" className="btn remove" onClick={props.onRemove} disabled={props.leaving} aria-label={`Remove ${s.name} from the fleet`}>
        Remove
      </button>
      </div>
    )}
    </div>
  );
}
