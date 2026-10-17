// #/history (SPEC T5.3): sessions that ended or were dropped on a day, and a read-only orchestrator
// page for one of them, built from its stored rows.
import { useEffect, useRef, useState } from "react";
import "./fleet.css";
import { fmtClock, fmtDur } from "./format";
import type { AgentSortKey } from "./logic";
import { defaultAgentDir, ORCHESTRATOR_ROW } from "./logic";
import { AgentDetail } from "./components/AgentDetail";
import { OrchestratorDetail } from "./components/OrchestratorDetail";
import type { AgentSort } from "./components/AgentTree";
import { Cost, ModelChip } from "./components/Chips";
import { FocusView } from "./components/FocusView";
import { BrandLink } from "./components/BrandLink";
import { ThemePicker } from "./components/ThemePicker";
import { PAGE_SIZES, Pager } from "./admin/Pager";
import { useTheme } from "./useTheme";
import { APP_NAME, type HistoryRow, type SessionView } from "./types";


export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** What the address holds so a reload, a shared link and the browser's Back button all land on the same list (#195). */
interface Where {
  day: string;
  page: number;
  size: number;
  open: string | null;
}

const DEFAULT_SIZE = 50;

function parseHash(hash: string): Partial<Where> {
  const q = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  const day = q.get("day");
  const page = Number(q.get("page"));
  const size = Number(q.get("size"));
  return {
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    size: PAGE_SIZES.includes(size) ? size : DEFAULT_SIZE,
    open: q.get("open") || null,
  };
}

function hashFor(w: Where): string {
  const q = new URLSearchParams({ day: w.day, page: String(w.page), size: String(w.size) });
  if (w.open) q.set("open", w.open);
  return `#/history?${q.toString()}`;
}

interface Paged {
  day: string;
  rows: HistoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 404 ? "not found" : `HTTP ${res.status}`);
  return (await res.json()) as T;
}

const CONFIG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };

export function HistoryView({ base = "/api/fleet", initialDay }: { base?: string; initialDay?: string }) {
  const theme = useTheme();
  const [where, setWhere] = useState<Where>(() => {
    const p = parseHash(window.location.hash);
    return { day: p.day ?? initialDay ?? localDay(Date.now()), page: p.page ?? 1, size: p.size ?? DEFAULT_SIZE, open: p.open ?? null };
  });
  const whereRef = useRef(where);
  const [rows, setRows] = useState<Load<Paged>>({ state: "loading" });
  const [session, setSession] = useState<Load<SessionView> | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [sort, setSort] = useState<AgentSort>({ key: null, dir: 1 });

  const { day, page, size, open: openId } = where;

  /** Changes part of the address. Opening a session pushes an entry so Back returns to the list; every other change replaces the current one. */
  const go = (patch: Partial<Where>, mode: "push" | "replace" = "replace") => {
    const next = { ...whereRef.current, ...patch };
    whereRef.current = next;
    setWhere(next);
    window.history[mode === "push" ? "pushState" : "replaceState"]({ open: next.open !== null }, "", hashFor(next));
  };

  useEffect(() => {
    document.title = `${APP_NAME} history`;
  }, []);

  useEffect(() => {
    const onPop = () => {
      // A Back or link click to another page also fires popstate; leave the list alone while it unmounts.
      if (!window.location.hash.startsWith("#/history")) return;
      const p = parseHash(window.location.hash);
      const next = { day: p.day ?? whereRef.current.day, page: p.page ?? 1, size: p.size ?? DEFAULT_SIZE, open: p.open ?? null };
      whereRef.current = next;
      setWhere(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let live = true;
    // The table of the page being left stays up while the next one loads; another day's table does not.
    setRows((r) => (r.state === "ok" && r.data.day === day ? r : { state: "loading" }));
    getJson<{ sessions: HistoryRow[]; total: number; page: number; pageSize: number }>(
      `${base}/history?day=${encodeURIComponent(day)}&page=${page}&pageSize=${size}`,
    )
      .then((b) => {
        if (!live) return;
        setRows({ state: "ok", data: { day, rows: b.sessions, total: b.total, page: b.page, pageSize: b.pageSize } });
        // The server moves a page past the end back to the last one; the address follows.
        if (b.page !== page) go({ page: b.page });
      })
      .catch((e: Error) => live && setRows({ state: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, [base, day, page, size]);

  useEffect(() => {
    if (!openId) {
      setSession(null);
      return;
    }
    let live = true;
    setSession({ state: "loading" });
    setAgent(null);
    getJson<SessionView>(`${base}/sessions/${encodeURIComponent(openId)}`)
      .then((s) => live && setSession({ state: "ok", data: s }))
      .catch((e: Error) => live && setSession({ state: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, [base, openId]);

  const onSort = (key: AgentSortKey | null) =>
    setSort((cur) => (key === null ? { key: null, dir: 1 } : cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: defaultAgentDir(key) }));

  const s = session?.state === "ok" ? session.data : null;
  const selected = s && agent ? s.agents.find((a) => a.id === agent) : undefined;

  return (
    <div className="podium">
      <div className="app" style={{ gridTemplateRows: "auto auto 1fr" }}>
        <header className="top">
          <BrandLink />
          <span className="pill">History</span>
          <span className="spacer" />
          <a className="btn" href="#/">
            Live fleet
          </a>
        </header>
        <div className="banner has-picker">
          <span>
            <b>Past sessions.</b> Read-only: built from what the server stored. Cost is an estimate, not a bill.
          </span>
          <ThemePicker theme={theme} />
        </div>
        <div className="history">
          <main className="main">
            {s ? (
              <>
                <button type="button" className="back" style={{ padding: "0 0 10px" }} onClick={() => (window.history.state?.open ? window.history.back() : go({ open: null }))}>
                  ← Back to {day}
                </button>
                <FocusView s={s} now={s.lastSeenAt} config={CONFIG} sort={sort} onSort={onSort} selectedAgent={agent} flashAgent={null} onAgent={setAgent} />
              </>
            ) : session?.state === "loading" ? (
              <div className="none">Loading the session…</div>
            ) : session?.state === "error" ? (
              <div className="none">Could not load that session ({session.message}).</div>
            ) : (
              <>
                <div className="tools">
                  <label className="sortlab" htmlFor="podium-day">
                    Day
                  </label>
                  <input id="podium-day" className="search" type="date" value={day} onChange={(e) => e.target.value && go({ day: e.target.value, page: 1 })} />
                  <span className="spacer" />
                  {rows.state === "ok" && <span className="kpi-cap">{rows.data.total} sessions ended</span>}
                </div>
                {rows.state === "loading" ? (
                  <div className="none">Loading…</div>
                ) : rows.state === "error" ? (
                  <div className="none">Cannot reach the Podium server ({rows.message}). Start it with npm run dev.</div>
                ) : rows.data.total === 0 ? (
                  <div className="none">No sessions ended on {day}.</div>
                ) : (
                  <div className="sec tw">
                    <table className="htable">
                      <thead>
                        <tr>
                          <th>Session</th>
                          <th>Project</th>
                          <th>Model</th>
                          <th className="num">Ended</th>
                          <th className="num">Duration</th>
                          <th className="num">Est. cost</th>
                          <th className="num">Blowouts</th>
                          <th className="num">Agents</th>
                          <th>End reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.data.rows.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <button type="button" className="lk" onClick={() => go({ open: r.id }, "push")}>
                                {r.name}
                              </button>
                              {r.integration && <span className="chip">{r.integration.engine}</span>}
                            </td>
                            <td className="mono">{r.project}</td>
                            <td>
                              <ModelChip family={r.modelFamily} model={r.model} />
                            </td>
                            <td className="num">{fmtClock(r.endedAt)}</td>
                            <td className="num">{fmtDur(r.durationSec)}</td>
                            <td className="num"><Cost usd={r.costUsd} family={r.modelFamily} /></td>
                            <td className="num">{r.blowouts || "–"}</td>
                            <td className="num">{r.agents}</td>
                            <td>
                              {r.endReason ?? "–"}
                              {/* A /clear links the two parts of one conversation (#206). */}
                              {r.clearedInto && (
                                <div className="clr">
                                  <button type="button" className="lk" title="The session that went on after /clear" onClick={() => go({ open: r.clearedInto }, "push")}>
                                    continued in {r.clearedInto.slice(0, 8)}
                                  </button>
                                </div>
                              )}
                              {r.clearedFrom && (
                                <div className="clr">
                                  <button type="button" className="lk" title="The session this one went on from after /clear" onClick={() => go({ open: r.clearedFrom }, "push")}>
                                    after /clear of {r.clearedFrom.slice(0, 8)}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Pager id="history" page={rows.data.page} pageSize={rows.data.pageSize} total={rows.data.total} onPage={(n) => go({ page: n })} onSize={(n) => go({ size: n, page: 1 })} />
                  </div>
                )}
              </>
            )}
          </main>
          {s && (selected || agent === ORCHESTRATOR_ROW) && (
            <aside className="side" aria-label="Agent detail">
              {agent === ORCHESTRATOR_ROW ? (
                <OrchestratorDetail s={s} now={s.lastSeenAt} onBack={() => setAgent(null)} />
              ) : (
                selected && <AgentDetail s={s} a={selected} now={s.lastSeenAt} onBack={() => setAgent(null)} onAgent={setAgent} />
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
