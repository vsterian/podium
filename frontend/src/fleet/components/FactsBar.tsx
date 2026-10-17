import { useEffect, useRef, useState } from "react";
import { fmtDur, fmtTok } from "../format";
import { AGENT_TIME_HINT, AGENTS_HINT, COST_HINT_SESSION, sessionAgentSec, sessionCounts, sessionElapsedSec, sessionTokens, NATIVE_TOKENS_HINT, TOKENS_HINT } from "../logic";
import type { SessionView } from "../types";
import { BlowBadge, Cost } from "./Chips";
import { IconCheck, IconChevron, IconCopy, IconWarn, IconX } from "./Icons";
import { HOOKS_NOTE, versionNote } from "./SessionCard";

export const COPIED_MS = 1600;

/** Copies the resume command; "Copied" for 1.6 s, or a selected text field when the clipboard refuses. */
export function CopyResume({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "fallback">("idle");
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (state === "fallback") input.current?.select();
  }, [state]);
  const onClick = () => {
    const fallback = () => setState("fallback");
    try {
      const p = navigator.clipboard?.writeText(command);
      if (!p) return fallback();
      p.then(() => {
        setState("copied");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), COPIED_MS);
      }, fallback);
    } catch {
      fallback();
    }
  };
  const label = state === "copied" ? "Copied" : state === "fallback" ? "Select and copy" : "Copy command";
  // A quiet whole-cell control: no button chrome. The fallback field sits under it, inside the cell, so the grid still lines up.
  return (
    <div className="fact copy">
      <button type="button" className="cellbtn" onClick={onClick} title="Copies the command that resumes this session in a terminal">
        <span className="k">Resume</span>
        <span className="v soft" aria-live="polite">
          <span>{label}</span>
          {state === "copied" ? <IconCheck /> : <IconCopy />}
        </span>
      </button>
      {state === "fallback" && (
        <input ref={input} readOnly value={command} aria-label="Resume command" onFocus={(e) => e.currentTarget.select()} />
      )}
    </div>
  );
}

/** The reporter mod's version; "Settings hooks" when there is no mod; the card chip's wording, a warning shape and the note as its tooltip when the server places it out of range. */
function ReporterFact({ s }: { s: SessionView }) {
  if (s.integration) return <div className="fact"><div className="k">Reporter</div><div className="v soft">{s.integration.engine} · {s.integration.mode}</div></div>;
  const note = versionNote(s);
  if (!note && (s.reporterVersion === null || s.reporter === "hooks")) {
    return (
      <div className="fact" title={`${HOOKS_NOTE} Install podium-reporter from eengelking-marketplace for the full view.`}>
        <div className="k">Reporter</div>
        <div className="v soft">Settings hooks</div>
      </div>
    );
  }
  return (
    <div className={`fact${note ? " warn" : ""}`} title={note ? (s.reporter === "hooks" ? `${note.text} ${HOOKS_NOTE}` : note.text) : "The podium-reporter mod's version in this session"}>
      <div className="k">Reporter</div>
      <div className="v mono">
        {note && <IconWarn />}
        {note ? note.label : s.reporterVersion}
      </div>
    </div>
  );
}

/** Always present. "none" when clear; with blowouts it is the button that opens the detail between the header and these cells. */
function BlowoutsFact({ s, blow }: { s: SessionView; blow?: BlowControl }) {
  const b = s.blowouts;
  if (!b.total) {
    return (
      <div className="fact" title="Times a context window ran over">
        <div className="k">Blowouts</div>
        <div className="v soft">{s.integration && !s.integration.metrics.includes("blowouts") ? "unavailable" : "none"}</div>
      </div>
    );
  }
  // Without a toggle there is nothing to open, so the cell is plain text rather than a dead control.
  if (!blow) {
    return (
      <div className="fact" title="Times a context window ran over">
        <div className="k">Blowouts</div>
        <div className="v">
          <BlowBadge n={b.total} level={b.level} />
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="fact blowcell" aria-expanded={blow.open} aria-controls={blow.open ? blow.controls : undefined} onClick={blow.onToggle} title="Times a context window ran over. Click for which loops.">
      <span className="k">
        Blowouts
        <IconChevron className="chev" />
      </span>
      <span className="v">
        <BlowBadge n={b.total} level={b.level} />
      </span>
    </button>
  );
}

/** What the Blowouts cell needs from the page: whether the detail is open, how to toggle it, and the detail's id. */
export interface BlowControl {
  open: boolean;
  onToggle: () => void;
  controls: string;
}

/**
 * Eight cells in fixed places, four to a row (#165). Row one: Agents, Est. cost, Tokens, Running for.
 * Row two: Agent time, Blowouts, Reporter, Resume. A cell never moves because another has nothing to say.
 */
export function FactsBar({ s, now, onAgent, blow }: { s: SessionView; now: number; onAgent: (id: string) => void; blow?: BlowControl }) {
  const c = sessionCounts(s);
  const firstFail = s.agents.find((a) => a.status === "failed");
  return (
    <div className="facts">
      <div className="fact agents" title={AGENTS_HINT}>
        <div className="k">Agents</div>
        <div className="v mono">
          <span className="n-running">{c.running} running</span>
          <span className="n-done">{` / ${c.done} done`}</span>
          {firstFail && (
            <button type="button" className="blow l2" onClick={() => onAgent(firstFail.id)} title="Show the first failure">
              <IconX />
              {c.failed} failed
            </button>
          )}
        </div>
      </div>
      <div className="fact cost" title={COST_HINT_SESSION}>
        <div className="k">Est. cost</div>
        <div className="v mono"><Cost usd={s.costUsd} family={s.modelFamily} /></div>
      </div>
      <div className="fact">
        <div className="k" title={s.integration ? NATIVE_TOKENS_HINT : TOKENS_HINT}>Tokens</div>
        <div className="v mono" title={s.integration ? NATIVE_TOKENS_HINT : TOKENS_HINT}>{s.integration && !s.integration.metrics.includes("tokens") ? "unavailable" : fmtTok(sessionTokens(s))}</div>
      </div>
      <div className="fact">
        <div className="k">Running for</div>
        <div className="v mono">{fmtDur(sessionElapsedSec(s, now))}</div>
      </div>
      <div className="fact" title={AGENT_TIME_HINT}>
        <div className="k">Agent time</div>
        <div className="v mono">{fmtDur(sessionAgentSec(s, now))}</div>
      </div>
      <BlowoutsFact s={s} blow={blow} />
      <ReporterFact s={s} />
      <CopyResume command={s.resumeCommand} />
    </div>
  );
}
