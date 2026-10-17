# Architecture

This repo holds **Podium**, a live fleet console for Claude Code sessions: the reporter mod
(`mod/podium-reporter/`), an Express server (`server/src/fleet/`) and a Vite frontend (`frontend/src/fleet/`),
the default view at `#/`. An earlier usage dashboard lived here until it was removed (DECISIONS 15).

`docs/SPEC.md` is the build spec for Podium. This file records how it was actually built, where it differs
from the spec and why, what was verified, and what is still open.

## How Podium fits together

```
 Claude Code session ──(reporter mod: hooks -> state.ts reducers -> report.ts)──┐
 Claude Code session ──(  flush timer: POST /api/fleet/report every 1 s when   )──┼──> server (Express, 127.0.0.1:4317)
 simulator (podium-sim) ─(  something changed, 5 s heartbeat, backoff offline )──┘      routes.ts: validate (protocol.ts)
                                                                                        fleet.ts:  ingest.ts -> SQLite (db.ts)
 browser (React, frontend/src/fleet) <── GET /api/fleet/state (first paint) ──────────   derive.ts: SessionView, KPIs, series
                                     <── GET /api/fleet/stream (SSE) ─────────────────   sse.ts + sweeper.ts (stale, drop, linger,
                                                                                         samples, retention, 2 s tick)
```

**The mod** (`mod/podium-reporter/`) runs in each Claude Code process. Hooks only update an in-memory
model through pure reducers (`state.ts`, `plan.ts`, `failures.ts`) and never wait on the network; a
`$.clock.every` timer reads `$.session.id()`, `$.session.usage()` and `$.agent.list()`, and posts a full
snapshot plus unacknowledged events (`transport.ts`). Git is polled every 10 s (`pollGit` in `register.ts`, reading through `git.ts`). `session.end`
sends the final report inside a 1 s deadline. A changed session id (after `/clear` or a resume) closes
the old id with a `done` report and starts over under the new one.

**The server** (`server/src/fleet/`) validates every report by hand (`protocol.ts`), stores it in one
transaction (`ingest.ts`: upsert session and agents, insert events and blowout rows idempotently, one
sample per second), and broadcasts the changed `SessionView` (at most one per session per 500 ms) and
each new event over SSE. `fleet.ts` owns the live set and time: the sweeper (`sweeper.ts`) runs every
second (stale at 15 s, dropped 60 s later, ended sessions linger 8 s, carry-forward samples), ticks KPIs
every 2 s and prunes hourly. `derive.ts` turns rows into views and is pure.

**The UI** (`frontend/src/fleet/`) is the mockup in React. `useFleet` loads `/state`, applies stream
messages with a pure reducer (`store.ts`), treats 6 s of silence as disconnected and reopens the stream
(whose first message is a full snapshot). Sorting, filtering, the agent tree and chart points are pure
functions in `logic.ts` and `chart.ts`. Styles are `fleet.css`, the mockup's tokens scoped under
`.podium`. The UI computes nothing it could not recompute from one `SessionView`.

**Who is reporting, and Admin** (`server/src/fleet/tokens.ts`, `people.ts`, `server/src/admin/adminRouter.ts`).
`routes.ts` turns the `X-Podium-Token` header into an identity before it reads a body: a person's token
(`pdm_<key id>_<secret>`, found by key id, checked against a stored SHA-256 in constant time), the admin secret
(`PODIUM_TOKEN`), or open when auth is off. The identity gives the session its `owner`, written by `ingest.ts`
into `sessions.owner`; for a person's token the report's `userName` must also match, so the token decides who
and the name is only a consistency check. `people.ts` owns the migration-6 tables (people, groups,
person_machines, admin_log, settings) and every paged query. The Admin API is a separate router mounted at
`/api/admin`: an unlock exchanges a name and token (an Administrator's own, #172, or `Admin` with the admin secret, checked by `fleet/nameToken.ts` as the sign-in to respond is) for a random session id held in a process-memory map (with who opened it, checked again on every request) and an
`HttpOnly; SameSite=Strict` cookie, with idle expiry, a per-address lockout and a required `X-Podium-Admin`
header on changes. The Admin page (`frontend/src/fleet/admin/`, route `#/admin`) holds a new token in component
state only until the owner says it is saved. A restart ends every Admin session, which is also how rotating the
admin secret ends them. A browser already signed in to respond as an Administrator opens Admin with no second sign-in (#215): the respond routes
widen their cookie to `Path=/api` and fill in a `RespondBridge` (`fleet/respondBridge.ts`) that the Admin router asks on `POST unlock/from-respond`. `POST lock` calls the bridge's `hold` to mark that sign-in so `administratorOf` answers
null until `POST unlock` calls `release` for that same person or the person signs in to respond again (#272).
The top bar's Admin button reads `me.admin` from `useRespond`; the server, not the button, is the check.

**Admin page patterns** (`frontend/src/fleet/admin/Page.tsx`, `admin.css`, issue #143, mockup `mockup/podium-admin.html`). `AdminView`
holds a side menu (`NAV` groups the pages and gives each group an outline icon from `GROUP_ICON`, `PAGES` names each page and gives its one-line lead; issue #244, mockup `mockup/podium-admin-menu.html`) and renders one page component at a time;
the menu and the page scroll on their own inside `.adminv`, so the menu always runs the full height with Lock Admin and the footer at
the bottom. A page component returns sections only: `AdminView` draws the header (`PageHeader`), and each section is `Section`
(an H2 with an optional help line) around a `Panel`. A list is a panel holding an optional toolbar (`.tool`), the table (`.ptab`) and
`Pager`; an on/off setting is a `SwitchRow`; a new page adds an entry to `PAGES` and `NAV` and follows the same shape, so a later tab
copies the pattern instead of inventing one. Spacing steps are 4, 8, 12, 16, 24 and 32 px; buttons are 30 px, or 26 px (`.sm`) in a
table row. Admin's CSS is scoped under `.adminv` and its layout classes are prefixed (`asec`, `apage`) because `fleet.css` already
uses `.sec`, `.main`, `.code` and `.back` under `.podium`, with higher specificity.

**Tooltips** (`frontend/src/fleet/components/Tip.tsx`, issue #275). A note on a word or badge is a `Tip`: a focusable `span.tip` holding a `role="tooltip"` child, which the trigger names with `aria-describedby`, so a screen reader reads the text whether or not the box is open. React un-hides the box on mouse enter and on focus and hides it on mouse leave (while the trigger is not focused), blur and Escape, so a test can drive it with `fireEvent`; a native `title` is not shown on keyboard focus, which is why `title` plus `tabIndex` is not used for these. The box is `position: fixed`, placed from the trigger's rectangle and kept inside the viewport, so the Reporters table's scroll container cannot clip it; it wraps and is at most 20 rem wide. Admin > Reporters (state, admin secret, "no name set") and the Kind row use it.

**Fleet card** (`frontend/src/fleet/components/SessionCard.tsx`, issue #144, mockup `mockup/podium-card.html`). The card is one `button.card.sc` holding four children in a fixed order: `.z1` (who and where, plus the tags in `.notes`), `.z2` (plan and the agent strip with its sparkline), `.z3` (four readouts) and `.band`. `.z2` has `margin-top: auto`, so when a row makes a card taller than its content the spare height opens between `.z1` and `.z2`, and `.z2`, `.z3` and the band stay together on the card's bottom edge, so they line up across the row; the card is `overflow: hidden` so it can run edge to edge inside the rounded corners. `cardKind` in `Chips.tsx` maps a session to one of five kinds (running, waiting, bg, stale, done; background work wins over waiting, as in `idleOnBackground`), and `StateIcon` draws that kind's shape, so the name marker and the band use one source and state is never color alone. The kind class on the band (`.band.waiting`, `.band.bg`...) sets `--c` and `--c-text`; `.hot` is the heavier tint for waiting and stale; every kind has the same thin top line. Remove cannot sit inside the card's button, so on a heartbeat-lost card it is a sibling in `.card-slot`, laid over the right end of the band (`.remove-bar`, absolutely positioned from the bottom edge, which works because the band has a fixed `min-height`). The layout rules hang on `.card.sc`.

**Orchestrator page** (`FocusView.tsx`, issue #165, mockup `mockup/podium-orchestrator.html`). `FocusView` renders `.op` (a size container, so the page's breakpoints are `@container` queries on its own width: facts to two columns at 520 px, plan and tree stacked at 700 px) holding `.osum`, the one bordered surface, and `.two`. `.osum` has the children `.fh` (`FocusHeader`), the blowout detail `.bdet` only while open, `.facts` (`FactsBar`) and `.band` (`StatusBand`), always in that order and with the band last. The band reuses the card's `cardKind`, `bandLine` and `waitSummary`; `stateKind` in `Chips.tsx` adds `deleg` (SPEC 8.1); the card, the rail item and this page all call it, with `delegatesOf` giving the delegates, so they cannot disagree (#287). `FocusView` computes `waitingOnByRow` and the kind once per render and passes them to `FocusHeader`, `StatusBand` and `AgentTree`, so the shape beside the name, the band and the tree rows never disagree. Remove now is a child of the band, absolutely positioned over its right end; the band reserves right padding for it (`.has-rm`), and below 520 px it moves under the text. `.fh` is a stretching flex row, so `.hcs` (the three charts) is as tall as the header (#197): `.hc` is a flex column, its `svg` takes `flex: 1 1 46px` with a `min-height` of 46 px, and the title row and the "60s ago / now" row keep their natural height at the top and bottom. The svg's `preserveAspectRatio="none"` viewBox and `vector-effect: non-scaling-stroke` let the graph stretch without changing line widths; `chartsFill.test.ts` reads these rules out of `fleet.css`. `.facts` is a four-column grid whose 1 px gap over a `--grid` background draws the hairlines. Blowouts and Resume are whole-cell controls without button chrome; the open state of the blowout detail is `FocusView`'s own (kept per session id, closed by default) and reaches the cell as `blow`. The Reporter cell takes its tooltip from `HOOKS_NOTE` and `versionNote`, the same sources as the card chip. `.osum.risk` is the card's red top edge for a level 2 blowout. The old callout stack, the status chip beside the name and `.alert` are gone; `.callout` remains for the agent panel and the fleet notice; it and `.bdet` share their text and loop-list rules in one grouped selector in `fleet.css` and differ only in the box.

**Which reporters are known** (`server/src/fleet/reporters.ts`, `frontend/src/fleet/admin/ReportersTab.tsx`, issue #142).
`ReporterStore` owns migration 11 (`reporters` and `reporter_sessions`) and is built once in `index.ts`, then handed to both
routers. `routes.ts` calls `record()` after a report or hook is stored, with the machine id (or the source address when the
report has none) as the key, plus `#<owner>` for a second account on the same machine (`accountKey`, #221) and the credential as a key id, never a token, and calls `rejected()` at each refusal, which
keeps the last 200 in memory only. A report with no machine id is filed under the row that already holds its session id (`knownKey`), and a row made for
the new address before that session turned up is merged into it, so a reporter that changes address (a container that
restarts) stays one row; migration 12 merges the duplicates that already existed. An unnamed reporter is named by its newest
session's project, else its address (#166). Ignore rules (#167, migration 13, `reporter_ignores`) live in the same store: `routes.ts` asks `ignoredBy()` before it stores a report or hook and, on a match, refuses with a 403 (`refuseIgnored`) and records the refusal. Rules are matched in JavaScript, with `*` turned into a case-insensitive pattern and everything else escaped, so no stored text is ever a regular expression. `removeMany`, `removeState` and `keys` serve the bulk removal behind `POST /api/admin/reporters/remove`. Retention (`fleet.retain`) never touches the table, so a reporter outlives its sessions; the one exception is the forget-by-age setting (`forgetStale`, two keys in `settings`), which `index.ts` hands to `startSweeper` as an `onRetention` hook and `forgetReporters` runs hourly, logging to the Admin log; the session count
comes from `reporter_sessions`. The state (reporting, idle, silent, not since restart) is computed in SQL from the last report,
the server's start time and now, so filtering, counting and sorting by it stay server-side and paged, and the browser only
asks again every 10 seconds. The page is admin-only because it shows source addresses and machine names. The report format did
not change, so the mod's options are not available to show.

**The prompt and answer modal** (`components/ReportDocs.tsx`, `components/Markdown.tsx`, issue #97). The whole
prompt and answer are kept out of the places that grow: the mod sends them (`promptText`, `answerText`, mod 0.10.0,
`fullPrompts` option) once each, tracked by `promptSent`/`answerSent` on its agent state and cleared only by an
accepted report (`markTextSent`); the server stores them in `agent_texts` (migration 8, a table of its own so
`SELECT` on `agents` and the SSE state stay small) and the view carries only `promptChars`/`answerChars`. The
modal fetches the text when it opens. `Markdown.tsx` builds React elements and never an HTML string, which
keeps SPEC 7.7's rule that reported strings reach the page only as text nodes, and it needs no dependency. The
modal shell is `components/Modal.tsx`, shared with the activity feed's modal (#118); it is portaled to `<body>` inside its own `.podium` wrapper (for the theme tokens), and blurs `#root`; a
capturing key listener keeps Esc and the shell shortcuts from reaching the page behind it.

**The activity feed** (`server/src/fleet/activity.ts`, issue #118). Observed only: nothing about an agent's
activity is captured, sent or kept unless a viewer is watching that loop. `ActivityStore` lives on the `Fleet`
and holds two maps in process memory: leases (session, then loop key: an agent id or `@orchestrator`), each with
its start, its expiry and a ring of the last 20 entries numbered by `seq`; and whether each session's reporter
has the option on (`SessionView.activityFeed`). `GET .../agents/:agentId/activity?every=` takes or renews a lease
for `every` seconds plus `ACTIVITY_LEASE_SLACK_MS` (15 s); the report route answers with `watch`, the loops under
a live lease; `Fleet.ingest` hands each validated report to the store, which merges only watched loops' entries,
skipping any stamped (through the session's clock skew) before the lease began and any it already has. The sweeper
expires leases every second, and a session leaving the live set or being deleted drops its leases. The Admin's
`activity-feed` flag (`server/src/fleet/featureFlags.ts`, a `feature.<id>` row in the settings table, '1' or '0', or unset for the flag's `defaultOn` in `FEATURES`) sits above all of this: the store asks `Fleet.features` on each call, so while it is off `watched` is empty,
`ingest` keeps only the reporter's option and no entries, and the route answers `enabled: false` without a lease. The
flag's `onChange` in `Fleet` calls `ActivityStore.clear()` when it goes off and sends every browser a fresh snapshot,
whose `features` map tells the panels. No table for the feed itself, no migration, no entries in the state or the stream; `ingest.ts` never sees the entries, because it copies named
fields only. In the mod (0.13.0, option `activityFeed`), `transport.ts` keeps the reply's `watch` list and
`flushOnce` hands it to `setWatched` in `state.ts` (an empty list when the option is off); a loop dropping off the
list forgets its ring. `tool.call` adds an entry (`activityCall` in `failures.ts`) and a watched `turn.step` reads
its text chunks as they pass (`activityText`), both through `addActivity`, which does nothing for a loop that is not
watched. `report.ts` sends `session.activityFeed` always, and a loop's `activity` only when the option is on and
the ring is not empty, within a 60,000-character budget per report. In the UI, `useActivityFeed.ts` runs the
fetch loop (only while `ActivityFeed.tsx` is mounted, the feed is on and `usePageVisible` says the tab is shown;
once more and then stop for a finished loop) and keeps a cursor: the first answer's highest `seq` is skipped, so a
viewer never sees entries from before they looked, and a changed `since` means the lease was started again. A reply
with `enabled: false` empties the hook's list and sets `adminOff`; the loop keeps running, and `FleetApp` passes the
flag from `StateBody.features` down through `SidePanel` (`activityFeedOn`) as the section's `adminOn`, which shows the
Admin's note ahead of the reporter notes and, when it changes, makes the hook ask again at once. The
section sits in `AgentDetail` and `OrchestratorDetail` (loop `@orchestrator`, which is also `ORCHESTRATOR_ROW`). The
simulator (`scripts/podium-sim.ts`) reads `watch` from each reply too and sends a scripted entry a second for each
watched loop that is still working, so the panel can be seen filling without a real session.

**Responding** (#206, SPEC 5.3, 7.1, 7.2, 7.7). The server side is `server/src/fleet/respond.ts` (`RespondStore`,
on the `Fleet`, in memory only: each session's last `respond` info, its asks with content, a closed ask's outcome
until the session reports idle with no open ask, or 10 minutes, the one answer taken per ask and up to 20 waiting messages, plus the held requests) and
`respondRoutes.ts` (mounted on the fleet router: the mod's routes behind `requireToken` and an owner check, and the
browser's under `/respond` with their own `HttpOnly` sign-in cookie, header and `Origin` checks). `Fleet.ingest`
hands each report to the store, which learns asks a restarted server lost and takes as closed an open one a report
stops listing (5 s grace). Answers and messages become `podium` entries in the watched loop's activity feed
(`ActivityStore.addPodium`), updated or removed as the mod reports results. `lockout.ts` is shared with the Admin
router. The Respond flag is `respond` in `FEATURES`, which now carries a per-flag default. The only database change
is migration 15's `sessions.cleared_from`. In the mod, `respond.ts` holds the pure parts (what the level accepts, the
asks, `planApproval` with `updatedInput`, `toolDecision`, the terminal lines) and `register.ts` the races:
`questionRace` and `planRace` inside the generic `tool.call` hook, `permissionAsk` from `classic.PermissionRequest`,
`settleToolAsk` when a tool's call ends, `startPermissionCheck` from `tool.check`, and `handleDeliveries` for the
reply's messages and commands. Closes and results queue in `outbox` and go out from the flush timer, since Esc
aborts a hook's own fetches; delivery ids already acted on are kept in `$.store`. In the UI, `useRespond.tsx`
provides who is signed in (asked only while the Admin's flags are on) and which session's modal is open;
`components/Respond.tsx` is the button and the modal, with `RespondForms.tsx`, `Compose.tsx` and `SignIn.tsx`;
`respond.ts` holds the rules for the button and the frames. The modal lets its fields keep their own keys
(`Modal.tsx`), and `useActivityFeed` follows a Podium entry's note as it changes.

**The people view** (`frontend/src/fleet/people.ts`, `components/People.tsx`,
`usePeoplePrefs.ts`, issue #34). The server adds three things and stores nothing new about people:
`sessions.machine_json` (migration 7) from `Report.machine`, which a named reporter (mod 0.9.0) sends next to
`userName`; `SessionView.ownerGroup`, joined from the people and groups tables by the owner's exact name when the
view is built; and `Kpis.costTodayByOwner`, the `costToday` sum split by owner with each owner's group. Bands,
their counts, ordering, the people filter, machine labels and the spend rows are pure functions in `people.ts`,
fed from the live sessions and the KPIs the UI already has, so people exist only while one of their sessions is
live. The view switches on when any live session's owner is a person (not `Admin`, not null). Who is looking comes from the browser's respond sign-in (`useRespond`, `GET /respond/me`; #245): `FleetView` is wrapped in `RespondProvider` so the wall can read it, and a signed-in name that is not `Admin` is "me" (the Me wall, the "you" tag, the viewer's band first). The other choices are in `localStorage` under
`podium.people`; the old `podium.me` is no longer read. The people controls are `PeopleCluster` in `components/People.tsx`, drawn by `Toolbar` in `components/Wall.tsx` in the same row as the filters; `fleet.css` narrows that row with container queries on the toolbar's own width (the `.toolbar` wrapper). Spend by person or group is not on the wall: since #239 it is Admin > Spend (`admin/SpendTab.tsx`, mockup `mockup/podium-admin-spend.html`), which opens its own `useFleet` while it is showing, builds its rows with `spendRows` from `people.ts` and pages them in the browser with Admin's `Pager`; its choices are in `podium.adminSpend`. Machine labels add the start of the machine id only when
one owner has two machines with the same host name. In the mod, `machine.ts` cuts `hostname` output to the short
name and makes the random id kept under `machineId` in `$.store`; `register.ts` reads both once per load and only
when `userName` is set.

**Logging** (`server/src/logging/`, issue #140). Server only; the mod's logs stay on its machine. `logger.ts`
makes a `Logger` whose calls are events: a stable dotted name (`report.rejected`), a message for people and flat
fields. Every record has `timestamp` (RFC 3339, UTC), `level`, `message`, `event`, `service` (`podium`), `host`
(`os.hostname()`, the container id under Podman) and `version`. `PODIUM_LOG_FORMAT=text`, the default, prints the
message alone, which is what the server always printed, and prints the events added in #140 (`quietInText`:
`session.*`, `reporter.*`, `admin.*`, `sweep.removed`, `auth.failed`, `report.conflict`, `report.accepted`,
`http.request`, `http.aborted`) only at debug, so the default text output is unchanged; `json` prints the whole record as one line,
every event at its own level, and the shipper always gets that JSON record. Debug and info
go to stdout, warn and error to stderr. `PODIUM_LOG_LEVEL` (default `info`) filters both what is printed and what
is shipped. `redact.ts` is the backstop for what a record may hold: callers pass named fields and never a body, a
field whose name contains a word such as token, secret, authorization, cookie, prompt, answer, activity, text or
body is dropped, and every string has person tokens (`pdm_...`), the admin secret, the ship header values and a
ship URL's password replaced with `[redacted]`, control characters removed and a 500-character cap. After the
exact-match replacement, `scrubPatterns` (issue #155) replaces common secret shapes in every string, the message and
event included: `Bearer`/`Basic` credentials, `password`, `passwd`, `pwd`, `secret`, `token`, `api_key` and
`access_key` assignments (`=`, or `:` when the key is quoted as in JSON), URL `user:pass@`, and the key formats
`sk-`, `ghp_`/`gho_`/..., `github_pat_`, `AKIA...`, `xox[bap]-` and JWTs. It skips numeric, boolean and null values
and names that only contain the word (`token_count`), and reads a `Bearer`/`Basic` word as a credential only when
it has a digit, a symbol or inner capitals. It reads only the first 4000 characters of a string, because the value
is cut to 500 anyway and the assignment pattern backtracks. It is pattern matching: no entropy detection, so an unknown secret
format is not caught. `shipper.ts`
runs only when `PODIUM_LOG_SHIP_URL` is set: `push` appends the JSON line to an in-memory array and returns, a
1 s timer (or a full batch of 100) gzips a batch as NDJSON and `fetch`es it to `<url>/insert/jsonline` with
`_time_field=timestamp&_msg_field=message&_stream_fields=service,host`, `Content-Type: application/stream+json`
and the `PODIUM_LOG_SHIP_HEADERS`, with a 5 s timeout. A failed batch goes back to the front; past
`PODIUM_LOG_SHIP_BUFFER` lines (2000) the oldest are dropped. Only a 400, 413 or 422 (a batch the endpoint calls
malformed or too large) drops that batch; any other answer, 401, 403, 404 and 5xx included, keeps it and retries,
backing off from 1 s to 30 s, and no full batch starts a flush while a retry is not due. The shipper reports a
failure (`log.ship_failed`), a full buffer (`log.ship_dropping`), a refused batch (`log.ship_refused`) and the
recovery once each per outage through the logger with `ship: false`, so those lines never feed the buffer they
describe.
Request paths never await it. `setup.ts` reads the settings and turns a bad value into its default plus one
`log.config_invalid` warning. Who emits what: `index.ts` (`server.start` with the settings, never the token;
`server.stop`, then up to 1 s to send what is left), `requestLog.ts` (`http.request` at debug: method, path without
query, route pattern, status, duration, source; `http.aborted` the same for a request the client dropped first), `fleet/routes.ts` (`auth.failed`, `report.rejected`,
`report.accepted` at debug, `report.conflict`, `hook.rejected`, `ingest.failed`, `request.failed`),
`admin/adminRouter.ts` (`admin.<kind>` for each Admin Log entry, with the action, source address and ids, never
the entry's text), `fleet/fleet.ts` (`session.started`, `session.ended`, `session.deleted`, `reporter.connected`
the first time an owner, machine and reporter kind is heard or after a silence longer than `STALE_AFTER_MS`,
`reporter.silent` when a session goes stale, `sweep.removed`) and `fleet/sweeper.ts` (`sweeper.failed`). The
routers and the sweeper still take the old `log(line)` option, wrapped by `loggerFromLine`; a `Fleet` built
without a logger is silent.

**Shared contract.** The Report types live in `server/src/fleet/protocol.ts` and, byte for byte between
markers, in `mod/podium-reporter/hooks/protocol.ts`; a test compares them. The UI imports the view types
from the server's file. `docs/fixtures/report.sample.json` is the shared fixture.

**Other server parts.**

- *Model prices.* `pricing.ts` holds the built-in price per model family (per million tokens, dated by
  `PRICES_AS_OF`). `modelPrices.ts` keeps the Admin's overrides and custom models (at most 100) under the
  `model_prices` settings key. `Fleet` prices every session and agent through `Pricing`, so a change on
  Admin > Model prices reaches every cost figure.
- *Wall notices.* `wallSettings.ts` defines the notices (today, `background-sessions`) and the setting behind
  them. `POST /api/fleet/notices/:id/close` and `PUT /api/fleet/wall/background-sessions` change only how the
  wall looks, so they take no token. `components/NoticeStack.tsx` draws them.
- *Compatibility.* `compat.ts` holds `REPORTER_SUPPORT`, the reporter versions this server reads. Only
  `major.minor` is compared. A mod outside the range gets a version note on its card and a toast in the mod.
- *The stream.* `sse.ts` sends `snapshot` (on every connect), `session`, `activity`, `removed`, `tick` (every
  2 s) and `wall`, and accepts at most 100 clients.
- *Admin pages.* `AdminView` lists eight pages in three groups: People, Groups and Reporters (People and
  access); Settings, Model prices and Reporting and security (Server); Spend and Admin log (Activity). Each
  has a `*Tab.tsx` file under `frontend/src/fleet/admin/`.
- *Mounts.* The server mounts `/api/fleet` and `/api/admin`, then `/api/health` and a 404 for any other
  `/api` path, then serves the built frontend with `*` falling back to `index.html`.

## Spec questions

Places where the spec was silent, ambiguous or wrong, the reading chosen, and why.

1. **"Identical type declarations" in both `protocol.ts` files (T0.1).** The mod has no use for the view
   types (`SessionView`, `Kpis`, ...). Reading chosen: the Report family (`Report`, `SessionReport`, `Plan`,
   `AgentReport`, `Failure`, `ActivityEvent` and their small helper types) lives between
   `// <protocol:begin>` and `// <protocol:end>` markers in both files, and the comparison covers that block.
   The view types live only in the server's file.
2. **Where the "sibling file" comparison runs (T0.1).** `claude plugin test` runs the mod's tests in the
   hooks sandbox, which has no file system, so a mod test cannot read the server's file. Reading chosen: the
   comparison lives in `server/src/fleet/protocol.test.ts` and reads both files. The comparison is
   symmetric, so one test covers both directions.
3. **Named sub-types.** Sections 6.2 and 7.4 write some shapes inline (`tokens`, `context`, `git`). The code
   names them (`TokenCounts`, `ContextFill`, `GitInfo`, `RateLimit`, `PlanStep`, `SessionReport`) so the
   validator, the server and the UI share them. The structure is unchanged.
4. **Omitted optional fields.** 6.2 says missing optional fields are `null`, never omitted. The validator
   accepts an omitted nullable field as `null` rather than rejecting the report (7.7: "reject, never crash,
   on junk" is about junk; a missing nullable is not junk). Required fields must be present.
5. **Over-long line lists.** `outputTail` keeps the **last** 12 lines and `evidence` the **first** 5;
   each line is clamped to 240 characters. These are clamped, not rejected, like other strings.
6. **Control characters.** Every reported string has C0 control characters (except tab) and DEL replaced
   by a space before it is stored. Newlines in single-line fields would break the UI's one-line layouts.

7. **Extra server files.** Besides the files 4.1 lists, `server/src/fleet/` has `fleet.ts` (the service
   that owns the live set and turns ingests and sweeps into SSE messages, used by `routes.ts` and
   `sweeper.ts`) and `testing.ts` (fixture loader for tests). `server/vitest.config.ts` adds
   `scripts/*.test.ts` to the server suite so the simulator is tested by `npm test`, and loads
   `server/src/testSetup.ts`, which binds the tests' own servers to `127.0.0.1` (GOTCHAS, "A server test
   fails now and then").
8. **Samples between reports.** 7.2 says one sample row per second per live session, but a quiet session
   reports only every 5 s. The sweeper writes a carry-forward sample (same totals, delta 0) for each
   second a live, non-stale session has none, so its charts do not drop to zero between heartbeats.
   Missing seconds (server down, stale session) are still zero-filled.
9. **First sample of a session.** `tokens_delta` of a session's first sample is 0, not its whole total,
   so a session first seen with 2M tokens (say after a server restart) does not show a 2M spike.
10. **Series end.** The 60-point series end at the last complete second, not the second in progress,
    whose sample is partial. `blowoutSecondsAgo` counts back from that point (a blowout in the second in
    progress is age 0).
11. **`tokensTotal`** counts all four token kinds (input, output, cache read, cache write) for the main
    loop and every agent. Cache reads dominate, which is what the requests really processed.
    It feeds the samples and the tokens-per-second series, a throughput. No "Tokens" figure in the UI
    shows it: those show context held now (`agentTokens` and `sessionTokens` in `logic.ts`), which is what
    Claude Code shows, because a running total re-counts the cached context on every request (#96).
12. **`costPerMinute`** (the KPI sparkline) is 60 one-minute buckets of fleet cost added, from the
    samples' cumulative cost, repriced from each sample's `usage_json` (kept in full only when it changed or at a minute's first sample, `=` otherwise) with the Admin's prices (#270; the
    ledger's `cost_usd` for a sample from a reporter that sends no usage). **`tokensPerSec`** is 60 one-second points of Σ `tokens_delta`.
13. **`clearedToday`** is a count: sessions that ended or were dropped since local midnight and are no
    longer in the live set.
14. **`session` throttle.** One message per session per 500 ms, trailing edge: the first change in a
    window schedules a send 500 ms later carrying the latest state. Ten ingests in 200 ms give one
    message. Activity messages are not throttled.
15. **Stale and drop after a restart.** Stored, not-done sessions are stale until they report. A session
    never heard since the restart is dropped `DROP_AFTER_MS` after `max(last_seen + STALE_AFTER_MS,
    server start)`, so reporters get a full minute to come back after the server was down. `Fleet.dropAtFor`
    holds that rule once: `sweep` and the `SessionView.dropAt` field both use it, so the card's countdown
    matches the drop. `Fleet.dropSession` (Remove, `POST /sessions/:id/drop`) runs the same exit early (#41).
16. **A repeated final report.** A `done` report for a session that already ended and left the live set
    is stored but does not bring the session back for another linger.
17. **Retention env names.** 7.2 says the three thresholds are env-configurable but names none:
    `RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`, `RETAIN_SESSIONS_MS`. `RETAIN_ADMIN_LOG_MS` joined them in #303.
18. **`GET /history`** is listed under Phase 4 in 7.1 but has no Phase 4 task. It was cheap, so it exists
    from T1.5: summary rows for sessions that ended or were dropped on a local day.
19. **Simulator haiku window.** The simulator runs its haiku agents as `claude-haiku-4-5` (200K window)
    so blowouts happen often, as 1.6.2 asks; the current Haiku 5.5 has a 1M window.

20. **View fields the UI needed.** `SessionView` gained `cwd` (home-shortened working directory, for the
    page header; in a container the home is the host's, passed in as `PODIUM_HOST_HOME`, see DECISIONS 16), `waitReason` (to word the orchestrator page's waiting band: "Waiting for your approval." vs "Waiting for
    your input.", with the tool name or a short question under it, see #64; the card and the activity feed use the same two sentences, picked by `waitLead` in `frontend/src/fleet/waiting.ts`: a question tool such as `AskUserQuestion` reads as input, any other permission wait as approval, see #50 and #68; the feed reads the tool name out of the event text, so the report format is unchanged; `readableEvent` in `eventText.ts` does the same for a failing-call turn end, a session start or end and a hook-seen spawn), and `/state` gained `config` (stale, drop and linger timings, so a stale card can say
    "dropped from the fleet at 1:15" without hard-coding server settings; since #41 the card counts down to the
    per-session `dropAt` instead, which stays right after a restart and for hook-only sessions). All additive.
21. **CSS scoping.** Every Podium rule is scoped under `.podium` and the tokens are defined on `.podium`, not
    `:root`, apart from a small document base (`html`, `body`, `#root` height and margin) in `fleet.css`.
    The theme attributes live on `<html>`: `data-theme` (resolved light or dark, as in the mockup), `data-theme-name` (the palette) and `data-mode` (light, dark or system). Podium's palette stays in `fleet.css`; the other five are token blocks in `themes.css`, selected by `[data-theme-name][data-theme]`, which also set the page background on `<html>`. `useTheme` sets the attributes and an inline script in `index.html` sets them before first paint from the same `podium.theme` value (`themes.test.ts` checks the two lists agree).
22. **Routing.** `main.tsx` picks the view with `routeFor` (`route.ts`): `#/history` is the history view and
    every other hash, including the retired `#/usage`, is the fleet console. The mockup's Pause, Start session and Clear buttons are left out (8.1 says they belong to the simulator).
23. **Resync on reconnect.** The server sends a full `snapshot` (the `/state` body) on every SSE connect,
    so a reconnect resyncs from it rather than issuing a separate `GET /state`. The first paint still
    fetches `/state`.
24. **"N reporters live"** counts live sessions that are not stale. One `ConnectionPill` component and one `reportersLive` helper in `store.ts` produce it for both the fleet top bar and the Admin top bar, so the two cannot drift; Admin opens its own `useFleet` stream to get the number (#187).
25. **Activity rows of ended sessions.** A session that leaves the live set stays in the reducer's
    `gone` map, so its activity rows stay greyed and inert even after its card is gone.

26. **Failure class order.** Read strictly, 6.4 ranks "`error` without a candidate ⇒ Model API error"
    above "window exceeded or 3 blowouts ⇒ Context window exhausted". The engine's `error` reason
    explicitly includes running out of context (`TurnCompleteUnrefused`: "dead on an API error
    (retries exhausted, the context limit)"), so a loop whose last stop was
    `model_context_window_exceeded` and then died on `error` ran out of context. Chosen order: denial,
    refusal, exhausted window, API error with no failing call, abort, tool error, Unknown. Every other
    pair keeps the spec's order. A loop that ends `aborted` also gets a failure record (class per the
    same rules) so the UI can say why.
27. **Plan `source` and the plan tool.** `podium_plan` would hide whether the steps came from TaskCreate
    or TodoWrite, so the plan tool only sets the title and `source` stays the steps' source. `podium_plan`
    is never sent.
28. **TaskCreate/TaskUpdate from any loop, TodoWrite from the main loop only.** The task list is the
    session's; a subagent's TodoWrite would otherwise replace the orchestrator's plan.
29. **Plan owners stick.** A step is matched to a running agent when the agent spawns or the plan
    changes, and keeps that owner after the agent finishes (6.3 matches "the running agent").
30. **`session.end` deadline is 1 s, not 2 s.** The types say one ~1.5 s bound covers every
    `session.end` hook and core together (`SessionEndInput` doc), so a 2 s wait would always be cut.
31. **Extra option `showStatus`** (boolean, default on) turns the status line off. 3.3.4 says "(if
    enabled) status line" without naming the switch.
32. **`skill.prompt` attribution.** It has no `agentId`, so it is attributed to the main loop only when no
    Skill tool call is in flight (that call records the right loop itself) and no agent is running (an
    agent may be preloading the skill). Otherwise it is ignored.
33. **The ack carries `liveSessions`.** `POST /report` answers `{ ok, serverTime, ackedEvents, sessionId,
    liveSessions }` so the status line can say `podium ● N live` (5.4) without another request.
34. **Waiting from start.** A new session is `waiting` (for input) until its first turn, and a session
    whose main loop is idle is `running` while any agent still runs, `waiting` otherwise.
35. **Plan tool registration.** The `plan` tool is registered deferred (behind ToolSearch, the default),
    so it costs a session nothing unless the model looks for it.

36. **Settings-hook snippet location (T5.1).** The spec asks for a `docs/` snippet; this repo's CLAUDE.md
    says not to start a new standing doc when an existing one can hold the content, so the
    `.claude/settings.json` snippet is in the README ("Sessions without the mod").
37. **Hook ingest merges with stored rows.** Each settings hook is one event, so `POST /hook` reads the
    stored session and agents, applies the event, and ingests the result through the normal path
    (`reporter.version: "hooks"`, shown as `SessionView.reporter: 'hooks'`). It never takes
    `last_assistant_message` or prompts, so hooks send no excerpts at all. Unknown hook events are
    heartbeats.

38. **Where an explanation's cost counts (T5.2).** "Usage cost counted in the session estimate": the
    session's own figure is the engine's ledger (which already includes `$.model.complete` calls made on
    the session's client), so the explanation's estimated cost is added to the failed agent's
    `costUsdEst`, the one estimate the report carries. Explanations are requested from the flush timer,
    never from a hook, at most once per failure; a call that errors is not retried. Since #117 its tokens
    also go into the agent's `usageByModel`, so the server's price of the session total includes them.

39. **The mod is installable from a marketplace (section 11 deferred it).** The first spec listed "installing
    the mod through a marketplace" as deferred until the repo is public, with a `marketplace.json` in this
    repo. It is done a different way: `eengelking/skills` already publishes `eengelking-marketplace`, and its
    `.claude-plugin/marketplace.json` lists `podium-reporter` with a `git-subdir` source pointing at
    `mod/podium-reporter` in this repo (full `https://` URL, because the `owner/repo` shorthand clones over
    SSH). Install with `/plugin install podium-reporter@eengelking-marketplace`. This repo has no
    marketplace file of its own. SPEC.md was amended to match (4.4, and the deferred item removed).
40. **Inside the container the server binds `0.0.0.0`.** The first spec said the server binds `127.0.0.1`
    by default. In the image it has to listen on all interfaces for the published port to reach it, so
    `podiumctl` publishes it only on the host's `127.0.0.1` (or the `--bind` address). The server's own
    default outside the container is unchanged. SPEC.md was amended to match (3, 4.2, 4.4, 7.7).
41. **A session that has done nothing is not on the wall (#42).** Claude Code's background daemon runs a
    parked twin for each interactive window and keeps a pool of pre-warmed spares. They are real
    processes, they load the mod, and they report as sessions that have no tokens, cost, agents or plan, so
    one window could show three identical cards. The mod cannot tell, because the engine exposes neither
    the session kind nor the parked job. `isUnused` in `derive.ts` decides it from the stored row, and
    `Fleet` applies it in one place per output: the live list, the SSE messages, the activity feed,
    `/history`, `clearedToday` and the `liveSessions` count (`visibleCount`). The session shows the moment it
    is running or has any usage. Settings-hook sessions are exempt. The mod needed no change: its status
    line shows the server's `liveSessions`. A hidden session's own status line reads `0 live` until it is
    prompted. SPEC.md 7.5 was amended to match. Known limits: a session whose first prompt is aborted
    before any token is counted goes from running back to idle, and an open browser keeps its card until
    the next reload. `/events` filters hidden sessions after the page limit is applied, so a page can come
    back short. `visibleCount` reads each live session once per report.
42. **A session nobody is attached to is dimmed, then set aside (#45).** After `/exit` under the daemon the
    conversation keeps running as a background job. The mod reads the roster from `$.session.surfaces()` on
    every flush and again on `session.attach` and `session.detach`, and reports `attached` (null until the
    first read, and when a read fails). The server stores `attached` and `detached_at`, the time of the
    first report with nobody attached, and serves `hideAt = detached_at + DETACHED_HIDE_AFTER_MS`. The hide
    itself is the wall's: `splitDetached` in `frontend/src/fleet/logic.ts` sets those cards aside once
    `now >= hideAt`, so the session stays live, in the totals and in History, and a client attaching again
    clears `hideAt` on the next report. Unlike #42 this is not an `isUnused`-style server filter, because a
    hidden session is still spending. Known limit: a non-interactive `claude -p` run has no client and reads
    as nobody attached.

## Deviations from the spec

The numbered Spec questions above are the full list, each with its reason. The ones that change behavior
a reader of the spec would expect:

- The failure class order ranks an exhausted context window above a generic API error (26).
- `session.end` waits at most 1 s, not 2 s, because the engine bounds the whole event to ~1.5 s (30).
- Haiku's window is 1M (Haiku 5.5); 200K is used only for Haiku 4.5 and older ids (Mod API findings).
- The plan tool never sets `source: 'podium_plan'`; it only names the plan (27).
- Escaped control characters in reported strings are stripped and the report accepted; raw control
  characters make the JSON invalid and get a 400 (T4.3.1 reading, Phase 4 below).
- The mod is installed through a marketplace (39) and the container listens on all interfaces behind a
  host-side `127.0.0.1` publish (40). Both were written back into SPEC.md (4.4) after the first build.
- Background waits (#119): `classic.Stop` carries `background_tasks` and `session_crons`; the mod keeps them in
  `SessionState.background` and sends `session.background`, which the server stores in `sessions.background_json`
  and serves as `SessionView.background`. `backgroundSummary` and `idleOnBackground` are defined once, in the shared protocol block, so the mod, the server and the UI cannot disagree about them. The status stays `waiting` with `waitReason: null`; the UI
  words it (`frontend/src/fleet/waiting.ts`) and leaves it out of the waiting count. Artifact live-update watchers (monitors named `live updates for artifact ...`) are skipped on both paths (#128). The settings-hook path reads
  the same Stop fields but leaves `wakeAt` null, because the server may not share the cron's time zone.
- Extra fields, all additive: `SessionView.cwd` and `waitReason`, `/state.config`, `liveSessions` in the
  report ack, `HistoryRow` for `/history`, and a `showStatus` mod option (20, 31, 33).
- Extra files: `server/src/fleet/fleet.ts`, `testing.ts`, `server/vitest.config.ts`, `frontend/src/fleet/`
  helpers (`logic.ts`, `chart.ts`, `storage.ts`, `useNow.ts`, `fixtures.ts`, `testState.ts`),
  `mod/podium-reporter/hooks/scripted.ts`, `mod/podium-reporter/tsconfig.json`, and the scripts
  `podium-mod-typecheck.sh`, `podium-soak.sh`, `mod-report.test.ts` (7).

## Known issues

1. **`explainFailures` was not tried against the real model.** It is tested in the kit with a stand-in
   for `$.model.complete`; all three allowed `claude -p` runs were spent before it was built.
2. **No agent-scoped tool calls in the mod's end-to-end test.** The test kit mints `tool.call`'s
   `agentId`, so a Skill or failing Bash inside an agent is covered by the pure `state.ts` tests and the
   real runs, not by `register.test.ts`.
3. **Not seen for real:** a subagent's own `session.compact`, a teammate, `classic.Notification` and
   `/clear` in an interactive session (the earlier real runs were headless `-p`). Each is covered by
   tests against the types. The status line and `/podium` have since been seen in an interactive session
   (October 2026), reporting to the container through the marketplace-installed mod.
4. **Plan owner matching is literal.** A step "Count .ts files under server" and an agent "Count .ts
   files in server" do not match (6.3's normalized contains rule); run 3 showed it. Steps then show no
   owner.
5. **Elapsed times and the stale countdown pause in a background tab.** Browsers throttle timers in
   hidden tabs; the numbers catch up when the tab is visible. The console also adds a `paused` class
   while the tab is hidden (`usePageVisible`), which pauses every CSS animation, and the heartbeat
   (`useHeartbeat`, which drives the running-dot pulse and the blinks through `data-beat`) stops too.
6. **Memory grows slowly under load.** The 5-minute soak (10 sessions x 20 extra agents, 3 SSE clients)
   went from 121.6 MB to 131.7 MB RSS, with growth slowing (+7.7 MB in the first 2 minutes, +2.4 MB in
   the last 2.5). Likely V8 warm-up and the SQLite page cache; a longer soak would tell.
7. **Cost estimates undershoot the ledger a little.** Run 1: main loop plus agent estimates $0.01237
   against a ledger of $0.01445. The orchestrator's figure is the ledger; agent figures are estimates and
   labeled so.
8a. **What Claude Code reports for a non-Claude model (Ollama), partly observed.** On 2026-10-12 Claude Code
   2.1.296 was launched with `ANTHROPIC_BASE_URL=http://localhost:11434` and `--model gemma4:12b-pinned`
   (Ollama 0.34.4) with the 0.5.0 reporter. The session registered and appeared on the wall. Observed: the
   model string is the Ollama tag as given (`gemma4:12b-pinned`), the engine's `context.window` is 200,000
   (a default, not the model's real window, so the percentage computed from it would be a guess), effort is
   null, and no plan. The model never answered (the run hung), so the ledger cost, token usage, context
   percent and stop reasons for such a model are unobserved. The mod sends `costUsd` and `costUsdEst` as
   `null` for it, and the dashboard shows the model's own name in an "other" chip, cost "n/a", and "not
   counting 1 unpriced session" under Est. cost today.
8. **A session that starts at the prompt shows as waiting.** An idle interactive session is honestly
   "waiting on you"; with many idle sessions the wall fills with waiting callouts.
9. **The production build also compiles the server's test files into `server/dist`** (as the existing
   app already did). Harmless; not changed.
10. **A change of effort shows after the next model request.** The mod reads the effort the session sends
    on each `turn.step`; the API has no event for the setting changing. A level picked with `/effort`
    appears in Podium after the session's next prompt, not when it is picked. A probe of `$.config.list()`
    and `$.settings.read()` to catch it sooner has been proposed and not tried.
11. **Claude Code draws a warning sign before the status line entry.** The mod sets plain text with
    `$.ui.status`, which takes no severity. Claude Code's mods API docs say the host starts every mod's
    status line with `⚠` and the mod's name, so it is not a trust state and the mod cannot remove it (#29).
    `podium ● N live` is the normal state.
12. **The `systemd` boot unit has not run on a Linux host.** Its generated text is unit-tested only.
13. *(Removed with the usage dashboard, #30. The number is kept so other references stay valid.)*

## Browser checklist (T4.2)

Run in Chrome (Claude in Chrome) against the dev server, Vite, and either `podium-sim --chaos` or real
`claude -p` sessions. Checked: yes unless noted.

| Item (SPEC 8.1) | 1440 dark | 1440 light | 400 dark | 400 light |
|---|---|---|---|---|
| Top bar: logo, connection pill, clock, theme toggle, link to usage | yes | yes | yes | yes |
| Connection pill shows "disconnected, retrying" with the server stopped, recovers by itself | yes (at once; back 2.3 s after restart) | | | |
| Three columns, drag handles (real drag 340 -> 510 px, saved), double-click reset, focus ring | yes | yes | hidden, stacked | hidden, stacked |
| Rail: status dot, name, blowout badge, model chip, plan bar, agents; red edge at level 2 | yes | yes | yes | yes |
| Rows enter and leave with animation | yes (burst of 11) | | | |
| KPI tiles with sparklines | yes | yes | yes (2 columns) | yes |
| Toolbar: segments, Sort (Model: Fable, Opus, Sonnet in rail and wall), text filter, counts | yes | yes | | |
| Cards: git line, model, effort, context, badge, blowout tooltip, plan, agent strip, cost, sparkline | yes | yes | yes | yes |
| Waiting and stale on the card band and the orchestrator page's status band | yes | yes | | |
| Empty states with an instruction | yes | | | |
| Orchestrator page: header, three charts with crosshair and readout, blowout marker and caption | yes | yes | yes | |
| Facts grid with Resume last ("Copied", then back) | yes | yes | yes | |
| Blowouts cell opens the blowout detail with agent links | yes | | | |
| Plan checklist, agent tree, sort columns and "Show as tree" (now "Launch order", and a sort keeps the tree, #101), row flash | yes | yes | yes (tree scrolls inside) | |
| Activity: 12 rows, Show 12 more, Show fewer, counts, 150-event note | yes | yes | yes | |
| Activity row selects session and agent, scrolls and flashes; failure row shows root cause | yes | yes | yes | |
| Rows of ended sessions greyed, "Session ended", inert | yes | | | |
| Agent detail: failure box, blowout timeline, inherited model and effort on a fork | yes | yes | | |
| No horizontal page scroll | yes | yes | yes (381 px in 396) | yes |
| Kill and restart the server: UI reconnects with no reload | yes | | | |
| 20 reports in 200 ms (10 new sessions + 10 for one): 11 rows, no duplicates | yes (23 ms) | | | |
| A session that never ends: stale at 15 s, gone at 75 s | yes | | | |
| A real `claude -p` session appears, with agents and plan, then leaves | yes (run 3) | | | |

Blank cells were not separately checked at that width or theme; the layout is the same CSS and the
400 px and light passes covered the views listed. 400 px ran in a 400 px same-origin iframe because Chrome
would not resize the window that narrow. Touch input and screen reader output were not checked.

## Mod API findings

Checked against the engine 2.1.296 type declarations, `claude plugin validate`, `claude plugin test`,
and two real `claude -p` runs (haiku) on 2026-10-10. The rows marked #206 were checked on 2.1.301 on 2026-10-15
with a throwaway mod that recorded every hook's input and timing in an interactive session (SPEC 5.3).

| Assumption (SPEC 5 and 12) | Result | Evidence |
|---|---|---|
| Relative imports may need explicit extensions | Both forms load. `./util.ts` and `./util` pass `validate` and run under `claude plugin test`; the mod uses `.ts` (also accepted by `tsc` with `allowImportingTsExtensions`) and loaded in both real runs. | probe mod in the scratchpad; run 1 `system/init` lists `podium-reporter@inline` |
| `userConfig` field syntax | `{ type, title, description, default }`, `type` one of `string`, `number`, `boolean`, `directory`, `file`; `title` and `description` are required. `sensitive: true` is accepted. | `validate` errors for a bad type and a missing title/description |
| `classic.PermissionRequest` hookable, fires headless | **Yes, both.** It is listed by `validate`, and in run 1 it fired for the model's Bash call under `-p` (a `wait` event "waiting on you: Bash(...)"). | run 1 events |
| `classic.Notification` hookable | Hookable (listed by `validate`, raised in tests). Not observed in a headless run. | `validate` |
| `session.compact` fires with `agentId` for a subagent's own compaction | Declared (`SessionCompactInput.agentId`: "for a subagent's or a fork's own transcript"). Not observed for real: neither run compacted. The reporter also counts `model_context_window_exceeded` stops, deduplicated within 2 s. | types |
| Effort visible on spawn | Not on `agent.spawn` (no field). Visible on the `Agent` tool call's input, and observed per step on `turn.step.effort`. | run 2: spawn event "Haiku low" before any step |
| `tool.call` (Agent) before or after `agent.spawn` | **Before.** The spawn event in run 2 already carried the requested effort, which only the tool call's input supplies. The reducer accepts both orders anyway. | run 2 |
| `$.session.usage().cost.usd` includes subagent spend | **Yes.** Run 1: ledger $0.014450 equals the CLI's `total_cost_usd` ($0.014450345); the main loop's own token estimate is $0.006628 and the agent's $0.005742 (sum $0.01237, the rest is pricing detail the estimate does not model). | run 1, database |
| Windows: 200,000 for haiku, 1,000,000 for others | **Wrong for the current Haiku.** Haiku 5.5 has a 1M window; only Haiku 4.5 (and older) has 200K. `windowOf` uses 200K only for `haiku-4`, `haiku-3`, `claude-3` ids. | `claude-api` skill, model table cached 2026-10-06 |
| Bash exit code in an error result | No field: `tool.call` error results carry `text` ("Exit code 1 ..."); the reporter parses it. | `BuiltinToolResults.Bash` has no exit code |
| #206: plan text and path on ExitPlanMode's `tool.call` | **Yes.** The input carries `plan` and `planFilePath`, though the declared type lists only `allowedPrompts`; `classic.PermissionRequest`'s `tool_input` has the same two. | recorded hook inputs |
| #206: Esc told apart from plan feedback | **Yes, by the text.** Both are `isError`; feedback reads "... To tell you how to proceed, the user said:\n<feedback>", Esc "... STOP what you are doing ...". | recorded results |
| #206: the engine ends a waiting PermissionRequest hook when the terminal answers first | **No.** `next.signal` never aborted; the hook held on for 60 s, past the command's end. The only signal is the call's `tool.call` resolving, so a tool ask stays open while a terminal-allowed command runs. | two Bash prompts answered "Yes" in the terminal |
| #206: `$.http.fetch` time limit | **30 s**: "no complete answer within 30000ms". Held requests wait 20 s at most. | recorded rejection |
| #206: `tool.check` before a prompt | Carries `tool_use_id`; resolves to `ask` 3 to 11 ms before `classic.PermissionRequest` fires (Bash and ExitPlanMode). The managed-setup case, where no PermissionRequest fires, is **unverified**. | recorded timings |
| Worktree detection when started inside a worktree | **Works.** Run 2 in a scratch worktree: `isWorktree: true`, `worktreePath` the worktree, branch `feat/wt-check`, `dirty: 1`, name `wt-check`, project the main checkout. | run 2 |
| Teammates | Reported as `kind: 'teammate'` from `agent.spawn.isTeammate`; not observed for real. | types |
| `$.session.version()` | Returns `{ version, base?, builtAt? }`, not a string. | types |
| `turn.step.effort` | May be a number as well as a level name; numbers are ignored. | types |

Further findings that shaped the code:

- **`$` is checked statically.** `validate` refuses a module that passes `$` to anything but a function
  declared at the top of the file, or that reads it as anything but `$.noun.event(...)` (so
  `runtime.$.session.id()` is refused). All `$` helpers are top-level functions taking `$`; the runtime
  lives in module variables that `register` resets.
- **No `setTimeout` in the sandbox.** Deadlines use `$.clock.sleep`; scheduling uses `$.clock.now()` (in
  tests that clock is mocked; a backoff computed from `Date.now()` never came due there, which a test
  caught).
- **`session.end` has one ~1.5 s bound** for all hooks and core; the final report waits at most 1 s.
- **Gating hooks.** `validate` names every hook at a site that can refuse (tool calls, spawns,
  compaction, classic events). Each reporter hook has a `.catch` that calls `next(e)` (it replays what
  `next` settled to when it was already called), so a reporter failure never changes an outcome.
- **Testing kit.** `claude plugin test` needs the test to answer the bottom of every event the plugin
  raises (`on('session.start', () => ({ cwd }))`) and every `$` call (`on('http.fetch', () => ({ value
  }))`). `tool.call`'s `agentId` and `tool_use_id` cannot be set from a test (the engine mints them), so
  agent-scoped tool results are covered by the pure `state.ts` tests. A compaction result must keep at
  least one message.
- **Hook cost.** With the server down, the reporter's own work measured 0.00-0.01 ms average and 0.03 ms
  at most per hook over 300 tool calls and steps (`register.test.ts`, via `/podium`). Target was under 5 ms.

`claude plugin validate mod/podium-reporter` output (T3.3.1):

```
Validating plugin manifest: ~/dev/podium/mod/podium-reporter/.claude-plugin/plugin.json

Validating hooks: ~/dev/podium/mod/podium-reporter/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, session.end, turn.start, turn.step, turn.complete, session.compact, session.measure, session.attach, session.detach, agent.spawn, tool.call, tool.call{tool=mcp__podium-reporter__plan}, skill.prompt, classic.PermissionRequest, classic.Notification, command.run{command=podium}
  ❯ ./register.ts answers its own command: command.run{command=podium}
  ❯ ./register.ts gating hook with .catch: session.compact
  ❯ ./register.ts gating hook with .catch: agent.spawn
  ❯ ./register.ts gating hook with .catch: tool.call
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__podium-reporter__plan}
  ❯ ./register.ts gating hook with .catch: classic.PermissionRequest
  ❯ ./register.ts gating hook with .catch: classic.Notification
  ❯ ./register.ts calls: $.agent.list (via readAgents), $.clock.every (via start), $.clock.now (via engineNow), $.clock.sleep (via end), $.command.register (via start), $.http.fetch (via start), $.process.run (via pollGit), $.session.id (via flush, start), $.session.model (via start), $.session.repo (via start), $.session.root (via start), $.session.usage (via readUsage, start, switchSession), $.session.version (via start), $.store.get (via loadName), $.store.set (via podiumCommand), $.tool.register (via start), $.ui.log (via record), $.ui.status (via showStatus), $.ui.toast (via toastOnce)

✔ Validation passed
```

## Dependencies added

None at run time. `@types/node` in `server/` went from 20 to 24 so `node:sqlite` is declared.

## Phase log

### Phase 0: contract and scaffolding

Built: `server/src/fleet/protocol.ts` (types and `validateReport`), the mod's copy of the Report types,
`docs/fixtures/report.sample.json`, `.gitignore` entries for `data/` and `*.sqlite*`, the Vite proxy to
`127.0.0.1:$PORT`, and the `podium:sim` and `podium:smoke` root scripts.

Verified: `npm test` (server 26, frontend 15 tests) and `npm run build` pass. The fixture validates. The two
Report blocks match.

Found: `import { DatabaseSync } from 'node:sqlite'` fails under vitest 2 (Vite strips the `node:` prefix
and then cannot resolve `sqlite`). `process.getBuiltinModule('node:sqlite')` works under vitest, `tsx` and
plain `node`, and is typed by `@types/node` 24, so `db.ts` uses it. No fallback to `better-sqlite3` was
needed.

Not verified yet: the SSE proxy through Vite (T4.1 checks it).

### Phase 1: server

Built: `db.ts` (schema, migrations, `FleetDb` queries), `ingest.ts`, `derive.ts`, `fleet.ts`, `sse.ts`,
`sweeper.ts`, `routes.ts`, wiring in `server/src/index.ts` (binds `127.0.0.1` unless `HOST`, database at
`PODIUM_DB` or `data/podium.sqlite`, graceful shutdown on SIGINT/SIGTERM), and `scripts/podium-sim.ts`.

Verified by tests (server suite 91 tests, incl. the simulator's 4): idempotent ingest, agent retention and
abort-on-done, revive, sample deltas, blowout level (12 table cases), stale/drop/linger with an injected
clock, restart behavior, SSE throttle, client removal on write error, every route incl. 400/401/404/413,
event paging, and simulator determinism and report validity.

Verified by running: `npm run dev -w server` creates `data/podium.sqlite`, logs its URL and listens on
`127.0.0.1:4317` only (checked with `lsof`). With the simulator (`--sessions 5 --chaos`), `/state` showed
five sessions with agents, plans and 60-point series; `curl -N /stream` printed `snapshot`, then
`session`, `activity` and `tick`; after Ctrl-C the simulator reported all five `done`, and 8 s later the
live set was empty with `clearedToday: 5`.

Found while running: the newest series point was always 0 (the current second's sample is partial).
Fixed test-first (see Spec question 10).

### Phase 2: frontend

Built: `frontend/src/fleet/` (`FleetApp`, `useFleet`, `store.ts` reducer, `logic.ts`, `chart.ts`,
`format.ts`, `useTheme`, `themes.ts`, `themes.css`, `ThemePicker`, `useResizable`, `usePanes`, `useHotkeys`, `useIdle`, `useNow`, `useWallColumns`, `wallLayout.ts`, `storage.ts`, `fleet.css` and the components in 8.2) and
hash routing in `main.tsx` (`#/` fleet, `#/history`; the old `#/usage` app was removed in #30).

Verified by tests (frontend suite 89 tests, plus the old app's 15 that existed then): reducer actions and the 150 cap;
formatters at 0, 999, 1000, 1.5M, 3,600 s and 86,400 s; all six sorts and every filter; tree guides,
cycles and orphans; polyline points; git line in all four cases; blowout levels 1 and 2 on cards; agent
strip classes; focus page navigation, selection kept across updates and cleared with a message on
removal; facts bar order; charts (markers, caption, crosshair readout); tree sort, reverse and "Show as
tree"; plan states and empty text; context bar thresholds; activity paging, navigation from fail and
blow rows, inert rows of ended sessions; failure box; "inherited" on forks; hostile `<img onerror>`
strings render as text; resize handles (keys, drag, double-click, limits, throwing storage); copy and
its fallback; roles and labels; theme persistence; `useFleet` silence detection and reconnect.

Verified in a real browser (Chrome, through Claude in Chrome) against the server and
`podium-sim --sessions 6 --chaos`, at 1440 px and in light and dark: wall, rail, KPI strip, cards, legend,
orchestrator page (header, three charts with hover crosshair and readout, a blowout marker and caption,
facts bar, plan, agent tree, flash on select), side panel (activity paging, a click on an "Open agent"
row opened the session and agent and flashed the row, failure box with "The step went back to the
plan"), Model sort order in rail and wall, text filter and its empty message, a real mouse drag on the
activity handle (340 to 510 px, saved), double-click reset, Tab focus ring, Copy resume command
("Copied", then back), theme kept across a reload, `#/usage` unchanged (the old app has since been removed). Stopping the server showed
"disconnected, retrying" at once; restarting it brought the page back in 2.3 s with no reload.

400 px: Chrome would not size the window that narrow, so the check ran in a 400 px same-origin iframe
of the app (media queries follow the iframe's width). Wall, orchestrator page and agent detail had
`scrollWidth` 381 in a 396 px viewport (15 px scrollbar): no horizontal scroll, in dark and light.

Found and fixed while running in the browser: the page was 28 px taller than the viewport and 172 px
too wide at 400 px, both from visually hidden labels whose containing block sat outside their scroll
container (columns and the agent tree scroller now set `position: relative`); the resize handles shared
the `.rail` / `.side` class names with the columns and lost their positioning (renamed `rz-rail` /
`rz-side`); long output lines widened the failure box and clipped its text; a pointer event without a
usable `clientX` produced a NaN width (fixed test-first); the "now" caption of the peak chart was red
with no blowouts.

Not verified: real touch input; screen reader output (roles and names are asserted in tests only).

### Phase 3: the reporter mod

Built: `mod/podium-reporter/` with `plugin.json` (eleven options as of 0.14.2), `hooks/hooks.json`, `register.ts`
(wiring), `state.ts`, `plan.ts`, `failures.ts`, `models.ts`, `report.ts`, `transport.ts`, `git.ts`,
`protocol.ts`, their tests, a `tsconfig.json` from the types header, and
`scripts/podium-mod-typecheck.sh`.

Verified: `claude plugin test mod/podium-reporter` (76 tests), `claude plugin validate` (passes, output
above), `tsc` against the engine's declarations (`scripts/podium-mod-typecheck.sh`), and a vitest
cross-check that a scripted mod Report passes the server's validator unchanged. Two real runs:

1. `claude --plugin-dir mod/podium-reporter --model haiku --output-format json -p "Use TaskCreate to add
   one task named 'List files'. Then use the Agent tool once (subagent_type Explore) to list the files in
   this directory. Reply with the file count."` in this repo: the session appeared in `/api/fleet/state`
   (28 one-second polls saw it running, waiting, then done) with model `claude-haiku-5-5`, effort
   `medium`, branch `feat/podium-fleet-console`, repo `eengelking/podium`, plan "List files"
   (done), one Explore agent (done, its own tokens and estimate), cost $0.014450 equal to the CLI's
   total; it ended (`endReason: other`) and left the live set ("session ended").
2. The same mod in a scratch git worktree with "Use the Agent tool once, with subagent_type
   general-purpose and effort low, asking it to reply with the word hello. Then reply done.": worktree
   detected, effort `low` at spawn.

Not verified for real: a subagent's own compaction, a teammate, `classic.Notification`, a `/clear` (the
id switch is covered by tests), and the status line (both runs were headless).

### Phase 4: integration and hardening

Built: `scripts/podium-smoke.sh` (T4.1), `scripts/podium-soak.sh`, robustness tests
(`server/src/fleet/robustness.test.ts`, a two-minute outage test in the mod), README, `.env.example`.

Verified:

- `npm run podium:smoke`: every check passed in 28 s (4 live sessions with 18 agents, 60-point series,
  snapshot first, session, activity, tick and removed events, sessions gone after the linger time, the
  Vite proxy delivering 6 ticks over 10 s), nothing left running, temp files removed. A copy with a 30 s
  linger exited 1 with the two expected failures.
- T4.3.1: malformed JSON, raw control characters, a 1 MB body, 5,000 agents, deep nesting and wrong
  content types all get a 4xx; invalid UTF-8 does not crash it; the server serves normally afterwards.
  Reading chosen: "strings with control characters" are rejected only when raw (invalid JSON); escaped
  ones are valid JSON, so they are stripped and the report accepted (7.7 says to clamp strings, and
  terminal output carries ANSI escapes).
- T4.3.2: `podium-soak.sh --restart` killed the server with SIGKILL 40 s in and restarted it on the same
  database: right after, all 5 sessions were `stale`; 8 s later all were `running`.
- T4.3.3: in the kit, two minutes of server outage with events every 5 s lost none, and the reporter's
  own time per hook stayed at about 0.01 ms (0.03 ms worst) with the server down.
- T4.3.4: 10 sessions x 20 extra agents for 300 s with 3 SSE clients: every client kept receiving (150
  ticks each, 467 messages in the last 30 s); RSS 121.6 MB at 30 s, 131.7 MB at 300 s (see Known issues).
- T4.2: the checklist above, including the burst, the never-ending session and a real session watched
  live in the browser (run 3: two parallel Explore agents and a two-step plan; cost equal to the CLI's).
- `npm run build` then `npm run start -w server` serves the built UI and API from one port.

### Phase 5: optional extensions

Done after Phases 0 to 4 passed.

- **T5.1 classic hook ingest.** `server/src/fleet/hookIngest.ts` and `POST /api/fleet/hook`. Payloads
  shaped from the engine's `ClassicHookInputs` (SessionStart, UserPromptSubmit, SubagentStart, PostToolUse,
  SubagentStop, Notification, Stop, SessionEnd) build a reduced session marked `reporter: 'hooks'`; the UI
  labels it "settings hooks" and says context, cost and the plan are unavailable. Tested through the
  route, and the README's curl command was run against the dev server (it exits 0 with the server down).
- **T5.2 failure explanations.** `explainFailures` (default off) asks `haiku` at `low` effort for at most
  two sentences per failed agent, from the redacted failure record only; one call per failure, never
  retried; its estimated cost is added to the agent's. Tested in the kit (off: no call; on: an erroring
  call is not retried, a later failure is explained once, secrets stay out of the prompt). Not run
  against the real model.
- **T5.3 history page.** `#/history` lists the sessions that ended or were dropped on a chosen day and
  opens a read-only orchestrator page with agent detail from stored rows. Tested with a mocked server and
  checked in Chrome by DOM (86 sessions listed for the day, one opened, no horizontal overflow); the
  window was hidden by then, so no screenshot.
- **History paging (#195).** The server pages: `GET /history` takes `page` and `pageSize` (25, 50 or 100, default 50)
  and answers `{ day, sessions, total, page, pageSize }`, so a busy day is not sent whole. `Fleet.historyPage`
  filters out unused sessions and sorts the stored rows newest first (the session id breaks ties, so a row does
  not move between pages), clamps a page past the end to the last one, and only then builds the rows of that
  page, so the agents query and the repricing run once per row shown, not once per session of the day (#273). The page reuses Admin's `Pager`. Day, page, size and the opened session live in the hash
  (`#/history?day=&page=&size=&open=`); `HistoryView` writes it with `pushState` when a session opens and
  `replaceState` for every other change, and re-reads it on `popstate`, so the browser's Back button returns to the
  same page. `main.tsx` listens only to `hashchange`, which neither call fires, so the view is not remounted.

### Code review pass (before the PR)

One `/code-review` pass over the branch found ten issues. Nine are fixed, each with a test written first
that failed for the reason described; one part is deliberately left as is.

- **SubagentStop flipped a working session to waiting** (`hookIngest.ts`). Only `Stop` means the main loop
  is idle now.
- **Hooks overwrote a mod-reported session** (cost, tokens, plan, blowouts, reporter). A hook for a session
  whose stored reporter is not `hooks` is acknowledged and ignored.
- **Hook-only sessions went stale after 15 s and were dropped at 75 s** though alive, because hooks send
  no heartbeat. They now use `HOOK_STALE_AFTER_MS` (default 10 minutes); the drop window follows it.
- **A rejected (400/413) report was re-posted every flush tick.** The transport now backs off 1, 2, 5, 10 s
  after a rejection as it does after a failure, and a success clears it.
- **`explained` was keyed by agent only,** so a retried agent that failed again was never explained. It is
  keyed by the failure's time too. A failed model call is still not retried, as the spec says.
- **Every Notification counted as a wait.** Only permission, idle and elicitation notifications do.
- **Hook event ids** now carry a digest of the payload and the second, so two different hooks in one
  millisecond keep both events, and the same payload retried at once is still one event.
- **`SseHub.add` returning null was reported as "too many clients"** even when the client had gone. The
  route checks `isFull` first and says nothing to a client that is already gone.
- **`clockSkew`** is forgotten when a session leaves the live set or is deleted.
- **`GET /history`** rejects days that do not exist (2026-02-31) with a 400. The day is still the server's
  local calendar day, which is right for a tool that runs on one machine; a `tz` parameter is deferred.

## Running as a service

`bin/podiumctl` (plain ESM, no dependencies, `bin` entry in the root `package.json`) manages the
server in one of two modes, chosen with `--mode` and saved in `~/.podium/config.env`:

- **container**: `Containerfile` is a two-stage Node 24 build (build stage runs `npm ci` and both builds;
  runtime stage has production deps for `server`, the two `dist` trees, user `node`, `/data` volume).
  `podiumctl` runs it as `podium` with `--restart unless-stopped`, port published on the chosen bind
  address, named volume `podium-data`, and a `--health-cmd` (the `HEALTHCHECK` instruction is dropped
  by Podman's default OCI image format). It also passes the host's time zone as `TZ`, so the day for "Est. cost today"
  is the host's. Inside, the server binds `0.0.0.0:4317`; the host-side bind is where access is limited.
- **standalone**: a detached `node server/dist/index.js` with a pid file and `~/.podium/podium.log`. The
  pid file is only trusted if that pid's command line is `podiumctl` or the server entry, so a reused pid
  is never signalled. Under the boot service, `podiumctl run` writes its own pid (not the server child's),
  so `stop` reaches its SIGTERM handler and the service does not restart the server. `start` refuses to
  spawn when something already accepts connections on the bind address and port, and only reports success
  for the process it spawned: if that process exits while `start` waits, it removes the pid file and
  shows the tail of the log. (Container mode relies on `podman run` failing when the port is taken.)

Secrets reach the server through the process environment (`podman run -e NAME` with no value), never
the command line. The token is generated on first start; an empty `PODIUM_TOKEN` is the deliberate
"auth off" setting. `enable` writes a launchd plist (macOS) or systemd user unit (Linux) that calls
`podiumctl start` (container; idempotent) or `podiumctl run` (standalone; foreground, restarted only on
a non-zero exit, so `stop` is not undone). The reporter mod is not containerized: it runs inside each
Claude Code process and posts to the server's URL. It is installed from `eengelking-marketplace` (39); its
`token` option is secret, so it is set with `/plugin configure`, not the `/config` menu.

Verified on macOS with Podman 6.1.2: build, start, token enforcement (401 without, accepted with),
non-root user, restart, stop, standalone start/stop, `run` plus SIGTERM, launchd enable/disable in both
modes, purge, and `claude plugin install podium-reporter@eengelking-marketplace` against the live
marketplace with a clean config directory. The systemd path is covered by a unit test of the generated text
only (known issue 12).


## Multi-CLI monitoring (vsterian fork)

Native adapters live in `reporters/`. Shared dependency-free ESM code allowlists native event metadata, redacts strings and transports bounded events to `POST /api/fleet/event`. Codex and Copilot hooks are one-shot advisory commands; Copilot's native extension joins the existing session through its bundled SDK, while OpenCode's plugin subscribes to native events. The extension/plugin send heartbeats; hooks use the existing longer hook silence allowance.

`nativeEvents.ts` validates and reduces events into the original Report protocol, then uses the original Fleet ingest/auth/SSE pipeline. Migration 18 adds optional integration metadata, native restart checkpoints and per-message/per-call usage snapshots. Nested SQLite savepoints make checkpoint, event deduplication and usage updates atomic with existing report ingestion. Native state and usage cascade when a session is removed. Retry IDs are deduplicated using the existing events table; usage snapshots replace the same message rather than adding it twice. Older lifecycle events cannot reopen an ended session; an explicit start/prompt can resume it. Rich extension events take precedence over reduced hook events.

Integration metadata identifies engine, native ID, reporting mode and observed metrics. Old reports/rows retain original Claude behavior. Resume commands quote cwd/native IDs and select the correct CLI. Native pricing keys are engine-qualified and require explicit Admin prices; provider-reported OpenCode USD is retained. Copilot billing multipliers never enter the USD field. Normal compaction is not context exhaustion.

Activity text is accepted only under the existing viewer lease, kept in the existing in-memory activity store, and excluded from checkpoints. Prompts, reasoning and raw transcript records are never forwarded by the new adapters. Enrichment reads a bounded 512 KiB tail of the exact transcript path supplied to the hook, checks session identity where present and extracts metadata only. Unknown formats remain unavailable. Transport queues are bounded to 200 in-memory events; one-shot hooks have no durable offline spool.

The installer writes narrow native hook/plugin shims referencing this checkout and private runtime config. It merges Codex hook groups, owns a separate Copilot hooks file and refuses to overwrite unowned plugin/extension files. Codex trust is reviewed through `/hooks`; no global trust bypass is installed. E2E alone uses the vetted-hook automation bypass in its private temporary Codex home.

OpenCode 1.3.x can dispose its event bus without awaiting plugin callbacks. The plugin therefore flushes pending normalized events and terminal session markers through a bounded Node child at process exit (two-second maximum). This preserves final usage and history without taking over the CLI's signal handlers. Hard kills and machine failures still rely on silence detection.
