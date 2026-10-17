# SPEC: Podium, a live fleet console for Claude Code orchestrators

| | |
|---|---|
| Status | Implemented. Amended after the first build for the container, `podiumctl` and the marketplace install (4.4) |
| Weight class | Phased (single implementing agent, one phase at a time) |
| Visual reference | `mockup/podium.html` (authoritative for look, layout, copy and behavior of the UI) |
| API reference for the mod | `plugin-authoring` skill, types file at `/private/tmp/claude-501/bundled-skills/2.1.296/d92c7b49108d4f84cc512e5d19a6266f/plugin-authoring/types/claude-code.d.ts` (see section 5.1 if that path is gone) |

Podium shows every Claude Code session running on one machine in one browser tab. Each session is an
**orchestrator**: a main agent that can launch **subagents** (blank slate) and **forks** (a copy of the
orchestrator that keeps its context). Podium shows each orchestrator's model and effort, its plan, the tree
of agents it launched, what each agent costs, how full its context window is, whether it blew out that
window, why anything failed, and which git branch or worktree it works in. Orchestrators appear when a
session starts and disappear when it ends, with no refresh.

It is built from three parts: a **reporter mod** that runs inside every Claude Code session and sends
snapshots, a **server** that stores and serves them, and a **browser UI** that renders them live.

This repo began with an earlier app (`server/`, `frontend/`) that charted Claude Code and Admin API usage.
Podium was added next to it, and that usage dashboard has since been removed (issue #30).

---

## 1. Goals and non-goals

### Goals

1. Show all live Claude Code sessions on this machine, updating within about 2 seconds of a change, with no
   page refresh. A new session appears by itself. An ended session leaves by itself.
2. Per orchestrator: name, working directory, git branch, whether it is a worktree, ahead/behind/modified
   counts, model, effort, status, context fill, estimated cost, token count, elapsed time, resume command.
3. Per orchestrator: the plan it is working through (from its task list), step states, and which agent owns
   which step where that can be determined.
4. Per agent (subagent or fork): parent, kind, type, description, model, effort, status, context fill, tokens,
   estimated cost, elapsed time, skills it loaded, last tool, and a failure record when it failed.
5. Make context-window blowouts impossible to miss: count them per loop, flag a loop or session that blew
   out twice or more as likely to have lost context, and show when each one happened.
6. Make a failure explorable: show the failing call, its output, and the evidence for the likely cause.
7. Sort and filter: by status, model, context blowouts, context fill, cost, newest; agents by any column.
8. Activity stream that is capped in memory, pages 12 at a time, and links each row to the thing it is about.
9. Charts per orchestrator for the last 60 seconds: tokens per second, peak context in any loop with
   blowout markers, subagents running. Fleet-level sparklines for cost and tokens.
10. Color themes (Podium, Solarized, Nord, Gruvbox, Catppuccin, GitHub), each with light and dark, picked from a dropdown with a light, dark or system mode; resizable side panels, keyboard accessible, usable at phone width.
11. Survive restarts: sessions, agents and events persist in SQLite. A restart of the server loses nothing
    that was already reported.
12. A simulator script that feeds the server realistic reports so the UI can be developed and demoed with no
    Claude sessions running.
13. Answer a session that waits on its person from the browser (#206, `mockup/podium-respond.html`): an
    AskUserQuestion form, a plan to approve, a tool's permission prompt, or a turn that ended. The terminal keeps
    working the whole time, and whichever answers first wins. Off unless the Admin and the session's owner both
    turn it on (5.9, 7.7).

### Non-goals (do NOT build these)

- No general control surface (DECISIONS 28 replaced "Podium only observes"). Podium can answer a session that
  waits on its person, and only in the ways Claude Code's own dialogs offer: answer an AskUserQuestion (an option,
  a typed answer, or a message in place of an answer), approve a plan in one of three modes or send it back with
  feedback, allow one tool call once or deny it with a reason, send a new message, and run `/clear` or `/compact`.
  All of it goes through podium-reporter inside the session, which fetches it from the server; the server never
  connects to a session. It is off unless the Admin turns on **Respond from Podium** and the session's owner sets
  the reporter's `respond` option (5.9), and only the session's owner or an Admin can use it (7.7). Podium never
  types into a terminal or opens one (the web terminal of #21 was not built), never changes a session's
  permission rules ("always allow" stays in the terminal), never runs any other slash command (`/model` and
  `/effort` included), never edits a plan's text, and never starts, stops, resumes or kills a session or an
  agent. The dashboard may also copy a resume command to the clipboard and remove a heartbeat-lost card from the
  live view early (7.5); neither sends anything to a session.
- No hosted service. Several people may report to one server, each with their own token (7.7), but it is
  still one server you run yourself. The server binds to `127.0.0.1` by default. In the container image it
  listens on all interfaces inside the container, and the port is published only on the host's `127.0.0.1`
  (4.4). Reaching it from other machines is an explicit choice (`--bind`) and needs a trusted network or a
  TLS proxy.
- No hosted deployment, accounts, or cloud sync. A container on the same machine is not a hosted deployment.
- No billing accuracy. Cost is an estimate from token counts and a price table. The UI always labels it as
  an estimate. Never present it as an invoice.
- No reading of conversation transcripts. Podium sends short excerpts only (section 6.4), never whole
  messages or files. The one exception is opt-in: with the `fullPrompts` option on, an agent's own task
  prompt and final answer go out whole (up to 20,000 characters each, 6.4), never the conversation around them.
  The other is the opt-in activity feed (`activityFeed`, #118): while someone watches an agent's panel, that
  loop's recent tool calls and the text it writes between them go out as short entries (300 characters each,
  the last 20, 6.4), and only for as long as someone watches. The model's thinking is never sent.
- No usage dashboard. The earlier one was removed (issue #30); it is not replaced.
- No terminal UI or pane inside Claude Code in this spec. A minimal `/podium` command and a status-line entry
  are in scope; a full pane is deferred (section 11).
- No accounts, passwords, per-person read permissions or roles beyond one: administrator. Authentication is a token per person plus an admin secret that opens the Admin section (signed in with the name `Admin`), and a person in the built-in Administrators group may open Admin with their own name and token too (section 7.7). A person also signs in to the console with their own token, but only to respond to their own sessions (7.7). Reading the console stays open.
- No new chart or UI libraries beyond those in section 2. Charts are inline SVG, as in the mockup.

---

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Reporter mod | TypeScript hooks module for Claude Code's mod API (`plugin.json` + `hooks/register.ts`) | The only mechanism that sees agent spawns, per-step usage, compaction, tool results and plans from inside a session, and can send them out (`$.http.fetch`). |
| Server | Node 24 (already in use), Express 4 (already in the repo), TypeScript | Matches the existing `server/` workspace. |
| Database | SQLite through Node's built-in `node:sqlite` (`DatabaseSync`) | No native build step, no new dependency, plenty for one machine. If `node:sqlite` proves unusable under vitest, fall back to `better-sqlite3` and say why in `docs/ARCHITECTURE.md`. Bump `@types/node` in `server/` to a version that declares `node:sqlite`. |
| Live updates | Server-Sent Events (`text/event-stream`) | One-way push, built into browsers, no dependency, reconnects by itself. |
| Frontend | React 18 + Vite + TypeScript (already in the repo) | Matches the existing `frontend/` workspace. |
| Charts | Hand-written inline SVG | The mockup's charts are small polylines with markers; a library would fight the design. |
| Styling | Plain CSS with custom properties, ported from the mockup | The mockup defines the tokens for both themes. |
| Tests | vitest (server, frontend), `claude plugin test` (mod) | vitest is already configured. The mod's tests must run on the engine itself. |
| Fonts | Schibsted Grotesk and JetBrains Mono from Google Fonts, with system fallbacks | Same as the mockup. The app must still work offline with the fallbacks. |

No other runtime dependencies without a written reason in `docs/ARCHITECTURE.md`.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| Session | One running Claude Code process conversation, identified by its session id (`$.session.id()`). A `/clear` ends a session and starts another in the same process. |
| Orchestrator | The main loop of a session. Podium's top-level row. Same thing as a session. |
| Agent | A loop the orchestrator started: a subagent, a fork, or a teammate. Has an `agentId`. |
| Subagent | An agent that starts from a blank slate (only its prompt). Model and effort can be set at spawn. |
| Fork | An agent that is a copy of its parent: keeps the parent's whole context. Always uses the parent's model and effort. The Agent tool spells it `subagent_type: "fork"`. |
| Loop | The main loop or any agent. Context is measured per loop. |
| Plan | The orchestrator's task list (`TaskCreate`/`TaskUpdate` tools, or `TodoWrite`), shown as steps. Without those tool calls there is no plan; plan mode is not a source (6.3). |
| Blowout | A loop's context window filled up and was compacted automatically, or the API reported the window exceeded. The count per loop is the signal for lost context. |
| Compaction | Summarizing older conversation to free context. Manual (`/compact`) is not a blowout. Automatic is. |
| Reporter | The mod. Runs in the Claude Code process and posts reports. |
| Report | One JSON snapshot of a session plus any new activity events, POSTed to the server. |
| Stale | A session the server has not heard from for 15 seconds and that never reported ending. |
| Effort | The reasoning-effort level: `low`, `medium`, `high`, `xhigh`, `max`. |
| Mod / plugin | The Claude Code extension mechanism. This spec uses "mod" for the reporter. |
| Ask | One thing a session waits on its person for, that Podium can answer (#206): an AskUserQuestion form, a plan (ExitPlanMode), or a tool's permission prompt. Its id is the tool call's `tool_use_id`. |
| Delivery | One answer or message sent from the browser, held by the server until the mod fetches it and says whether the session took it (6.2, 7.1). |

---

## 4. Architecture

```
 Claude Code session A  ──┐   POST /api/fleet/report (JSON, ~1/s while changing, heartbeat every 5 s)
 Claude Code session B  ──┼──────────────────────────────►  Podium server (Express, 127.0.0.1:4317)
 Claude Code session C  ──┘   (reporter mod, via $.http.fetch)     │  validate → upsert → derive → persist (SQLite)
                                                                   │
 Browser tab  ◄──────────  GET /api/fleet/stream (SSE)  ◄──────────┘  sweeper: stale / done / dropped
              ───────────► GET /api/fleet/state (first paint + resync)
```

### 4.1 Repo layout (create exactly this; do not move existing files)

```
docs/SPEC.md                         this file
docs/ARCHITECTURE.md                 written during the build (Phase 4 and section 10)
docs/fixtures/report.sample.json     one full valid Report (section 6); shared by mod and server tests
mockup/podium.html                   visual reference, do not edit
mod/podium-reporter/                 the Claude Code mod
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts                  wiring only: registers hooks, no logic
  hooks/state.ts                     in-memory session model and pure reducers
  hooks/report.ts                    builds a Report from state
  hooks/transport.ts                 queue, flush, backoff, offline buffer
  hooks/git.ts                       branch, worktree, ahead/behind, dirty
  hooks/plan.ts                      Task*/TodoWrite → plan steps
  hooks/failures.ts                  classify and excerpt failures
  hooks/models.ts                    model family, context windows, price table
  hooks/protocol.ts                  Report types (kept identical to server/src/fleet/protocol.ts)
  hooks/respond.ts                   responding from Podium (#206): asks, answers, terminal lines (pure)
  hooks/*.test.ts                    run by `claude plugin test`
server/src/fleet/
  protocol.ts                        Report + view types, validators
  db.ts                              schema, migrations, queries
  ingest.ts                          Report → rows, events, blowouts, samples
  derive.ts                          SessionView, KPIs, blowout level, series
  sweeper.ts                         stale / linger / drop timers
  sse.ts                             client registry and broadcast
  routes.ts                          Express router mounted at /api/fleet
  respond.ts, respondRoutes.ts       responding from Podium (#206): the in-memory store, the mod's and the browser's routes
  lockout.ts                         wrong-credential lockout shared by Admin and the sign-in to respond
  *.test.ts
frontend/src/fleet/
  FleetApp.tsx, useFleet.ts (SSE + reducer), store.ts, format.ts
  components/…                       see section 8.2
  fleet.css                          tokens and layout ported from the mockup
  *.test.tsx
scripts/podium-sim.ts                simulator (has --help)
scripts/podium-smoke.sh              end-to-end smoke check (has --help)
scripts/podium-respond-demo.mjs      seeds a throwaway server with waiting sessions to answer (#206; has --help)
scripts/podiumctl.test.ts            tests for podiumctl (4.4)
bin/podiumctl                        command-line manager for the server (4.4; has --help)
Containerfile, .containerignore      the server and UI as a Podman image (4.4)
```

`server/src/index.ts` mounts the fleet router and starts the sweeper. `frontend/src/main.tsx` renders
`FleetApp` for `#/` (default), `HistoryView` for `#/history` and `AdminView` for `#/admin`.

### 4.2 Ports and addresses

- Server: `PORT` env, default `4317` (already the repo's default). Binds `127.0.0.1` unless `HOST` is set.
  The container image sets `HOST=0.0.0.0` and `PORT=4317` inside the container (4.4).
- Vite dev server proxies `/api` to the server (check `frontend/vite.config.ts`; add the proxy if missing).
- Mod option `serverUrl`, default `http://127.0.0.1:4317`.

### 4.3 Data ownership

The mod owns what is true inside a session. The server owns time: staleness, lingering, dropping, series
(tokens per second, peak context, running count) and blowout severity. The UI owns presentation only. The
UI never computes anything it could not recompute from one `SessionView` (section 7.4).

### 4.4 Packaging, running and distribution

Added after the first build. `docs/ARCHITECTURE.md` ("Running as a service") records how it was built.

- **Image.** `Containerfile` builds the server and the UI into one image: a build stage that runs `npm ci`
  and both builds, and a runtime stage with the server's production dependencies, the two `dist` trees, a
  non-root user and a `/data` volume for the SQLite file. Nothing else is needed; there is no second
  service.
- **`podiumctl`** (`bin/podiumctl`, no dependencies, a `bin` entry in the root `package.json`) manages
  the server in one of two modes, `container` (the default when Podman is installed) or `standalone` (a
  Node process on the host). It has `build`, `start`, `stop`, `restart`, `status`, `logs`, `health`, `url`,
  `token`, `config`, `enable`, `disable`, `shell`, `rm` and `run`, and a `--help`. `status` exits 3 when the
  server is stopped. `--mode`, `--port` and `--bind` are saved in `~/.podium/config.env` (mode 0600, home
  overridable with `PODIUMCTL_HOME`).
- **Network.** In container mode the port is published on `127.0.0.1` unless `--bind` says otherwise. Inside
  the container the server listens on `0.0.0.0`; that is the only place the `127.0.0.1` default (7.7) is
  not what the server binds.
- **Token.** The first `start` generates a random `PODIUM_TOKEN` and saves it in `config.env`. It is the admin
  secret (7.7): it opens the Admin section and may be used to report. `podiumctl
  token` prints it and `--rotate` replaces it (after a restart every open Admin session is over, and people's own
  tokens, which are in the database, are unaffected). An empty value is the deliberate "auth off" setting and is
  passed through to the server as empty. Secrets reach the server through its environment, never a
  command line.
- **Start on boot.** `enable` and `disable` write and remove a launchd agent (macOS) or a systemd user unit
  (Linux). In container mode the unit runs `podiumctl start`; in standalone mode it runs `podiumctl run`
  (foreground, restarted only after a non-zero exit, so `stop` is not undone). The unit names the `node` that ran `enable`; when that is a Homebrew Cellar path (`<prefix>/Cellar/<formula>/<version>/bin/node`) it names `<prefix>/opt/<formula>/bin/node` instead, which a `brew upgrade` leaves in place. `status` reports a unit that does not name the current script path as stale; running `enable` again rewrites it.
- **The mod is not containerized.** It runs inside each Claude Code process and posts to `serverUrl`.
  It is installed from `eengelking-marketplace`: `eengelking/skills` lists `podium-reporter` in its
  `.claude-plugin/marketplace.json` with a `git-subdir` source pointing at `mod/podium-reporter` in this
  repo (a full `https://` URL; the `owner/repo` shorthand clones over SSH). Users run
  `/plugin install podium-reporter@eengelking-marketplace`. This repo carries no marketplace file. The
  mod's version is set in `plugin.json` and in `VERSION` in `hooks/register.ts`, kept equal by `scripts/versions.test.ts`. The `token` option is `sensitive`, so it
  is set with `/plugin configure`, not the `/config` menu. `claude --plugin-dir` stays the way to work on
  the mod.

---

## 5. The Claude Code mod API: everything the reporter needs

This section is the working reference. Everything marked **Verified** was read from the engine's type
declarations on the build this spec was written against (engine 2.1.296). Everything marked **Assumption** must be
checked by the implementer against the types file or with `claude plugin validate` before relying on it, and
any wrong assumption must be recorded in `docs/ARCHITECTURE.md` under "Mod API findings".

### 5.1 Where the truth is

- Types file (this build): `/private/tmp/claude-501/bundled-skills/2.1.296/d92c7b49108d4f84cc512e5d19a6266f/plugin-authoring/types/claude-code.d.ts` (about 21,000 lines; grep it, do not read it whole). Long form guide: `.../plugin-authoring/reference.md`. Examples: `.../plugin-authoring/examples/`.
- If that path is gone, invoke the `plugin-authoring` skill (it rewrites the types and names the new folder). Once a mod is loaded from a folder the engine watches, the same types appear in `<mod folder>/.claude-plugin/types/` and `tsc -p <mod folder>` type-checks the mod.
- The API is early access and moves between releases. The declaration file is the authority. This section is a map.

### 5.2 Shape of a mod (Verified)

A mod is three files plus optional extras:

- `.claude-plugin/plugin.json`: `{ "name": "podium-reporter", "version": "0.1.0", "description": "…" }`. Add `"userConfig"` for options (see 5.9) and `"types"` only if the mod keeps values in `$.state`.
- `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`. Exactly one path, relative to that file.
- `hooks/register.ts`: `export const register: Register = (on, options) => { … }` with `import type { Register } from 'claude-code'`.

Rules the module must obey:

- Runs in its own sandbox: **no DOM, no Node, no `import()`**. Everything outside is reached through `$`.
- Every file the plugin imports must be `.ts`, `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts` and is an ES module. Import with `import` declarations only. **Assumption:** relative imports may need explicit extensions (`./state.ts`); try `validate` and keep whichever form it accepts.
- A hook is `($, e, next)`. `next(e)` runs the plugins beneath and then the engine, resolving to the event's result. Returning without `next` answers for yourself (never do this in the reporter except for the commands and tool it registers). `next({ ...e, x })` rewrites. The reporter only observes: it must always call `next(e)` and return what it resolves to unchanged. The one exception is answering for Podium (5.3, "Responding"): with the `respond` option on, the hooks for an open ask may return an answer from Podium while `next(e)` is still pending, and nothing else.
- A hook that throws or outlasts its budget is skipped. Wrap every reporter hook body in `try/catch`; on error, record it in a bounded in-memory error list and still `return next(e)`. For hooks where `next` may already have run, never call it twice.
- Module variables are lost on hot reload. That is fine for the reporter: rebuild state from `$.agent.list()`, `$.session.*` and `$.session.usage()` on `session.start` and on reload, and accept some lost event history.
- Reload: a reload runs `register` again and fires `session.start` again. `$.store` (across sessions) and `$.state` (the session's) survive.

Run during development:

```
claude plugin validate mod/podium-reporter          # manifest + source: lists every event hooked and every $ call made
tsc -p mod/podium-reporter                           # only once the engine has laid types in .claude-plugin/types/
claude plugin test mod/podium-reporter               # runs hooks/*.test.ts against the engine
claude --plugin-dir mod/podium-reporter              # a session with the mod loaded (hot-reloads on save)
claude --plugin-dir mod/podium-reporter -p "…"       # headless; always loads fresh
```

### 5.3 Events the reporter hooks

`on(event, matcher?, hook)`. Matchers narrow by the event's key (for `tool.call`: `{ tool: 'Agent' }`).

| Event | Raised when | Input fields the reporter uses (Verified unless noted) | Reporter's use |
|---|---|---|---|
| `session.start` | Session ready; also after every hot reload | `cwd`, `surface` (null for `-p`/SDK), `isInteractive` | Create the session model; start timers; register `/podium`; first report. |
| `session.end` | Session ends, including `/clear` | `reason` (the classic SessionEnd reason, includes `clear`), `sessionId`, `resume.id` | Send a final report with `status: "done"`, `endReason`, `resumeId`. After `reason: "clear"` **no `session.start` fires**: the process continues under a new session id (see 5.8). |
| `agent.spawn` | An agent is about to start (`agent.spawn` hook also covers `$.agent.spawn`) | `tool_use_id`, `prompt`, `description`, `subagentType`, `model?`, `parentModel`, `parentAgentId?` (absent = main loop), `background`, `fork` (true for a fork), `isTeammate?`, `name?`, `cwd?`, `provider` | Create an agent record. Result of `next(e)` is `{ model, agentId, teammateId? }` or `{ deny }`: key the agent by `agentId`. Effort is **not** on this event. |
| `tool.call` | Any tool call, main loop or agent | `tool`, `tool_use_id`, the tool's own arguments (`e.command` for Bash, etc.), `agentId?` (set inside an agent). Result: `{ result, text, isError? }` or `{ deny }` | (a) For `tool: "Agent"`, read the requested `effort`, `model`, `subagent_type`, `description`, `name` and key them by `tool_use_id` (this is where effort at spawn is visible). (b) For `tool: "Skill"`, read `skill` and attach to the loop (`agentId` or main). (c) For `TaskCreate`, `TaskUpdate`, `TodoWrite`: update the plan. (d) For every tool: if the result `isError` or is `{ deny }`, record a failure candidate on that loop (section 6.4). (e) With the `activityFeed` option on and the loop watched (6.4), add one activity entry for the call before it runs: the tool's name and a short summary of its arguments. (f) For every tool, remember the loop's latest call (tool, input, `tool_use_id`), so a permission prompt can be paired with it. (g) For `AskUserQuestion` and `ExitPlanMode` while the mod responds: open an ask and wait for an answer (see "Responding" below). |
| `tool.check` | The permission check of a call, before any dialog (#206) | `tool`, `input`, `agentId?`, the call's id. Result: `{ decision: 'allow' \| 'ask' \| 'deny', … }` | Only while the mod responds. Await `next(e)` and return it unchanged. When it resolves to `ask`, note that a prompt should follow, to find out whether `classic.PermissionRequest` hooks run here (see "Responding"). |
| `turn.start` | Main loop turn starts (a subagent's run raises none) | `text`, `turnId` | Mark the orchestrator `running`; remember `turnId`. |
| `turn.step` | One model request of a turn, in any loop. **A streaming event: the hook must be an `async function*`** (`yield* next(e)` forwards and evaluates to the result). | Input: `turnId`, `index`, `model`, `effort?`, `messageCount`, `agentId?`. Result (after the stream): `answer`, `toolUses`, `stopReason`, `usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model } \| null` | Per loop: record model and **observed effort**; context tokens = `input + cache_read + cache_creation` of the latest step; accumulate token totals and cost; if `stopReason === "model_context_window_exceeded"` or `"compaction"`, record a blowout. With the `activityFeed` option on and the loop watched (6.4), read the stream with `for await (const chunk of stream)`, yield every chunk on unchanged and in order, take the result from `stream.result` (a `for await` drops the generator's return value), and keep the step's `text` chunks, joined, as one entry; `thinking` chunks are passed on unread. Any other step uses plain `yield* next(e)`. |
| `turn.complete` | A loop's turn ends | `answer`, `durationMs`, `isAborted`, `turnId`, `agentId?`, `usage?`, `reason` (`answer` \| `aborted` \| `refusal` \| `error`), `refusal?` when `reason` is `refusal` | Main loop: status `waiting` (waiting on the user). Agent: `answer` → `done`; `aborted` → `aborted`; `refusal`/`error` → `failed` with a failure record. |
| `session.compact` | Compaction runs, main or in an agent's own transcript | `trigger` (`manual` \| `auto` \| `plugin` \| `precompute`), `agentId?`, `instructions?`, `messages`. Result: either `{ messages, tokensBefore?, tokensAfter?, usage? }` or `{ skip }` | Await `next(e)`. If the result has `messages` and `trigger === "auto"`: **blowout** with `tokensBefore`, `tokensAfter`, `agentId`. `manual`: log a `compact` event, not a blowout. Ignore `precompute` and `skip`. |
| `session.attach`, `session.detach` | A client (terminal, phone) joins or leaves the session's roster | `surface`, `clientId`, on detach `reason` | Observe, then re-read `$.session.surfaces()` so `attached` follows at once. Await `next(e)` first and return its result unchanged. |
| `session.measure` | The status line's figures changed | `context: { tokens?, window, percent? }`, `rateLimits: [{ kind, percentUsed, resetsAt? }]`, `cost?: { usd }`, `changed: ('context'\|'rateLimits'\|'cost')[]` | Cheap trigger for main-loop context, session cost and rate limits without polling. Mark state dirty. |
| `classic.PermissionRequest` | A permission dialog is about to show (Verified hookable on 2.1.301, #206; it fires as the dialog opens, and the terminal draws the dialog while the hook waits) | `tool_name`, `tool_input`, `permission_mode`, and inside a subagent `agent_id`, `agent_type`. No `tool_use_id`. Result: `{ decision: { behavior: 'allow', updatedInput?, updatedPermissions? } \| { behavior: 'deny', message?, interrupt? } }` | Set orchestrator `status: "waiting"`, `waitReason: "permission"`, `waitNote: "<tool_name>(<short input>)"`. Cleared by the next `tool.call` of that loop or `turn.complete`. While the mod responds: answer a tool's prompt, or approve a plan, from Podium (see "Responding"). |
| `classic.Notification` | Claude Code raises a notification (needs permission, idle for input) | `message`, `title?`, `notification_type` | Fallback signal for `waiting`. |
| `classic.Stop` | The main loop stops and waits (#119) | `background_tasks?` (`{ id, type, status, description, command? }`), `session_crons?` (`{ id, schedule, recurring, prompt }`) | Record the work still in flight as `background`: tasks whose status is not finished, and wake-ups with their next fire time from the cron schedule in local time (null when the schedule cannot be read). A session idle on any of it is `waiting` with `waitReason: null`, not `input`. A monitor whose description starts with `live updates for artifact ` is Claude Code's artifact watcher: it lives as long as the session and is not counted (#128). A new turn clears it. A shell's command is never kept: a task with no description is named by the command's first word. |
| `classic.SubagentStart`, `classic.SubagentStop` | Subagent lifecycle | `agent_id`, `agent_type`, plus on stop `last_assistant_message?`, `agent_transcript_path` | Reconciliation only. `agent.spawn` + `turn.complete` are primary. |
| `classic.PreCompact`, `classic.PostCompact` | Compaction | `trigger`, `compact_summary` (PostCompact) | Not needed if `session.compact` works. Fallback. |
| `classic.TaskCreated`, `classic.TaskCompleted` | Task tool lifecycle | `task_id`, `task_subject`, `teammate_name?` | Fallback for plan tracking. |
| `prompt.submit`, `prompt.compose`, `skill.prompt` | Prompt and skill events | `skill.prompt`: `skill`, `text` | `skill.prompt` is a second source for "skill loaded" (no `agentId`). |
| `telemetry.*` (matcher `{ to: "collector" }` or `"anthropic"`) | Engine telemetry | varies | Optional, deferred. Not required. |

All hook inputs are plain frozen data. Do not mutate them.

**Agents that launch agents (Verified on 2.1.296 with real `claude -p` runs, #101).** A subagent has the Agent tool and can launch a subagent or a fork, and a fork can launch a subagent. Three levels (subagent, subagent, subagent) and every mixed pair were run. What the engine gives:

- `agent.spawn` sets `parentAgentId` to the `agentId` of the loop that made the call, at every depth, and leaves it out only for a launch from the main loop. `fork` is true for a fork at any depth. The result's `agentId` is the id the child's own events carry. So the reporter's `parentId` is the real parent, never the orchestrator by mistake, and needs no guessing.
- A fork inherits from the loop that launched it: under a subagent, that subagent's model and effort, not the orchestrator's.
- `tool.call` for the inner Agent call carries the launching loop's `agentId`; `turn.step` and `turn.complete` carry the child's.
- `$.agent.list()` gives the same `parentId`. While a parent waits on a child it lists the parent as `waiting` (the reporter keeps it `running`; the UI shows it as delegating, 8.1). Once a parent finishes, its finished children drop out of the list, so the list cannot rebuild a finished branch after a reload; the reporter keeps every agent it has seen.
- The classic `SubagentStart` and `SubagentStop` payloads have `agent_id` and `agent_type` but no parent. A session reported only through settings hooks therefore cannot say who launched an agent, and shows every agent under the orchestrator.
- Forks are off in a non-interactive `claude -p` run unless `CLAUDE_CODE_FORK_SUBAGENT=1` is set (the Agent tool answers "Agent type 'fork' not found"). In the runs with forks on, the main loop's launches came with `background: true` and the agents' own launches with `background: false`; the reporter does not send `background`.
- `$.session.usage().cost` includes every agent, nested ones too.

**Responding (#206, `mockup/podium-respond.html`).** Verified on Claude Code 2.1.301 with a throwaway mod in a real terminal session (the spike results and the correction on plans, both comments on #206, and a second check during the build that recorded every hook's input and timing), except where marked **Assumption** or **unverified**. The mod *responds* only while all of these hold: its `respond` option is not `off` (5.9), its `activityFeed` option is on, the session is interactive (`session.start`'s `surface` is not null, so a `claude -p` run never responds), and the reply to its last accepted report said `respond: true` (6.1). Otherwise every hook below observes exactly as before, and the mod announces nothing and accepts nothing.

- **What the session takes.** The mod works out `accepts` (6.2) from its `respond` level and narrows it where Claude Code can't do a kind (below). It checks every delivery against `accepts` itself and never relies on the server for it.
- **Announcing an ask.** When an ask opens, the mod adds it to `session.asks` (6.2), marks the state dirty, sends `PUT …/asks/:askId` at once (7.1), and writes `also open in Podium. Answer here or there.` with `$.ui.log`. Every report carries the open asks again, so a restarted server learns them back.
- **Waiting for an answer.** The hook then waits on the server with a held request, `GET …/asks/:askId/answer?wait=20` (7.1), again and again until an answer comes, the ask closes, or the hook's race ends. `$.http.fetch` gives up on a request after 30 seconds ("no complete answer within 30000ms", verified), so a hold is never longer than 20 seconds. The hook's 10-second budget stops while it awaits `next(e)` or any `$` call, so it can wait as long as the dialog is up. A 204 asks again; a 404 (a restarted server) announces again and asks again; a 410 stops; a network failure waits out the transport's backoff (6.7) and asks again. `$.http.fetch` takes no abort signal, so a held request can outlive the race it was for; whatever it brings back then is refused (below).
- **A question** (`tool.call` on `AskUserQuestion`). The hook announces the ask (each question's text, `header` and `multiSelect`, and each option's `label`, `description` and `preview`), then races `next(e)`, which is the terminal's dialog, against the held request.
  - Podium first: the hook returns `{ result: { questions: e.questions, answers } }` while `next(e)` is still pending, which closes the terminal's dialog ("returning with `next` pending aborts what runs beneath"). `answers` maps each question's exact text to its answer: an option's label, a multi-select's labels joined with ", ", or the typed text. A question left out is skipped. The transcript shows `User answered Claude's questions:`, and Claude reads the same text a terminal answer gives. A message sent in place of an answer ("Chat about this") is `{ result: { questions: e.questions, answers: {}, response: "<message>" } }`: Claude reads `The user responded: <message>` and answers it in the same turn. The abandoned `next(e)` later resolves with a rejection that Claude never sees.
  - Terminal first: `next(e)` resolves to `{ result: { questions, answers, annotations }, text }`. The hook returns it unchanged, and the mod closes the ask as `terminal` with a summary of the answers. The terminal's own "Chat about this" rejects the tool with "The user wants to clarify these questions" and no answer; the mod closes the ask as `closed`.
  - Esc or an aborted turn: `next(e)` resolves to an `isError` rejection. The hook returns it unchanged, and the mod closes the ask as `closed`. Esc also aborts the hook's own `$.http.fetch` calls, so **every close is queued and sent from the flush timer**, never from inside the hook.
- **A plan** (`tool.call` and `classic.PermissionRequest` on `ExitPlanMode`). One ask, under the ExitPlanMode `tool_use_id`, answered by two hooks.
  - The `tool.call` hook announces the ask (the plan's text and its file path) and holds for an answer. "No, keep planning" with feedback, and a message sent in place of an answer, are returned there as `{ deny: "The user doesn't want to proceed with this plan yet. They sent this from Podium: <feedback>" }` (with nothing typed: `They chose "No, keep planning" from Podium.`). Claude revises the plan and stays in plan mode. The framing follows the terminal's own "Tell Claude what to change" and names Podium: on 2.1.301 the bare feedback text read to Claude as an instruction injected into a tool result, and it put the same plan up again (decided 2026-10-15).
  - An approval is taken by the waiting `classic.PermissionRequest` hook. **That hook waits on the server itself, with held requests of its own** (it leaves feedback and replies to the `tool.call` hook's wait; either wait may take an approval and hand it to the other): a hook's 10-second budget stops only while a `next(e)` or `$` call of its own is in flight, a `$.clock` wait excepted, so a hook that waited on a promise alone was let go 10 seconds after the dialog opened and an approval sent later never reached Claude Code (seen live on 2.1.301, 2026-10-15). The hook returns `{ decision: { behavior: "allow", updatedInput: e.tool_input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] } }`, with `mode` one of `auto` ("Yes, and use auto mode"), `acceptEdits` ("Yes, auto-accept edits") or `default` ("Yes, manually approve edits"). **`updatedInput` is required, and it is `e.tool_input` unchanged.** Without it Claude Code ignores the allow for ExitPlanMode and the dialog stays open (anthropics/claude-code#97656; the hooks guide's example leaves it out). A regression test in the mod fails if an approval goes out without it. Approving through `tool.call` with `{ result }` is wrong: it closes the dialog but leaves the session in plan mode, and plan mode comes back a few turns later.
  - Whichever hook answers, the other one's wait ends without answering and returns its `next(e)` unchanged.
  - **An approval counts only once it took**: the ExitPlanMode `tool.call`'s `next(e)` resolves as approved. If it doesn't within 5 seconds, the mod reports the delivery `not-taken`, and the ask stays open so the terminal can approve it. This guards against a Claude Code release that changes the behavior above.
  - Terminal first: `next(e)` resolving as approved closes the ask as `terminal` with `planApproved: true`. The mod can't see which mode was picked there. A rejection is an `isError` result whose text tells the two apart (verified): feedback from "Tell Claude what to change" reads `… To tell you how to proceed, the user said:\n<feedback>\n\nNote: …`, and closes the ask as `terminal` with the answer `No, keep planning`; Esc reads `… STOP what you are doing and wait for the user to tell you how to proceed. …`, and closes it as `closed`.
  - The plan's text and file path reach the `tool.call` hook in the ExitPlanMode input as `plan` and `planFilePath` (verified; the input declared in the types has only the deprecated `allowedPrompts`), and `classic.PermissionRequest`'s `tool_input` has the same two fields.
- **A tool permission** (`classic.PermissionRequest` on any tool but `AskUserQuestion` and `ExitPlanMode`).
  - The event has no `tool_use_id`. The mod pairs it with the latest `tool.call` of the same loop for the same tool with the same input (the event's `agent_id` is the call's `agentId` for a subagent), and that call's `tool_use_id` is the ask's id. With no pair, the mod announces nothing and lets the prompt pass.
  - The hook announces the ask (the tool's name, its input, and `agentId` for a subagent's prompt) and holds while the terminal draws the prompt. **Allow once** returns `{ decision: { behavior: "allow" } }`: the command runs, and the transcript says "Allowed by PermissionRequest hook". **Deny** returns `{ decision: { behavior: "deny", message } }` with the reason given in Podium: the tool errors with the message, and Claude replies to it. A message sent in place of an answer is a Deny with that message. **A tool's decision never carries `updatedPermissions` or `interrupt`.** The only `setMode` the mod ever sends is a plan approval's.
  - PermissionRequest also fires for `AskUserQuestion`; the hook lets it pass, since `tool.call` handles questions.
  - **Terminal first: the engine does not end the waiting hook** (verified; this was an assumption before the build and it failed). When the terminal answers the prompt, `next.signal` never aborts and the hook can go on holding long after the command has run. Nothing tells the mod which answer the engine used. The one signal is the call's own `tool.call` resolving, so **the ask stays open in Podium while a command the terminal allowed runs**, and the mod decides what happened from how that `tool.call` ends. A PermissionRequest deny ends the call as an error whose text is the deny's own message, with no stock wording (seen live on 2.1.301), so the mod knows its own Deny by the message it sent:
    - It resolves rejected (`{ deny }`, or an `isError` denial) with no answer from Podium handed over: the terminal denied it, and the ask closes as `terminal`, `denied`. **Assumption, checked in the maintainer's live test:** a terminal Deny resolves the `tool.call` at once, so this close is prompt.
    - It ran, with no answer from Podium handed over: the ask closes as `terminal`, `allowed`.
    - It ran after a Podium **Deny** was handed over: the terminal allowed it first. The ask closes as `terminal`, `allowed`, and the Deny's result is `closed`, so the modal shows "Answered in the terminal" with "Allowed", never that the Deny took.
    - It resolves rejected after a Podium **Allow** was handed over: the terminal denied it first. The ask closes as `terminal`, `denied`, and the Allow's result is `closed`.
    - It ran after a Podium **Allow** was handed over: it was allowed either way. The mod reports `took`. It can't tell whether the engine used the hook's Allow or a terminal "Yes" that came first, and nothing the console then shows claims more than what was sent: the panel goes away and the feed reads "You, from Podium: allowed once: …", which is true either way. The terminal line `Allowed once from Podium by <name> at <HH:MM>` is written when the hook returns the Allow.
- **Where PermissionRequest hooks don't run.** They don't run in a user-installed plugin where an organization manages Claude Code (`claude plugin validate` warns about it). There, tool permissions and plan approval can't be answered from Podium, but questions, "No, keep planning" and messages can. The mod finds out with its `tool.check` hook: when `next(e)` resolves to `ask`, a prompt is about to show, and if no `classic.PermissionRequest` fires for that call within 2 seconds, the mod drops `plan-approve` and `permission` from `accepts` until a `classic.PermissionRequest` does fire, which puts them back. A prompt that auto mode's classifier answers shows no dialog and raises no PermissionRequest, so a missed one is not taken as final. Verified: `tool.check` carries the call's `tool_use_id`, and where the hooks run it resolves to `ask` 3 to 11 ms before `classic.PermissionRequest` fires, for Bash and for ExitPlanMode alike. **Unverified (no managed setup available):** that no PermissionRequest fires in a managed setup, and so that the method catches it. The safety net for plans is the approval's `not-taken` fallback: an approval the session doesn't take is reported and left to the terminal. A tool ask needs none: it is announced from the PermissionRequest hook, so where that hook doesn't run there is no tool ask to answer. What the method adds is an honest `accepts`, so the console can say a plan can only be sent back.
- **Messages and commands** come in the reply to a report (`deliveries`, 6.1), never through a held request. A message goes to `$.prompt.submit({ text })`, not `asUser`, so the transcript shows "Prompt from the podium-reporter plugin" and Claude reads "The podium-reporter plugin sent a message:". The flush loop doesn't await it: sent while a turn runs, the promise stays pending and Claude Code starts the message's own turn once the session is idle. So the mod reports it `queued` at once when the main loop is running, and `took` when the promise resolves. A command is `$.command.run({ command: "clear" })` or `$.command.run({ command: "compact" })`, run from the flush timer (it rejects inside a hook that a turn waits on), and never anything else, whatever the delivery says. After `/clear` resolves, `$.session.id()` returns the new id and `session.end` fires with `reason: "clear"` and the old id; the new id's first report carries `clearedFrom` (5.8, 6.2).
- **What counts as taken.** A question's answer, a tool's decision, plan feedback and a message in place of an answer count as taken when the hook returns them, since the spike saw the engine take each one. A plan approval counts only as above. A message or a command counts when its promise resolves.
- **Results and closes go out from the flush timer**, before the report, from a queue of at most 50 that is kept while the server is unreachable and retried with the report's backoff. Each delivery the mod receives gets exactly one final result (7.1). The mod keeps the ids of the last 100 deliveries it acted on in `$.store`, so a delivery handed over twice (a lost reply, a hot reload) acts once.
- **Refused by the mod.** A delivery whose kind isn't in `accepts`, one for an ask no hook of the mod is waiting on, one for an ask already closed, and a command other than `clear` or `compact`, get the result `refused` and change nothing.
- **Terminal lines.** `$.ui.log(text)` draws as `⏺ podium-reporter: <text>`, so the mod logs the text without a prefix. The mod never calls `$.config.set`, and never sends `/model`: both write to `~/.claude/settings.json`. While an ask is also open in Podium: `also open in Podium. Answer here or there.` After an answer from Podium, naming who sent it and when, in the session machine's local time: `Answered from Podium by <name> at <HH:MM>` for a question, `Approved from Podium by <name> at <HH:MM>` for a plan approval, `Allowed once from Podium by <name> at <HH:MM>` for a tool, and `Sent from Podium by <name> at <HH:MM>` for a message or a command, `Denied from Podium by <name> at <HH:MM>` for a tool's Deny, `Sent back from Podium by <name> at <HH:MM>` for "No, keep planning", and `Replied from Podium by <name> at <HH:MM>` for a message sent in place of an answer. `<name>` is the delivery's `by`. While responding is on and the session is idle, `messages from Podium are on.`: written once, the first time the main loop is idle with `message` in `accepts` and the last reply saying `respond: true`, and again after that stopped being true and became true again, or after a `/clear` (which empties the transcript), so it is not repeated at every turn's end.

### 5.4 Things on `$` the reporter calls (Verified)

All calls are async unless noted. Read each one's doc comment in the types file before first use.

| Call | Returns / does | Reporter's use |
|---|---|---|
| `$.session.id()` | session id (transcript file name) | Primary key. Re-read on every flush to detect a `/clear`. |
| `$.session.cwd()`, `$.session.root()` | absolute dirs | Name, project path. `root()` follows `/cd` and worktree moves. |
| `$.session.model()` | main loop model as `/model` shows it | Orchestrator model. |
| `$.session.repo()` | `{ root, remote, internal, name } \| null` | Repository name (`name` may be null; fall back to the remote's `owner/name` parsed from `remote`, else directory name). |
| `$.session.usage(args?)` | `{ startedAt, context: { tokens?, window, percent? }, rateLimits, cost?: { usd } }` | Main-loop context, **real session cost**, start time, rate limits. Plain call is free. Do **not** pass `breakdown`. |
| `$.session.surfaces()` | the clients attached to the session (`terminal`, `desktop`, `vscode`, `mobile`); empty in a plain `-p` run and for a background job nobody has attached to | `attached` is `surfaces().length > 0`. Read on every flush; a failed read leaves `attached` as it was (null at first). A non-interactive `-p` run therefore reads as nobody attached. |
| `$.session.turns()`, `$.session.version()`, `$.session.messages()` | counts, engine version, transcript | `version()` goes in the report for debugging. **Never call `messages()` for reporting** (privacy, cost). |
| `$.agent.list()` | `AgentInfo[]`: `{ id, teammateId?, description, type, status, parentId?, spawnedBy?, name? }`, `status` ∈ `pending` `running` `waiting` `idle` `completed` `failed` `killed` | Reconcile agent existence and status on every flush. Authority for "which agents exist now". |
| `$.process.run(argv, { cwd, timeoutMs, env, stdin })` | `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`, **no shell**, git runs with repo hooks off, default timeout 30 s | All git queries (section 5.7). CLI only. |
| `$.http.fetch(url, { method, headers, body })` | `{ status, ok, headers, text }`, goes through the host, `http` or `https`. Rejects on network failure. | POST reports. Always set `Content-Type: application/json`. |
| `$.clock.now()`, `$.clock.every(ms, fn)`, `$.clock.after(ms, fn)`, `$.clock.sleep(ms, { signal })` | `every`/`after` return a handle with `cancel()` | The flusher and git poller. Start timers from `session.start`; they run until cancelled or the module reloads. Cancel in `session.end` only when the whole process is ending (see 5.8). |
| `$.store.get/set/delete/keys` | JSON key-value, per plugin, survives sessions (4 MiB cap) | Offline buffer spill (optional), session display names, last-seen server URL. |
| `$.state` + `atom`, `read`, `update` (from `'claude-code'`) | Host-held session values with versions; redraw readers | Only if a pane is added later. The reporter needs none. If used, declare them in `types/index.d.ts` and name it in `plugin.json`. |
| `$.settings.read()`, `$.env.get(NAME)` | merged settings; env var (name must be a **string literal**) | Optional: read `CLAUDE_EFFORT`, `LANG`. |
| `$.command.register({ name, description, argumentHint? })` | Registers a slash command | `/podium`. Serve with `on('command.run', { command: 'podium' }, …)` returning `{ text }`. Call in `session.start`. |
| `$.tool.register({ name, description, inputSchema, isDeferred? })` | Registers `mcp__podium-reporter__<name>` | Optional `plan` tool so an orchestrator can name its plan (section 6.3). Serve with `on('tool.call', { tool: 'mcp__podium-reporter__plan' }, …)` returning `{ result }`. |
| `$.ui.status(text)`, `$.ui.toast(text)`, `$.ui.log(text, { to: 'debug' })` | Status-line entry, toast, transcript or debug-log line | Status line shows `podium vX.Y.Z ● 4 live` or `podium vX.Y.Z ○ offline` (the mod's own `VERSION` in every state); the host draws it as `⚠ podium-reporter: <text>`, which the mod does not control. `log` to `debug` only, except the terminal lines for responding (5.3), which go to the transcript. No toasts except on first successful connect and first failure. |
| `$.prompt.submit({ text })` | Submits a prompt as a turn of its own once the session is idle, under the plugin's name (Verified on 2.1.301, #206) | A message from Podium (5.3, "Responding"). Never awaited in the flush loop, never `asUser`. |
| `$.command.run({ command })` | Runs a slash command as if the person typed it, once the session is idle; rejects inside a hook a turn waits on (Verified on 2.1.301, #206) | `/clear` and `/compact` from Podium, from the flush timer, and no other command. |
| `$.model.complete({ model, prompt, effort? })` | `{ isAnswered, text?, usage, reason? }`, never rejects over provider errors | Optional failure explanation (Phase 5), default **off**. |
| `$.agent.register(spec)`, `$.agent.spawn(args)` | Define or start agent types | **Not used.** Listed so the implementer does not reach for them. |

`$.process`, `$.fs` and the UI nouns may be unavailable in some hosts (`-p`, SDK, desktop). Every call in the
reporter must be wrapped so that a missing capability degrades the report (null field) instead of failing it.

### 5.5 Tool inputs the reporter reads (Verified)

```ts
Agent:      { description: string; prompt: string; subagent_type?: string;
              model?: 'sonnet'|'opus'|'haiku'|'fable'; effort?: 'low'|'medium'|'high'|'xhigh'|'max';
              name?: string; isolation?: 'worktree'|'remote' }
              // effort and model are IGNORED for subagent_type "fork": a fork inherits both.
Skill:      { skill: string; args?: string }
TaskCreate: { subject: string; description: string; activeForm?: string; metadata?: {} }
            // result: { task: { id: string; subject: string } }
TaskUpdate: { taskId: string; subject?; description?; activeForm?;
              status?: 'pending'|'in_progress'|'completed'|'deleted';
              addBlocks?: string[]; addBlockedBy?: string[]; owner?: string; metadata?: {} }
            // result: { success, taskId, updatedFields, error?, statusChange?: { from, to } }
TaskList:   {}   // result: { tasks: [{ id, subject, status, owner?, blockedBy }] }
TaskGet:    { taskId }  // result: { task: { id, subject, description, status, blocks, blockedBy } | null }
TodoWrite:  { todos: [{ content, status: 'pending'|'in_progress'|'completed', activeForm }] }
            // result: { oldTodos, newTodos }
```

For a fork the model sets `subagent_type: "fork"`; in `agent.spawn` that arrives as `fork: true`.

### 5.6 What the engine does and does not tell you (read before designing)

| Wanted | Where it comes from | Caveat |
|---|---|---|
| Orchestrator model | `$.session.model()`, `turn.step.model` (no `agentId`) | Per step, so a mid-session `/model` shows up. |
| Orchestrator effort | `turn.step.effort` (no `agentId`) | Absent for models without effort support: report `null`. Read on each model request, and no event fires when the setting changes, so a `/effort` change shows after the next prompt. |
| Subagent model | `agent.spawn` result `model`, `turn.step.model` | Resolved alias, may be a full id. Map to a family (section 6.5). |
| Subagent effort | `tool.call` Agent input `effort` (requested), then `turn.step.effort` for that `agentId` (observed, wins) | `agent.spawn` has no effort. Fork: copy the parent's. Record `effortSource`. |
| Skills loaded | `tool.call` with `tool === "Skill"` (per loop via `agentId`), `skill.prompt` (no loop) | An agent definition may preload skills; that is not visible. Report what was observed. |
| Context fill, main loop | `$.session.usage().context.percent`, `session.measure` | `tokens` may be absent before the first response. |
| Context fill, an agent | `turn.step` result `usage` (input + cache read + cache creation tokens) over the model's window | No per-agent window API. Use the table in 6.5. Clamp to 100. Unknown window (non-Claude model): percent is `null`. |
| Tokens, as shown (issue #96) | The same `usage` as context fill: an agent's Tokens figure is its latest context size (input + cache read + cache write of its newest request), which is what Claude Code's own agent line shows. Its output tokens are not added (#108 did, #120 reverted it): the newest request's context already contains the output of the earlier ones, so adding it counted that output twice and ran further above Claude Code's the longer the agent worked. An orchestrator's is its own context size; the facts bar and the wall card show the orchestrator's plus every agent's, so the rows add up. The agent panel also lists the running totals of the four counters ("Used so far"). Every Tokens label carries a tooltip saying this. | A running total of all four counters re-counts the cached context on every request and reads about 100 times too large. `tokensTotal`, `tokens_total` and the tokens-per-second figures stay running totals, because they measure throughput, not context. |
| Blowouts | `session.compact` (auto) and `turn.step` `stopReason` | If the build lacks `session.compact` for agents, fall back to the `stopReason` signal and note it. |
| Cost, session | `$.session.usage().cost.usd` | Real ledger. Includes every agent, those launched by other agents too (verified with a three-level run, #101). |
| Cost, agent | tokens × price table | Estimate only. `null` for a non-Claude model (no price). |
| Plan | `tool.call` for Task*/TodoWrite | Built-in tools have no plan title or phase. |
| Waiting on the user | `classic.PermissionRequest`, `classic.Notification`, `turn.complete` of the main loop | Best effort. If neither classic event is hookable, main-loop `turn.complete` ⇒ `waiting` with `waitReason: "input"`. With background work or a wake-up in flight (`classic.Stop`) it is `waiting` with `waitReason: null` and `background` set instead (#119). |
| Git | `$.process.run(["git", …])` | Section 5.7. |
| Failures | `tool.call` results with `isError`/`{deny}`, `turn.complete.reason`, `turn.step.stopReason` | The engine gives evidence, not a diagnosis. |

### 5.7 Git queries (run from the session's `cwd`; poll every 10 s and on `session.start`, never per event)

```
git rev-parse --abbrev-ref HEAD                  → branch ("HEAD" means detached; report the short sha instead)
git rev-parse --git-dir ; git rev-parse --git-common-dir
        → isWorktree = (resolve(git-dir) !== resolve(git-common-dir))
git rev-parse --show-toplevel                    → worktreePath (when isWorktree)
git status --porcelain=v1 -b                     → first line "## branch...origin/branch [ahead N, behind M]"; remaining lines = modified count (dirty)
```

If any call exits non-zero (not a repo), report `git: null`. Cache the result; send it with every report.

**Changed files.** The same poll builds `session.files`, the files the session changed. The first read of a session records the commit HEAD points at (the empty tree when there are no commits yet), keeps it in the mod's store under the session id, and every later read diffs the working tree against it, so committed work stays listed. Each query runs as `git -C <toplevel> …`:

```
git rev-parse HEAD                               → the starting commit, on the first read
git merge-base --is-ancestor <start> HEAD        → still an ancestor? if not, the commit was dropped (rebase, amend, branch switch)
git merge-base HEAD @{upstream}                  → the fallback base; with no upstream, diff against HEAD and report since "worktree"
git diff --name-status -z -M <base>              → status and rename pairs
git diff --numstat -z -M <base>                  → added and removed lines per file (`-` for a binary file)
git ls-files -z --others --exclude-standard --full-name   → untracked files
git grep --no-index -I -c -z '' -- <paths>       → their line counts, one process per 100 files; it leaves out empty and binary files
git diff --no-index --numstat -- /dev/null <path> → those left-out files, one process each, for at most 20 per read
```

Only paths and counts are read, never file contents or diff text. The list is sorted by path and cut at 200 files; `total`, `added` and `removed` cover every file, except that an untracked file past the 200th is counted as a file but adds no lines (only the listed ones are line-counted, on every poll; an empty or binary one past the first 20 of those in a read shows no counts, as a binary file always does). A repository with no commits yet is read too, against the empty tree. If any query fails the mod keeps the last list. Two sessions in the same checkout see the same changes, because the diff is of the working tree; worktrees avoid that.

### 5.8 Session identity, `/clear`, restarts

- A session id changes on `/clear` and on resume. After `/clear` the engine fires `session.end` with `reason: "clear"` and **does not fire `session.start`** for the new id.
- Therefore the reporter's flush loop calls `$.session.id()` every time. When it differs from the id in state: send a final `done` report for the old id (`endReason: "clear"`), reset per-session state (agents, plan, blowouts, event sequence), and begin reporting under the new id as a new session. When the old id ended with `reason: "clear"`, every report under the new id carries `clearedFrom: <old id>` (6.2), so History can link the two (#206). This holds for a `/clear` typed in the terminal and one sent from Podium alike.
- A hot reload re-runs `session.start` for a live session. State rebuilds from `$.agent.list()` and `$.session.*`. The first report after a reload carries the full agent list and may lack older event history. The server tolerates this: events are idempotent by id and agents are upserted.
- Closing the terminal gives no hook in time. The server's stale logic (section 7.5) handles it.

### 5.9 Mod configuration (userConfig)

Declare in `plugin.json` (**Assumption:** confirm the exact `userConfig` field syntax with `claude plugin validate`; the reference says a field may list `options`, `default`, and secret fields are supported):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `serverUrl` | string | `http://127.0.0.1:4317` | Where to POST. |
| `token` | string (secret if supported) | empty | Sent as `X-Podium-Token` when non-empty: a person's token from Admin (7.7), or the admin secret. |
| `userName` | string | empty | The person's name as the server owner entered it. Sent as `Report.userName`, with `Report.machine`; the server accepts a report made with a person's token only when the name matches. Empty sends neither. Claude Code keeps it in `~/.claude/settings.json` under `pluginConfigs["podium-reporter@eengelking-marketplace"].options` (the key is `podium-reporter` for a `--plugin-dir` load). |
| `flushIntervalMs` | number | `1000` | Minimum time between reports while something changes. |
| `heartbeatMs` | number | `5000` | Report at least this often even when nothing changed. |
| `sessionName` | string | empty | Override display name for this machine's sessions (rare). |
| `showStatus` | boolean | `true` | Show the status line (`podium v<version> ● N live` and its offline and refused states). |
| `explainFailures` | boolean | `false` | Phase 5 only. When true, ask a small model to explain a failure (costs tokens). |
| `fullPrompts` | boolean | `false` | When true, send each agent's whole task prompt and final answer as `promptText` and `answerText` (6.4). Off by default: only the 400-character excerpts are sent. |
| `activityFeed` | boolean | `false` | When true, send the activity feed (`activity`, 6.4) of each loop the server's reply lists as watched: its tool calls and the text it writes, the last 20, each redacted and cut to 300 characters. Also sends `session.activityFeed`. Off by default: nothing is captured and `watch` is ignored. Title "Send an agent's recent activity". |
| `respond` | string, one of `off`, `questions`, `questions-and-plans`, `everything` | `off` | What this session accepts from Podium (#206, 5.3 "Responding"). `off`: nothing. `questions`: answers to questions, and new messages while idle. `questions-and-plans`: the above, plus approving or rejecting a plan. `everything`: the above, plus allowing or denying a tool (allow once only), and `/clear`, `/compact`. Any other value reads as `off`. It needs `activityFeed` on as well; with that off the mod accepts nothing. Title "Respond from Podium". Set with `/plugin configure podium-reporter@eengelking-marketplace`. The mod enforces its own level and never relies on the server for it. |

Read via the `options` argument of `register`. A config change reloads the module.

**Identity (#226).** The options are one set per Claude config directory, so two terminals on one machine share them, and a config change reloads every running session's module. A session's name and token are therefore taken once, at `session.start`, and held in `$.state` (`podium-reporter.identity`, declared in the mod's `types/index.d.ts`) for the rest of the session; a reload with different options does not change them. At that first start the mod uses, in order: the terminal's `PODIUM_USER` and `PODIUM_TOKEN` environment variables (taken together; when either is set the shared `userName` and `token` are not used), then the `userName` and `token` options. A session with no token holds nothing, so adding one later still applies. To change who a running session reports as, start a new session. A session that belongs to someone else is still refused (7.7). **Known limit (#230).** `/plugin configure` therefore holds one login per Claude config on a machine: the engine gives a mod one shared set of `userConfig` values and no storage for a single session's login (`$.state` is per session but only the mod can write it, and the mod cannot tell which session's person just signed in; `$.store` is shared; a `sensitive` field such as `token` is not a `/config` row, so no `config.set` hook sees it changes). Two logins on one machine are possible only through the environment variables above. If the engine gains a per-session login or a way to tell which session a sign-in came from, the mod should use it.

### 5.10 Alternatives and extras the implementer may use

- **Settings command hooks** (`.claude/settings.json` `hooks`: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Notification`, `PermissionRequest`, `TaskCreated`, `TaskCompleted`, `Stop`) can `curl` the server without a mod. Every payload has `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and inside a subagent `agent_id`, `agent_type`, and often `effort.level`. They lack per-step usage and context, so they can only drive a reduced display. `POST /api/fleet/hook` accepts them, for sessions started without the mod. The mod is the primary path.
- **`CLAUDE_EFFORT` env var** is set for hook commands and Bash children; useful only for settings-hook scripts.
- **`telemetry.*` hooks** can forward engine telemetry to a collector. Out of scope.
- **Status line command** (`statusLine` setting) can show Podium's URL in the terminal. Out of scope; the mod uses `$.ui.status`.
- **OpenTelemetry**: the engine can export OTel metrics natively. Out of scope; noted so nobody rebuilds it.
- **`$.model.complete`** with `model: "haiku"`, `effort: "low"` is the cheapest way to produce a one-paragraph failure explanation (Phase 5, opt-in).
- **`claude-api` skill** (invoke it) is the source for current model ids, context windows and prices when filling `models.ts`. Do not guess prices from memory.

### 5.11 Testing a mod (Verified in the reference)

`claude plugin test <folder>` runs `*.test.ts`. Import `test`, `expect`, `mock` from `'claude-code/testing'`. A test holds the engine's `$` and an `on` whose hooks sit beneath the plugin. Hooks beneath stand in for the engine, so what they answer is what the plugin receives. `test(name, { options }, body)` supplies `userConfig` values. `mock.session(on)` reads appended rows back. A UI test mounts a component per surface; the reporter has no UI components, so it needs none. Read the testing types (`grep -n "claude-code/testing"` in the types file) for the exact API, and write a test that raises each hooked event and asserts what the reporter posted through a mocked `http.fetch`.

---

## 6. The reporter protocol

### 6.1 Endpoint

`POST /api/fleet/report` with `Content-Type: application/json`, optional `X-Podium-Token`. Body is one `Report`. The server decides who sent a report from the token (7.7) and answers `401` for a missing, wrong, revoked or mismatched credential and `409` when the session id already belongs to another owner; the mod logs a 401 once and retries about once a minute; on a 409 the mod shows "refused: session belongs to someone else" on its status line instead of "connecting", tells the user once (a toast and `/podium`) to start a new session, logs it once, and clears the message at the next accepted report. Response `200 { "ok": true, "serverTime": <epoch ms>, "ackedEvents": <n>, "sessionId": "…", "liveSessions": <n>, "serverVersion": "…", "reporterSupport": { "min": "…", "max": "…" }, "reporterCompat": "ok" | "outdated" | "newer" | "unknown", "watch": ["<agentId>" | "@orchestrator", …], "respond": boolean, "deliveries": Delivery[] }` (6.8 explains `serverVersion`, `reporterSupport` and `reporterCompat`; `watch` lists the loops a viewer is watching right now, the orchestrator's main loop as `@orchestrator`, so the mod knows whose activity to send, 6.4; it is always empty while the Admin has the activity feed turned off; `respond` is whether the server takes answers for this session now (7.7: authentication on, the Admin's `respond` and `activity-feed` flags on, and the session has an owner), and the mod announces asks only while it is true; `deliveries` are the messages and commands sent from Podium for this session that the mod has not yet given a result for (6.2, 7.1), in the order they were sent, at most 20, and always empty while `respond` is false; an answer to an ask never comes here, only through the held request), or `400 { "ok": false, "error": "…", "path": "…" }` for a body that fails validation (the mod drops that report and logs once to debug, it never retries a 400), or `413` above 512 KB.

The mod sends a **full snapshot** every time (idempotent upsert) plus the **events not yet acknowledged**. The server never needs a previous report to understand a new one.

### 6.2 The Report

All times are epoch milliseconds. All token counts are integers. Unknown fields are ignored by the server. Missing optional fields are `null`, never omitted, so the shape is stable. `docs/fixtures/report.sample.json` is one full valid example, with every optional field below filled in and a reporter version inside the range the server supports (6.8), and is the shared fixture for both test suites. When a field is added to the Report, add it to the fixture in the same change; `fixtureReport()` in `server/src/fleet/testing.ts` hands tests the fixture without the fields that start behavior of their own (asks, background work, an owner and machine, a live activity feed).

```ts
interface Report {
  v: 1;
  sentAt: number;
  reporter: { name: 'podium-reporter'; version: string; engineVersion: string | null; hostSurface: string | null };
  session: {
    id: string;
    name: string;                       // display name (6.6)
    status: 'running' | 'waiting' | 'done';
    waitReason: 'permission' | 'input' | null;
    waitNote: string | null;            // e.g. "Bash(npm run e2e -- --retries=0)", ≤ 160 chars
    endReason: string | null;           // set with status 'done'
    resumeId: string | null;
    startedAt: number;
    cwd: string;
    projectRoot: string | null;
    repoName: string | null;            // "owner/name" or directory name
    git: { branch: string | null; detached: boolean; isWorktree: boolean; worktreePath: string | null;
           ahead: number; behind: number; dirty: number } | null;
    model: string | null;               // as the engine reports it (alias or id)
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
    context: { tokens: number | null; window: number | null; percent: number | null };
    costUsd: number | null;             // the engine ledger's session cost; the server prices usageByModel instead when it is present (6.5)
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };  // main loop only, cumulative
    usageByModel?: { model: string; tier: 'std' | 'long'; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number } }[];  // the whole session, agents included (#117); absent from a reporter older than 0.12.0
    rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[];
    blowouts: number;                   // main loop count, cumulative for this session id
    plan: Plan | null;
    loop: LoopReport | null;            // the main loop's own steps, tools and skills; null from a reporter older than 0.4.0
    files: FilesReport | null;          // the files the session changed (5.7); null from a reporter older than 0.6.0
    attached: boolean | null;           // whether any client is attached (5.3, 5.4); false for a background session after /exit; null from a reporter older than 0.7.0 or when the roster could not be read
    activityFeed?: boolean;             // whether the reporter's activityFeed option is on (5.9); absent from a reporter older than 0.13.0
    activity?: ActivityEntry[];         // the main loop's activity feed, sent only while the reply's `watch` lists `@orchestrator` (6.4)
    background?: {                      // what an idle session waits on (#119), with waitReason null; absent from a reporter older than 0.11.0 and when there is none
      tasks: { type: 'shell' | 'agent' | 'monitor' | 'workflow' | 'wakeup' | 'other'; description: string; status: string }[];  // at most 20; description ≤ 120 chars, never a whole shell command
      wakeAt: number | null;            // epoch ms of the next scheduled wake-up; null when there is none, or when any schedule's time could not be read
    };
    respond?: {                         // whether and how far this session can be answered from Podium (#206, 5.3, 5.9); absent from a reporter older than 0.14.0
      level: 'off' | 'questions' | 'questions-and-plans' | 'everything';   // the `respond` option as set
      accepts: RespondKind[];           // what the session takes now: the level's kinds, empty while `activityFeed` is off or the session is not interactive, less what `limits` removes
      limits: ('no-permission-hooks' | 'not-interactive')[];  // why a kind the level allows is missing: PermissionRequest hooks don't run here (drops plan-approve and permission), or a `claude -p` run (drops everything)
    };
    asks?: Ask[];                       // the asks open now, at most 8; sent only while the last reply said `respond: true`, else omitted
    clearedFrom?: string | null;        // the session id this one continues after a /clear (5.8); null or absent otherwise
  };
  agents: AgentReport[];                // every agent seen this session, running or finished
  events: ActivityEvent[];              // not yet acknowledged
  userName?: string;                    // the person this reporter is set up as (the `userName` option); omitted when empty. The server checks it against the token's owner (7.7)
  machine?: { name: string; id: string };  // sent only with userName (0.9.0 and later): the short host name (`hostname` up to the first dot, ≤ 64) and a random 12-hex id the mod keeps in one file, `podium-machine-id` in the Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), made on first use and shared by every load of the mod on the machine (#267; an id already in a load's own store under `machineId` is adopted into the file, and the store is used alone where the file cannot be), so two machines with one host name stay apart
}

interface FilesReport {
  files: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed';
           added: number | null; removed: number | null;   // null for a binary file
           from: string | null }[];                         // the old path of a rename
  total: number; added: number; removed: number;            // over every changed file, not only the listed ones
  since: 'start' | 'upstream' | 'worktree';                 // what the diff is against: the starting commit, the upstream merge base, or HEAD
}

interface Plan {
  title: string | null;
  source: 'TaskCreate' | 'TodoWrite' | 'podium_plan';
  steps: { id: string; text: string; state: 'pending' | 'active' | 'done' | 'blocked';
           activeText: string | null; ownerAgentId: string | null; ownerLabel: string | null }[];
}

// What an agent entry carries about its own work, for the orchestrator's main loop. Same fields, same meaning,
// as the AgentReport fields of the same name; calls made by agents the orchestrator launched are not counted here.
interface LoopReport {
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;   // finished calls per tool name, summing to toolCalls (less when capped, see 7.7)
  steps: { done: number; total: null }; // model requests the main loop has made so far
}

interface AgentReport {
  id: string;                           // the engine's agentId
  parentId: string | null;              // the agentId of the agent that launched it (a subagent or a fork can launch agents, 5.3); null = launched by the orchestrator
  kind: 'subagent' | 'fork' | 'teammate';
  type: string;                         // 'general-purpose', 'Explore', 'fork', a plugin agent…
  name: string | null;
  description: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  effortSource: 'requested' | 'observed' | 'inherited' | 'unknown';
  status: 'queued' | 'running' | 'done' | 'failed' | 'aborted';
  startedAt: number;
  endedAt: number | null;
  context: { tokens: number | null; window: number | null; percent: number | null };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsdEst: number;
  usageByModel?: { model: string; tier: 'std' | 'long'; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number } }[];  // this agent's own loop (#117); absent from a reporter older than 0.12.0
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number> | null;   // finished calls per tool name, summing to toolCalls; null from a reporter older than 0.2.0
  blowouts: number;                     // this loop's cumulative blowouts
  steps: { done: number; total: number | null } | null;   // model steps taken so far; total only when known, else null
  promptExcerpt: string;                // first 400 chars of the task prompt
  answerExcerpt: string | null;         // first 400 chars of its final answer
  promptText?: string;                  // the whole task prompt, redacted, line breaks kept, ≤ 20,000 chars then "[cut off at 20,000 characters]". Only with the fullPrompts option (0.10.0 and later), and only in the first accepted report that has it
  answerText?: string;                  // the same for the final answer, sent once when the agent finishes (again if a later answer replaces it)
  activity?: ActivityEntry[];           // this agent's activity feed, sent only while the reply's `watch` lists its id (6.4)
  failure: Failure | null;
}

// One entry of a loop's activity feed (#118), oldest first, at most 20 per loop. A loop's key in `watch` and in the
// activity route is its agent id, or `@orchestrator` (MAIN_LOOP in protocol.ts) for the main loop.
interface ActivityEntry {
  at: number;                           // when the reporter saw it
  kind: 'tool' | 'text' | 'reasoning';  // `reasoning` is reserved; the reporter does not send thinking
  text: string;                         // a tool call: the tool's name, a space, a short summary of its arguments; text: what the model wrote in one step. Redacted, ≤ 300 chars
}

// What a session can be answered with from Podium (#206). Which levels allow which: `questions` gives question and
// message; `questions-and-plans` adds plan-approve and plan-feedback; `everything` adds permission and command.
type RespondKind = 'question' | 'plan-approve' | 'plan-feedback' | 'permission' | 'message' | 'command';

// One open ask (#206, 5.3). Everything in it is redacted by the rule in 6.4 before it leaves the machine, and cut to
// the limits below with a visible "[cut off at N characters]" marker. The server keeps it in memory only (7.2).
interface Ask {
  id: string;                           // the tool_use_id of the AskUserQuestion or ExitPlanMode call, or of the call a permission prompt is for
  kind: 'question' | 'plan' | 'permission';
  agentId: string | null;               // the loop that asked; set for a subagent's permission prompt, null for the main loop
  openedAt: number;
  questions?: {                         // kind 'question': 1 to 4, in the order Claude Code shows them
    question: string;                   // ≤ 1,000 chars
    header: string;                     // ≤ 40 chars
    multiSelect: boolean;
    options: { label: string; description: string; preview: string | null }[];  // 1 to 4; label ≤ 200, description ≤ 1,000, preview ≤ 4,000 chars
  }[];
  plan?: { text: string; filePath: string | null };   // kind 'plan': the plan's markdown, ≤ 40,000 chars, and where Claude Code keeps it
  tool?: { name: string; input: Record<string, unknown>; cut: boolean };  // kind 'permission': the tool and its arguments, ≤ 20,000 chars as JSON; `cut` when anything was cut off
}

// One answer or message sent from Podium, as the server hands it to the mod (#206, 7.1). An answer to an ask comes
// through the held request; a message or a command in the reply to a report.
interface Delivery {
  id: string;                           // 'dlv_' and 24 hex characters, made by the server
  askId: string | null;                 // the ask it answers; null for a message or a command
  by: string;                           // who sent it: a person's name, or 'Admin' for the admin secret
  at: number;                           // when the server took it (server time)
  kind: 'question' | 'reply' | 'plan-approve' | 'plan-feedback' | 'allow-once' | 'deny' | 'message' | 'command';
  answers?: ({ options: number[] } | { text: string } | null)[];  // kind 'question': one per question, by position: the chosen options' indexes (one for a single choice), a typed answer (≤ 2,000 chars), or null for skipped. The mod turns it into Claude Code's map from question text to answer, so a redacted question still gets its answer
  mode?: 'auto' | 'acceptEdits' | 'default';   // kind 'plan-approve'
  text?: string;                        // 'reply' (a message in place of an answer), 'plan-feedback', 'deny' (the reason, may be empty) and 'message': ≤ 20,000 chars, line breaks kept
  command?: 'clear' | 'compact';        // kind 'command'
}

interface Failure {
  class: 'Tool error' | 'Blocked by permission' | 'Model API error' | 'Refusal'
       | 'Context window exhausted' | 'Aborted' | 'Unknown';
  at: number;
  tool: string | null;                  // e.g. "Bash", "Edit", "model request"
  call: string | null;                  // the failing call, summarized, ≤ 300 chars
  exitCode: number | null;
  outputTail: string[];                 // last ≤ 12 lines of output, each ≤ 240 chars
  evidence: string[];                   // short facts the reporter observed, ≤ 5 lines (e.g. "exceeded the window 3 times", "same file read 4 times")
  explanation: string | null;           // only when explainFailures is on (Phase 5)
  retriedAs: string | null;             // agent id that took over the step, when known
}

interface ActivityEvent {
  id: string;                           // unique per event; idempotency key (sessionId:agentId|main:kind:t:n)
  t: number;
  kind: 'start' | 'end' | 'spawn' | 'skill' | 'done' | 'fail' | 'blow' | 'compact' | 'plan' | 'wait' | 'note';
  agentId: string | null;
  text: string;                         // ≤ 240 chars, plain
  data: Record<string, unknown> | null;
}
```

### 6.3 Plan building rules (`plan.ts`, a pure module)

- Keep a map of tasks by id. `TaskCreate` result gives the id; `subject` becomes the step text; `activeForm` becomes `activeText`. `TaskUpdate` applies `status` (`pending`→`pending`, `in_progress`→`active`, `completed`→`done`, `deleted`→remove), `subject`, `activeForm`, `owner`, `addBlockedBy` (a step with an unfinished blocker is `blocked` unless it is `active` or `done`). `TodoWrite` replaces the whole list; ids are `todo-<index>`; the later of Task*/TodoWrite wins as `source`.
- Plan title: the optional tool `mcp__podium-reporter__plan({ title, phase? })` sets it. Otherwise `metadata.planTitle` or `metadata.title` of the first TaskCreate. Otherwise `null` (the UI then shows "Plan").
- Step owner: `TaskUpdate.owner` if it matches an agent `name`; else the running agent whose description, normalized (lowercase, alphanumerics only), equals or contains the step text or vice versa; else `null`. `ownerLabel` is `"<type> · <Model> <effort>"` for the matched agent.
- No tasks yet ⇒ `plan: null`. That is the case for a session whose Claude Code does not provide the task tools or does not use them, and plan mode (`ExitPlanMode`) is not read, so it gives no plan either. The user-facing explanation is in `docs/GOTCHAS.md` ("A session shows no plan").

### 6.4 Failure and excerpt rules (`failures.ts`, pure)

- On every `tool.call` result with `isError` or a `{ deny }`, store a candidate on the loop: tool name, a summary of the call (Bash: the command; Edit/Read/Write: tool + `file_path`; others: tool + first argument, ≤ 300 chars), exit code parsed from the result text where present (best effort, `null` otherwise), and the last 12 lines of the result text.
- A loop that ends `failed` takes its most recent candidate (≤ 60 s old) as the failure's `tool`/`call`/`outputTail`. Class: `deny` ⇒ `Blocked by permission`; `turn.complete.reason === "error"` ⇒ `Model API error` unless a candidate exists; `refusal` ⇒ `Refusal`; `stopReason === "model_context_window_exceeded"` or blowouts ≥ 3 ⇒ `Context window exhausted`; `aborted` ⇒ `Aborted`; else `Tool error` if a candidate exists, else `Unknown`.
- `evidence` lines are factual and generated, never invented: blowout count and times, repeated identical failing calls ("same call failed 3 times"), repeated reads of one file, the permission denial text.
- A loop with a failure candidate that later ends `done` is `done`; the candidate is discarded.
- **Redaction.** Before anything leaves the machine, truncate to the limits above and replace anything that looks like a secret (`sk-ant-[A-Za-z0-9_-]{10,}`, `ghp_[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, `Bearer [A-Za-z0-9._-]{20,}`, values after `password=`, `token=`, `secret=`, `apikey=`, `api_key=`) with `[redacted]`. The reporter unit-tests this.
- Excerpts are the first 400 characters, whitespace collapsed.
- **Full text (opt-in).** With the `fullPrompts` option on, the mod also keeps each agent's whole task prompt and final answer: redacted by the rule above, line breaks kept, cut to 20,000 characters with a visible `[cut off at 20,000 characters]` marker. A text goes out once, in the first accepted report after it exists (the prompt when the agent starts, the answer when it finishes; a replacement answer goes out again), so heartbeats stay small. One report carries at most 120,000 characters of full text (the 512 KB body limit, 7.7); an agent whose text does not fit goes out in a later report, and a text counts as sent only when the report that carried it was accepted. Everyone who can open the console can read them, which is why the option is off by default. The server keeps them in `agent_texts` (7.2) and serves them from `GET /api/fleet/sessions/:id/agents/:agentId/text`; the state and the stream carry only their lengths (`promptChars`, `answerChars`).
- **Activity feed (opt-in, observed only, #118).** With the `activityFeed` option on, the mod can send a loop's recent work: each tool call as one entry (the tool's name and a short summary of its arguments: Bash the command, Read/Edit/Write the path, Grep the pattern and path, Agent the description, otherwise the first argument) and the visible text of each model request as one entry (whitespace collapsed). Each is redacted by the rule above and cut to 300 characters; a loop keeps its last 20, and one report carries at most 60,000 characters of them. Nothing is captured, sent or stored unless someone is watching that loop: the console's panel for an agent or the orchestrator takes a short lease on it (`GET /api/fleet/sessions/:id/agents/:agentId/activity`), the reply to each report lists the loops under a live lease (`watch`, 6.1), and the mod captures and sends entries only for those, from the moment it sees them listed, and forgets a loop's entries once it is no longer listed. The server keeps the last 20 entries of a watched loop in memory only, never in the database, and drops them when the lease lapses, when the session leaves the live set or is deleted, and on restart. It never keeps an entry older than the lease, so a viewer who comes back starts empty; nothing is backfilled. Thinking is not sent: `turn.step` streams `thinking` chunks, but they are left alone. With the option off the mod captures nothing, ignores `watch`, and sends `activityFeed: false`. The orchestrator, subagents and forks are all treated alike. The feed needs two switches: this reporter option on the machine, and the server's `activity-feed` feature flag (Admin > Settings > Feature flags, 8.1), which is on by default. With the flag off the server grants no lease, every reply's `watch` is empty, it drops every lease and entry it held at the moment the flag goes off, and it keeps nothing a mod sends; turning it back on needs nothing else, since the next fetch takes a lease as usual.
- **Who and where.** A report names a person only when the user has set the `userName` option, which is empty by default; it then also carries `machine` (the short host name and the mod's own random id, never a hardware id). Nothing else that identifies the person or the machine is sent, and the operating system user name and `git config` are never read for it. Everyone who can open the console sees both. Without a person's token (7.7) the name is a label anyone can claim, so the server records an owner only from a token.

### 6.5 Models, windows, prices (`models.ts`, pure)

- `family(modelIdOrAlias)`: lowercase substring match: `opus` → `opus`, `sonnet` → `sonnet`, `haiku` → `haiku`, `fable` → `fable`, else `other`. Only a Claude model matches: a bare alias (`opus`, `sonnet[1m]`) or an id containing `claude`. A local model such as `my-sonnet-finetune:latest` is `other` even though its name holds a family word. The UI colors by family (section 8.3); `other` is shown with the raw model name and labeled as not a Claude model. The UI labels a Claude model with its family and version (#116): `modelVersion` in `frontend/src/fleet/logic.ts` reads the version from the id, `claude-sonnet-5-5` → `Sonnet 5.5`, `claude-opus-4-8` → `Opus 4.8`, `claude-sonnet-5` → `Sonnet 5`, and also the older `claude-3-5-sonnet-…` order. Version parts are one or two digits, so a date stamp is ignored. An alias with no version (`sonnet`, `opus[1m]`, `opusplan`) shows the family alone; the version is never guessed. The full id stays in the tooltip and the color stays tied to the family. The reporter's own event text (`shortName`) is unchanged.
- `windowOf(model)`: `null` for a model in the `other` family (the percentage is then shown as unknown, never computed against 1M). **Assumption:** 200,000 for Haiku 4.5 and older (`haiku-4`, `haiku-3`, `claude-3`), 1,000,000 for the others, Haiku 5.5 included; for the main loop prefer `$.session.usage().context.window`. Verify with the `claude-api` skill and record the sources in `docs/ARCHITECTURE.md`.
- `priceOf(family)`: USD per million tokens, split input / output / cache read / cache write. **Placeholder values must be replaced with current published prices** (use the `claude-api` skill). Keep all of it in this one file with a visible comment and a `PRICES_AS_OF` date constant. Cost estimate = Σ tokens × price / 1e6. A model in the `other` family has no built-in price: `priceOf` and `costOf` return `null`, the report carries `null` for the agent's `costUsdEst` and for the session's `costUsd` (the engine's ledger figure is not trusted for a model Podium has no price for, because what it is priced from is not known; see Known issues in `docs/ARCHITECTURE.md`), the UI shows "n/a" with the reason, and the fleet's "est. cost today" leaves those sessions out and says how many (`kpis.unpricedSessions`).

- **Admin prices and where they are applied (#117).** The reporter's table is only a fallback for a server that predates this. Since reporter 0.12.0 each report carries `usageByModel`: the tokens of a loop per model and per prompt-size tier (`std`, or `long` for a request whose prompt, input plus cache reads plus cache writes, is over 100,000 tokens), for the whole session and for each agent, with cache writes split into the 5-minute and the 1-hour kind when Claude Code gives the split (`cache_creation.ephemeral_1h_input_tokens`; otherwise all cache writes count at the 5-minute rate). The server prices these in one place, `server/src/fleet/pricing.ts`: the built-in table (Anthropic's pricing sheet of 2026-10-13, one row per model id, five prices each: input, output, cache read, 5-minute cache write, 1-hour cache write, in USD per million tokens; Haiku 5.5 has a second set for prompts over 100,000 tokens) with the Admin's changes laid over it (Admin > Model prices, stored in `settings.model_prices`). A model id resolves to the Admin's exact row for that id, else a built-in row (an alias such as `opus` is the family's current model), else nothing. The stored cost is repriced when it is read, so a price change moves the cards, the orchestrator and agent costs, the facts bar, "Est. cost today", the spend panel and History at once, and a restart keeps it. The orchestrator's own cost stays the session total minus its agents, so the figures add up. A row from a reporter that sends no `usageByModel` (or an empty list) keeps the cost it was stored with. A model nobody priced adds nothing to the total, so the rest of a mixed session still follows the Admin's prices; a session whose models are all unpriced keeps its stored cost. This makes the session figure an estimate from the Admin's prices rather than the engine ledger's own number; the ledger's `costUsd` is still stored and is what a reporter older than 0.12.0 shows. The sparkline of cost per minute is still drawn from the ledger's samples and does not follow Admin prices. The day starts at local midnight in the server's timezone; podiumctl gives the container the host's `TZ` (or the `TZ` set with `podiumctl config set`), because the container would otherwise run in UTC and roll the day over at the wrong hour (#139).
- Admin validation: each price is a finite number from 0 to 1000 (USD per million tokens); an Admin-added model id is lowercased, at most 120 characters, and at most 100 can be added; a long-prompt price can be set only on a model that has one. A price equal to the built-in value is not stored, and resetting a row deletes the Admin's change.

### 6.6 Session display name

In priority order: a name set with `/podium name <text>` (kept in `$.store` by session id); the `sessionName` option; for a worktree, the last segment of the branch (`refactor/invoice-v2` → `invoice-v2`) or of the worktree directory; else the repository directory's name; else `session-<first 6 of id>`.

### 6.7 Reporting cadence

- State changes mark `dirty`. A `$.clock.every(flushIntervalMs)` timer flushes when dirty or when `heartbeatMs` has passed since the last report.
- Git is polled every 10 s, not per flush. `$.agent.list()` and `$.session.usage()` are read per flush (both cheap).
- Never `await` a network call inside a hook that sits on the tool path. Hooks only mutate in-memory state and set `dirty`. The one exception is an open ask while the mod responds (5.3): its hook announces the ask and waits on the server on purpose, and only while the dialog it races is on screen.
- Events: assigned an id at creation, queued; the queue holds at most 500; acknowledged by `ackedEvents` count (the server acks all events in a valid report; the mod then clears them). If the server is unreachable: keep the latest snapshot and the event queue (oldest dropped past 500), retry with backoff 1 s → 2 s → 5 s → 10 s max, and update the status line to `podium ○ offline`. On the first success after failures, send the full snapshot plus queued events.
- On `session.end`, flush synchronously (await the POST, 2 s timeout) before returning from the hook.

---

### 6.8 Version compatibility

The mod and the server are released separately, so their versions can drift in either direction. The server keeps one range, `REPORTER_SUPPORT` in `server/src/fleet/compat.ts`: the oldest and newest reporter (mod) versions it reads correctly. It changes when the report format or the mod's behavior needs it, not on every release.

Only `major.minor` is compared, so a mod-only patch fix never warns. `checkReporter` returns:

| Result | Meaning | What to do |
|---|---|---|
| `ok` | Inside the range. | Nothing. |
| `outdated` | Below `min`. | Update the mod: `claude plugin update podium-reporter@eengelking-marketplace`, then `/reload-plugins`. |
| `newer` | Above `max`. | Upgrade the server. |
| `unknown` | The version is not `X.Y.Z` (the simulator's `0.1.0-sim`, for one). | Nothing. No warning is shown. |

A mismatch is a warning, never an error. The server still accepts and shows every report it can read.

**Responding moves the range to `{ min: "0.2.0", max: "0.14.0" }` (#206).** Reporter 0.14.0 adds `session.respond`, `session.asks`, `session.clearedFrom`, the ask and delivery routes (7.1) and the `respond` option (5.9), so `plugin.json`'s `version` and `VERSION` in `register.ts` move to 0.14.0. `min` stays: an older reporter still reports as before, and its sessions show "Reporter can't answer", because their reports carry no `respond` (the modal's note names the version from `reporterVersion`, or reads "an older podium-reporter" without one, and asks for an update; for a session reported by the settings hooks, a `claude -p` run, or a computer where the permission hooks don't run, the note says that instead and asks for no update, as the mockup's frames show). A 0.13 reporter now shows `· update available` on its status line. A server older than this ignores the new fields and sends no `respond`, so a 0.14 reporter never announces an ask to it. Plan approval was verified on Claude Code 2.1.301; the report already carries Claude Code's version as `reporter.engineVersion`, and because the mod checks that each approval took (5.3), a different version degrades to "approve it in the terminal" rather than failing quietly.

- The reply to a report carries `serverVersion`, `reporterSupport` and `reporterCompat` for that report's version. A mod that reads them shows `· update mod` or `· upgrade server` on its status line, a line in `/podium`, and a toast once. A reporter inside the range but a major.minor below `reporterSupport.max` shows `· update available` instead (a patch difference is not flagged); this needs no new server field. A mod that predates this ignores them, and a mod talking to a server that predates this sees no `reporterCompat` and shows nothing.
- `SessionView` carries `reporterVersion` (null for a hooks-only session, which has no mod) and `compat` (always `unknown` for hooks). `StateBody.server` carries `{ version, reporterSupport }`, and the UI shows the server version in the left rail footer.
- The dashboard marks each affected card, counts them in the top bar, and says what to do on the session's page.

## 7. The server

### 7.1 Endpoints (all JSON unless noted)

| Method and path | Purpose |
|---|---|
| `POST /api/fleet/report` | Ingest (6.1). |
| `GET /api/fleet/state` | `{ serverTime, config, sessions: SessionView[], kpis, clearedToday, events: ActivityView[], server: { version, reporterSupport }, wall, features }`: everything live plus the latest 150 events. `wall` is the wall's notice and background-sessions settings (8.1); `features` maps each Admin feature flag's id to whether it is on (8.1). First paint and resync. |
| `GET /api/fleet/stream` | SSE (7.3). |
| `GET /api/fleet/sessions/:id` | One `SessionView`, live or historical. 404 if unknown. |
| `GET /api/fleet/sessions/:id/agents/:agentId/text` | `{ prompt: string \| null, answer: string \| null }`: the agent's whole task prompt and final answer (6.4). 404 if the server holds neither. No token, like the other reads. |
| `GET /api/fleet/sessions/:id/agents/:agentId/activity?every=` | `{ entries: (ActivityEntry & { seq })[], since, live, enabled, serverTime }`: a loop's activity feed (6.4); `@orchestrator` is the main loop. Each call takes or renews a lease on that loop for `every` seconds (5, 10, 20, 30 or 60; anything else is 5) plus 15 seconds, and while a lease is live the reply to each report lists the loop in `watch`. `seq` numbers entries in the order the server took them. For a session that is not live it answers `live: false`, `since: null` and no entries, and takes no lease. `enabled` is false while the Admin has the activity feed turned off (8.1): the reply then has no entries and `since: null`, `live` as usual, and no lease is taken. 404 for an unknown session or agent. In memory only, never in the state or the stream. No token, like the other reads. |
| `GET /api/fleet/events?sessionId=&before=&limit=` | Page through stored events newest first (`limit` ≤ 200, default 50, `before` = event time). |
| `GET /api/fleet/history?day=YYYY-MM-DD&page=N&pageSize=N` | Ended or dropped sessions that day, newest first, summary rows only (name, project, model, duration, cost, blowouts, end reason), one page at a time (#195); the server builds the rows of the requested page only (#273). `page` is 1 or more (default 1; a page past the end answers the last page) and `pageSize` is 25, 50 or 100 (default 50); anything else is a 400. The body is `{ day, sessions, total, page, pageSize }`, where `total` counts the whole day. Each row also carries `clearedFrom` (the session it continues after a `/clear`) and `clearedInto` (the session that continued it), each null when there is none (#206, 5.8). Phase 4. |
| `POST /api/fleet/notices/:id/close` | Turn a wall notice off for everyone (8.1). No token, like Remove. 400 for an id that is not a known notice. |
| `PUT /api/fleet/wall/background-sessions` | Body `{ show: boolean }`: the Show them / Hide them link on the background-sessions note changes this setting. No token. 400 unless `show` is a boolean. |
| `POST /api/fleet/sessions/:id/drop` | Remove a heartbeat-lost session from the live view now: the same exit as the automatic drop (7.5). No token. 404 if the session is not live, 409 if it is not `stale`. |
| `DELETE /api/fleet/sessions/:id` | Remove a session and its rows (for stuck test data). Requires the token if one is configured. |
| `GET /api/fleet/health` | `{ ok, dbPath, liveSessions, uptimeSec, reporterVersionsSeen, serverVersion, reporterSupport, sseClients, maxClockSkewMs }`. |
| `POST /api/fleet/hook` | Phase 5: classic settings-hook payloads. |
| `PUT /api/fleet/sessions/:id/asks/:askId` | Responding (#206, 5.3): the mod announces an open ask. Body: one `Ask` (6.2) whose `id` is `:askId`. Needs `X-Podium-Token` from the session's owner (7.7). `200 { ok: true }`, also for an ask already known: the call is idempotent, and a changed body replaces the stored ask while no answer to it is pending. `403 { ok: false, error: "responding is off" }` while the server takes no answers for this session (the report reply's `respond` is false); `404` for a session that is not live; `409 { ok: false, error: "closed" }` for an ask already closed; `400` for a body that fails validation; `429` past 8 open asks for one session. |
| `GET /api/fleet/sessions/:id/asks/:askId/answer?wait=` | The mod's held request for an answer. Same credential. `wait` is 1 to 20 seconds (default 20; `$.http.fetch` gives up after 30). `200 { delivery: Delivery }` at once when an answer to the ask is pending (one already handed over but with no result yet is handed over again), else the request is held until one arrives (`200`) or `wait` runs out (`204`). `404` for an ask the server doesn't hold, such as after a restart (the mod then announces it again); `410 { outcome }` for a closed ask; `403` while responding is off. At most 4 held requests per ask and 200 in all; past that the oldest is answered `204`. |
| `POST /api/fleet/sessions/:id/asks/:askId/close` | The mod says an ask closed without an answer from Podium. Same credential. Body `{ outcome: "terminal" \| "closed" \| "ended", at, answer?, planApproved? }`: answered in the terminal (`answer` is a short summary of what was chosen there, redacted, ≤ 2,000 chars: a question's answers joined with "; ", `No, keep planning` for a plan sent back from there, `allowed` or `denied` for a tool; `planApproved: true` for a plan approved there, with no mode), closed without an answer (Esc or an aborted turn), or the session ended. `200 { ok: true }`, also for an ask already closed or unknown. An answer still pending for the ask is dropped, and the modal shows why. An answer from Podium closes its ask through its delivery's result instead. |
| `POST /api/fleet/sessions/:id/deliveries/:deliveryId/result` | The mod says what became of a delivery. Same credential. Body `{ result: "took" \| "queued" \| "not-taken" \| "refused" \| "closed", at }`: the session took it (for an answer this closes the ask as `podium`); a message waits for the session to be idle (a later `took` follows); Claude Code didn't take a plan approval (the ask stays open, and no further answer from Podium is accepted for it); the mod refused it (5.3); its ask had closed first. `200 { ok: true }`; `404` for a delivery the server no longer holds, which the mod ignores: the server drops a message once it has a final result (`took`, `not-taken`, `refused`, `closed`) and an answer once it is `refused`, so a retry of one of those gets `404` too, and the mod, which drops a queued result on any response, does not send it again (DECISIONS 34). A repeat of the result a held delivery already has (`queued` again) gets `200`. |
| `GET /api/fleet/respond/me` | `{ enabled, signedIn, name, admin }`: whether responding is on for this server (authentication on and the `respond` flag on, 7.7), and who this browser is signed in as for responding (`name` is a person's name or `Admin`; `admin` is true for the admin secret or a person in Administrators). No credential needed. |
| `POST /api/fleet/respond/sign-in` | Body `{ name, token }`: a person's name and their token, or the name `Admin` and the admin secret (7.7). Starts this browser's respond session. `200 { ok: true, name, admin }`, `name` as Admin > People spells it; `401 { ok: false, error: "wrong name or token" }`, which never says which of the two was wrong; `400` when either is empty; `429 { ok: false, error: "too many wrong tries", retryAfterSec }`; `403` while responding is off. |
| `POST /api/fleet/respond/sign-out` | Ends this browser's respond session. `200 { ok: true }`. |
| `GET /api/fleet/respond/sessions/:id/asks/:askId` | The whole ask, for the modal: `{ ask: Ask, state: "open" \| "pending" \| "not-taken" \| "closed", delivery: (Delivery & { result: string \| null, mine: boolean }) \| null, closed: { outcome: "podium" \| "terminal" \| "closed" \| "ended", at, by: string \| null, answer: string \| null, planApproved: boolean } \| null, lastSeenAt }`. `delivery` is the answer taken for it, from whoever sent it; `mine` is whether this browser's person sent it. Owner or Admin only (`403 { ok: false, error: "not your session", owner }` otherwise), `404` for an ask the server doesn't hold. A closed ask stays readable until the session reports itself idle with no open ask (#208), for at most 10 minutes, or until the same session's next ask opens. |
| `POST /api/fleet/respond/sessions/:id/asks/:askId/answer` | Answers an open ask. Body: a `Delivery` (6.2) without `id`, `askId`, `by` or `at`, of kind `question`, `reply`, `plan-approve`, `plan-feedback`, `allow-once` or `deny`. Owner or Admin only. `202 { ok: true, deliveryId }`: the answer waits for the mod, and the modal shows "Sent, not confirmed yet" until its result. Only the first answer to an ask is taken: a later one is `409 { ok: false, error: "answered", by, at }`. `410 { ok: false, error: "closed", outcome, at }` for a closed ask; `422 { ok: false, error: "not accepted", kind }` for a kind outside the session's `accepts`, one that doesn't fit the ask's kind, or `allow-once` for a tool whose input was cut off; `400` for a body that fails validation (an option index out of range, two options on a single-choice question, text over its limit); `403` when the browser isn't signed in, isn't the owner or an Admin, or responding is off; `404` for an unknown ask. |
| `DELETE /api/fleet/respond/deliveries/:deliveryId` | "Discard my answer": drops an answer or message the mod has not been handed yet. Its sender or an Admin. `200 { ok: true }`; `409 { ok: false, error: "handed over" }` once the mod has it; `404` when it's gone. |
| `POST /api/fleet/respond/sessions/:id/messages` | Sends a new message or a command. Body `{ text }` or `{ command: "clear" \| "compact" }`. Owner or Admin, with `message` (or `command`) in the session's `accepts`. `202 { ok: true, deliveryId, queued }`, `queued` true when the session is running, so the message starts its turn once the session is idle. A text that starts with `/` is read as a command: `/clear` and `/compact` are taken as those commands; either with anything after it is `400 { ok: false, error: "/<name> takes nothing after it from here. Send /<name> on its own, or use the terminal." }`, and any other is `400 { ok: false, error: "/<name> runs only in the terminal. From here you can send /clear and /compact." }`. `422` for a kind outside `accepts`; `429` past 20 undelivered messages for one session; `403` and `404` as above. While an ask is open, the modal sends a message in its place as a `reply` to the ask instead. The modal sends `/clear` and `/compact` only on their own: with anything after one it sends nothing and shows "/compact takes nothing after it from here. Send /compact on its own, or use the terminal." (with the command's own name). |
| `/api/admin/*` | The Admin API (7.7): `GET session` (`{ enabled, unlocked, version }`), `POST unlock` (body `{ name, token }`), `POST unlock/from-respond` (a browser signed in to respond as an Administrator), `POST lock`, then with an unlocked session `GET/POST people`, `POST people/:id/rotate`, `POST people/:id/revoke`, `PUT people/:id/group`, `GET/POST groups`, `DELETE groups/:id`, `GET reporters`, `GET reporters/:key`, `DELETE reporters/:key`, `POST reporters/remove` (many at once: `{ keys }` of 1 to 500, `{ state }`, or `{ match: { q?, state?, admin? } }` for every reporter a filter holds; replies `{ ok, removed }`), `GET/POST reporters/ignores` (the ignore rules, `{ kind, pattern }`) and `DELETE reporters/ignores/:id` (the Reporters page, 7.7, 8.1), `GET/PUT settings` (the admin-secret switch, the feature flags: `features` lists `{ id, name, description, on }` and a change sends `{ features: { <id>: boolean } }`, an unknown id is a 400, the wall notice switches, the background-sessions setting, `forgetReporters` (`{ enabled?, days? }`; days a whole number from 1 to 3650), and the model prices: `modelPrice` `{ key, std, long? }` saves one model, `resetModelPrice` `key` removes the change), `GET log`. Lists take `page`, `pageSize` (default 50, at most 100) and, for people and reporters, `q`, and return `{ total, page, pageSize, rows }`; the reporters list also takes `state`, `sort` and `dir` and adds `counts` and `serverTime`. |

### 7.2 Database (SQLite)

Path: `PODIUM_DB` env, default `<repo>/data/podium.sqlite` (add `data/` to `.gitignore`). Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`. Migrations are a numbered list applied in order and recorded in `schema_migrations`.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,           -- running | waiting | done
  wait_reason TEXT, wait_note TEXT, end_reason TEXT, resume_id TEXT,
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, dropped_at INTEGER,
  cwd TEXT NOT NULL, project_root TEXT, repo_name TEXT,
  git_json TEXT,                                                           -- Report.session.git
  model TEXT, effort TEXT,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  cost_usd REAL, tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER,
  rate_limits_json TEXT, blowouts INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT, reporter_version TEXT, engine_version TEXT,
  loop_json TEXT,                                                          -- Report.session.loop; NULL from a reporter older than 0.4.0
  files_json TEXT,                                                         -- Report.session.files; NULL from a reporter older than 0.6.0
  attached INTEGER,                                                        -- Report.session.attached (1 or 0); NULL when unknown
  detached_at INTEGER,                                                     -- when the first report with attached = false arrived; NULL while attached or unknown
  owner TEXT,                                                              -- who the server decided the session belongs to from the token: a person's name, 'Admin', or NULL (auth off, or from before migration 6)
  background_json TEXT,                                                    -- Report.session.background (#119); NULL when the session waits on nothing in the background
  machine_json TEXT,                                                       -- Report.machine ({ name, id }); kept when a later report or hook carries none; NULL when never sent (migration 7)
  usage_json TEXT                                                          -- Report.session.usageByModel (#117, migration 10); NULL from an older reporter
);
CREATE TABLE agents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
  parent_id TEXT, kind TEXT NOT NULL, type TEXT NOT NULL, name TEXT, description TEXT NOT NULL,
  model TEXT, effort TEXT, effort_source TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  tok_in INTEGER, tok_out INTEGER, tok_cr INTEGER, tok_cw INTEGER, cost_usd_est REAL,
  usage_json TEXT,                                                         -- AgentReport.usageByModel (#117, migration 10); NULL from an older reporter
  skills_json TEXT, last_tool TEXT, tool_calls INTEGER, tool_counts_json TEXT, blowouts INTEGER NOT NULL DEFAULT 0,
  steps_done INTEGER, steps_total INTEGER, prompt_excerpt TEXT, answer_excerpt TEXT, failure_json TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE agent_texts (   -- migration 8: the whole prompt and answer (6.4), apart so agents stays small
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, prompt_text TEXT, answer_text TEXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, data_json TEXT
);
CREATE INDEX events_session_t ON events(session_id, t DESC);  CREATE INDEX events_t ON events(t DESC);
CREATE TABLE blowouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT, t INTEGER NOT NULL,
  kind TEXT NOT NULL,                                                      -- auto-compact | window-exceeded | server-compaction
  tokens_before INTEGER, tokens_after INTEGER, UNIQUE (session_id, agent_id, t, kind)
);
CREATE TABLE samples (                                                     -- one row per second per live session
  session_id TEXT NOT NULL, t INTEGER NOT NULL,                            -- t = whole seconds
  tokens_total INTEGER NOT NULL, tokens_delta INTEGER NOT NULL, peak_context REAL NOT NULL,
  running_agents INTEGER NOT NULL, cost_usd REAL, usage_json TEXT,        -- usage_json: the session's usageByModel at that second (migration 16, #270), stored in full only when it changed or at a minute's first sample, else '='; NULL from an older reporter
  PRIMARY KEY (session_id, t)
);
```

Migration 6 adds the tables for the Admin section (7.7). A token is never stored: only its SHA-256 (migration 17, #277, dropped the last four characters it used to keep).

```sql
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,   -- token_last4 existed until migration 17 (#277)
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER, last_report_at INTEGER
);
CREATE TABLE person_machines (person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, machine TEXT NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (person_id, machine));
CREATE TABLE admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE reporters (                                                  -- #142, migration 11 (12 merges rows that share a session, #166): every reporter the server has heard from; retention never touches it, only the Admin (or the forget-by-age setting) removes rows
  key TEXT PRIMARY KEY,                                                    -- the machine id the reporter sends (`<machine id>#<owner>` for a second account on the same machine, #221), else 'addr:<source address>' (a mod that sends none) or 'hooks:<source address>' (settings hooks)
  kind TEXT NOT NULL, machine_id TEXT, machine_name TEXT, source_address TEXT,  -- kind: 'mod' or 'hooks'
  owner TEXT, credential TEXT,                                             -- credential: 'pdm_<key id>' or 'admin secret', never a token; NULL when auth is off
  reporter_version TEXT NOT NULL, engine_version TEXT,                     -- reporter_version is 'hooks' for settings hooks
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE reporter_sessions (reporter_key TEXT NOT NULL REFERENCES reporters(key) ON DELETE CASCADE, session_id TEXT NOT NULL, PRIMARY KEY (reporter_key, session_id));  -- counts a reporter's sessions and finds the recent ones that still exist
CREATE TABLE reporter_ignores (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, pattern TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (kind, pattern));  -- #167, migration 13: a report from a reporter that matches a rule is refused. kind is key, address or version; pattern is text with * for "anything"
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- allow_admin_secret_reporting: '1' (default) or '0'; feature.<id>: '0' once the Admin turns a feature flag off and '1' once on, an unset flag taking its default (on, except `respond`, which is off, #206); wall_notice.<id>: '0' once a notice is off; wall_show_background_sessions: '1' when on (default off); model_prices: JSON of only what the Admin changed from the built-in prices, `{ "<key>": { std?, long? } }` (#117)
```

Migration 15 (#206) links a session to the one it continues after a `/clear` (5.8):

```sql
ALTER TABLE sessions ADD COLUMN cleared_from TEXT;                        -- Report.session.clearedFrom; NULL when the session does not continue another
CREATE INDEX sessions_cleared_from ON sessions(cleared_from);             -- finds clearedInto for History
```

Migration 17 (#277) drops `people.token_last4`, the last four characters of a person's token, which nothing has read since #218:

```sql
ALTER TABLE people DROP COLUMN token_last4;
```

**What responding keeps, and where (#206).** Only two things reach the database: the `cleared_from` link above and the Admin's `feature.respond` setting. Each answer is also written to `admin_log` (7.7) with who sent it, the session and the kind of answer, never its text. Everything else is held in the server's memory, in one store per live session, and never in the database, the state body or the stream:

- the open asks, with their questions, plan text or tool input (6.2), at most 8 per session;
- a closed ask's outcome (who answered and when, the terminal's answer summary), until the session goes idle with no open ask, for at most 10 minutes, or until its next ask opens;
- the pending deliveries: the one answer taken for each ask, and at most 20 messages and commands per session, each with who sent it, when, and its result once the mod reports one.

A pending answer or message does **not** survive a server restart: it is gone, and the person sends it again. A delivery that a restart lost before the mod took it never reaches the session; one the mod already took and reports on afterwards gets a `404` the mod ignores. The asks come back by themselves, since the mod re-sends its open asks in every report and announces an ask again when a held request gets a `404`. This keeps the text of answers, questions and plans off the disk, and the cost is small: a delivery normally waits a second or two, so only one sent to a session that isn't checking in is at risk. The store drops a session's asks and deliveries when the session leaves the live set (7.5), when it reports `done`, and when it is deleted; an ask closes as `ended` then. While a session is stale it keeps them, so an answer sent then is delivered once the reporter checks in again, unless the ask closed by then ("Session not checking in"). Turning the `respond` flag off drops every ask and delivery the store holds, and refuses every respond route until it is on again.

Retention (run by the sweeper hourly): samples older than 24 h deleted; events older than 30 days deleted; sessions ended more than 30 days ago deleted with their rows. The `reporters` table is kept, so a reporter outlives its sessions until the Admin removes it, or until the forget-by-age setting does (off by default; the same hourly run, once the server has been up for an hour so a long outage cannot empty the list before anyone reports, removes reporters not heard from for `days` days, 30 unless the Admin sets another, and writes a `reporters_forgotten` entry to the Admin log). Admin log rows older than 90 days are deleted in the same run, except that the newest 100 rows are always kept, so a quiet server keeps some history (#303). The thresholds are env-configurable: `RETAIN_SAMPLES_MS`, `RETAIN_EVENTS_MS`, `RETAIN_SESSIONS_MS` and `RETAIN_ADMIN_LOG_MS`. `GET /api/admin/log` also returns the period as `retainMs`, and Admin > Admin log says "Entries are kept for N days."

### 7.3 Ingest rules (`ingest.ts`) and derivation (`derive.ts`)

On a valid report, in one transaction:

1. Upsert the session (`last_seen_at = serverTime`, never the reporter's clock; store clock skew `sentAt − serverTime` for debugging). A report with `status: 'done'` sets `ended_at`. `started_at` is set once, when the session is first stored: from a report, the reporter's `startedAt` if it is within 2 minutes of `serverTime`, otherwise `serverTime`; from a settings hook, `serverTime`. Later reports never change it, and rows stored before this rule keep their value. Under Claude Code's background daemon the engine's `usage().startedAt` can be one shared host-level value, so sessions that began minutes apart reported the same start (#43).
2. Upsert every agent. An agent absent from a later report is **not** deleted (a reload may lose it); it stays as last reported, and if it was `running` and the session is `done`, mark it `aborted`.
3. Insert events with `INSERT OR IGNORE` on `id`. Insert a `blowouts` row for each `blow` event carrying `data.kind`.
4. Sample: compute `tokens_total` (main loop tokens + Σ agent tokens), `tokens_delta` against the previous sample (≥ 0), `peak_context = max(session context %, max over running agents' context %) / 100`, `running_agents`. At most one sample per session per second.
5. Broadcast the changed `SessionView` and new events over SSE, throttled to one `session` message per session per 500 ms.

**Blowout level** (the signal, computed in `derive.ts` and tested): `total = session.blowouts + Σ agent.blowouts`. `level = 0` if total is 0; `2` if the orchestrator has ≥ 2 blowouts or any single agent has ≥ 2 or total ≥ 3; else `1`. Level 2 is the red "likely losing context" state. Level 1 is the amber "context exceeded" state.

**KPIs:** live orchestrators; counts running/waiting/stale (a waiting session idle on background work, #119, is not in `waiting`); subagents running and agents total; plan steps done/total across live sessions; est. cost today (Σ of what each session, live or ended, spent since local midnight on the server, #139: a session that started today counts whole; one that started earlier counts the share of its cost that came after the ledger's last sample before midnight, and one with no such sample counts what it spent since its first sample, #276; one that now reports no ledger cost, a local model, counts its cost now minus the cost of the usage on its last sample before midnight, priced with the Admin's prices, #286, and nothing today when no sample kept usage), and the same sum split by owner with each owner's group (`costTodayByOwner`, largest first, an owner of `null` for sessions with none); tokens in the last 60 s (Σ `tokens_delta`); total blowouts with the count of sessions at level 2; sparkline series for cost-per-minute and tokens-per-second, 60 points. The cost-per-minute series is priced like every other cost figure (#270): each sample's `usage_json` is repriced with the Admin's prices, so a price change moves the sparkline with the cards; samples from a reporter that sends no usage keep the ledger's `cost_usd`, and where the two kinds meet in one window that step counts as zero.

### 7.4 View types (server → UI; defined once in `protocol.ts`, imported by the UI)

```ts
interface SessionView {
  id: string; name: string; project: string; repoName: string | null; resumeCommand: string;
  reporterVersion: string | null; compat: 'ok' | 'outdated' | 'newer' | 'unknown';  // the mod's version and where it sits against the server's range (6.8)
  git: { branch: string | null; detached: boolean; isWorktree: boolean; worktreePath: string | null; ahead: number; behind: number; dirty: number } | null;
  model: string | null; modelFamily: 'opus'|'sonnet'|'haiku'|'fable'|'other'; effort: string | null;
  status: 'running' | 'waiting' | 'stale' | 'done'; waitNote: string | null; endReason: string | null;
  startedAt: number; lastSeenAt: number; secondsSinceSeen: number;
  dropAt: number | null; // epoch ms when a stale session leaves the wall by itself; null unless stale (7.5)
  context: { tokens: number | null; window: number | null; percent: number | null };
  costUsd: number | null; tokensTotal: number;
  blowouts: { orchestrator: number; agents: number; total: number; level: 0 | 1 | 2; loopsHit: number; loopsTotal: number;
              log: { t: number; agentId: string | null; kind: string; tokensBefore: number | null; tokensAfter: number | null }[] };
  plan: Plan | null;
  loop: LoopReport | null;              // the main loop's steps, tools and skills; null from a reporter older than 0.4.0 and for a settings-hooks session
  files: FilesReport | null;            // the files the session changed; null from a reporter older than 0.6.0 and for a settings-hooks session
  attached: boolean | null;             // whether any client is attached; null from a reporter older than 0.7.0 (counts as attached)
  background: { tasks: { type: string; description: string; status: string }[]; wakeAt: number | null } | null;  // what the session is idle on (#119); not a wait on the person, so it is left out of the waiting count
  hideAt: number | null;                // epoch ms when a session nobody is attached to is set aside from the wall; null while attached or unknown (7.5)
  owner: string | null;                 // who the server decided the session belongs to from the token (7.7): a person's name, 'Admin', or null
  ownerGroup: string | null;            // that person's group from Admin; null for Admin, no owner, or no group
  machine: { name: string; id: string } | null;  // Report.machine as last sent; null when none was
  activityFeed: boolean | null;         // the reporter's activityFeed option (6.4); null for a reporter older than 0.13.0, a settings-hooks session, or no report since the server started (held in memory)
  respond: { level: string; accepts: RespondKind[]; limits: string[] } | null;  // Report.session.respond (#206); null for a reporter older than 0.14.0, a settings-hooks session, or no report since the server started (held in memory)
  asks: {                               // the session's asks, open, or closed and not yet forgotten (7.2: at idle, or 10 minutes), without their content: that is served only to the owner or an Admin (7.1)
    id: string; kind: 'question' | 'plan' | 'permission'; agentId: string | null; openedAt: number;
    count: number;                      // questions in a question ask (the Respond button's number); 1 otherwise
    state: 'open' | 'pending' | 'not-taken' | 'closed';
  }[];
  clearedFrom: string | null;           // the session this one continues after a /clear (5.8)
  agents: AgentView[];                  // AgentReport + modelFamily + costUsdEst
  series: { tokensPerSec: number[]; peakContext: number[]; running: number[]; blowoutSecondsAgo: number[] };  // 60 points, oldest first; peakContext in 0..1; missing seconds zero-filled
}
```

`resumeCommand` is `cd <cwd> && claude --resume <resumeId ?? id>`. `project` is `projectRoot ?? cwd` with the home directory shortened to `~`.

### 7.5 Lifecycle timers (`sweeper.ts`, runs every second, all values env-configurable)

| Condition | Result | Default |
|---|---|---|
| `status ≠ done` and no report for `STALE_AFTER_MS` | Shown as `stale` (derived, not stored) | 15,000 |
| `stale` for `DROP_AFTER_MS` more | `dropped_at` set, removed from the live set, event `end` "heartbeat lost" | 60,000 |
| `status = done` for `LINGER_MS` | Removed from the live set, event `end` "session ended" | 8,000 |
| `attached = false` for `DETACHED_HIDE_AFTER_MS` | The wall sets the card aside behind a "N background sessions hidden" note (client-side; the session stays live, in History and in the totals). A client attaching again clears it at once | 60,000 |

A stale session that reports again immediately returns to its stored status. A dropped session that reports again is revived (clear `dropped_at`, `ended_at`). On server start the sweeper treats every stored non-done session as stale until it reports. SSE broadcasts `removed` when a session leaves the live set.

`SessionView.dropAt` is when a stale session leaves the live set by itself: `max(last_seen + staleAfter, server start if not heard since) + DROP_AFTER_MS` (`staleAfter` is `STALE_AFTER_MS`, or `HOOK_STALE_AFTER_MS` for a hook-only session). The sweep and the view use the same calculation, so a heartbeat-lost card shows a countdown that matches what happens, including after a restart.

**Remove.** A heartbeat-lost card and its rail row have a Remove control, and the orchestrator page has "Remove now" on its status band. It calls `POST /api/fleet/sessions/:id/drop`, which runs the same exit as the automatic drop (`dropped_at` set, event `end` "heartbeat lost", `removed` with reason `dropped`), so every open tab updates. The session stays in History, so Remove asks for no confirmation. The server refuses a session that is not `stale`. Removing hides the card and nothing more: a removed session that reports again comes back on the wall, exactly as a dropped one does. Remove needs no token, like the other requests the dashboard makes, and sends nothing to the session.

A session that has done nothing yet is not part of the wall. That means its status is not `running` and it has no tokens, cost, context, blowouts, agents or plan. It stays out of `/state`, the SSE `session` and `activity` messages, the KPIs, `/history`, `clearedToday`, the activity feed, and the `liveSessions` number in the report ack and `/health`. It appears as soon as any of those change. Sessions reported only through settings hooks are exempt, because hooks carry no usage and would never leave that state. Claude Code's background daemon runs such sessions (a parked twin of an interactive window, and a pool of pre-warmed spares), and each one loads the reporter.

### 7.6 SSE stream

`GET /api/fleet/stream` sends `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and flushes headers at once. Messages (`event:` name, `data:` one JSON line):

| Event | Data | When |
|---|---|---|
| `snapshot` | the full `/state` body | on connect, and when the Admin changes a model price or a feature flag |
| `session` | one `SessionView` | on change (throttled per session) |
| `activity` | one `ActivityView` | new event |
| `removed` | `{ sessionId, reason: 'done'|'dropped'|'deleted' }` | leaves the live set |
| `wall` | `{ notices, showBackgroundSessions }` | when an Admin setting or a closed notice changes the wall's notices (8.1) |
| `tick` | `{ serverTime, kpis }` | every 2 s (also serves as keepalive; the client treats 6 s of silence as disconnected) |

The registry removes a client on `close`/`error`, and a write that throws never crashes the process. Supports 100 simultaneous clients. Send `retry: 2000`.

### 7.7 Hardening

- Bind `127.0.0.1` by default (the container image listens on `0.0.0.0` inside the container and `podiumctl` publishes it on the host's `127.0.0.1`, 4.4). If `PODIUM_TOKEN` is set, `POST /report`, `DELETE` and `POST /hook` require `X-Podium-Token`; reads and the `drop` route stay open on localhost.
- **Who a report is from (issue #36).** `PODIUM_TOKEN` is the *admin secret*. A credential is either a person's token, `pdm_<12 hex key id>_<48 hex secret>` (192 bits of randomness, made by the server in Admin, shown once, stored only as a SHA-256; random tokens of that length need no slow or keyed hash), or the admin secret. The server finds a person by the key id, compares hashes in constant time, and accepts a report when the token is live (not revoked, not rotated away) and `Report.userName` equals that person's name, compared case-insensitively. The token, not the name, decides identity: the name is visible in the console, so the match is a consistency check and the token's randomness protects the account. A hook has no body name, so a person's token alone identifies it. The admin secret is accepted as before and puts the session under the owner `Admin`, unless the owner turned that off in Admin. With no `PODIUM_TOKEN` and no person token, a report is accepted with no owner ("Unassigned"); a person token that is presented is still checked. A session id that already belongs to another owner is refused with `409`. Any valid credential may `DELETE` a session.
- **The Admin API (`/api/admin`).** Off (403) when `PODIUM_TOKEN` is empty. `POST unlock` takes a name and a token, the same pair as the sign-in to respond (#215): the token of a person in the built-in **Administrators** group with that person's name (case-insensitive), or the admin secret with the name `Admin`. A missing name or token is a `400`. It starts an in-memory session whose id is in an `HttpOnly; SameSite=Strict` cookie scoped to `/api/admin`; it ends after 10 idle minutes, on lock, and on restart, so rotating the admin secret (which needs a restart) ends every session. Five wrong names or tokens from one source address lock that source for 15 minutes; a name or token that is unknown, mismatched, revoked, rotated away or from a person outside Administrators is refused with the same `401 wrong name or token`, never saying which part was wrong, and counts toward the same lockout. **No second sign-in (#215):** `POST unlock/from-respond` (no body) opens a session for a browser whose sign-in to respond (below) is an Administrator's, or Admin's with the secret, and is a `401` for anyone else, so an Administrator who is signed in to the console opens Admin without typing anything again, including after the idle lock. It records the same `unlock` entry and actor. **An explicit lock holds it shut (#272):** `POST lock` also marks that browser's sign-in to respond as held, and `unlock/from-respond` is a `401` for a held sign-in, so reloading `#/admin` after Lock Admin shows the name-and-token sign-in while the console sign-in itself stands. Unlocking with the name and token of the person who is signed in to respond in that browser lifts the hold (the idle lock then lets them back in as before); a different Administrator unlocking there does not, a new sign-in to respond starts without one, and another browser's sign-in is unaffected. The hold lives in memory with the sign-in and ends with it. The Admin button in the top bar shows only to a browser signed in to respond as an Administrator (`GET respond/me` says `admin`); anyone else reaches Admin at `#/admin`, which shows the name-and-token sign-in. Hiding the button is not the check: every Admin route except `GET session` and the two unlocks needs an open session, as before. **Administrators (#172):** migration 14 creates the group `Administrators` on every server (a group already of that name is adopted). It is built in: `DELETE groups/:id` on it is a `400` that says why, and group listings carry `builtIn`. The admin secret is the Admin user and is always a member, shown as a fixed member and never stored as a person row, so the group may hold no people and nobody can be locked out of it. A session an administrator opened records who opened it and ends on the next request after they leave the group or their token is revoked. The admin log records an `actor` for each entry: the person's name, or `Admin secret`; entries from before it was recorded have none. A person's token still reports as that person, and the owner `Admin` is unchanged. Every change needs the header `X-Podium-Admin: 1` and, when an `Origin` is sent, the server's own host; no CORS is enabled. Every response carries `Cache-Control: no-store`. The secret and tokens are never logged, never put in an error, the activity list or the admin log, and never stored by the page in `localStorage` or `sessionStorage`. The admin log records unlocks, failed unlocks, lockouts, people, rotations, revocations, group changes, the reporting switch, the feature flags (a flag turned on or off, kind `feature_changed`), the wall settings (a notice turned on or off, background sessions shown or hidden) and the model prices (a price set, a price reset) and a reporter taken off the list (`reporter_removed`), each with the source address. A name is 1 to 48 characters and a group name 1 to 24, with no control characters, both unique case-insensitively. The name `Admin` is reserved: it is the owner of a report made with the admin secret. A person sees no one's token, including their own; only the owner rotates it.
- **Which reporters the server knows (#142).** After each accepted report (`POST /report` and `POST /hook`, never a refused one, and never the simulator's, whose `reporter.hostSurface` is `simulator`, so a simulator run leaves no row behind, #168) the server notes its sender in `reporters`: one row per account on a machine, keyed on `machine.id` for the first account to report and `<machine id>#<owner>` for each other account on that machine (two accounts on one machine send the same id, #221), or on the source address when the report carries none (a reporter with no user name sends no machine, 6.2) with the prefix `addr:` for a mod and `hooks:` for the settings hooks, so several machines behind one address share a row until they send an id. A session belongs to one reporter, so a report with no machine id that carries a session already recorded under another `addr:` (or `hooks:`) row is filed under that row, oldest first, and a row created for the new address before the session turned up is merged into it: a reporter whose address changes, as a container's does when it restarts, stays one row, with its first-seen time and sessions kept. A reporter that has never reported a known session from a new address still gets its own row. Migration 12 merges rows that already share a session. A reporter with no machine name is named by its newest session's project, else its source address (`named` is false, and the page says no name is set and that the `userName` option sets one). The row keeps the machine name, source address, owner, the credential as `pdm_<key id>` or `admin secret` (the key id only finds a person and is not a secret; the token never reaches this table), the reporter and Claude Code versions and the first and last time it was heard. `reporter_sessions` records the sessions it reported, so the total outlives the 30-day session retention. The **state** is worked out by the server from the last report, the time the server started and now: `reporting` (under 2 minutes), `idle` (under 1 hour), `silent` (longer) and `restart` (last heard before this server started; shown as "Not since restart"). `silent` means only that nothing arrived: the server cannot tell a reporter that is turned off from one that cannot reach it, and the page says so. The server also keeps the last 200 refused reports in memory only (source address, time, one of its fixed reasons) and shows those from a reporter's address in its detail; they are lost on restart. A reporter that reports with the admin secret (its `credential` is `admin secret`) instead of a person's token is always flagged (`adminSecret`), whatever the setup: `GET reporters` returns the count of them (`adminSecret`, unfiltered), takes `admin=1` to list only them and `sort=token` to put them first, and each row carries its `credential`. With authentication off there is no credential, so nothing is flagged. A reporter's compatibility is `checkReporter` (6.8) on its version, and `unknown` for the settings hooks. `GET reporters/:key` also returns how many of its sessions are running, the refusals, and its sessions that still exist, newest first and paged like the other lists (`page`, `pageSize`; `recent` is that page, with `recentTotal`, `recentPage` and `recentPageSize`). `DELETE reporters/:key` takes a reporter off the list (kind `reporter_removed`); it returns if it reports again, and its sessions are untouched. `POST reporters/remove` does the same for many at once and writes one `reporter_removed` entry with the count. **Ignoring (#167):** `POST reporters/ignores` adds a rule that matches a reporter's key, its source address or its reporter version (`*` means "anything", never a regular expression; case is ignored; an identical rule is kept once; a pattern of only `*` is a 400, since it would turn every reporter away) and takes the reporters it matches off the list; `GET` lists the rules and `DELETE reporters/ignores/:id` removes one (kinds `reporter_ignore_added` and `reporter_ignore_removed`). A key rule on a machine id covers every account on that machine; a rule on `<machine id>#<owner>` covers that account only (#221). A report (`POST /report`, and `POST /hook` by address) from a reporter a rule matches is **refused** with 403 `this reporter is ignored by the Admin`, before anything is stored, so its sessions stop appearing on the fleet until the rule is removed; the refusal is logged (`report.ignored`) and shown in the reporter's refusals. The simulator is never matched. All of these need an unlocked session, because a source address and a machine name are personal data. The report format is unchanged: there is no install id, and the mod's options are not sent, so the page cannot show them.
- **Responding (#206).** This is the only way anything reaches a session from Podium, so every rule here holds whatever else is set.
  - **Off by default, five switches.** It needs authentication on (`PODIUM_TOKEN` set: with it empty there is no credential to check, so every respond route answers `403` and every report reply says `respond: false`), the Admin's **Respond from Podium** flag (`respond` in `FEATURES`, Admin > Settings > Feature flags, "Lets people answer and message the sessions they own. Each answer is written to the admin log with who sent it.", off by default, a change written to the admin log as `feature_changed`), the Admin's `activity-feed` flag, and on the session's machine the reporter's `respond` option (not `off`) and `activityFeed` option (5.9). With any of them off there is no Respond button and no message box, every browser respond route but `GET me` refuses, the report reply's `respond` is false and its `deliveries` empty, and the mod accepts nothing: Podium is observe-only, as before. The mod checks its own two switches and its level itself and never relies on the server for them.
  - **Who.** Only the session's owner (the person whose name, compared case-insensitively, is the session's `owner`) or an Admin (the admin secret, or a person in Administrators) can respond. A session owned by `Admin` can be answered only by an Admin. Everyone else gets `403 { error: "not your session", owner }`, and the console shows Respond dimmed with whose session it is.
  - **The browser's credential.** Reads stay open, but every respond route except `GET /respond/me` needs a respond session. `POST /respond/sign-in` takes a name and a token, the same pair as the reporter's `userName` and `token` options, and checks them the way a report's credential is checked against its `userName` (`identify` in `routes.ts`): a person's token is accepted only with that person's name, compared case-insensitively, and the admin secret only with the name `Admin`. A person in Administrators signs in with their own name and token and can respond to every session. It starts a session whose random 32-byte id is in a cookie, `podium_respond`, `HttpOnly; SameSite=Strict; Path=/api` (and `Secure` over HTTPS; the path is wide so that `POST /api/admin/unlock/from-respond` receives it, #215), held in the server's memory only. It ends on sign-out, on restart, after 12 hours without use, and on the next request after the person's token is revoked or rotated; an Admin's rights follow their membership of Administrators on every request. Five wrong tokens from one source address lock it out for 15 minutes, counted together with failed Admin unlocks. A sign-in and a failed sign-in are written to the admin log (`respond_sign_in`, `respond_sign_in_failed`). The token is never stored by the page and never logged.
  - **Cross-site protection, as in the Admin API.** Every respond route that changes something needs the header `X-Podium-Respond: 1` and, when an `Origin` is sent, the server's own host. No CORS is enabled. Every response carries `Cache-Control: no-store`. JSON bodies over 64 KB are refused.
  - **The mod's routes** (asks, held requests, closes and results, 7.1) need `X-Podium-Token`, checked as for `POST /report`, and the credential must be the session's owner: a person's token for that person's session, the admin secret for a session owned by `Admin`. A wrong credential is `401`, another owner's session `403`. They need no `Origin` check, since a page on another site has no token to send.
  - **The mod never trusts the server.** It acts only within its own `accepts` (5.3), only on an ask it has open and a hook of its own is waiting on, and runs no command but `/clear` and `/compact`. A tool's answer never carries `updatedPermissions` ("always allow" and every other change to permission rules stay in the terminal). A plan approval's only `setMode` is `auto`, `acceptEdits` or `default` with `destination: "session"`, and its `updatedInput` is the event's own `tool_input`, unchanged.
  - **The admin log.** Each answer, message and command the server takes is written to the admin log as `respond_sent`, with who sent it (`actor`), the source address, the session (its name and the first 8 characters of its id) and the kind of answer: answered a question, sent a message in place of an answer, approved a plan (with the mode), sent a plan back, allowed a tool once, denied a tool, sent a message, ran `/clear`, ran `/compact`. Its detail ends with the delivery's short id in brackets (`dlv_` and 8 hex digits). What then became of that answer is a second row with the same actor and short id: `respond_result` when the mod reports a result (the session took it, queued it, did not take it, refused it, or it had closed before the session got it; a repeat of the result a delivery already has, as from a mod retrying, writes no second row), and `respond_dropped` when the server let go of it with no result: its sender discarded it, its ask closed first, the session ended first (for a message, command or handed-over answer still waiting for a result), the session ended while a message was still queued (Podium cannot tell whether Claude Code read it), the session was deleted first, or responding was turned off first. Deleting a session or turning responding off writes one row for each such delivery, not one for the lot, so a row always pairs with its `respond_sent` by id (DECISIONS 34). A delivery that already has a result is not written again, and one that is dropped twice (a session that ended, then was deleted) is written once. The server log has the same as `respond.sent`, `respond.result` and `respond.dropped`, and each refusal as `respond.refused` with its reason. The text of an answer, a message, a question, a plan or a tool's input is never logged, shipped or stored on disk (7.2).
  - **What the content is shown as, and to whom.** An ask's content and the answers are served only to the session's owner or an Admin (`GET /respond/sessions/:id/asks/:askId`), never in the state or the stream, which carry only a summary (7.4). Question text, option labels and descriptions, previews and tool input are drawn as text nodes; the plan's markdown goes through the existing renderer from #97 (`frontend/src/fleet/components/Markdown.tsx`). Allow once is refused (`422`) for a tool whose input was cut off (`tool.cut`), since the person could not see all of what they would allow; Deny still works. The modal doesn't offer it then: it selects Deny and says "This command is too long to show in full here, so it can only be allowed in the terminal. You can still deny it from here."
  - **Validation.** The server validates every ask and every delivery against the limits in 6.2, clamps nothing it would then act on (a delivery over a limit is a `400`, not cut), strips control characters except line breaks from text, and checks an answer against its ask: one option for a single-choice question, indexes in range, a kind that fits the ask's kind.
  - `.github/SECURITY.md` says what responding exposes: that it lets the server's people send answers and messages into sessions whose owners opted in, what the console shows to whom, and that the browser's token and the session cookie travel over plain HTTP unless a TLS proxy is used.
- **The `Host` header (#256, DNS rebinding).** A page on another site can point its own name at this server's address, and the browser then lets that page read the open routes. The server runs a check ahead of every route (before the response headers, the log and the routers) and answers `403 { "error": "host not allowed" }` to a request whose `Host` is none of: `localhost` (with or without a trailing dot), an address in `127.0.0.0/8`, `[::1]`; the address the server is bound to (`HOST`); a name or address in `PODIUM_ALLOWED_HOSTS` (comma-separated; set with `podiumctl config set`); or, when `HOST` is `0.0.0.0`, `::` or empty, any IP address (an address cannot be rebound, a name can). The port is never compared, a missing or malformed `Host` is refused, and names are compared case-insensitively. In container mode the server listens on `0.0.0.0` inside the container, so any address is taken there and a name needs `PODIUM_ALLOWED_HOSTS`. A refusal is logged as `http.host_refused` (warn) with the `Host` value only, never a header, query, path or body, and at most once a minute per value. See DECISIONS 33.
- **Guessing the admin secret through `X-Podium-Token` (#255).** The routes that check it (`POST /report`, `POST /hook`, `DELETE /sessions/:id` and the mod's respond routes) throttle wrong secrets per source address, with a counter of their own, apart from the Admin and sign-in lockout (which is unchanged). Five *different* wrong values from one address throttle it for 15 minutes; the same wrong value sent again counts once, so a reporter with a stale credential, which always sends the same one, throttles nobody. A person's token (`pdm_…`, 192 bits) is never counted or throttled, whether right, revoked or unknown, so reporters with a person's token are unaffected whatever else the address sends. While an address is throttled, any other value is answered `429 { ok: false, error: "too many wrong tries", retryAfterSec }` with a `Retry-After` header, even the right admin secret, since answering it would confirm a guess. The refusal is logged as `auth.failed` (`reason: "too many wrong secrets"`, `status: 429`) and shown in the Reporters page's refusals; the value is never logged. In memory only. At start the server warns (`server.weak_token`, never the secret) when `PODIUM_TOKEN` is under 24 characters.
- Tokens and the admin secret travel in a header over plain HTTP. A server reachable over a network needs a trusted network or a TLS proxy.
- **Plain HTTP warnings (#306).** Nothing blocks. The server logs a `warn` event `server.respond_plain_http` (fields `trigger`, `bind`, or `request_host`; never a token, header or cookie value) (a) once at start, and again whenever the Admin turns Respond from Podium on, when `HOST` is not loopback (`127.*`, `localhost`, `::1`) and the flag is on, and (b) on a sign-in to respond whose connection Express sees as `http` (`req.protocol`, which follows `X-Forwarded-Proto` only when proxy trust is set; there is no such setting yet, #305) and whose `Host` is not loopback, at most once a minute. Admin > Settings adds a caution to the Respond from Podium row when the console itself is loaded over `http:` from a non-loopback host. The reporter mod starts its status line with `⚠ ` and toasts once per session when its `serverUrl` is `http:` to a host that is not loopback; it keeps reporting.
- Body limit 512 KB. Validate every field's type and length; clamp strings (name ≤ 80, text ≤ 240, excerpt ≤ 400, `promptText` and `answerText` ≤ 20,100 (line breaks kept, other control characters removed), arrays ≤ 200 agents and ≤ 100 events and ≤ 100 plan steps per report). `toolCounts` takes at most 100 distinct tool names per agent, and per `session.loop`: the mod stops adding new names past 100 (they still count in `toolCalls`), and the server keeps the 100 most used (ties by name) instead of rejecting the report, so the counts then add up to less than `toolCalls`. `session.files` keeps the first 200 files (paths clipped to 300 characters and stripped of control characters, counts non-negative integers, `total` never below the listed count) rather than rejecting a longer list. `userName` is clipped to 80; `machine.name` is clipped to 64, trimmed and must not be empty, and `machine.id` must be 1 to 32 letters, digits, `-` or `_`. `activity` (on the session and on each agent) takes at most 20 entries, a longer list is rejected, and each entry's text is clipped to 300 characters and stripped of control characters; past 60,000 characters of activity in one report, the server drops the feed of the loops that do not fit (the orchestrator's first, then the agents' in order) rather than the report. Reject, never crash, on junk.
- Never log report bodies. Log one line per error with the path.
- **Server logging (issue #140).** Each log line is an event with a stable dotted name (`report.rejected`, `session.started`, `admin.feature_changed`), a level and flat fields. `PODIUM_LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`; `PODIUM_LOG_FORMAT` is `text` (default: the message alone, as before; the events added in #140, such as `session.*`, `reporter.*`, `admin.*`, `sweep.removed` and `auth.failed`, print in text only at `debug`, so the default output is unchanged) or `json` (one object per line with `timestamp`, `level`, `message`, `event`, `service`, `host`, `version` and the event's fields). Access logging is one `http.request` line per request at `debug`, with no query string, header or body; a request the client drops before the response is one `http.aborted` line at `debug` with the same fields but no status. `sweep.removed` names at most the first 10 session ids and counts the rest in `session_ids_omitted`. When `PODIUM_LOG_SHIP_URL` is set the server also pushes the JSON lines, gzipped NDJSON, to VictoriaLogs' `/insert/jsonline` with `_time_field=timestamp&_msg_field=message&_stream_fields=service,host` and the headers in `PODIUM_LOG_SHIP_HEADERS` (`Name=Value;Name2=Value2`). Shipping is off by default, never delays a request, keeps at most `PODIUM_LOG_SHIP_BUFFER` lines (2000) while the endpoint is down, drops the oldest past that and says so once in the server's own output. No token, admin secret, ship header value, prompt, answer or activity text is ever logged or shipped. The mod does not ship logs.
- Never execute, `eval`, or interpolate reported strings into SQL (parameterized statements only) or into HTML (the UI uses React text nodes only).
- CORS: none needed (same origin). Do not enable `*`.
- **Response headers and the container (#249).** Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a `Content-Security-Policy`: `default-src 'self'`, scripts only from the server and the page's one inline script (the theme setter in `frontend/index.html`, allowed by its SHA-256, computed from the built page at start), styles from the server, inline styles and Google Fonts, fonts from the server and `fonts.gstatic.com`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and `frame-ancestors 'none'`. A new third-party origin or a second inline script needs the policy changed in `server/src/securityHeaders.ts`. `podiumctl` starts the container with `--cap-drop ALL` and `--security-opt no-new-privileges`, on top of the non-root user (4.4).

---

## 8. The UI

`mockup/podium.html` is the specification. Open it, read all of it (about 1,100 lines), and reproduce its behavior in React. Where the mockup simulates data, the UI consumes `SessionView`. Do not redesign. `mockup/podium-wall.html` shows the collapsed panes, the disconnect strip and wall mode added in #33.

### 8.1 What the UI must do (each line is a requirement)

**Shell.** Top bar: logo and name, which are one link to the fleet page (`#/`, accessible name "Podium, fleet") on the wall, History and Admin, and leave the wall as it is when already there; a pill that names the page, supplied by the page itself and not fixed in the top bar ("Fleet" on the wall, "Orchestrator" on an orchestrator's page (#225), "History" in History, "Admin" in Admin); connection pill ("N reporters live", or "1 reporter live"; no synced time (#178); red "disconnected, retrying" when SSE is down). Admin's top bar shows this same pill, from the same component and count, right after its "Admin" pill (#187). There is no clock. Nothing goes to the right of the connection pill, because its width changes with the reporter count and anything after it would move. No Pause or simulator buttons (those belong to the simulator script). **Theme picker.** The info row under the top bar carries the theme picker at its right end, in the live view and in History (a Theme dropdown and a Light, Dark or System radio group, with arrow keys moving through the radios; a Theme dropdown and a Light, Dark or System radio group, remembered in `localStorage` under `podium.theme` with try/catch; the default is Podium in System mode, which follows the OS; an old stored `light` or `dark` becomes Podium in that mode; the choice is applied to `<html>` before first paint; a theme with no palette for the chosen mode uses Podium's palette for that mode). **Refresh every (#138, `mockup/podium-update-interval.html`).** The same row carries a **Refresh every** dropdown (2s, 5s, 10s, 20s, 30s, 60s; default 2s; remembered in `localStorage` under `podium.updateEvery`, with try/catch, and a stored value that is not one of the six is ignored) just left of the Theme dropdown. It sets how often the fleet page redraws: the browser keeps receiving every event, but shows the newest state once per interval, and the elapsed times and clock move on the same interval. A change shows at once when it is a change of connection phase, a session that newly reaches waiting or stale, or an agent that newly has a failure. The pulse and blink beat (`useHeartbeat`) is not affected, History and Admin have no such control, and the activity feed has its own. It goes with the info row when the top bar is collapsed, and the red disconnect banners replace the info row, so it is absent then. **Legend.** The legend (what the agent squares mean, and the model colors) is a footer under the middle column, on the wall and on the orchestrator page. The content above it scrolls and the legend does not; the rail and the right panel keep their full height beside it. It has a background halfway between the card surface and the page background (so it stands out from the cards) and a top border, its items are centered and wrap on a narrow area, and it stays visible in wall mode. Below 1040 px the page scrolls as a whole and the legend is the last thing on it, with extra padding. Three columns: left rail (252 px), main, right panel (340 px), with drag handles between them exactly as the mockup (limits 180–440 and 260–700, main ≥ 420, double-click or Home resets, arrow keys 16 px, Shift 48 px, widths remembered, handles hidden and panels stacked below 1040 px). **Collapsing.** The left pane, the right pane and the top bar each collapse and expand on their own, from a visible control and from a shortcut: `[` left, `]` right, `\` top bar, `w` wall mode, `Esc` leaves wall mode. The shortcuts are ignored while typing in a field, with ctrl, meta or alt held, and on a resize handle. A collapsed pane leaves a 24 px edge tab with an expand button (`aria-expanded`, `aria-controls`); its content is `hidden`, so it is out of the tab order and the accessibility tree, and its saved width comes back when it opens. A collapsed top bar leaves a 4 px strip with a Show top bar button, and takes the info banner with it. The disconnect alert never collapses: with everything collapsed, a lost connection still shows the red "Lost the connection…" alert (and a red strip), and reconnecting clears it. The collapsed flags are remembered in `localStorage` under `podium.collapsed`, apart from the widths. Below 1040 px the panes are stacked, so the control collapses the stacked section to a one-row tab, and the Wall mode button is hidden. **Wall mode.** A Wall mode button (in the top bar, or in the upper right corner when the top bar is collapsed) collapses all three at once and asks the browser for fullscreen from that click only; a refusal changes nothing. It is left with `Esc`, the Exit wall mode button, or the browser leaving fullscreen, and each pane returns to its state from before. Wall mode is not remembered, so a reload comes back out of it. After 4 seconds without pointer, touch or key activity the cursor and the wall mode buttons hide (never while the pointer is over one), and any activity brings them back; `prefers-reduced-motion` removes the transitions.

**Left rail footer.** The bottom left corner of the rail holds a footer: "Theme credits" (links to `docs/THIRD_PARTY_NOTICES.md`), "License" (links to `LICENSE`) and the copyright line. It collapses with the rail.

**Left rail.** "All orchestrators" item and one item per live session: status dot, name, blowout badge, model chip, plan bar and `done/total`, running/total agents. Red left edge when blowout level is 2. Follows the current sort. Rows enter and leave with the mockup's animations (respect `prefers-reduced-motion`).

**Fleet wall (default view).** KPI tiles: orchestrators live, subagents running (the number running, forks included, and nothing beside it), context blowouts, plan steps done, est. cost today (sparkline), tokens in the last minute (sparkline). Toolbar: status segments All / Running / Waiting / Stale / Blowouts; a Sort menu (Status, Model, Context blowouts, Context used, Cost, Newest); a text filter over name, project and branch; "N shown · M cleared today". Cards are never narrower than 360 px and stretch to fill the row. The wall holds as many 360 px cards, 12 px apart, as fit in its own width, at most four and never more columns than there are cards (four from a 1476 px wall, three from 1104, two from 732, otherwise one); a lone card is half the wall when two columns fit and the full width otherwise. Rows after the first keep the same column width, so a short last row stays left-aligned (five cards on four columns are 4 + 1). In the People and Group views every band uses the same columns, worked out from the total cards shown, so bands line up. The columns are recomputed whenever the wall's width or the number of cards changes, so collapsing or expanding a pane or the top bar, dragging a pane, or entering Wall mode can change the columns and the card width (#145). This applies to the fleet wall only, not History, the agent tree or Admin. Cards per session (#144, `mockup/podium-card.html`) are four layers in a fixed order, divided by hairlines, with the content padding unchanged at 12 px. **1, who and where:** a state shape, the name, the model chip and the effort meter (see below); the owner line in the People view; the project path (one line, shortened from the front when too long, full path as its tooltip); the git line (branch icon, worktree chip or dashed "main checkout" chip, ahead/behind arrows, modified count or "clean"; the branch is one line ending in an ellipsis when too long, with the full name as its tooltip, and never wraps mid-name; other git chips move to a second line whole when the line is full); then small tags, only when they apply: "nobody attached" and "hides in", "settings hooks", and the reporter version warning. **2, what it is doing:** the plan title, current step (the first pending step when none is active, #179) and progress bar, or "No plan reported. Agents were launched ad hoc."; the agent strip (square per agent, filled by model color; circle for a fork; faded when done; red outline when failed; dashed when queued; blinking when running) with its running, done and failed count and the tokens-per-second sparkline at its right end. **3, cost and health:** four readouts in fixed columns, Cost, Tokens, Time and Context; Context carries a thin bar and the blowout badge. A level 2 blowout adds the red card edge and turns the context figure red; its sentence ("Context exceeded N× ...") is the Context readout's tooltip and the orchestrator page's callout, not card text. **4, the status band:** always the last thing in the card, full width to the card's edges and the same height on every card, so cards in a row end on one line. It holds the state shape and one sentence: "Running", "Done", "Waiting for your input." or "Waiting for your approval.", "Waiting for 1 background shell to finish." (blue, with the dashed-ring clock shape), or the heartbeat-lost line. States that want the person (waiting) or say the session is lost (heartbeat lost) get the heavier tint; running, done and background waits get a light tint. Every band has the same thin top line. A heartbeat-lost card has its Remove button as its own element at the right end of the band, so the changing countdown text cannot move it; the band's text keeps clear of it. A countdown under a minute has no space before its unit: "Goes away in 55s." The state shape beside the name is the same shape as in the band, so state is never carried by color alone. Empty states with an instruction, never a blank panel.

**Admin layout (#143, `mockup/podium-admin.html`).** Admin has a grouped side menu on the left that runs the full height and one page at a time on the right; the menu and the page scroll on their own. The menu is `<nav aria-label="Admin sections">` of buttons, the current one `aria-current="page"`, in three groups: People and access (People, Groups, Reporters), Server (Settings, Model prices, Reporting and security) and Activity (Spend, Admin log). Each group has a heading (#244, `mockup/podium-admin-menu.html`): a small outline icon, the group's name at 18 px (16 px from 761 to 1280 px of viewport, where the rail is 224 px and 18 px would wrap "People and access") in the primary ink and a rule under it, with the groups 24 px apart; no color is used, since color means model and status. A list's page shows its count as a badge once it has loaded. Lock Admin and "Locks after 10 minutes without activity." sit at the bottom of the menu, under them the left rail's footer (Theme credits, License, the version and the copyright; the version comes from `GET /api/admin/session`), and the footer shows on the lock screen too. Below 760 px the menu is a scrolling strip above the page, the group headings show only their icon and a hairline sits between groups, the footer moves to the bottom of the page, and tables scroll inside their panel. Every page is the same stack: a header (an H1 and a one-line lead), then sections, each an H2 with an optional one-line help above one panel. A token shown once sits above the header of whichever page is open until the owner says it is saved. **People** has **Create user** (a Name field and a **Create user** button; the token it makes is shown once) and then **Reporting people** (a **Search people** label with its field to the right, the table, whose Token column names each token as `pdm_<key id>`, as the Reporters page does, and never shows any of the secret (#218), the pager). **Groups** has **Create group** and then **Manage groups**. **Spend** (#239, `mockup/podium-admin-spend.html`) has one section, **Spend today, by person** (or **by group**), whose lead says it is estimated from tokens, not a bill. Its panel has a toolbar with **Group by** (People, Groups) and **Show as** (Chart, Table) and, at the right of that row, the total spent and the live session count; then the list; then the pager with its usual sizes. The list is largest first and counts what was spent since midnight on the server, live or ended sessions (the same rule as "Est. cost today"), so a person whose sessions ended today still has a row but no band on the wall. A chart row is a monogram, the name, the person's group, a bar in a neutral ink (never a hue: hues mean model and status), the amount and the share; the table has person (or group), group, live, spend and share, and a Total row. The total, the live count and the Total row cover everyone, whatever page or page size is showing. The numbers are the fleet stream's (`kpis.costTodayByOwner` and the live sessions) paged in the browser; the page's Group by, Show as and rows per page are remembered in `localStorage` under `podium.adminSpend`, read and written with try/catch. Only an Administrator opens Admin, but the same numbers are in the fleet stream, so this is a place for the view, not access control. Names are untrusted text and drawn as text nodes. Every search is a label with its field to its right, alone in the table's toolbar, and every list ends in the pager (range, Rows per page, Previous, Next). Every on/off setting is a switch row: name, id when it has one, a one-line description and On/Off. Buttons are 30 px tall and 26 px in a table row, a panel has at most one primary button, a confirmation is inline in the row, and an error says what failed. Spacing steps are 4, 8, 12, 16, 24 and 32 px. The theme picker stays in the info row under the top bar.

**Feature flags (#118, `mockup/podium-feature-flags.html`).** Admin > Settings starts with a "Feature flags" group, above the wall notices, with the hint "Turn a feature off for everyone on this server. A flag that is off hides the feature in the console and stops its data. New features that can be switched off appear here." It has one switch row per flag, in the same style as a notice's row: the flag's name, its id in mono beside the name, a one-line description and On/Off. The flags are **Agent activity feed** (`activity-feed`): "Shows an agent's recent tool calls and text in its panel while someone watches. Needs the reporter's activityFeed option on the machine as well. Nothing is kept after the panel closes.", and **Respond from Podium** (`respond`, #206, 7.7). Flags default to on, except `respond`, which is off by default, live in the server's `settings` table (`feature.<id>`), apply to every browser, survive a restart, and each change is written to the admin log (`feature_changed`). The console gets them in `StateBody.features` and a change as a fresh snapshot. A later flag adds one entry to `FEATURES` in `server/src/fleet/featureFlags.ts`. What turning the activity feed off does is under *Activity* below and in 6.4.

**Responding (#206, `mockup/podium-respond.html`).** The mockup is the specification: every string, frame and placement in it is literal, and this paragraph is only a map of it.

- **Respond** sits at the right end of the amber waiting band, on the fleet card and on the orchestrator page's status band, with the reply icon and, for a question, the number of questions in the ask. It shows only while the session waits on its person with an open ask whose kind the session accepts (or, idle, with `message` in `accepts`), and only while `features.respond` and `features["activity-feed"]` are on and `GET /respond/me` says responding is enabled. It is never on a blue band (waiting on background work). It is gone when responding is off and when the reporter can't answer (`respond` null, or the ask's kind removed by `limits`). Signed out, it is live on every waiting card, since Podium doesn't know whose sessions are yours. Signed in, on a session that is neither yours nor answerable as an Admin, it is dimmed, with "<Owner>'s session" beside it and the tooltip "Only <Owner>, who owns this session, or an Admin can respond." The card's own click target is unchanged.
- It opens the existing Activity modal (#118) on the orchestrator's main loop. The modal gains the answer panel between the feed and the message box, and the message box at the bottom. Expand on the orchestrator's Activity panel opens the same modal, so a message can be sent while the session runs. The panel's content comes from `GET /respond/sessions/:id/asks/:askId` and is fetched again whenever the session's `asks[].state` changes. Section 3 of the mockup has every case, grouped as signing in, a question, plan approval, a tool permission, its turn ended, and when Podium can't send the answer.
- **Signing in.** Signed out, Respond opens the modal with the feed and the sign-in form (Name, Token, Sign in) in the answer panel, and no message box. The top bar's far end, after a divider that follows History, Hide top bar, the wall mode button and Admin, has **Sign in**, which opens a small Sign in dialog with the same form; signed in, that spot shows "Signed in as <name>" and **Sign out**. These go after the spacer, at the end of the bar, so the controls before them don't move; nothing is added next to the connection pill. A wrong pair, an empty field, the lockout and a sign-in that ended show the mockup's messages. The page never keeps the token.
- **The feed.** An answer, message or command sent from Podium is a feed entry: "You, from Podium:" for the signed-in person's own, "<Name>, from Podium:" (for example "Alex, from Podium:") for someone else's, with the mockup's notes, such as "(queued until the session is idle)". The server adds these entries to the loop's in-memory feed (6.4) when it takes the delivery and updates them when the mod reports its result; they follow the feed's lease rules and are never stored.
- Admin > Settings > Feature flags has the **Respond from Podium** row (7.7), off by default.

**Wall notices (#114, `mockup/podium-wall-notices.html`).** Informational notes about the wall sit in one stack at the bottom of the wall, below the cards, one per row. Each has an X (accessible name "Close notice: <name>"); its action link, if it has one, stays in the note. Closing a notice turns it off for everyone (`POST /api/fleet/notices/:id/close`) and shows a confirmation, bottom right, that names the notice and links to `#/admin/settings`; it clears itself after about 9 seconds and has its own X. Errors and connection problems are not notices: they keep their place and have no X, and so does the short status message at the top of the main column that clears itself after 6 seconds. The switches live in Admin > Settings > Wall notices, one row per notice (name, one-line description, On/Off), stored in the server's `settings` table and sent to the wall in `StateBody.wall`, so they apply to every browser and survive a restart. A change reaches open tabs through the `wall` stream event. All notices default to on. The only notice today is the background-sessions note; a later notice adds one entry to `NOTICES` in `server/src/fleet/wallSettings.ts` and one to the stack in `Wall.tsx`. Whether background sessions are shown is a separate server setting (`StateBody.wall.showBackgroundSessions`, off by default), switched in Admin > Settings > The wall or by the note's Show them / Hide them link, so turning the note off never removes the way to show them.

**Model prices (#117, `mockup/podium-model-prices.html`).** Admin > Model prices, its own page since #143 (under Server, after Settings). A sentence says the figures are US dollars per million tokens, that changing one changes today's cost everywhere at once, and the date of the built-in sheet. One table: a row per model (the built-in rows in the sheet's order, then the models the Admin added), with five price columns: Input, Output, Cache read, Cache write 5 min, Cache write 1 hour. Haiku 5.5 is two peer rows, both named `Haiku 5.5` with the prompt size under the name (`Prompts up to 100,000 tokens`, `Prompts over 100,000 tokens`), joined by a dashed divider while a full divider separates models. Each price is a text box with a number keyboard and an accessible name such as `Sonnet 5.5 cache write 1 hour`. A box whose value differs from the saved one has an accent border, and the row shows Cancel and Save (a row with no unsaved edit shows nothing). A saved row that differs from the built-in price shows a Changed tag, a note with the built-in input price and a Reset to built-in button; an Admin-added model shows an Added by you tag and a Remove button. A value that is empty, not a number, negative or over 1000 is refused on the row with a message that names the price (`Output must be zero or more.`), the box is marked `aria-invalid`, and nothing is sent; a refusal from the server is shown the same way. Above the table, an **Add a model** section with a **Model id** field and an **Add model** button adds a row with empty boxes (all five must be filled before Save), and refuses an id already in the table. A saved change reaches every open browser as a fresh snapshot.

**People view (#34, `mockup/podium-people.html`; the controls row #245, `mockup/podium-wall-controls.html`).** It appears once any live session's `owner` is a person (not `Admin`, not null); until then the wall, the rail and the right panel are exactly as above. Then the wall's one control row, the same row as the status filter, Sort by and the text filter, gains an outlined **People** cluster (#245): **Group by** (People, Group, All, and Me while a person is signed in) and **Order by** (Needs attention, Spend, Name; hidden for All and Me). Order by orders the bands and Sort by, beside the filter, orders the cards inside each band; their tooltips say so. The row gives way in a fixed order as the wall narrows, measured on the toolbar's own width and never hiding a control: below about 1470 px the caption "N shown · M cleared today" becomes an info icon whose tooltip and `aria-label` carry the same words; below about 1300 px the cluster takes its own line under the filter row, so the row is never more than two lines; below about 651 px the buttons and the Sort by menu tighten; below about 635 px the cluster's "People" label is dropped; below about 599 px the text filter gives a little more. With the people view off the row is the plain toolbar and keeps its caption in words. People are derived from live sessions only: a person whose sessions all leave has no band. *People*: one band per owner, keyed by the name, so one person on two machines is one band. A band header is a button that collapses the band to its header (`aria-expanded`, "N hidden") and shows a monogram (one or two initials in a neutral circle; a person never gets a color, because color means model and status), the name, a "you" tag for the viewer, the person's group as a chip, the machines the person's live sessions run on, "N live", the waiting and stale counts in amber, and the person's share of today's estimated spend (`kpis.costTodayByOwner` against `kpis.costToday`) as an amount, a percentage and a neutral bar. Sessions reported with the admin secret are the **Admin** band and sessions with no owner the **Unassigned** band, always after the people. Each card in a person's band gets a line with its machine (`machine.name`, plus the first four characters of `machine.id` when one person has two machines with the same name). *Group*: one band per group from Admin holding every member's orchestrators, each card naming its owner; a group with no live session has no band, and people with no group, Admin and Unassigned are under **No group**, last; the viewer's group is marked "your group". *All*: the flat wall, each card naming its owner (called None before #245). *Me*: offered only while a person is signed in to the console (7.7; `GET /respond/me` with a name that is not `Admin`); a flat wall of just that person's orchestrators, each card naming its machine but not its owner, ordered by Sort by. A remembered Me with nobody signed in falls back to People until someone signs in. Cards inside a band follow the Sort menu and the status and text filters, and a band with nothing left to show is hidden. *Needs attention* puts the signed-in viewer's band first, then the most waiting plus stale, then the most spend; *Spend* is most spend first; *Name* is alphabetical. The left rail groups the same way: a header per band (monogram, name, you tag, attention count, orchestrator count) is a toggle that narrows the wall and the rail to that person or group, and **All orchestrators** undoes it (the wall's control row no longer repeats that with a "Showing X" line); for Group, All and Me each rail row carries the owner's monogram. The right panel on the wall is the activity list alone; spend by person or group is on Admin > Spend (#239, above). Group by, Order by and the collapsed bands are remembered in `localStorage` under `podium.people`, read and written with try/catch. Who "me" is comes from the browser's sign-in, the same one Respond uses, so it exists only while the Admin's respond and activity-feed flags are on and someone is signed in; signed out, or signed in as `Admin`, there is no Me, no "you" tag and no viewer's band first. #245 retired the "You are" picker, "Only me" and the `podium.me` key; a stale `podium.me` is ignored. Names and machine names are untrusted text and drawn as text nodes.
**Reporters page (#142, `mockup/podium-reporters.html`).** Admin > Reporters, under People and access after Groups, with the number of reporters as its badge. Admin only, like the rest of Admin. A strip of five buttons (**All reporters**, **Reporting**, **Idle**, **Silent**, **Not since restart**), each with its count from `counts` and a tooltip with the state's definition (a row's own state is a focusable element whose tooltip adds when the reporter was last heard and, for Not since restart, when the server started and that the server cannot tell whether the reporter still runs; "no name set" under an unnamed reporter's name explains the same way and is also in the detail), filters the list (`aria-pressed`). Under it, a **Search reporters** label with its field to the right, which searches machine, person, address, machine id and version after a 250 ms pause. When any reporter uses the admin secret, a warning band under the strip says how many and has **Show only these** (**Show all reporters** to undo; `aria-pressed`). The table has State, Machine (with its machine id, or "no machine id, matched by address ..."), Person ("Admin" for the admin secret), Token (the token's key id, or an **Admin secret** badge with a warning icon, in the warning color and with a tooltip, focusable, that says what is wrong and to make a token for the person in Admin > People), Reporter version (a warning with "outdated" or "newer" beside a version outside the supported range, "no mod" for the settings hooks), Last report ("3 h ago", counted from the server's `serverTime`) and Sessions (with "N live"); the headers sort (`aria-sort`), it is paged like the other Admin lists, and there is no note under it: what Silent and Not since restart mean is the tooltip on the state chip and on the strip button ("Silent means the server has not heard from this reporter for a while. It does not mean the reporter is turned off: Podium can only see what arrives." and "Not since restart is what every reporter reads after this server restarts, until it reports again. Most rows show it for a short while after a restart; it does not mean they stopped."), and how an unnamed reporter is named and matched is the tooltip on "no name set" (#181). The list and an open detail ask the server again every 10 seconds while the page is visible, so a reporter that stops moves to Silent without a reload. Each row has a checkbox, and the header box selects the page; when more rows match than fit, a line offers **Select all N that match** (sent as `match`, so it reaches past one page). A bar above the table, always there so the rows do not move, reads "Tick reporters to remove many at once." until a row is ticked, then shows **N selected**, **Remove N…** and **Clear selection**; removing asks "Remove N reporters from the list? They come back if they report again, unless ignored. Their sessions are not touched." with **Remove N reporters** and **Keep them**. With a state chosen, **Remove all <state> (N)** beside the search asks the same. **Remove from list** has a tooltip that says what it does and does not do: it takes the row away and nothing else, the sessions stay, and the reporter comes back the next time it reports (#181). After the reporters section, **Ignore rules** is its own section (a heading, a help line and its own panel, like the other Admin pages) that lists each rule (what it matches, the pattern, when added) with **Remove rule**, says a matching reporter is refused and its sessions stop appearing until the rule is removed, and has a form (**Rule matches**, **Pattern**, **Ignore matching reporters**). A reporter's detail has **Ignore…**, which sits at the right of the header beside **Remove from list** (the name and state stay on the left; #247). Its label ends in an ellipsis because it opens a choice before anything happens, and its tooltip says so. It offers this reporter only, everything from its address, or every reporter on its version, and says its reports are turned away. Admin > Settings has **Forget old reporters** (off by default) with a **Days** box (30 by default). Selecting a row opens its detail in place with an **All reporters** link: a header with the name, state and **Remove from list** (which asks "Remove X from the list? It comes back if it reports again. Its sessions are not touched." with **Remove reporter** and **Keep it**), and, for a reporter on the admin secret, a warning callout, **This reporter is using the admin secret**, with the three steps to fix it (make a person in Admin > People, run `/plugin configure podium-reporter`, enter `token` and `userName`), then **Reporter** (version, compatibility, Claude Code version, first seen, last report, sessions seen with a tooltip) and **Where it comes from** (machine, machine id, source address, person, token as `pdm_<key id>` or "admin secret", with a tooltip saying the secret is never shown). Below the details, **Recent sessions** and **Reports the server turned away** are each their own section with a title, a help line and a panel, like the other Admin pages (#188). Recent sessions has the shared pager (**Rows per page** 25, 50 or 100, 50 by default, **Previous**, **Next**), so every session the server still holds for the reporter can be reached; the turned-away list is not paged, since the server keeps at most 20 per reporter. Explanations sit in tooltips (`title`), shown with a dotted underline. A reporter removed while its detail is open shows "That reporter is no longer on the list." Machine names, addresses and refusal reasons are untrusted text and drawn as text nodes.

**Effort meter.** Wherever effort appears (cards, facts bar, agent tree, agent panel) it is five small bars with no text: one bar lit for `low` up to five for `max`, so the count carries the level and color is never the only signal. Lit bars are colored by level: low orange, medium green, high blue, xhigh purple, and max one rainbow color per bar. The level is the meter's tooltip and accessible name ("Effort: medium"). When effort was not reported, or is not one of the five levels, the bars are dimmed and the tooltip says "Effort not reported".

**Orchestrator page** (click a card or rail item; #165, `mockup/podium-orchestrator.html`). The header, the facts and a status band are one bordered surface, in this order: the header, then (only when the session has context blowouts and its Blowouts cell is open) the blowout detail, then the facts, then the status band as the last row. Header block (name at 28 px beside the state shape, which is the status band's shape, goal line = plan title and current step; with no step active, the first pending step is shown as the current one marked "(inferred)", and "plan complete" when every step is done (#179), working directory and session id, git line) on the left and three charts on the right (tokens per second, peak context with a dashed 100% line and red blowout markers and a "N blowouts in 60s" caption, subagents running), each with a crosshair and a value readout on hover. The three charts are equal in height and fill the height of the header row (#197): each chart's title and readout stay at the top, "60s ago" and "now" stay at the bottom, and the graph takes the space between, never shorter than 46 px and with no maximum. Gridlines, the 100% line, blowout markers and the crosshair scale with the graph. Off the chart, the readout of peak context and subagents running is the newest second; the tokens-per-second readout is the average of the newest 10 seconds (#191), because tokens reach the server in bursts and the newest second alone is usually 0. Its tooltip says "Average over the last 10 seconds". A facts grid of eight cells in fixed places, four to a row (two columns at 520 px and narrower, by the page's own width): agents (running, done, and a red "N failed" button that opens the first failure; the orchestrator counts as an agent, running while the session runs, done once it is done, and neither while the session is stale), est. cost (the session's ledger), tokens, running for (wall-clock time), agent time (the orchestrator's time plus every agent's own, which can be longer than running for when agents run at once), **Reporter** (#124: `reporterVersion` as given, such as `0.11.0`; "Settings hooks" when it is null, with the hooks note as its tooltip; when `compat` is `outdated` or `newer`, the card chip's wording without the leading "reporter", for example `0.3.0 · update`, in the warning color, with the same tooltip text as the note, taken from the same `versionNote` so the card and the bar never disagree), **Blowouts** is always present: "none" when clear, otherwise the count with a warning shape, amber at level 1 and red at level 2, and a button (`aria-expanded`, `aria-controls`) that opens and closes the blowout detail (the sentence and each affected loop as a link), closed by default; a level 2 blowout also gives the whole surface the card's red top edge. **Resume** is a quiet whole-cell control, "Copy command" with a copy icon (the label **Resume**), with the behavior of Copy resume command below, and its fallback field opens inside the cell. Row one is Agents, Est. cost, Tokens, Running for; row two is Agent time, Blowouts, Reporter, Resume. The orchestrator's model, effort and context are not in the bar; its row in the agent tree shows them (#109). **The status band** is the last row of the surface, full width, at least 58 px tall, with one bold line and an optional detail line, and it replaces the status chip beside the name and the waiting, background-wait, heartbeat-lost, hooks and reporter-version callouts. It uses the card band's states, shapes, sentences and tints (`cardKind`): running "Running", done "Done", waiting the wait sentence with the detail "Answer in its terminal." and what it waits on, a background wait its sentence with the task description as the detail (tooltip: the full text), heartbeat lost "No heartbeat for 0:38. Goes away in 37s." with the detail "The session may have crashed or been closed without a clean exit." and a **Remove now** button laid over its right end as its own element (only for a viewer who can remove). Waiting and heartbeat lost get the heavier tint. **Delegating** (#98, #287) shows here and on the card, the rail item and the wall: "Delegating to N agents." with the blue ring shape, naming the agents (the card carries the sentence and lists the agents in its tooltip; the page adds them as the detail line). Failed agents do not change the band. Two columns: the plan section and the agent tree. The plan section is a tab list, **Plan** and **Files** (arrow keys, Home and End move between them; Plan is selected first and the choice is not saved). Plan is the checklist (done, active, blocked, pending, with owner label), under a progress bar that a hairline separates from the first step (#200). Each state has its own mark, so shape carries the state as well as color: a green circle with a check for done, a ring with a filled dot for in progress, a ring with a slash for blocked, an empty ring for not started; with no step active the first pending step gets a dashed ring and the note "up next · inferred" (#179), display only, never sent to or from the reporter. A plan of more than 10 steps shows 10 at a time with the same pager as Files under the list ("Showing 1–10 of 23", the page buttons; none for 10 steps or fewer, #214); the count beside the tabs and the progress bar cover the whole plan, not the page, the panel opens on the page holding the current step, and a plan that changes keeps the page being viewed unless it no longer exists. The plan panel does not say where the steps were read from. Files, from `session.files`, lists every file the session changed, committed or not: the file name in bold over its folder, a letter for the status (A, M, D, R) with the word for screen readers, and the signed counts (`+12 −3`, the word `binary` for a binary file), with a five-block bar beside them (green for the share of added lines, red for the rest) that carries no numbers. A summary line above the list gives the file count and the totals (`6 files · +855 −145`), the list shows 20 files a page, and the pager footer reads "Showing 1–20 of 47" with the page buttons (previous, numbered, next) once there is more than one page, and "20 per page" when there is not (#200). A footer says when the reporter cut the list (`Listing the first 200 of 340 files.`) or when the starting commit is gone and the diff is against the upstream or the working tree only. With no files the tab says `Files will appear here once a file has been updated.`; when the reporter is older than 0.6.0 or the session is hook-only, a note under it says to update the mod. The tab label carries the count (`Files 3`). While Files is selected the left column is 400 px wide instead of 300. The agent tree (indented guides, the agent marker (#141), task, type, model chip, effort meter, context bar (amber from 75%, red from 80%) with blowout badge and red stripes at 2+, tokens, cost, time, status chip, inline failure class). The marker at the start of a row is the same one the card's agent strip draws: a square in the agent's model color for a subagent, a circle for a fork, faded when done or aborted, outlined red when failed, dashed and unfilled when queued. In the tree it has a 1.5 px border, the model color mixed toward the theme's ink so it follows light and dark (dashed in the model color when queued). It is not a stroke icon, so it never reads as an empty box, and it is decorative: the status chip carries the state. The legend's "Square color is the model" holds for the cards and the tree rows (the legend's own swatches are grey). The Kind row of the agent panel keeps its own icons. A column header sorts the tree: the children of each parent, and the top-level agents, are ordered by that column, and every child stays under its parent at every depth (#101); clicking the same header again reverses it, and **Launch order** clears the sort. The full task and type are each row's tooltip. Selecting a row opens the agent panel; the selected row keeps a highlighted background and does not flash. The orchestrator's own row is selectable too and opens an orchestrator panel (name, status, model, effort, context with blowout badge, tokens, cost, time, git line, and from `session.loop` the steps, tools used and skills loaded, laid out and worded as in the agent panel). The orchestrator's tool counts cover its own calls, not those of the agents it launched. When the reporter sent no `session.loop` (a mod older than 0.4.0), those rows are left out rather than shown empty, and one note under the facts says they need podium-reporter 0.4.0 or later, as the agent panel does for tool counts. A settings-hooks session has no mod, so it shows neither the rows nor the note.

**Agents that launch agents (#101, `mockup/podium-nested-agents.html`).** A subagent or a fork can launch its own agents (5.3), and every place that lists or counts agents treats them like top-level ones. The agent tree nests each under its real parent at any depth; each level past the second widens the Task column by one 16 px guide (a `--deep` custom property on the table), and the table scrolls sideways inside its own box, so a deep row keeps as much room for its task as a second-level one and no guide is dropped. The tree's caption says how many were launched by other agents ("6 launched, 4 by other agents"). Cost: an agent's row is its own estimate; the facts bar and the card are the session's ledger, which includes every agent once at every depth; the orchestrator's row and panel are its own share, the ledger less each agent's estimate (never below zero), so the rows add up to the facts bar (#109); each says so in its tooltip, and the Cost header's tooltip says both. Tokens add the same way (5.6). The agent panel has a **Launched by** row (the parent's task as a button that opens it, or "the orchestrator") and, for an agent that launched any, **With its agents**: its own estimated cost and Tokens figure plus those of every agent under it, each counted once (a parent cycle cannot loop), with the count of those agents and how many are not priced. The card's agent strip is in tree order, and a nested agent's square names its parent in its tooltip. The rail, the facts bar and the card count every agent once and the orchestrator as one more (#109); the wall's "agents running" tile counts agents only, since "orchestrators live" is beside it. A spawn row in the activity feed for a nested agent ends with "· launched by <parent's task>" and opens that agent. A plan step can be owned by a nested agent like any other. The Files tab lists the session's working-tree changes and names no agent, so changes made by nested agents are in it. A settings-hooks session has no parent ids (5.3): its agents are all at the top level and its note says so.

**Delegating (#98).** In the agent tree, the page header and band, the fleet card (and so the wall) and the rail item (#287), a row whose own status is `running` and that has at least one running direct child reads **delegating** instead of "running", in a blue ring-dot style that is not amber (amber and the word "waiting" mean the session is waiting on the person). The orchestrator's children are the agents with no parent, or whose parent is not in the list; an agent's children are the agents whose `parentId` is its id. Hovering the chip lists the agents it is waiting on ("Waiting on 2 agents: A, B. Not waiting on you."), and the same text is its accessible name. It is derived in the browser from `agents[].status` and `parentId` only: it is not a session status. The card, the rail item and the page all take it from one function (`stateKind` over `waitingOnByRow`), so they cannot disagree. On the card the band reads "Delegating to N agents." in the blue style with the ring shape beside the name; on the rail item the dot is the blue ring and the screen-reader text is "delegating". A delegating session still counts as running in the status filter, the sort order and the KPI counts (live, running, waiting), because the server status is still `running`. When the session itself is waiting, stale or done its own status shows, and when its last running child finishes the card and the rail item go back to "Running". Podium cannot tell a foreground launch from a background one, so an agent launched in the background reads as delegating while it runs. The color is the `--deleg` and `--deleg-text` tokens, defined in every theme and mode and checked by `scripts/theme-contrast.ts`.

**Waiting on a background process (#119, `mockup/podium-background-wait.html`).** A session that ended its turn but has background work in flight (a shell, a monitor, a background agent or a workflow) or a scheduled wake-up is not waiting on the person. Its card, rail item, orchestrator page's status band and activity row read "Waiting for 1 background shell to finish" (counts per kind when there are several; "Waiting for a scheduled wake-up at 14:30" for a wake-up; with both, "Waiting for 1 background shell to finish, and a scheduled wake-up at 14:30"), in the blue ring style of Delegating, not amber. It keeps its place in the Waiting filter, but is not counted in "waiting on you". The card carries only that short line, so a long task description cannot wrap it. The orchestrator page's band adds the task description after the line, as its detail row, cut at a character limit and ended with " ..." (a space, then three dots); the tooltip lists each task. The ring dot pulses like the running dot, on the same shared beat. In the activity feed the newest such row is tinted and outlined in blue with a kind pill, as a waiting row is in amber. A shell's command is shortened and redacted, and never sent whole. When the work ends the wording goes back to normal at once. "Waiting for your input" and approval waits are unchanged.

**Right panel.** *Activity*: newest first, **12 rows**, "Show 12 more" and "Show fewer", count text "Showing N of M", footnote "Only the latest 150 events are kept in memory." Each row is a button that selects the session and agent it is about, scrolls the agent row into view and flashes the whole row once (the only place a row flashes); failure rows say "Show root cause", blowout rows "Show context history"; rows of sessions that have left the live set are greyed and say "Session ended" and do nothing. Filtered to the selected orchestrator when one is selected. *Agent detail*: status, **failure box** (class, failing call, output tail, evidence list, explanation if present, what happened next), **blowout box** (timeline of each overflow with time and token counts, explanation), kind, type, model and effort (marked "inherited" for a fork), context, tokens, cost, time, steps, **tools used** as chips (below), skills as chips, a **Report** group, an **Activity** section (below), child agents as buttons ("Launched by this agent"), back button. It also has a **Launched by** row and, for an agent that launched any, a **With its agents** row (see "Agents that launch agents" above). *Report group*: two buttons, **Task prompt** and **Final answer**, each with the length of the text (`1,842 chars`). A button is enabled only when there is text for it. Without the full text it falls back to the 400-character excerpt and says `excerpt only`; with neither it is dimmed, dashed and inert and says `not reported`, and for the answer of an agent that is still running `not finished`; it turns on when the answer arrives, without a reload. A click opens a centered modal (`role="dialog"`, `aria-modal`, labelled by its title) with the text rendered as markdown (headings, lists, bold, italic, inline code, fenced code, block quotes, links; a fence closes only on a fence at least as long as the one that opened it, and a link's address may hold one level of balanced parentheses), the rest of the page blurred behind it. The renderer builds elements only: raw HTML in the text shows as text, and a link opens in a new tab with `rel="noopener noreferrer"` and only for `http:`, `https:` and `mailto:`. The modal closes with the X, Esc or a click on the dimmed area; focus moves in, Tab stays inside, and focus returns to the button. While it is open the page behind gets no keys (Esc does not leave wall mode). A **Copy** button copies the raw text. When only the excerpt is shown a note says so: for a mod older than 0.10.0 it says to update, otherwise it names the `fullPrompts` option. The full text is fetched when the modal opens; if that fails the modal shows the excerpt and says so. *Activity* (#118, `mockup/podium-agent-feed.html`): under the Report group of the agent panel, and under the git line of the orchestrator panel, the loop's recent tool calls and the text it writes (6.4), newest at the bottom, at most 20, each row with its time since the loop started (`01:22`, the clock time as its tooltip), an icon for its kind (tool call, text, reasoning) with the kind as its accessible name, and the text: a tool call's name in the delegating blue followed by its argument summary in mono, text in the secondary ink, and each `[redacted]` the mod put in marked in red. The list follows the newest entry; scrolled up, it stops following and a **Jump to latest** pill brings it back. The header has an **Expand** button (`aria-haspopup="dialog"`) and, while the loop runs, a **Refresh every** dropdown (5s, 10s, 20s, 30s, 60s; default 5s; remembered per browser in `localStorage` under `podium.activityEvery`, with try/catch). The panel fetches `GET /api/fleet/sessions/:id/agents/:agentId/activity` (7.1) at once and then on that interval, only while the panel or its modal is open and the tab is visible; each fetch renews the server's lease. A viewer sees only what arrived after their first fetch, so it starts with "Watching from now. Earlier activity is not kept, and nothing is kept after you close this." Under the list, in one row that keeps its height whatever the text says (each text on one line; the count is cut with an ellipsis and carries its full text as a tooltip; the time reads "Updated Ns ago" from the first second, never "just now"): "Last N of M since you started watching" (or "Nothing yet") and "Updated Ns ago"; then the line "Kept only while someone is watching. Closing this clears it. Secrets are removed before they leave the session." A finished agent (or an ended session) is fetched once more for its last entries, offers no dropdown, and says "Agent finished, no more updates". Expand opens the same feed, larger, in the console's modal, with the same blur, Esc, X, click-outside, focus trap and focus return as the Report modal (one shared `Modal` component), and the dropdown in its header; it shares the panel's fetching. When the option is off (`activityFeed: false`), a dashed note says "Recent tool calls and text appear here while the agent works." and names the `activityFeed` option (Send an agent's recent activity) and the 300-character cut; nothing is fetched. For a mod older than 0.13.0 the note says to update instead. When the Admin has turned the feed off (the `activity-feed` flag, *Feature flags* above), the section shows a dashed note instead, "The activity feed is turned off by the Admin." with "Someone with Admin access can turn it back on in Admin > Settings > Feature flags. Nothing is fetched or kept while it is off.", and no list, no Refresh every dropdown and no Expand button; an open modal shows the same note. This note takes the place of the reporter-option and update notes when both apply. The panel learns it from `StateBody.features` and from the route's `enabled: false`; while the panel is open it keeps asking the route on its interval (no lease is taken while the flag is off), so the feed starts again by itself, empty, when the flag is turned back on. A settings-hooks session has no mod and shows no Activity section. *Tools used*: one chip per tool with its call count, most used first and ties by name, in the Skills chip style, under the label "Tools used (N calls)". The five most used show; with more, a "Show all N" button (`aria-expanded`) shows every tool and then reads "Show fewer". A green dot on a chip marks the tool used last (with a visually hidden "last used"); when that tool is not among the five shown, a line "Last used: name" says so. An agent with no calls shows "None seen". When the reporter sent no `toolCounts` (older than 0.2.0), the panel shows the "Last tool  name (N calls)" line instead and no chips. When that reporter is a mod below 0.2.0 (not a settings-hooks session, which has no mod to update), one note under the line says tool counts need podium-reporter 0.2.0 or later, gives the version the session reports and the update command, and points at `/reload-plugins`.

**Data flow.** `useFleet` loads `/api/fleet/state`, opens the SSE stream, applies `session`/`activity`/`removed`/`wall`/`tick` with a pure reducer, and on reconnect refetches state. Elapsed times tick locally every second from `startedAt` so numbers move between server messages. Memory: keep at most 150 events; keep `series` as sent.

**Copy resume command** copies `resumeCommand` with `navigator.clipboard.writeText` inside the click handler, catches rejection, and shows "Copied" for 1.6 s (or "Select and copy" fallback with the text selected).

### 8.2 Components (create these; split further only if a file passes about 250 lines)

`FleetApp`, `TopBar`, `Rail`, `Wall` (with `KpiStrip`, `Toolbar`, `SessionCard`), `People` (`Monogram`, `PeopleBar`, `Band`, `OwnerLine`), `Legend`, `FocusView` (with `FocusHeader`, `MiniCharts`, `FactsBar`, `BlowoutCallout`, `PlanPanel`, `AgentTree`, `AgentRow`), `SidePanel` (with `ActivityList`, `AgentDetail`, `FailureBox`, `BlowoutBox`, `ReportDocs`, `ActivityFeed`, `Modal`), `Chips` (`ModelChip`, `EffortMeter`, `StatusChip`, `BlowBadge`, `GitLine`), `Sparkline`, `ResizeHandle`, `PaneTab`, `useFleet`, `useActivityFeed`, `useResizable`, `usePanes`, `useHotkeys`, `useIdle`, `useTheme`, `usePeoplePrefs`, `useWallColumns` with `wallLayout.ts` (the wall's column count), `people.ts` (bands, ordering, the people filter, machine labels, spend rows), `format.ts` (`fmtTok`, `fmtUsd`, `fmtDur`, `fmtClock`, `shortenHome`). Pure logic (sorting, filtering, tree building, series to polyline points, reducer) lives in plain functions with their own tests.

### 8.3 Visual tokens (copy from the mockup's `:root` blocks; dark is the base, light via `prefers-color-scheme` and `[data-theme]`; the other themes are token sets keyed by `[data-theme-name]` and `[data-theme]`, shown in `mockup/podium-themes.html`)

Surfaces `#0d0d0d` page, `#1a1a19` card, `#222220` raised; ink `#f0efec`, secondary `#c3c2b7`, muted `#898781`; grid `#2c2c2a`, axis `#383835`. Model colors: opus `#9085e9` (light `#6250d6`), sonnet `#3987e5` (`#2a78d6`), haiku `#199e70` (`#1baf7a`), fable `#d95926` (`#eb6834`). In Podium's own theme the status colors are fixed: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`, and the delegating blue `#2fa4e0` (light `#0a7fb8`; text `#5cbcf0` and `#07608c`). An administrator's name in Admin > People (#182) uses the text color `--admin-text`, an orange (Podium `#bd7705`, light `#9b6104`), defined in every theme and mode, with a tooltip and a screen-reader label so color is not the only signal. Other themes may use their palette's green, amber, orange and red, which stay recognizable as those four, and their own blue or teal for delegating. Model colors may differ per theme but stay distinct from each other. Every theme meets 4.5:1 for text on its backgrounds and 3:1 for status and model marks (or Podium's own ratio in that mode where that is lower), checked by `scripts/theme-contrast.ts`. Status is always shown as icon plus word, never color alone. Fonts: Schibsted Grotesk (UI), JetBrains Mono (ids, numbers, paths). Body 13 px. Numbers use tabular figures. `prefers-reduced-motion` disables animation.

### 8.4 Accessibility and responsiveness

Every interactive element is a real `button`, `a` or `input`, with a visible focus ring. Resize handles are `role="separator"` with `aria-orientation`, `aria-valuenow`, labels and arrow-key support. The pane tabs and the top bar toggle report `aria-expanded` and `aria-controls`. Charts have `role="img"` with an `aria-label`; the same numbers are in text elsewhere. No horizontal scroll of the page at 400 px; the agent tree scrolls inside its own container.

---

## 9. Phased build plan

Phases run in order. Each ends with committed, passing, runnable work. Inside a phase, do tasks in the order listed unless a task says it is independent. **Commit at the end of each task** (conventional-commit style, matching the repo's history), on the branch you are on. Run `npm test` at the root before each commit.

### Phase 0: Contract and scaffolding

**Goal:** the shared contract exists as code and fixtures, and the workspace builds.

#### T0.1 Protocol types and fixture
- **Scope:** `server/src/fleet/protocol.ts`, `mod/podium-reporter/hooks/protocol.ts`, `docs/fixtures/report.sample.json`.
- **Depends on:** none.
- **Acceptance:**
  1. `protocol.ts` exports `Report`, `Plan`, `AgentReport`, `Failure`, `ActivityEvent`, `SessionView`, `AgentView`, `ActivityView`, `Kpis` exactly as in sections 6.2 and 7.4, plus a hand-written `validateReport(unknown)` that returns `{ ok: true, report } | { ok: false, error, path }` and enforces every limit in 7.7.
  2. The mod's `protocol.ts` has identical type declarations (types only). A test in each project reads the sibling's file and fails if the interface text differs after whitespace normalization.
  3. `docs/fixtures/report.sample.json` is a full valid report with a running orchestrator, a plan with four steps in different states, one done subagent, one running fork, one failed subagent with a failure and one with two blowouts, and three events. `validateReport` accepts it.
  4. `validateReport` rejects: a missing `v`, `v: 2`, a non-array `agents`, an agent with an unknown `status`, a 600-char event text (clamped, not rejected), 201 agents (rejected), a non-object body.

#### T0.2 Repo plumbing
- **Scope:** root `package.json`, `.gitignore`, `server/package.json`, `frontend/vite.config.ts`, `scripts/`.
- **Depends on:** none (independent of T0.1).
- **Acceptance:**
  1. `.gitignore` ignores `data/` and `*.sqlite*`.
  2. `server/package.json` has `@types/node` at a version that declares `node:sqlite`; `npm install` at the root succeeds; `npm test` and `npm run build` still pass unchanged for the existing app.
  3. The Vite dev server proxies `/api` to the server port; the `/api/fleet/stream` proxy does not buffer (verify with the smoke script in T4.1).
  4. Root `package.json` gains scripts `podium:sim` (runs the simulator) and `podium:smoke`.

**Exit criterion:** `npm test` and `npm run build` pass; the fixture validates; both type files match.

### Phase 1: Server

**Goal:** a server that ingests reports, persists them, derives views, and streams them, proven by tests and the simulator.

#### T1.1 Database and migrations
- **Scope:** `server/src/fleet/db.ts` and its test.
- **Depends on:** T0.1, T0.2.
- **Acceptance:**
  1. `openDb(path)` creates the schema in section 7.2 on an empty file and is idempotent on an existing one; `schema_migrations` records versions.
  2. `:memory:` works for tests. WAL is on for file databases.
  3. Parameterized queries only. A test inserts a session name containing `'); DROP TABLE sessions;--` and the table survives.

#### T1.2 Ingest
- **Scope:** `server/src/fleet/ingest.ts` and its test.
- **Depends on:** T1.1.
- **Acceptance:**
  1. Ingesting the fixture creates one session, all its agents, its events and its blowout rows.
  2. Ingesting the same report twice changes nothing but `last_seen_at` (idempotent), including event count and blowout count.
  3. A later report that omits a previously reported agent keeps it. If the session ends `done`, a still-`running` agent becomes `aborted`.
  4. A report with `status: "done"` sets `ended_at`. A later report for the same id with `status: "running"` revives it.
  5. Samples: two reports 1 s apart with cumulative tokens 1,000 then 4,000 give `tokens_delta` 3,000; a decreasing total gives delta 0; at most one sample per second per session.
  6. Server time, not reporter time, sets `last_seen_at`.

#### T1.3 Derivation
- **Scope:** `server/src/fleet/derive.ts` and its test.
- **Depends on:** T1.2.
- **Acceptance:**
  1. `blowoutLevel` returns 0 for none; 1 for one blowout anywhere; 2 for an orchestrator with 2; 2 for any agent with 2; 2 for a total of 3 spread over three loops; with a table-driven test of at least 10 cases.
  2. `SessionView.status` is `stale` when `now − lastSeenAt > STALE_AFTER_MS` and the stored status is not `done`.
  3. `series` has exactly 60 points per array, zero-filled for seconds with no sample, `peakContext` in 0..1, and `blowoutSecondsAgo` containing the age in seconds of each blowout in the last 60 s.
  4. KPIs match hand-computed values for a three-session fixture, including est. cost today and tokens in the last 60 s.
  5. `resumeCommand` uses `resumeId` when present, else the session id, and quotes a `cwd` containing spaces.
  6. `project` replaces the home directory prefix with `~`.

#### T1.4 Sweeper and SSE
- **Scope:** `server/src/fleet/sweeper.ts`, `server/src/fleet/sse.ts` and tests.
- **Depends on:** T1.3.
- **Acceptance:**
  1. With an injectable clock, a session unheard for 15 s becomes `stale`; 75 s total drops it and emits `removed` with reason `dropped`; a `done` session lingers 8 s then emits `removed` with reason `done`.
  2. A dropped session that reports again returns to the live set.
  3. SSE sends `snapshot` on connect, `session` after ingest (throttled: ten ingests in 200 ms produce at most one `session` message), `activity` per new event, `removed` and `tick` every 2 s. A client that disconnects is removed; a write error does not crash the process.
  4. Hourly retention deletes samples > 24 h, events > 30 d, old ended sessions, verified with injected old rows.

#### T1.5 Routes and server wiring
- **Scope:** `server/src/fleet/routes.ts`, `server/src/index.ts`, tests with supertest.
- **Depends on:** T1.4.
- **Acceptance:**
  1. All endpoints in 7.1 except `history` and `hook` exist and behave as specified, including 400 with `{ ok:false, error, path }`, 413 over 512 KB, 401 without the token when `PODIUM_TOKEN` is set, 404 for an unknown session.
  2. `GET /api/fleet/events` pages correctly with `before` and `limit`, newest first.
  3. `GET /api/health` still answers. (The old `/api/claude-code` and `/api/api-usage` routes were removed in issue #30.)
  4. The server starts with `npm run dev -w server`, creates `data/podium.sqlite`, and logs the URL. It binds `127.0.0.1`.

#### T1.6 Simulator
- **Scope:** `scripts/podium-sim.ts`.
- **Depends on:** T1.5 (can start once T0.1 is done, finish after T1.5).
- **Acceptance:**
  1. `--help` documents flags: `--url`, `--sessions N`, `--speed X`, `--seed N`, `--duration S`, `--chaos` (random stale sessions, failures, blowouts), `--token`, and for the people view (#34) `--person NAME[=TOKEN]` (repeatable: sessions go to the people in turn, each sends that person's `userName`, a `machine` (a laptop, and a build box for every third session) and its own token, else `--token`) and `--unnamed` (also keep a share of sessions with no name), and `--nested` (keep one session running agents that launch agents: a subagent under a subagent, a fork under a subagent and a subagent under a fork, four levels deep, #101).
  2. It POSTs full reports once a second per simulated session using the exact `Report` type, with sessions that start, spawn subagents and forks, load skills, fail, blow out context (haiku-sized windows blow out often), finish, and get replaced, as in the mockup's simulation.
  3. A seeded run is deterministic (same seed, same sequence of reports apart from timestamps).
  4. It exits 0 on `--duration` expiry and leaves no sessions running; sessions it created are ended with `status: "done"` on exit and on SIGINT.

**Exit criterion:** start the server and `npm run podium:sim -- --sessions 5 --chaos`; `curl -s localhost:4317/api/fleet/state` shows five sessions with agents, plans and series; `curl -N localhost:4317/api/fleet/stream` prints `snapshot`, then `session`, `activity` and `tick` messages; stopping the simulator ends its sessions and they leave the live set within the linger time.

### Phase 2: Frontend

**Goal:** the UI from the mockup, running on live server data.

#### T2.1 Foundations
- **Scope:** `frontend/src/fleet/` shell: `FleetApp`, `useFleet`, reducer, `format.ts`, `fleet.css` tokens, theme hook, `main.tsx` routing (`#/` fleet, `#/history`).
- **Depends on:** T0.1, T1.5.
- **Acceptance:**
  1. `#/` renders the shell with the top bar. (The old `#/usage` app this once had to leave unchanged was removed in issue #30; that hash now shows the fleet.)
  2. The reducer is a pure function with tests for `snapshot`, `session` upsert, `activity` prepend with a 150 cap, `removed`, and `tick`.
  3. With the server and simulator running, the connection pill shows the live reporter count; stopping the server shows "disconnected, retrying" within 6 s and recovers by itself when the server returns.
  4. `fmtTok`, `fmtUsd`, `fmtDur` and `fmtClock` have tests including edge values (0, 999, 1000, 1.5M, 3,600 s, 86,400 s).
  5. Dark and light themes match the mockup's tokens; every theme and mode can be picked, the whole console follows, and the choice survives a reload with no flash of the default.

#### T2.2 Rail, KPI strip, wall, cards
- **Scope:** `Rail`, `Wall`, `KpiStrip`, `Toolbar`, `SessionCard`, chips, `Sparkline`, `Legend`.
- **Depends on:** T2.1.
- **Acceptance:**
  1. With the simulator running, new sessions appear in the rail and wall without reload; ended ones leave with the leave animation; `prefers-reduced-motion` disables both.
  2. Sorting by each of the six keys reorders both the rail and the wall; sorting by Model orders Fable, Haiku, Opus, Sonnet and breaks ties by status then name. A unit test covers all six sorts.
  3. Filters: each status segment and the Blowouts segment filter correctly; the text filter matches name, project and branch case-insensitively. Unit-tested.
  4. A card renders the git line for all four cases (worktree with ahead/behind/dirty, main checkout clean, detached head, `git: null` shows nothing).
  5. Blowout level 1 shows the amber badge; level 2 shows the red badge, the red card edge and a red context figure, with the sentence as the Context readout's tooltip and no sentence on the card.
  6. Agent strip squares: fork is a circle, done is faded, failed has a red outline, queued is dashed.

#### T2.3 Orchestrator page
- **Scope:** `FocusView`, `FocusHeader`, `MiniCharts`, `FactsBar`, `BlowoutCallout`, `PlanPanel`, `AgentTree`, `AgentRow`.
- **Depends on:** T2.2.
- **Acceptance:**
  1. Selecting a card or rail item shows the page; Back (the "All orchestrators" rail item) returns to the wall; the selection survives `session` updates and clears with a message if the session is removed.
  2. The header, charts, facts grid and status band match the mockup's layout at 1440 px (`mockup/podium-orchestrator.html`, #165; `mockup/podium-facts-reporter.html` for the Reporter cell, #124); the status band is the last row of the summary surface and **Resume** is the last cell of the facts grid.
  3. Charts: three charts of 60 points from `series`; `peakContext` fixed 0..100%; red markers at `blowoutSecondsAgo`; caption counts markers; hover shows a crosshair and the value and time under the pointer and restores the live value on leave. A pure function converts a series to polyline points and is tested (empty, single point, all zeros, max scaling).
  4. The agent tree builds from `parentId`; guides draw correctly for last and non-last children; sorting by Model/Effort/Context/Tokens/Cost/Time/Status orders siblings and keeps the tree (#101) and clicking the same header again reverses it; "Launch order" clears the sort. Unit-tested.
  5. Plan panel shows state icons, the owner label, and "No plan reported. Agents were launched ad hoc." when `plan` is null.
  6. Context bars turn amber at ≥ 75% and red at ≥ 80% (#213, `mockup/podium-context-bar.html`; never both, the red bar carries an outline and a cap so it differs from amber in grayscale, and its accessible name ends "nearly full"), and show red stripes for loops with ≥ 2 blowouts.

#### T2.4 Side panel
- **Scope:** `SidePanel`, `ActivityList`, `AgentDetail`, `FailureBox`, `BlowoutBox`.
- **Depends on:** T2.3.
- **Acceptance:**
  1. Activity shows 12 rows; "Show 12 more" appends 12 more until the cap; "Show fewer" returns to 12; the count text is correct at each step; the 150-event memory note is present.
  2. Clicking an activity row with an agent selects its orchestrator and agent, opens the agent detail, scrolls the row into view and flashes it. A failure row opens a detail that contains the failure box. A blowout row opens a detail containing the blowout timeline. A row of a removed session is inert and says "Session ended".
  3. `FailureBox` shows class, call, output lines (as `pre` text, never HTML), evidence lines, optional explanation, and the "step went back to the plan" / "no retry queued" line from `retriedAs`.
  4. Agent detail shows "inherited" next to model and effort for forks.
  5. All text from reports renders as text nodes. A test puts `<img src=x onerror=…>` in a description, a failure output line and an event and asserts no element is created.

#### T2.5 Resizable panels, copy button, responsive, accessibility
- **Scope:** `ResizeHandle`, `useResizable`, copy handler, CSS breakpoints.
- **Depends on:** T2.3.
- **Acceptance:**
  1. Drag, keyboard and double-click behave as in 8.1, limits enforced, widths persisted with try/catch, covered by tests that simulate pointer events and keys.
  2. Copy writes `resumeCommand` to the clipboard (mocked) and shows "Copied" then reverts; a rejected promise shows the fallback.
  3. At 400 px width there is no horizontal page scroll (assert `document.documentElement.scrollWidth <= innerWidth` in a browser check, see T4.2).
  4. Every control is reachable by keyboard with a visible focus ring; `jest-dom` assertions for roles and labels on the handles and the charts.

**Exit criterion:** `npm run dev`, then the simulator; open `http://localhost:5173/#/` (check the Vite port) and exercise every requirement in 8.1 with real clicks in a real browser (use the Claude in Chrome tools or Playwright if installed). Record what was checked and what could not be in the commit message of the last Phase 2 commit.

### Phase 3: The reporter mod

**Goal:** a real Claude Code session appears in the dashboard with everything section 6 describes.

#### T3.1 Pure modules
- **Scope:** `hooks/state.ts`, `hooks/plan.ts`, `hooks/failures.ts`, `hooks/models.ts`, `hooks/report.ts` and their tests.
- **Depends on:** T0.1.
- **Acceptance:**
  1. `plan.ts` handles TaskCreate, TaskUpdate (every status incl. `deleted`, `addBlockedBy`, `owner`), TodoWrite replace, title rules and owner matching, with tests for each and for a malformed input (ignored, never throws).
  2. `failures.ts` classifies per 6.4 in a table-driven test with at least 10 cases; redaction removes all the listed secret shapes; outputs obey every length limit.
  3. `models.ts` maps aliases and full ids to families (`opus`, `claude-opus-5-5`, `sonnet`, `haiku`, `fable`, unknown); `windowOf` and `priceOf` are documented with their source and `PRICES_AS_OF`.
  4. `state.ts` reducers (spawn, step, complete, tool result, compaction, skill, session id change) are pure functions; given a scripted sequence of events they produce the expected `Report` which validates against the fixture's shape. The effort rule holds: requested → observed wins → fork inherits parent's.
  5. Blowout counting: auto compaction counts, manual does not, `model_context_window_exceeded` counts, duplicate signals within 2 s for the same loop count once.

#### T3.2 Transport and git
- **Scope:** `hooks/transport.ts`, `hooks/git.ts` and tests.
- **Depends on:** T3.1.
- **Acceptance:**
  1. With a mocked `$.http.fetch`: a flush posts one JSON report with the right headers (`X-Podium-Token` only when configured); a 400 drops the report; a network error keeps the snapshot and events and retries with backoff 1/2/5/10 s; the queue holds at most 500 events, dropping oldest; success clears acknowledged events.
  2. `git.ts` with a mocked `$.process.run` parses: normal branch with ahead/behind, detached head, worktree (differing git-dir and common-dir), non-repo (non-zero exit → `null`), and dirty counts from porcelain output (modified, untracked, renamed lines).
  3. No function awaits the network from a tool-path hook (checked by a test that the `tool.call` hook resolves while a `fetch` promise is still pending).

#### T3.3 Wiring
- **Scope:** `hooks/register.ts`, `plugin.json`, `hooks/hooks.json`.
- **Depends on:** T3.2.
- **Acceptance:**
  1. `claude plugin validate mod/podium-reporter` passes with no errors and lists the hooked events from section 5.3 and the `$` calls from 5.4. Attach its output to `docs/ARCHITECTURE.md`.
  2. `tsc -p mod/podium-reporter` passes once types are laid, or the type-check recipe from the reference is used if not.
  3. Every hook calls `next(e)` exactly once (or `yield*` for `turn.step`) and returns its result unchanged; a test with a hook that throws inside the reporter proves the session is unaffected.
  4. `session.start` registers `/podium` and starts the flusher, git poller and (if enabled) status line. A session-id change detected by the flusher sends a `done` report for the old id and starts the new one.
  5. `/podium` returns the dashboard URL, connection state, reports sent and failed, last error; `/podium name <text>` sets the name and persists it.
  6. `session.end` flushes with `status: "done"` and `endReason` before the hook returns.
  7. `claude plugin test mod/podium-reporter` passes, with an end-to-end hook test that raises `session.start`, `agent.spawn` (subagent and fork), `tool.call` (Agent, Skill, TaskCreate, TaskUpdate, a failing Bash), `turn.step` (with usage and a window-exceeded stop), `session.compact` (auto) and `session.end`, and asserts the final posted report's agents, plan, failure, blowouts and skills.

#### T3.4 Real-session verification
- **Scope:** running the real mod; no new files except notes in `docs/ARCHITECTURE.md`.
- **Depends on:** T3.3, T1.5.
- **Acceptance:**
  1. Start the server. Run `claude --plugin-dir mod/podium-reporter --model haiku -p "<a tiny task that uses the Agent tool once and TaskCreate once>"` (see rules in 10.4 on cost). The session appears in `GET /api/fleet/state` with the right model, a git branch, at least one agent with a model and a state, and a plan with the task, then ends and leaves the live set.
  2. Compare `session.costUsd` with what `/cost` or the final result reports. Record whether session cost includes subagents.
  3. Record in `docs/ARCHITECTURE.md` under "Mod API findings": which Assumptions in section 5 were right and which were wrong, with the evidence, including whether `classic.PermissionRequest` and `classic.Notification` are hookable, whether `session.compact` fires for agents, whether effort is visible on spawn, and the exact import-extension rule.

**Exit criterion:** one real session visible end to end in `GET /api/fleet/state`, and the findings recorded.

### Phase 4: Integration and hardening

**Goal:** it works as a product, documented, and survives abuse.

#### T4.1 Smoke script
- **Scope:** `scripts/podium-smoke.sh` (has `--help`).
- **Depends on:** Phases 1 and 2.
- **Acceptance:** one command starts the server on a free port with a temporary database, runs the simulator for 20 s, asserts via `curl` that `/state` has sessions, that `/stream` yields `snapshot` and `session` events, that a `done` session is removed after the linger time, then stops everything and deletes temporary files. Exit code is non-zero on any failed assertion. No process is left running (checked with `pgrep`).

#### T4.2 Browser verification
- **Scope:** a written checklist in `docs/ARCHITECTURE.md` plus the run itself.
- **Depends on:** T2.5, T4.1.
- **Acceptance:** with server and simulator running, in a real browser at 1440 px and 400 px, in dark and light: every item in 8.1 is exercised; screenshots are not required but findings are listed; any defect is fixed or recorded as a known issue with a reason. Includes: kill and restart the server (UI reconnects), 200 ms of 10 simultaneous reports (no UI jank, no duplicated rows), a session that never ends (goes stale, then leaves).

#### T4.3 Robustness
- **Scope:** server and mod.
- **Depends on:** T3.3, T1.5.
- **Acceptance:**
  1. Server: sending malformed JSON, a 1 MB body, a report with 5,000 agents, strings with control characters and invalid UTF-8 never crash it and return 4xx.
  2. Server restart mid-session: sessions reload from SQLite as stale and recover when their reporters send again.
  3. Mod: server down for 2 minutes, then up; no events lost within the 500 queue; the Claude session was never slowed (hook latency with the server down is measured and recorded, target under 5 ms added per hook).
  4. 10 concurrent simulated sessions with 20 agents each for 5 minutes: server memory stays flat (record start and end RSS) and SSE clients keep receiving.

#### T4.4 Documentation
- **Scope:** `README.md`, `docs/ARCHITECTURE.md`, `.env.example`.
- **Depends on:** all above.
- **Acceptance:**
  1. `README.md` explains what Podium is, how to run the server and UI, how to install the mod (from `eengelking-marketplace`, or `claude --plugin-dir mod/podium-reporter` for a session), how to run the server with `podiumctl` (4.4), how to run the simulator, the env vars (`PORT`, `HOST`, `PODIUM_DB`, `PODIUM_TOKEN`, `STALE_AFTER_MS`, `DROP_AFTER_MS`, `LINGER_MS`) and what is sent off the session (section 6.4).
  2. `docs/ARCHITECTURE.md` documents the final architecture, the mod API findings, deviations from this spec with reasons, known issues, and the verification evidence.
  3. `.env.example` lists the new env vars with defaults.
  4. No `TODO` is left in code without a matching entry under "Known issues".

**Exit criterion:** a new reader can follow the README from a clean clone to a running dashboard with simulated sessions, and then to a real session, in under 10 minutes.

### Phase 5: Optional extensions (do only after Phase 4 passes; each is independent)

#### T5.1 Classic hook ingest
- **Scope:** `server/src/fleet/hookIngest.ts`, route `POST /api/fleet/hook`, `docs/` snippet for `.claude/settings.json`.
- **Acceptance:** a `SessionStart`/`SubagentStart`/`SubagentStop`/`SessionEnd`/`Notification` payload (fixtures from the types file) produces a reduced session (name, cwd, agents by type, no usage) marked `reporter: "hooks"` in the UI with a note that context and cost are unavailable.

#### T5.2 Failure explanations
- **Scope:** mod `explainFailures` option; `$.model.complete` with `model: "haiku"`, `effort: "low"`.
- **Acceptance:** default off; when on, a failed agent gets a ≤ 400-char `explanation` generated from the redacted `Failure` fields only (never transcript), at most one call per failure, never retried on error, usage cost counted in the session estimate.

#### T5.3 History page
- **Scope:** `GET /api/fleet/history`, a `#/history` view.
- **Acceptance:** lists past sessions by day with summary columns and opens a read-only orchestrator page from stored rows. The list is paged (#195): 25, 50 or 100 rows per page (default 50) with Previous, Next and a "Showing N to M of T" line, the same pager as Admin > Reporters, and the day selector stays a single day. "N sessions ended" is the day's total, not the rows on the page. Changing the day or the rows per page returns to page 1. The day, page, rows per page and opened session are kept in the address (`#/history?day=&page=&size=[&open=]`); opening a session adds a browser history entry, so Back returns to the same page. Empty, loading and error states are unchanged, except that moving to another page keeps the current table on screen until the next page arrives (a change of day shows "Loading…" as before) (#273).

---

## 10. Rules for the implementing agent

*These rules were written for the original build. Where they differ from `.claude/CLAUDE.md` (for example the branch name and the push and PR rules below), that file governs now.*

### 10.1 Repository rules (from this repo's `.claude/CLAUDE.md`)

- You are on branch `feat/podium-fleet-console`. Stay on it. Never work on `main`.
- Commit on this branch after each task (section 9). **Do not push, open a PR, merge, tag, or rewrite history.** The coordinating session does that after review.
- Do not commit secrets. Do not commit `data/`, `.env`, `node_modules/`, or SQLite files.
- Do not spawn forks. If you need help, use a fresh non-fork sub-agent and state its authority in its prompt (report only, no commits). Prefer doing the work yourself, in order.
- When fixing a bug in code, first write a test that reproduces it and watch it fail for the expected reason.
- Verify with real runs, not only type-checks. Say plainly in your final report what you could not run.
- Leave no mess: stop every server, simulator and browser tab you start; check with `pgrep -fl "tsx|vite|node dist|podium"` at the end.
- Before writing a one-off helper script, check `scripts/` for one that does it. New scripts go in `scripts/` with `--help` and stay.
- Do not document architecture in `.claude/CLAUDE.md`. Use `docs/ARCHITECTURE.md`.
- If code and this spec disagree, or the spec is silent where it matters, record the question and your chosen reading in `docs/ARCHITECTURE.md` under "Spec questions". Do not silently pick; do not stop for small ones.

### 10.2 Quality bar

- TypeScript strict. No `any` without a comment saying why.
- Every new module has tests. Pure logic is tested without I/O.
- No dependency added without a line in `docs/ARCHITECTURE.md` explaining why nothing existing would do.
- No reported string is ever interpreted as HTML, SQL, a path, or a shell command.
- The UI never blocks on the server: first paint renders the shell and a loading state; errors show a message with what to do.

### 10.3 Order of work and checkpoints

Do the phases in order. After each phase run `npm test` and `npm run build` at the root and fix failures before continuing. At the end of each phase append a short entry to `docs/ARCHITECTURE.md` ("Phase N: what was built, what was verified, what was not").

### 10.4 Using the real Claude CLI (T3.4)

Allowed: at most **three** `claude -p` smoke runs total, each with `--model haiku`, a prompt under 40 words, and `--plugin-dir mod/podium-reporter`. They use the user's quota; do not loop. Set `PORT` to a free port for the test server rather than 4317 if 4317 is busy, and pass it to the mod as `serverUrl` through settings or `pluginConfigs`. Never run an interactive `claude` session. If `claude -p` is unavailable or fails to authenticate, stop that task, record it under "Known issues", and finish the rest.

### 10.5 What to report when done

1. Per task: done or not, with the commit hash.
2. Test and build results (counts), and the exact commands used.
3. What you ran for real, and what you could not.
4. Every Assumption in section 5 that proved wrong.
5. Deviations from this spec and why.
6. Known issues and anything left undone.
7. The final `git log --oneline` of your commits.

---

## 11. Explicitly out of scope / deferred (the design must not preclude these)

- A terminal pane or band inside Claude Code that shows the same fleet (the mod's `$.ui.open` and `ui.render` can draw it later; keep `state.ts` UI-free so a pane can read it).
- Remote or multi-machine fleets beyond one shared server: a named reporter already sends `machine` (6.2), and the people view groups by person and machine (8.1).
- Alerts and notifications (a blowout at level 2 pushes a desktop notification): `session.blowouts.level` and `$.ui.notify` are the hooks for it.
- Budgets and forecasts, comparisons between runs, cost per plan step.
- A scheduled-agent view (`CronCreate` tasks, `session_crons` on the Stop hook). A session waiting on a wake-up is only worded as such (#119); no list of schedules is shown.
- Authentication beyond the shared token.

## 12. Open questions and flagged assumptions

These were not resolvable from the type declarations alone. The implementer verifies each and records the answer in `docs/ARCHITECTURE.md`. None blocks starting.

1. Does `$.session.usage().cost.usd` include subagent spend? (T3.4)
2. Are `classic.PermissionRequest` and `classic.Notification` hookable from a mod, and do they fire for a permission dialog in a headless run? If not, `waiting` is derived from main-loop `turn.complete` only. (T3.4)
3. Does `session.compact` fire with an `agentId` for a subagent's own compaction? If not, agent blowouts come only from `stopReason`. (T3.4)
4. What are the real context windows per model family for subagents, and the current prices? Fill `models.ts` from the `claude-api` skill, not from memory.
5. Does `tool.call` for the `Agent` tool run before or after `agent.spawn` for the same `tool_use_id`? The reporter must tolerate both orders (it keys pending data by `tool_use_id` and merges).
6. Exact `userConfig` syntax in `plugin.json`, and whether relative imports need file extensions. `claude plugin validate` decides.
7. How is a bash exit code exposed in a `tool.call` error result? The reporter parses `text` best effort; improve if the result carries a field.
8. Should the dashboard also show teammates (agent-team members) distinctly? v1 shows them as agents with `kind: "teammate"` and the same row design.
9. Does the sample worktree detection work when a session is started inside a worktree created by `isolation: "worktree"`? Verify with one real run.
10. Name: "Podium" is a working name. Keep it in one constant (`APP_NAME`) so it can change.


## 13. Native CLI integrations (vsterian fork)

- Supported engines are Claude Code (legacy), Codex, GitHub Copilot CLI and OpenCode. Existing report v1 requests remain valid without integration metadata.
- Native events require the existing reporting token and matching userName for per-person tokens. Session IDs are engine-prefixed; ownership and engine cannot be replaced by another reporter.
- Native monitoring covers supported lifecycle/tool/agent/plan/usage events. Fields unavailable from a native surface remain unavailable; no transcript parsing, full prompt capture or reasoning export occurs by default.
- Codex uses native advisory hooks. Copilot uses its experimental native extension and reduced native hooks fallback. OpenCode uses its native plugin. Sessions retain the CLI's own terminal workflow and permission policy. New integrations do not accept dashboard responses.
- Explicit opt-in enrichment may read only the current session transcript supplied to a hook. Raw transcript content stays local. Unsupported versions fail open to native telemetry.
- Native telemetry persists engine identity, reporting mode, original session ID and observed metric availability through restart and history. Tool retries and message snapshots must not double-count usage. Late events must not accidentally resume ended sessions.
- The dashboard identifies and filters CLIs, uses engine-specific resume commands and labels incomplete metrics. Prices require an explicit exact native-model key or a provider-reported USD value. Copilot request multipliers/credits are not USD.
- Installation must preserve unrelated configuration and credentials. Uninstall removes only Podium-owned entries. Normal Codex trust review remains required.
- Acceptance includes legacy regression tests, migrations, ownership/auth, malformed/replayed events, usage/cache accounting, reporter precedence, installer preservation and browser checks. Native E2E must distinguish real provider access from deterministic local model fixtures.
