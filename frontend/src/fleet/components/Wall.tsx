import { fmtTok, fmtUsd } from "../format";
import { SORTS, STATUS_FILTERS, type SortKey, type StatusFilter } from "../logic";
import type { Kpis, LifecycleConfig, SessionView } from "../types";
import { NO_PRICE_TITLE } from "./Chips";
import { splitText, type Split } from "./Rail";
import { SessionCard } from "./SessionCard";
import { Band, PeopleCluster } from "./People";
import { isFlat, type GroupBy, type Unit } from "../people";
import type { ComponentProps, CSSProperties } from "react";
import { useWallColumns } from "../useWallColumns";
import { Sparkline } from "./Sparkline";
import { NoticeStack, type NoticeItem } from "./NoticeStack";

const COST_TODAY_TITLE = "What the fleet has spent since midnight on the server, counting only the part of a session that came after midnight.";

export function KpiStrip({ kpis, split }: { kpis: Kpis | null; split: Split }) {
  const k = kpis;
  const lvl2 = k?.sessionsAtLevel2 ?? 0;
  return (
    <div className="kpis">
      <div className="kpi">
        <div className="k">Orchestrators live</div>
        <div className="v mono">{k?.live ?? "–"}</div>
        <div className="kpi-cap">{splitText(split)}</div>
      </div>
      <div className="kpi">
        <div className="k">Subagents running</div>
        <div className="v mono">
          <span>{k?.agentsRunning ?? "–"}</span>
        </div>
      </div>
      <div className="kpi">
        <div className="k">Context blowouts</div>
        <div className="v mono">
          <span>{k?.blowoutsTotal ?? "–"}</span>
        </div>
        <div className="kpi-cap">{lvl2 ? `${lvl2} session${lvl2 > 1 ? "s" : ""} repeatedly over the limit` : "none repeating"}</div>
      </div>
      <div className="kpi">
        <div className="k">Plan steps done</div>
        <div className="v mono">{k ? `${k.planDone}/${k.planTotal}` : "–"}</div>
        <div className="kpi-cap">across all plans</div>
      </div>
      <div className="kpi">
        <div className="k" title={COST_TODAY_TITLE}>Est. cost today</div>
        <div className="v mono">{k ? fmtUsd(k.costToday) : "–"}</div>
        {k && k.unpricedSessions > 0 ? (
          <div className="kpi-cap" title={NO_PRICE_TITLE}>
            not counting {k.unpricedSessions} unpriced session{k.unpricedSessions > 1 ? "s" : ""}
          </div>
        ) : null}
        <Sparkline values={k?.costPerMinute ?? []} w={100} h={26} />
      </div>
      <div className="kpi">
        <div className="k">Tokens, last minute</div>
        {!!k?.incompleteSessions && <div className="kpi-cap">Partial telemetry: {k.incompleteSessions} session(s) without usage</div>}
        <div className="v mono">{k ? fmtTok(k.tokensLastMinute) : "–"}</div>
        <Sparkline values={k?.tokensPerSec ?? []} w={100} h={26} />
      </div>
    </div>
  );
}

export function Toolbar(props: {
  filter: { status: StatusFilter; q: string; engine?: string };
  onFilter: (f: { status: StatusFilter; q: string; engine?: string }) => void;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  shown: number;
  cleared: number;
  /** The people controls, drawn in this same row while the people view is on (#245). */
  people?: ComponentProps<typeof PeopleCluster>;
}) {
  const { filter, people } = props;
  const caption = `${props.shown} shown · ${props.cleared} cleared today`;
  return (
    // The wrapper is the container the row's width steps are measured against (fleet.css, "toolbar").
    <div className="toolbar">
      <div className={people ? "tools has-people" : "tools"}>
        <div className="fgrp">
          <div className="seg" role="group" aria-label="Filter by status">
            {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((k) => (
              <button type="button" key={k} aria-pressed={filter.status === k} onClick={() => props.onFilter({ ...filter, status: k })}>
                {STATUS_FILTERS[k]}
              </button>
            ))}
          </div>
          <label className="sortlab" htmlFor="podium-sort" title="Orders the cards inside each band">
            Sort by
          </label>
          <select className="sel" id="podium-sort" value={props.sort} onChange={(e) => props.onSort(e.target.value as SortKey)}>
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORTS[k]}
              </option>
            ))}
          </select>
          <select className="sel" aria-label="Filter by CLI" value={filter.engine ?? "all"} onChange={(e) => props.onFilter({ ...filter, engine: e.target.value })}>
            <option value="all">All CLIs</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="copilot">Copilot CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
          <input
            className="search"
            type="search"
            placeholder="Filter by name, project or branch"
            aria-label="Filter orchestrators"
            value={filter.q}
            onChange={(e) => props.onFilter({ ...filter, q: e.target.value })}
          />
        </div>
        {people && <PeopleCluster {...people} />}
        {!people && <span className="spacer" />}
        <span className="kpi-cap counts">{caption}</span>
        {people && (
          // Where the words do not fit beside the controls, the caption is this button's tooltip (fleet.css).
          <button type="button" className="info" aria-label={caption.replace(" · ", ", ")}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 7.2v4M8 4.8v.2" />
            </svg>
            <span className="tip" aria-hidden="true">
              {caption}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/** What the wall needs for the people view; absent while no session reports a person (the plain wall). */
export interface WallPeople {
  bar: ComponentProps<typeof PeopleCluster>;
  groupBy: GroupBy;
  /** Bands in order, built from every live session. */
  units: Unit[];
  /** Machine label per session id. */
  machines: Map<string, string>;
  /** Today's estimated spend, for each band's share. */
  total: number;
  /** Band keys collapsed to their header. */
  collapsed: ReadonlySet<string>;
  onToggleBand: (key: string) => void;
}

export function Wall(props: {
  sessions: SessionView[];
  totalLive: number;
  kpis: Kpis | null;
  split: Split;
  filter: { status: StatusFilter; q: string; engine?: string };
  onFilter: (f: { status: StatusFilter; q: string; engine?: string }) => void;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  cleared: number;
  now: number;
  config: LifecycleConfig;
  entering: (id: string) => boolean;
  leaving: Record<string, number>;
  onOpen: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Sessions nobody is attached to that were set aside, and whether they are being shown anyway. */
  detached: { count: number; costUsd: number; show: boolean; onToggle: () => void };
  /** Whether a notice is switched on in Admin > Settings (on unless turned off), and what closing one does. */
  noticeOn?: (id: string) => boolean;
  onCloseNotice?: (item: NoticeItem) => void;
  people?: WallPeople;
}) {
  const pv = props.people;
  // One set of columns for the whole wall, from the total shown, so every band lines up (#145).
  const wall = useWallColumns(props.sessions.length);
  const card = (s: SessionView, showName: boolean) => (
    <SessionCard
      key={s.id}
      s={s}
      now={props.now}
      config={props.config}
      entering={props.entering(s.id)}
      leaving={!!props.leaving[s.id]}
      onOpen={() => props.onOpen(s.id)}
      onRemove={props.onRemove ? () => props.onRemove?.(s.id) : undefined}
      owner={pv ? { machine: pv.machines.get(s.id) ?? null, showName } : undefined}
    />
  );
  const banded = pv && !isFlat(pv.groupBy);
  const notices: NoticeItem[] = [];
  if (props.detached.count > 0 && (props.noticeOn?.("background-sessions") ?? true)) {
    notices.push({
      id: "background-sessions",
      name: "Background sessions",
      body: (
        <>
          <b>
            {props.detached.count} background {props.detached.count === 1 ? "session" : "sessions"} {props.detached.show ? "shown" : "hidden"}
          </b>
          <span>nobody is attached{props.detached.costUsd > 0 ? `, ${fmtUsd(props.detached.costUsd)} so far` : ""}</span>
          <button type="button" className="link" onClick={props.detached.onToggle}>
            {props.detached.show ? "Hide them" : "Show them"}
          </button>
        </>
      ),
    });
  }
  return (
    <>
      <KpiStrip kpis={props.kpis} split={props.split} />
      <Toolbar filter={props.filter} onFilter={props.onFilter} sort={props.sort} onSort={props.onSort} shown={props.sessions.length} cleared={props.cleared} people={pv?.bar} />
      <div ref={wall.ref} className={wall.cols ? "wall-area has-cols" : "wall-area"} style={wall.cols ? ({ "--wall-cols": wall.cols } as CSSProperties) : undefined}>
        {props.sessions.length ? (
          banded ? (
            <Bands sessions={props.sessions} people={pv} card={card} />
          ) : (
            <div className="wall">{props.sessions.map((s) => card(s, !!pv && pv.groupBy !== "me"))}</div>
          )
        ) : null}
      </div>
      {props.sessions.length ? null : props.totalLive > (props.detached.show ? 0 : props.detached.count) ? (
        <div className="none">No orchestrators match. Clear the filter to see all {props.totalLive}.</div>
      ) : props.detached.count ? null : (
        <div className="none">
          <b>No Claude Code sessions are reporting.</b>
          <br />
          Start one with the reporter mod: <code>claude --plugin-dir mod/podium-reporter</code>, or run the simulator:{" "}
          <code>npm run podium:sim</code>.
        </div>
      )}
      <NoticeStack items={notices} onClose={(n) => props.onCloseNotice?.(n)} />
    </>
  );
}

/** The wall as bands: each band holds its shown sessions in the wall's sort order; a band with none shown is left out. */
function Bands({ sessions, people, card }: { sessions: SessionView[]; people: WallPeople; card: (s: SessionView, showName: boolean) => JSX.Element }) {
  const unitOf = new Map<string, string>();
  for (const u of people.units) for (const s of u.sessions) unitOf.set(s.id, u.key);
  const shownBy = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const k = unitOf.get(s.id);
    if (!k) continue;
    const list = shownBy.get(k) ?? [];
    list.push(s);
    shownBy.set(k, list);
  }
  return (
    <div className="bands">
      {people.units.map((u) => {
        const shown = shownBy.get(u.key);
        if (!shown?.length) return null;
        const key = `${people.groupBy}:${u.key}`;
        const machines = [...new Set(u.sessions.map((s) => people.machines.get(s.id)).filter((m): m is string => !!m))];
        // A person's own band already names them; a group band names each card's owner.
        const showName = u.kind !== "person" && u.kind !== "admin" && u.kind !== "unassigned";
        return (
          <Band key={u.key} unit={u} total={people.total} machines={machines} open={!people.collapsed.has(key)} onToggle={() => people.onToggleBand(key)} shown={shown.length}>
            {shown.map((s) => card(s, showName))}
          </Band>
        );
      })}
    </div>
  );
}
