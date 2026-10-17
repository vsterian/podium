// The Podium fleet console: top bar, the orchestrator rail, the wall or one orchestrator's page, and
// the activity / agent panel. Data comes from useFleet; everything here is presentation state.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./fleet.css";
import { idleOnBackground } from "./waiting";
import { filterSessions, defaultAgentDir, sortSessions, splitDetached, type AgentSortKey, type SortKey, type StatusFilter } from "./logic";
import { PAGE } from "./components/ActivityList";
import type { AgentSort } from "./components/AgentTree";
import { FocusView } from "./components/FocusView";
import { ThemePicker } from "./components/ThemePicker";
import { Rail, type Split } from "./components/Rail";
import { ResizeHandle } from "./components/ResizeHandle";
import { SidePanel } from "./components/SidePanel";
import { TopBar } from "./components/TopBar";
import { Legend } from "./components/Legend";
import { Wall } from "./components/Wall";
import { NoticeClosed, type NoticeItem } from "./components/NoticeStack";
import { closeNotice, removeSession, setShowBackgroundSessions, useFleet, type UseFleetOptions } from "./useFleet";
import { useNow } from "./useNow";
import { useHeldState } from "./useHeldState";
import { isUrgentChange, readUpdateEvery, writeUpdateEvery } from "./updateInterval";
import { UpdateEveryPicker } from "./components/UpdateEveryPicker";
import { useResizable } from "./useResizable";
import { useTheme } from "./useTheme";
import { useHotkeys } from "./useHotkeys";
import { useIdle } from "./useIdle";
import { usePageVisible } from "./usePageVisible";
import { useHeartbeat } from "./useHeartbeat";
import { usePanes } from "./usePanes";
import { usePeoplePrefs } from "./usePeoplePrefs";
import { ADMIN, buildUnits, filterByPeople, machineLabels, meKey, NO_FILTER, orderUnits, peopleActive, type GroupBy, type PeopleFilter, type Unit } from "./people";
import type { WallPeople } from "./components/Wall";
import type { RailPeople } from "./components/Rail";
import { APP_NAME, type ActivityView } from "./types";
import { reportersLive, type FleetState } from "./store";
import { RespondProvider, useRespond } from "./useRespond";
import type { RespondApi } from "./respondApi";
import { RespondModal } from "./components/Respond";
import type { SessionView } from "./types";


const ENTER_MS = 1000;

/** The Respond modal (#206), for whichever live session it was opened on; it closes by itself if that session leaves. */
function RespondHost(props: { sessions: Record<string, SessionView>; now: number; adminFeedOn: boolean }) {
  const ctx = useRespond();
  const s = ctx?.openFor ? props.sessions[ctx.openFor] : undefined;
  useEffect(() => {
    if (ctx?.openFor && !s) ctx.close();
  }, [ctx, s]);
  return s ? <RespondModal s={s} now={props.now} adminFeedOn={props.adminFeedOn} /> : null;
}

/** Marks ids that appeared after the first render, for one second, so they play the enter animation. */
function useEntering(ids: readonly string[], ready: boolean): (id: string) => boolean {
  const first = useRef(new Map<string, number>());
  const primed = useRef(false);
  const now = Date.now();
  if (ready) {
    for (const id of ids) if (!first.current.has(id)) first.current.set(id, primed.current ? now : 0);
    primed.current = true;
  }
  return (id: string) => {
    const t = first.current.get(id);
    return !!t && now - t < ENTER_MS;
  };
}

export interface FleetAppProps {
  /** For tests: drive the app from a given state instead of the server. */
  state?: FleetState;
  fleetOptions?: UseFleetOptions;
}

function LiveFleetApp({ fleetOptions }: { fleetOptions?: UseFleetOptions }) {
  const live = useFleet(fleetOptions);
  const [every, setEvery] = useState(readUpdateEvery);
  // The page below redraws once per chosen interval (#138); a session needing the viewer or a failure shows at once.
  const state = useHeldState(live, every * 1000, isUrgentChange);
  const change = useCallback((n: number) => {
    setEvery(n);
    writeUpdateEvery(n);
  }, []);
  return <FleetView state={state} updateEvery={every} onUpdateEvery={change} />;
}

export function FleetApp(props: FleetAppProps = {}) {
  useEffect(() => {
    document.title = APP_NAME;
  }, []);
  if (props.state) return <FleetView state={props.state} />;
  return <LiveFleetApp fleetOptions={props.fleetOptions} />;
}

interface FleetViewProps {
  state: FleetState;
  /** Seconds between redraws; the clock moves on the same interval. */
  updateEvery?: number;
  onUpdateEvery?: (seconds: number) => void;
  /** For tests: the respond API, so the sign-in the wall reads "me" from can be faked. */
  respondApi?: RespondApi;
}

// Memoized so the held state, which keeps its identity between updates, stops a parent render from redrawing it.
// The respond provider sits above the view so the wall itself can read who is signed in (#245).
export const FleetView = memo(function FleetView(props: FleetViewProps) {
  const respondFlags = props.state.features.respond === true && props.state.features["activity-feed"] !== false;
  return (
    <RespondProvider flagsOn={respondFlags} api={props.respondApi}>
      <FleetViewBody state={props.state} updateEvery={props.updateEvery} onUpdateEvery={props.onUpdateEvery} />
    </RespondProvider>
  );
});

function FleetViewBody({ state, updateEvery = 2, onUpdateEvery }: FleetViewProps) {
  const now = useNow(updateEvery * 1000);
  const theme = useTheme();
  const [sel, setSel] = useState<string | null>(null);
  const [selAgent, setSelAgent] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ status: StatusFilter; q: string; engine?: string }>({ status: "all", q: "" });
  const [sort, setSort] = useState<SortKey>("status");
  const [evShow, setEvShow] = useState(PAGE);
  const [aSort, setASort] = useState<AgentSort>({ key: null, dir: 1 });
  const [notice, setNotice] = useState<string | null>(null);
  const cols = useRef<HTMLDivElement>(null);
  const container = useCallback(() => cols.current, []);
  const resize = useResizable(container);
  const panes = usePanes();
  const idle = useIdle(panes.wall);
  const visible = usePageVisible();
  const root = useRef<HTMLDivElement>(null);
  useHeartbeat(root, visible);
  const fullscreen = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const all = useMemo(() => Object.values(state.sessions), [state.sessions]);
  const live = all.filter((s) => !state.leaving[s.id]);
  const sorted = useMemo(() => sortSessions(all, sort), [all, sort]);
  const showDetached = state.wall.showBackgroundSessions;
  const [closed, setClosed] = useState<string | null>(null);
  const sets = splitDetached(sorted, now, showDetached);
  // The people view (#34) switches on once any live session belongs to a named person.
  const people = usePeoplePrefs();
  const [pf, setPf] = useState<PeopleFilter>(NO_FILTER);
  const active = peopleActive(live);
  // Who "me" is comes from the browser's sign-in (#245): a signed-in person, never Admin. Signed out there is no "me".
  const signedIn = useRespond()?.me;
  const me = signedIn?.signedIn && signedIn.name && signedIn.name.toLowerCase() !== ADMIN.toLowerCase() ? signedIn.name : null;
  // A remembered Me means nothing without a sign-in, so the wall is grouped by People until someone signs in.
  const groupBy: GroupBy = people.prefs.groupBy === "me" && !me ? "people" : people.prefs.groupBy;
  const myKey = active ? meKey(sorted, me) : null;
  const peopleFilter: PeopleFilter = groupBy === "me" && myKey ? { person: myKey, group: null } : pf;
  const peopleShown = active ? filterByPeople(sets.shown, peopleFilter) : sets.shown;
  const shown = filterSessions(peopleShown, filter);
  const split: Split = {
    running: live.filter((s) => s.status === "running").length,
    // A session idle on background work is not waiting on the person (#119).
    waiting: live.filter((s) => s.status === "waiting" && !idleOnBackground(s)).length,
    stale: live.filter((s) => s.status === "stale").length,
  };
  const reporters = reportersLive(state.sessions, state.leaving);
  const outdated = live.filter((s) => s.compat === "outdated").length;
  const newer = live.filter((s) => s.compat === "newer").length;
  const ready = state.phase !== "loading";
  const enteringSession = useEntering(all.map((s) => s.id), ready);
  const newEvent = useEntering(state.events.map((e) => e.id), ready);
  const selected = sel ? state.sessions[sel] ?? null : null;

  const { prefs } = people;
  const spendByOwner = state.kpis?.costTodayByOwner ?? [];
  const units: Unit[] = active ? orderUnits(buildUnits(sorted, groupBy, spendByOwner, me), prefs.order) : [];
  const pickUnit = (u: Unit) => {
    const asGroup = u.kind === "group" || u.kind === "nogroup";
    setPf((cur) => (asGroup ? { person: null, group: cur.group === u.key ? null : u.key } : { person: cur.person === u.key ? null : u.key, group: null }));
  };
  const wallPeople: WallPeople | undefined = active
    ? {
        bar: {
          groupBy,
          onGroupBy: (g) => {
            people.setPrefs({ groupBy: g });
            setPf(NO_FILTER);
          },
          order: prefs.order,
          onOrder: (o) => people.setPrefs({ order: o }),
          canMe: !!me,
        },
        groupBy,
        units,
        machines: machineLabels(sorted),
        total: state.kpis?.costToday ?? 0,
        collapsed: new Set(prefs.collapsed),
        onToggleBand: people.toggleBand,
      }
    : undefined;
  const railPeople: RailPeople | undefined = active
    ? { groupBy, units, picked: pf.person ?? pf.group, onPick: pickUnit, visible: new Set(filterByPeople(sorted, peopleFilter).map((s) => s.id)) }
    : undefined;

  // A selected session that leaves the live set clears the selection, with a message.
  useEffect(() => {
    if (!sel) return;
    if (state.gone[sel] || (ready && !state.sessions[sel])) {
      const name = state.sessions[sel]?.name ?? "That session";
      setNotice(`${name} ${state.gone[sel] === "dropped" ? "stopped reporting" : "ended"} and left the fleet.`);
      setSel(null);
      setSelAgent(null);
    }
  }, [sel, state.gone, state.sessions, ready]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const flashRow = useCallback((id: string | null) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(null);
    if (!id) return;
    (window.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16)))(() => setFlash(id));
    flashTimer.current = setTimeout(() => setFlash(null), 1700);
  }, []);

  const selectSession = (id: string | null) => {
    setSel(id);
    setSelAgent(null);
    setNotice(null);
  };
  const onCloseNotice = (n: NoticeItem) => {
    closeNotice(n.id)
      .then(() => setClosed(n.name))
      .catch((err: Error) => setNotice(`Could not close the notice: ${err.message}. Try again.`));
  };
  // The confirmation clears itself after about 9 seconds.
  useEffect(() => {
    if (closed === null) return;
    const t = setTimeout(() => setClosed(null), 9000);
    return () => clearTimeout(t);
  }, [closed]);

  const onRemove = (id: string) => {
    removeSession(id).catch((err: Error) => setNotice(`Could not remove the session: ${err.message}. Try again.`));
  };
  const selectAgent = (id: string) => {
    setSelAgent(id);
    flashRow(null);
  };
  const openEvent = (e: ActivityView) => {
    const s = state.sessions[e.sessionId];
    if (!s || state.gone[e.sessionId]) return;
    const agent = e.agentId && s.agents.some((a) => a.id === e.agentId) ? e.agentId : null;
    setSel(e.sessionId);
    setSelAgent(agent);
    setNotice(null);
    flashRow(agent);
    const side = document.querySelector(".podium .side");
    if (side) side.scrollTop = 0;
  };
  const onAgentSort = (key: AgentSortKey | null) => {
    setASort((cur) => (key === null ? { key: null, dir: 1 } : cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: defaultAgentDir(key) }));
  };

  // A collapsed pane keeps a slim 24 px tab; its saved width comes back when it opens again.
  const colStyle = {
    ...(panes.collapsed.left
      ? { ["--rail-w" as string]: "24px" }
      : resize.widths.rail !== undefined ? { ["--rail-w" as string]: `${resize.widths.rail}px` } : {}),
    ...(panes.collapsed.right
      ? { ["--side-w" as string]: "24px" }
      : resize.widths.side !== undefined ? { ["--side-w" as string]: `${resize.widths.side}px` } : {}),
  };

  const { enterWall, exitWall } = panes;
  // Fullscreen is only ever asked for from the click on the wall mode button, and a refusal changes nothing.
  const startWall = (fromClick: boolean) => {
    enterWall();
    if (!fromClick) return;
    try {
      const asked = document.documentElement.requestFullscreen?.();
      if (asked) {
        fullscreen.current = true;
        asked.catch(() => {
          fullscreen.current = false;
        });
      }
    } catch {
      fullscreen.current = false;
    }
  };
  const stopWall = exitWall;
  // Wall mode ends by any route (button, Esc, opening a pane from its tab), so fullscreen is released here.
  useEffect(() => {
    if (!panes.wall && fullscreen.current) {
      fullscreen.current = false;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    }
  }, [panes.wall]);
  // Leaving fullscreen with the browser's own Esc also leaves wall mode.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && fullscreen.current) {
        fullscreen.current = false;
        exitWall();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [exitWall]);

  const { toggle } = panes;
  // In the top bar's own row while it is open, floating in the corner once it is collapsed.
  const wallButton = panes.wall ? (
    <button type="button" className="btn wall-exit" data-wall-control onClick={stopWall} aria-label="Exit wall mode" title="Exit wall mode (Esc)">
      Exit wall mode
    </button>
  ) : (
    <button type="button" className="btn wall-enter" data-wall-control onClick={() => startWall(true)} aria-label="Enter wall mode" title="Collapse everything for a wall display (w)">
      Wall mode
    </button>
  );
  useHotkeys((e) => {
    if (e.key === "[") toggle("left");
    else if (e.key === "]") toggle("right");
    else if (e.key === "\\") toggle("top");
    else if (e.key === "w" || e.key === "W") (panes.wall ? stopWall : () => startWall(false))();
    else if (e.key === "Escape" && panes.wall) stopWall();
  });

  return (
    <div ref={root} className={`podium${panes.wall ? " wall-on" : ""}${idle ? " idle" : ""}${visible ? "" : " paused"}`}>
      {panes.collapsed.top && (
        <div className="wall-ctl" data-wall-control>
          {wallButton}
        </div>
      )}
      <div className="app">
        <TopBar
          page={selected ? "Orchestrator" : "Fleet"}
          phase={state.phase}
          reporters={reporters}
          outdated={outdated}
          newer={newer}
          collapsed={panes.collapsed.top}
          onCollapse={() => toggle("top")}
          wall={wallButton}
        />
        {panes.collapsed.top && (
          <div className={`strip${state.phase === "disconnected" ? " bad" : ""}`}>
            <button type="button" aria-expanded="false" aria-controls="podium-top" title={"Show the top bar (\\)"} onClick={() => toggle("top")}>
              Show top bar
            </button>
          </div>
        )}
        {state.phase === "disconnected" ? (
          <div className="banner bad" role="alert">
            <b>Lost the connection to the Podium server.</b> Retrying every 2 seconds. Numbers below are frozen until it reconnects.
          </div>
        ) : state.phase === "loading" && state.error ? (
          <div className="banner bad" role="alert">
            <b>Cannot reach the Podium server.</b> Start it with <code>npm run dev</code> (or <code>npm run dev -w server</code>); this page connects by itself.
          </div>
        ) : panes.collapsed.top ? null : (
          <div className="banner has-picker">
            <span>
              <b>Live fleet.</b> Cost is an estimate from token counts and a price table, not a bill.
            </span>
            <div className="bannerctl">
              <UpdateEveryPicker every={updateEvery} onChange={(n) => onUpdateEvery?.(n)} />
              <ThemePicker theme={theme} />
            </div>
          </div>
        )}
        <div className="cols" ref={cols} style={colStyle}>
          <Rail
            sessions={sorted}
            selected={sel}
            onSelect={(id) => {
              // "All orchestrators" also drops a person or group picked in the list.
              if (id === null) setPf(NO_FILTER);
              selectSession(id);
            }}
            split={split}
            entering={enteringSession}
            leaving={state.leaving}
            liveCount={live.length}
            onRemove={onRemove}
            version={state.server?.version ?? null}
            collapsed={panes.collapsed.left}
            onToggle={() => toggle("left")}
            people={railPeople}
          />
          <div className="mid">
            <main className="main" id="podium-main">
              {notice && (
                <div className="callout notice" role="status">
                  <div>{notice}</div>
                </div>
              )}
              {state.phase === "loading" && !state.error ? (
                <div className="none">Connecting to the Podium server…</div>
              ) : selected ? (
                <FocusView
                  s={selected}
                  now={now}
                  config={state.config}
                  sort={aSort}
                  onSort={onAgentSort}
                  selectedAgent={selAgent}
                  flashAgent={flash}
                  onAgent={selectAgent}
                  onRemove={onRemove}
                />
              ) : (
                <Wall
                  sessions={shown}
                  totalLive={all.length}
                  kpis={state.kpis}
                  split={split}
                  filter={filter}
                  onFilter={setFilter}
                  sort={sort}
                  onSort={setSort}
                  cleared={state.clearedToday}
                  now={now}
                  config={state.config}
                  entering={enteringSession}
                  leaving={state.leaving}
                  onOpen={selectSession}
                  onRemove={onRemove}
                  detached={{
                    count: sets.hidden.length,
                    costUsd: sets.hidden.reduce((n, s) => n + (s.costUsd ?? 0), 0),
                    show: showDetached,
                    onToggle: () =>
                      setShowBackgroundSessions(!showDetached).catch((err: Error) => setNotice(`Could not change the setting: ${err.message}. Try again.`)),
                  }}
                  noticeOn={(id) => state.wall.notices[id] !== false}
                  onCloseNotice={onCloseNotice}
                  people={wallPeople}
                />
              )}
              {closed !== null && <NoticeClosed name={closed} onDismiss={() => setClosed(null)} />}
            </main>
            <Legend />
          </div>
          <SidePanel
            events={state.events}
            sessions={state.sessions}
            gone={state.gone}
            selected={selected}
            selectedAgent={selAgent}
            shown={evShow}
            onShown={setEvShow}
            isNew={newEvent}
            onOpenEvent={openEvent}
            onAgent={selectAgent}
            onBack={() => setSelAgent(null)}
            now={now}
            activityFeedOn={state.features["activity-feed"] !== false}
            collapsed={panes.collapsed.right}
            onToggle={() => toggle("right")}
          />
          {!panes.collapsed.left && <ResizeHandle panel="rail" r={resize} container={container} label="Resize orchestrator list" />}
          {!panes.collapsed.right && <ResizeHandle panel="side" r={resize} container={container} label="Resize activity panel" />}
        </div>
      </div>
      <RespondHost sessions={state.sessions} now={now} adminFeedOn={state.features["activity-feed"] !== false} />
    </div>
  );
}

export default FleetApp;
