# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Podium is
pre-1.0, so a minor release can include breaking changes.

Podium and its reporter mod, `podium-reporter`, share one version number, the way Kubernetes versions its
parts together. A release sets that number in every file `CLAUDE.md` lists under "Releases", in the same
commit. Releases 0.2.0 to 0.14.3 were cut retroactively: each is the commit where the reporter's version
changed, and its section holds the changes that landed since the one before it. 0.14.3 also holds
the changes merged after the reporter's 0.14.3 bump, because it is the first release to carry both versions.

## [Unreleased]

### Added

- Native Codex hooks with opt-in current-session metadata enrichment.
- Copilot CLI extension with live telemetry and stable hooks fallback.
- OpenCode plugin for lifecycle, tools, plans, child sessions and usage.
- Backward-compatible integration metadata, durable native state and authenticated event ingestion.
- CLI filtering, engine badges, native resume commands and explicit unavailable telemetry.
- Reporter install/uninstall commands preserving unrelated configuration.
- Native regression tests and real-CLI E2E probes with optional deterministic model fixtures.


## [1.1.0] - 2026-10-16

### Added

- **A favicon.** The browser tab shows a white agent-tree mark on a dark tile, so the Podium tab is easy to pick out among many open tabs. It is a single SVG, `frontend/public/favicon.svg`, served from the app's own origin.

- **Podium warns when responding would send its sign-in unencrypted (#306).** With Respond from Podium on and the server bound beyond loopback, the log gets one `server.respond_plain_http` warning at start and another each time the flag is turned on; a sign-in to respond that arrives over plain HTTP at a name that is not loopback is noted at most once a minute, whatever the bind address. Admin > Settings adds a caution to the Respond from Podium row when the console is loaded over `http:` from a non-loopback host, and the reporter mod starts its status line with `⚠ ` and toasts once per session when its server URL is `http://` to another machine. Nothing is blocked, and no token, header or cookie value is logged. Until the server can trust a proxy's `X-Forwarded-Proto` (#305), a TLS proxy in front is not recognised from the bind address, so ignore the start warning behind one. SPEC 7.7, SECURITY.md and the user guide say so.

- **A CI check fails a PR into `main` that is not a release or a hotfix.** The "PR target check" workflow passes only when the PR's head is `development` or `hotfix/*` in this repo, and fails with a message that says to change the base to `development`. `main` is the GitHub default branch, so a contributor's "New pull request" proposes it by default. CI and documentation only; no behavior changes.

- **The Admin log is pruned (#303).** Nothing ever removed a row from `admin_log`, so a busy fleet with responding on added one for every answer for as long as the database lived. The hourly retention run now deletes rows older than 90 days, set with `RETAIN_ADMIN_LOG_MS` (also accepted by `podiumctl config set`), and always keeps the newest 100 rows so a quiet server keeps some history. `GET /api/admin/log` returns the period as `retainMs` and Admin > Admin log says how long entries are kept. There is no Settings control for it yet. SPEC 7.2, the user guide, the README and `SECURITY.md` say so.

- **The Admin log says what became of an answer, not only that the server took it (#304).** `respond_sent` now ends with the delivery's short id (`[dlv_1a2b3c4d]`). When the mod reports a result, a `respond_result` row follows with the same actor and id: the session took it, queued it, did not take it, refused it, or it had closed before the session got it. When the server drops an answer before the session has it, a `respond_dropped` row says so: its sender discarded it, or its ask closed first. Neither row, nor the server log's `respond.result` and `respond.dropped`, carries the text of an answer. SPEC 7.7 and the user guide say so.

### Fixed

- **A queued message that is lost when its session ends is written to the Admin log (#334).** A message the session had queued showed `respond_result` ("the session queued it") and then nothing if the session ended before Claude Code read it. It now gets a `respond_dropped` row saying the session ended while it was still queued; the row does not say it never arrived, because Podium cannot know. A message that later got `took` writes no extra row. SPEC 7.7, the user guide and DECISIONS 34 say so.

- **Deliveries dropped when a session is deleted or responding is turned off are written to the Admin log (#333).** Deleting a session, or turning off Respond from Podium or the activity feed, discarded every waiting answer, message and command with no row. Each one that had no result yet now gets a `respond_dropped` row, one per delivery and not one for the lot, with the sender as actor and the same short id as its `respond_sent` row, saying the session was deleted first or responding was turned off first. A session that ended and was then deleted writes one row per delivery, not two. SPEC 7.7, the user guide and DECISIONS 34 say so.

- **A retried final delivery result answers `404`, and that is now the contract (#329).** `POST .../deliveries/:id/result` for a message with a final result, or an answer the session refused, finds nothing the server still holds and answers `404 unknown delivery`. The bundled mod drops a queued result on any response, so it does not retry a `404`; DECISIONS 34 records why the server keeps no finished-delivery record, and tests lock the route and the mod. No behavior changed. SPEC 6.2 says so.

- **A message dropped when its session ends is written to the Admin log (#326).** A message or `/clear` or `/compact` command that was accepted and still waiting for the mod when the session ended vanished without a trace, so the log showed `respond_sent` and nothing after it. Each one now gets a `respond_dropped` row with the same actor and short delivery id, saying the session ended first, before any result came back; the server log's `respond.dropped` has `why: session-ended`. A message the session already took writes no extra row; one it queued is followed up by #334, below. No row carries the text. SPEC 7.7 and the user guide say so.

- **A retried delivery result no longer logs `respond.delivered` twice (#330).** #327 stopped the second `respond_result` row, but the server log still got a second `respond.delivered` line for the same result. `RespondStore.result()` now says whether a result was new, a repeat or for a delivery the server no longer holds, and the route logs only a new one. What the route answers does not change.

- **A retried delivery result no longer writes a second `respond_result` row (#327).** A mod that posted the same result twice for one delivery, as after a network timeout, left two identical rows in the Admin log. A repeat of the result a delivery already has is now ignored; a different result (`queued`, then `took`) still writes its own row. The route still answers `200` while the server holds the delivery; a message with a final result, or a refused answer, is no longer held, so a repeat of that one is a `404` as before and writes no row. SPEC 7.7 says so.

- **One machine reports one machine id, however the mod is loaded (#267).** The mod kept its random machine id in its own store, one file per plugin load, so a copy loaded inline and the marketplace install each had an id and one machine showed as two rows on Admin > Reporters. The id now lives in `podium-machine-id` in the Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`) and every load reads it. A load with no file adopts the id its store already holds, so a machine with one install keeps its row; a machine that had two ids settles on one, and the other row stays live only while its session does. Where the file cannot be read or written the store is used alone, as before. SPEC 6.2, DECISIONS 21, GOTCHAS and the README say so.
- **The start-on-boot unit no longer names a `node` that `brew upgrade` deletes (#268).** `podiumctl enable` wrote the path of the running `node`, and Homebrew's is `Cellar/<formula>/<version>/bin/node`, a directory the next upgrade removes, so the unit would fail at the next boot. It now writes `opt/<formula>/bin/node` when that leads to the same binary. On Linux, `podiumctl disable` no longer says the server is stopped only in standalone mode. The unit has now run on Bazzite in both modes; DECISIONS 11 and GOTCHAS say what that covered and that a reboot is still untested.
- **The notes on Admin > Reporters and the agent panel's Kind row show on keyboard focus (#275).** They used `title` plus `tabIndex`, which a browser shows on hover only, and the Kind row's span had no role. One `Tip` component now shows its note on hover and on focus, closes it on blur, mouse leave and Escape, wraps in a narrow panel and is placed from the trigger so a table's scroll area cannot clip it, and keeps the text in the page as a `role="tooltip"` line the trigger is described by, so a screen reader reads it either way. It replaces the Reporters state, admin secret and "no name set" notes and the Kind row's `data-tip` styling. The wording of the notes is unchanged. ARCHITECTURE says so.
- **"Lock Admin" stays locked after a reload (#272).** `POST /api/admin/unlock/from-respond` let an Administrator's console sign-in reopen Admin at once, so locking Admin on purpose, for example before leaving a shared screen, lasted only until the page was reloaded. Lock Admin now marks that browser's sign-in as held: a reload shows the name-and-token sign-in, while the console sign-in itself stands and the person can still answer sessions. Unlocking with the name and token of the person signed in to respond there lifts the hold, a new sign-in to respond starts without one, and another browser's sign-in is unaffected. The 10-minute idle lock still lets a signed-in Administrator back in. The Admin sign-in screen no longer says Admin opens without it for anyone signed in to respond; it now mentions Lock Admin. DECISIONS 30, SPEC 7.7, ARCHITECTURE and the user guide say so.
- **"Est. cost today" counts a session that started before midnight and now reports no ledger cost (#286).** The mod sends no ledger cost on a local model, so a session that spent on a Claude model earlier in the day and then switched counted $0 today, in the total and in the Spend tab. It now counts what it costs now minus what the usage on its last sample before midnight cost, priced with the Admin's prices, so only its spend after midnight is added; the owner split still adds up to the total. A session none of whose samples kept usage (a reporter older than 0.12.0 on a local model) still counts nothing. DECISIONS 23 and SPEC (KPIs) no longer list this as a gap.

### Changed

- **The three groups in Admin's side menu read as separate sections (#244).** Each group's heading is now 18 px (16 px from 761 to 1280 px of viewport, where the narrower rail would wrap it) in the primary ink with a small outline icon and a rule under it, and the groups are 24 px apart, where the heading was a 12 px muted line that read as one more row. On the narrow strip the heading text stays hidden, the icon stays as a leading glyph, and a hairline sits between groups. The pages, counts, order and current-page marker are unchanged. Mockup: `mockup/podium-admin-menu.html`.
- **A History page does the per-row work for its own rows only (#273).** `GET /api/fleet/history` built a row for every session that ended in the day, with an agents query and a repricing each, and sliced the page afterwards, so paging shrank the response and not the work. It now filters and sorts the stored rows, slices the page, and builds only those rows. Totals, ordering and the unused-session filter are unchanged, and the check for an unused session reads a session's agents only when nothing else already shows it was used. Moving to another page also keeps the current table on screen until the next one arrives, instead of replacing it with "Loading…". A test fails if the server's page sizes and the pager's differ. SPEC (`/history`, T5.3) and ARCHITECTURE say so.
- **The mod counts the lines of untracked files with a few git processes, not one each (#271).** Every 10-second Files poll ran one `git diff --no-index` per listed untracked file, up to 200, so a checkout with a large untracked folder started about 200 processes a poll. It now runs one `git grep -c` per 100 files. On a checkout with 500 untracked files a poll went from 206 processes (about 1.15 s) to 8 (about 55 ms), with the same totals. Empty and binary files, which `git grep` leaves out, still get a `git diff --no-index` each, for at most 20 per read; past that they show no counts. The 200-file cap is unchanged. SPEC 5.7 and DECISIONS 19 say so.
- **The README says up front that Podium has company.** A short paragraph after the introduction says Podium started as a tool the maintainer built for themselves, that similar tools exist, and that a reader should use whichever fits better. Documentation only; no behavior changes.
- **`docs/ISSUES.md` now exists, and `.claude/CLAUDE.md` no longer points at a file that was not there (#251).** It is a short inbox for findings that are not yet GitHub issues, cleared by `cii`, which the `cii` shorthand and the status-narrative rule already named. `.claude/CLAUDE.md` also drops the issue number from the project overview and lists `docs/GOTCHAS.md` among the known sample-data version hits at release. Documentation only; no behavior changes.
- **A person's token is stored only as its SHA-256; the unread `token_last4` column is gone (#277).** The server kept the last four characters of each token since #36, and nothing has read them since #218. Migration 17 drops the column, creating and rotating a person no longer writes it, and the helper that cut it is removed. A database made by an earlier release upgrades when the server opens it, and nothing a person sees changes. SPEC (Admin tables, 7.7) and DECISIONS 20 no longer say the last four characters are stored.
- **`SECURITY.md` is laid out as tables and points to the other documentation.** What is in scope, what is by design, how responding works (identity, the browser's sign-in, who can respond, what it needs, what the mod refuses, what is kept, the audit trail) and the known limits (the shared admin secret, plain HTTP, no log retention or export) are now tables, and a new "Where to read more" table names the DECISIONS, SPEC, USER_GUIDE and GOTCHAS sections behind each. "Supported versions" no longer says Podium is pre-1.0. Documentation only; no behavior changes.
- **The test tooling moves to vitest 5 and vite 8, and `npm audit` reports nothing (#269).** `npm audit` listed `vitest`, `vite`'s `esbuild` and `tinypool` (none ships in the image); the full audit, with dev dependencies, is now clean, as the production one already was. `@vitejs/plugin-react` moves to 6 with vite 8, and the root `package.json` names `vitest` for the `scripts/` tests. `frontend/src/jest-dom.d.ts` restores jest-dom's matcher types, which vitest 5's two-parameter `Assertion` dropped, and one server test types its mock with `vi.fn<() => void>()`. `server/src/testSetup.ts` is unchanged and still in `setupFiles`. No product behavior changes. DECISIONS 31 and GOTCHAS say so, including that six parallel test loops now exhaust the machine's ports (use three).
- **`sweep.removed` names at most 10 session ids, and an aborted request is logged (#279).** A sweep after a long outage could remove hundreds of sessions and write them all into one line; it now lists the first 10 in `session_ids` and counts the rest in `session_ids_omitted` (`removed`, `done` and `dropped` still carry the totals). A request the client drops before the server answers, such as a held answer request the mod gave up on, is now one `http.aborted` line at `debug`, with the fields of `http.request` except the status, which was never sent, and no `http.request` line. Neither shows in the default text output. USER_GUIDE, ARCHITECTURE and SPEC say so. The ring buffer, shared route and `reporterKind` helpers the issue listed as optional were left alone: none is a net simplification.
- **The rail works out a session's state once, and `bandLine` requires its delegates (#289).** The rail called `stateKind` twice for each item, once for the dot and once for the screen-reader text; it now calls it once and `sessionDot` takes the result. `bandLine` no longer defaults `delegates` to none, so a caller that leaves them out fails the typecheck instead of drawing Running on a delegating session. No behavior change.
- **This repo now uses the development-branch workflow.** `development` holds unreleased work; feature and fix PRs target it and are squash-merged. `main` stays the GitHub default branch, so a clone and the `podium-reporter` marketplace listing get released code, and it moves only on a release (a `development` to `main` PR merged with a merge commit) or a hotfix. Feature PRs no longer bump the version; a `release-prep/<version>` PR does, when the maintainer decides to release. `CLAUDE.md` "Releases", `CONTRIBUTING.md` and the PR template say so. CI runs on `development` as well, Dependabot opens its PRs against `development`, and `scripts/hooks/pre-commit` refuses a commit on `main` or `development`. Documentation and CI only; no behavior changes.

## [1.0.2] - 2026-10-16

### Fixed

- **The prompt and answer modal renders a fence inside a fence and a link with parentheses in its URL (#274).** A fenced block now closes only on a line of backticks at least as long as the one that opened it, so a shorter fence quoted inside a longer one stays text and the block renders as one. A link URL holding one level of balanced parentheses, such as `https://en.wikipedia.org/wiki/A_(b)`, now links the whole address instead of stopping at the first `)`. Only `http(s)` and `mailto` links open, as before.
- **The cost-per-minute sparkline follows the Admin's model prices (#270).** It was drawn from Claude Code's ledger samples, so after a price change it disagreed with the cards, the facts bar and "Est. cost today". Each sample now keeps the session's per-model usage (migration 16; in full only when it changes or at a minute's first sample, so a quiet session adds one character per second), and the series is priced from it like the other figures, so a price change moves the sparkline at once. Samples from a reporter older than 0.12.0, or from before this release, keep the ledger's figures, and the step where the two kinds meet counts as zero. Existing samples have no usage, so the sparkline's last hour mixes both for an hour after the upgrade.
- **A cost that is not known reads as a dash, and priced spend stays visible next to unpriced spend (#276).** Checked against the code after #117: a loop that has not reported a model yet and has spent nothing showed `$0.00` (hook-only agents always did); it now shows a dash. The "not counting N unpriced sessions" note counted every session on a non-Claude model, even after the Admin priced it; it now counts only sessions whose cost is still unknown. The note replaced the cost-per-minute sparkline on the Est. cost today tile; the sparkline now stays beside it. A session first heard of after midnight, whose start the server believed from just before it, counted $0 today; it now counts what it spent since its first sample. Already right and left alone: a session that switches from Claude to a local model keeps its Claude spend on its card and in the total when it started today (#117). Still open, noted in DECISIONS 23: a session that started before midnight and now reports no ledger cost counts nothing today.
- **A fleet card, a rail item and the wall now say "delegating" when the orchestrator page does.** A session whose orchestrator is running while an agent it launched runs used to read "Running" on its card and show the green dot in the left rail, while its page said "Delegating to 1 agent." The card's band now reads "Delegating to N agents." in the blue style (hover for the agents), the rail item shows the blue hollow dot and reads "delegating" to screen readers, and all three take the state from the same function as the page, so they cannot disagree. They return to Running when the last agent finishes. It is still display-only: the session counts as running in the status filter, the sort and the counts. UI only. (#287)

### Changed

- **A documentation-only or chore PR is no longer a release.** `CLAUDE.md` and `CONTRIBUTING.md` now say that from 1.0.0 on only a PR that changes code or behavior carries a release. A PR that changes only documentation, comments, CI or chores bumps no version, adds its entry under `[Unreleased]` and gets no tag. The bump is chosen by what the PR changes, not by its issue's label, and the maintainer may bundle several issues into one release: each PR adds its entry under `[Unreleased]`, and a final release PR cuts the version once they have all merged. This replaces the 1.0.0 rule that made documentation-only PRs patch releases.
- **The fleet store no longer keeps `lastMessageAt` (#278).** Nothing read it since #184 removed the "synced" counter. The field, its test assertion and the argument that fed it are gone; no behavior changes.
- **The plan panel's empty state uses the shared sentence (#278).** It read "No plan reported. Agents were launched ad hoc, so only the agent tree is available."; it now reads "No plan reported. Agents were launched ad hoc.", as the card and the focus header do and as SPEC 7.x says. The user guide is updated.
- **`CLAUDE.md` describes a second, opt-in branching workflow.** A new "Branching Model" section says that when the repo's GitHub default branch is `development`, feature PRs are squash-merged into it, `main` moves only on a release PR from `development` (merged with a merge commit), the version bump belongs to that release PR, and hotfixes branch from `main`. With the default branch on `main`, nothing changes. The Do Not list, "Always Branch First", the workflow table (a new hotfix row) and the Working row name `development` where they name `main`. The Releases section still describes per-PR releases and would need adapting if this repo opts in. Documentation only; no behavior changes.
- **Dependencies.** CI uses `actions/checkout` 7 and `actions/setup-node` 7 (#8, #9). The dev group moves `supertest` to 7.3.1, `@types/supertest` to 7.2.1, `tsx` to 4.23.15 and `@testing-library/react` to 16.3.3 (#10). `dotenv` moves from 16.6.1 to 18.0.7 (#11); since `dotenv` 17 prints an "injected env" line at startup, which the logger's text output does not expect, the server now loads `.env` with `quiet: true`. React 19 (#12) and TypeScript 7 (#13) are not taken: each needs its own migration.

## [1.0.1] - 2026-10-16

### Changed

- **The README opens with the problem Podium solves and a logo.** The lead-in now describes a session waiting on you with no way to tell which one, and presents Podium as a single pane of glass for one person or a whole team. The feature description became a short list under the screenshot, and "Run it" is now "Quick start". Adds `docs/images/podium-logo.png`. Documentation only; no behavior changes.

## [1.0.0] - 2026-10-16

This is the first stable release. From here on every PR to `main` is its own release (see #241 below).

### Changed

- **From 1.0.0 on, every PR to `main` is a release (#241).** `CLAUDE.md` now says that a breaking change is a major release, a feature a minor release, and a fix, a mod-only fix or a documentation-only change a patch release; that every release PR updates every file in its table and the CHANGELOG; and that a fresh Haiku subagent checks the release before the PR is opened and reports a verdict without editing anything. Before 1.0.0 the old rules held. `CONTRIBUTING.md` points at it. The tag is still proposed after the merge and waits for the maintainer.

- **The people controls share the wall's one control row (#245, #246).** With two or more people reporting, Group by and Order by join the status filter, Sort by and the text filter in an outlined People group, so the wall spends one row on controls, or two when the window is narrow, never three. Group by's None is now **All**, and a new **Me** appears while someone is signed in as a person: a flat wall of just their orchestrators. Who "me" is now comes from the browser's sign-in (the one Respond uses), so **You are**, **Only me**, the wall's "Showing X / Show everyone" line and the `podium.me` setting are gone; the left list's person headers and **All orchestrators** still narrow and widen the wall. Where the caption "N shown · M cleared today" does not fit, it is an info icon with the same words as its tooltip. **Upgrade note:** signing in needs the Admin's respond and activity-feed flags to be on; with them off nobody is signed in, so there is no Me and no "you" marking. See SPEC (People view) and `mockup/podium-wall-controls.html`.

## [0.14.3] - 2026-10-16

### Added

- **The server refuses a request whose `Host` is not one it expects (#256).** A page on another site that points its own name at `127.0.0.1` (DNS rebinding) could read the console's open routes, including every agent's prompt and answer. Now a `Host` that is not `localhost`, `127.0.0.1`, `[::1]`, the `--bind` address or a name in the new `PODIUM_ALLOWED_HOSTS` setting (`podiumctl config set PODIUM_ALLOWED_HOSTS=box.lan,...`) gets `403`, and a server bound to `0.0.0.0` also takes any IP address. The refusal is logged as `http.host_refused` with the host only. **Upgrade note:** a reporter on another machine whose `serverUrl` uses a name (`http://box.lan:4317`) is refused until that name is in `PODIUM_ALLOWED_HOSTS` and the server is restarted; a `serverUrl` that uses an address keeps working on a `0.0.0.0` bind. See DECISIONS 33.
- **Wrong admin-secret guesses sent as `X-Podium-Token` are throttled (#255).** Five different wrong secrets from one address on `POST /report`, `POST /hook`, `DELETE /sessions/:id` or the mod's respond routes now get `429` with `Retry-After` for 15 minutes, counted apart from the Admin and sign-in lockout. Person tokens are never throttled, and one reporter repeating a stale credential throttles nobody. While an address is throttled even the right admin secret is refused from it. The refusal is logged as `auth.failed` and shown on the Reporters page. The server warns at start when `PODIUM_TOKEN` is under 24 characters. Server only.
- **Security sweep (#249).** Every response now carries a content security policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; the container runs with all capabilities dropped and no way to gain privileges; and `express`, `qs`, `body-parser` and `proxy-addr` moved to patched versions, so `npm audit --omit=dev` is clean. The findings, and the risks accepted, are in `docs/DECISIONS.md` (31).

### Changed

- **Podium and podium-reporter share one version.** The app's `package.json` files were still at 0.1.0 while the reporter had reached 0.14.3; all of them are now 0.14.3, and every release sets them together (`scripts/versions.test.ts` checks the mod, the three manifests and the lockfile; `CLAUDE.md` lists the files). Releases 0.2.0 to 0.14.3 were tagged afterwards at the commit where the reporter's version changed.
- Spend by person or group moved from the fleet page's right panel to its own page, **Admin > Spend** (#239). The page is in the Activity group, above the Admin log. It has Group by (People, Groups) and Show as (Chart, Table), the total spent and the live session count at the top right, and Admin's pager (25, 50 or 100 rows per page, largest first); the total and the table's Total row count everyone, whatever page is showing. The right panel on the fleet page is now the activity list alone, with no empty band and no "Each bar is one person..." line, and the wall's people bands still show each person's share of today's spend. Only an Administrator can open Admin, so other people no longer see the per-person list. The page remembers its own choices in `localStorage` under `podium.adminSpend`; the old chart or table choice in `podium.people` is ignored. The mockup is `mockup/podium-admin-spend.html`.
- Admin access is one model (#215). The **Admin** button in the top bar shows only to someone signed in to the console as an Administrator, or as Admin with the secret. That person opens Admin with no second sign-in, including after the idle lock. Anyone else goes to `#/admin`, whose sign-in now takes a name and a token (an Administrator's own, or `Admin` with the admin secret) instead of a token alone. `POST /api/admin/unlock` takes `{ name, token }` and answers a wrong pair with `401 wrong name or token`; `POST /api/admin/unlock/from-respond` is new; the `podium_respond` cookie is scoped to `/api`. Anything that called `unlock` with `{ secret }` must send `name` too.
- Admin > People names a person's token the way Reporters does, as `pdm_` and its twelve-character key id, such as `pdm_35fa525ce1b4`, instead of `pdm_…` and the last four characters of the secret (#218). The key id only finds a person and is not a secret; no part of the secret is shown or sent to the page any more. The token itself, and what is stored, are unchanged.
- `bin/podiumctl.mjs` is now `bin/podiumctl`, so it runs as `bin/podiumctl status` with no `node` in front (#227). `package.json`'s `bin` entry and `npm run podiumctl` follow. A boot unit made by `podiumctl enable` before this change still points at the old file and stops working: `podiumctl status` now says `on boot: enabled, but stale` for it, and running `podiumctl enable` again rewrites it.
- `docs/GOTCHAS.md` has a new "Reporters and machines" section (#237): why the Reporters page can show several rows for one machine (two machine ids, one row per account, a reporter with no name, rows left by container restarts), and why a running Claude Code session cannot be handed to another Podium user and shows "refused: session belongs to someone else". The README and the User Guide's Reporters entry link to it.
- The orchestrator page's plan shows 10 steps at a time. A plan of 11 steps or more has the Files tab's pager under the list ("Showing 1–10 of 23", Previous, page numbers, Next); a plan of 10 or fewer has none. The count and progress bar above the list still cover the whole plan. The panel opens on the page holding the current step, stays on the page you chose when the plan changes, and falls back only when that page no longer exists. The pager is now one shared component, `PageNav`, used by Plan and Files. UI only. (#214)
- `THIRD_PARTY_NOTICES.md` moved into `docs/` with the other standing docs, and every reference follows it, including the Theme credits link in the left rail footer (#212).
- The docs now say that a machine holds one saved Podium login per Claude config, why (Claude Code gives a reporter one shared set of settings and no per-session login, and tells every running session when they change), and that `PODIUM_USER` and `PODIUM_TOKEN` are the way to hold two logins at once. A later Claude Code release may remove the limit. Documentation only; the reporter is unchanged. (#230)
- The top bar's pill names the page it is on: "Orchestrator" on an orchestrator's page (it said "Fleet" there), "Fleet" on the wall, "History" and "Admin" as before. The text now comes from the page, so a new page cannot inherit the wrong name. UI only. (#225)

### Fixed

- `npm run podium:smoke` passes on a clean checkout again. Vite listened only on `::1` here while the script curled `127.0.0.1`, so the proxy check found nothing and the 15-second wait for it pushed the simulator past the direct stream's 34-second `--max-time`, which then missed the `removed` events. The script now starts Vite with `--host 127.0.0.1` and lets the stream run to 90 seconds. The server was sending `removed` correctly. Script only. (#259)
- **A reporter's detail puts Ignore… beside Remove from list (#247).** Both buttons now sit together at the right of the header, with the name and state on the left, and they stay together when the header wraps or Remove turns into its confirmation. **Ignore…** keeps its ellipsis, because it opens a choice before anything happens, and now has a tooltip that says so. UI only.

### Documentation

- The README's screenshot (`docs/images/podium-chaos.png`) is refreshed: nine simulated sessions with running, stale and failing orchestrators, context blowouts and the activity feed.
- The podium-reporter option descriptions now match the code: **Status line** shows the real text (`podium v<version> ● N live`, with the offline, connecting and token-refused states and the update hints), and **Podium token** and **Your name in Podium** say that the `PODIUM_TOKEN` and `PODIUM_USER` environment variables override them at a session's first start. No behavior change. Reporter 0.14.3. (#252)
- `docs/fixtures/report.sample.json` is now a current-format report: reporter 0.14.2 with every optional field filled in (`activityFeed`, `activity`, `background`, `respond`, `asks`, `clearedFrom`, `userName`, `machine`), so `checkReporter` no longer calls it outdated. SPEC 6.2 says so. Tests that want a plain session read it through `fixtureReport()`, which leaves out the fields that start behavior of their own. No change to the report protocol. (#253)
- A documentation sweep (#248): corrected stale non-goals, the respond cookie path, the container bind note, the status-line examples, SPEC cross-references and sign-in wording, and the User Guide's tile names, refresh times and log events. Added the model prices, wall notices, compatibility, stream and Admin page parts to ARCHITECTURE, marked entry 7 of DECISIONS as superseded in part, removed three duplicate bullets from this file and merged its repeated headings. In-app and `podiumctl` copy now matches the code: the Admin button tooltip, the hooks-only tooltip, the Forget old reporters note, `token --rotate` and the sign-in help. (#248)

## [0.14.2] - 2026-10-15

### Changed

- A context bar turns red at 80% and above (#213, `mockup/podium-context-bar.html`). From 75% to 79% it stays amber; the red is the theme's own red, the one the level 2 blowout badge uses, in every theme and in light and dark. The red bar has an outline and a solid cap at the end of its fill so it still differs from amber in grayscale, and its accessible name now ends "nearly full". It applies everywhere the bar shows: the card, the orchestrator page, the agent tree and rows, and both detail panels.

### Fixed

- Two Podium identities can report from one machine at once, and signing in as another person no longer turns a running session into a refused one (#226). The reporter's name and token are one setting per Claude config, and Claude Code reloads every running session's reporter when it changes, so a session that had been reporting as Admin began sending the other person's token and was refused. A session now takes its name and token once, at its start, and keeps them; a reload with new settings does not change them. A terminal can also name itself with the `PODIUM_USER` and `PODIUM_TOKEN` environment variables, which are used ahead of the settings. To change who a running session reports as, start a new session. Reporter 0.14.2.
- Admin > Reporters now lists every account that reports from one machine. Two accounts on a machine send the same machine id, so they shared one row and each report overwrote the other's person and token. The first account keeps the machine id as its key and each other account is keyed `<machine id>#<person>`, so rows and ignore rules made before this still match. An ignore rule on a machine id still covers every account on it. (#221)

## [0.14.1] - 2026-10-15

### Fixed

- podium-reporter now says so when the server refuses its reports because the session already belongs to someone else (a `409`). The status line reads `podium v0.14.1 ○ refused: session belongs to someone else` instead of `○ connecting`, a toast and `/podium` say "Start a new session to report as yourself", and the reporter writes the reason to its log once. This is what happens when the name and token in the reporter's settings change while a session that reported as another owner (the Admin, say) is still open; the server still refuses it, as intended. A later accepted report clears the message. podium-reporter is now 0.14.1. (#209)
- In the People view (and Group by Group), a band's header sits on top again with its cards below it at full width, instead of beside them and squeezing them. The band shared the class `band` with the card's status band and picked up its flex row, padding, tint and top border; it is now `pband`, so the two can't collide. The card's status band is unchanged. UI only. (#207)
- The Sign in button's label is readable again. In the Sign in dialog `.podium .modal.sm .btn` set the label color and, being more specific than `.podium .btn.pri`, beat it, so the label was the same ink color as the button: black on black in the light theme, white on white in the dark theme. The dialog, answer panel and composer rules no longer set a color on a primary button (`.btn:not(.pri)`), and `frontend/src/fleet/primaryButton.test.ts` guards it. The other primary buttons were not affected. UI only. (#216)
- The Respond modal no longer keeps a closed ask's outcome after its turn is over. The server drops a closed ask once the session has been seen running and then reports itself idle with no open ask (it still drops one after 10 minutes, or when the session's next ask opens), and the modal's header reads "No longer waiting." for a closed ask instead of "Waiting for…". In History, the "continued in …" and "after /clear of …" links of a `/clear` row each sit on their own line under the end reason, so the id is no longer cut off. (#208)

## [0.14.0] - 2026-10-15

### Added

- **Answer a waiting session from Podium** (#206, `mockup/podium-respond.html`). When a session stops to ask you something, its amber band gets **Respond** (on the card and on the orchestrator page), which opens the Activity modal with the question, plan or tool request under the feed and a message box at the bottom. You can answer an AskUserQuestion form (an option, a typed answer, or a message in its place), approve a plan in one of three modes or send it back with feedback, allow a tool once or deny it with a reason, send a new message, and run `/clear` or `/compact`. The terminal keeps working the whole time and whichever answers first wins; the modal says when the terminal, someone else or the session got there first, and when an approval didn't take. Off by default: it needs the Admin's new **Respond from Podium** flag (Admin > Settings > Feature flags, off by default; the feature flags now each have their own default), the activity feed, and on the session's machine podium-reporter 0.14.0 with its new `respond` option (`off`, `questions`, `questions-and-plans`, `everything`) and `activityFeed` on. Only the session's owner or an Admin can respond: you sign in with your name and token, from the modal or from **Sign in** at the far right of the top bar. Each answer goes to the Admin log with who sent it, never its text; what a session asks is shown only to its owner or an Admin and kept in the server's memory. New routes under `/api/fleet/sessions/:id/asks` for the mod and `/api/fleet/respond` for the browser; the report's reply carries `respond` and `deliveries`, and reports carry `respond`, `asks` and `clearedFrom`. History links the two parts of a conversation split by `/clear`. podium-reporter is now 0.14.0, and the server reads reporters up to 0.14.0. `scripts/podium-respond-demo.mjs` fills a throwaway server with waiting sessions for trying it without Claude Code.
- Wrong Admin unlocks and wrong sign-ins to respond now count together toward the 15-minute lockout.
- The orchestrator page and the cards no longer go quiet between one plan step finishing and Claude marking the next one in progress. With no step active, the first step not started is shown as current: in the goal line ("now: ... (inferred)"), on the card, and in the Plan checklist, where it has a dashed marker and "up next · inferred". When every step is done the goal line says "plan complete". It is display only: Podium cannot change Claude's task list, the report format is unchanged, and a step Claude marks in progress replaces the inferred one at once. UI only. (#179)
- Admin > Reporters > a reporter's details: **Recent sessions** is paged, with the same pager as the other Admin lists (50 a page by default, 25 or 100 to choose), so every session the server still holds for that reporter can be reached, not only the newest 10. `GET reporters/:key` takes `page` and `pageSize` and returns `recentTotal`, `recentPage` and `recentPageSize`. **Recent sessions** and **Reports the server turned away** are now their own titled panels below the details, like the sections on the other Admin pages. The turned-away list is unchanged (the server keeps at most 20 per reporter, in memory). Server and console only; the mod is unchanged. (#188)
- Admin's top bar shows **N reporters live**, beside the "Admin" pill, the same as the fleet page. It is one shared component and one count helper, so the wording, plural handling and meaning cannot drift between the two pages, and it updates as a reporter starts or stops. UI only. (#187)
- Admin has a built-in **Administrators** group. A person in it can unlock Admin with their own token, so the shared admin secret no longer has to be handed around; the admin secret is always a member and the group cannot be renamed or deleted. A token from someone outside the group, or a revoked one, is refused like a wrong secret and counts toward the same lockout. Moving a person out of the group, or revoking their token, locks their open Admin session. The Admin log has a new **Who** column naming the person or the admin secret for each change. The lock screen, Groups and People pages say who can sign in. New migration 14 (the group and `admin_log.actor`). `docs/SPEC.md` 7.7 and its non-goal line are updated to allow this one role. Server and console only; the mod is unchanged. (#172)
- Admin > Reporters can remove many reporters at once: tick rows (the header box ticks the page, and **Select all N that match** reaches past it) and choose **Remove N…**, or choose **Remove all** for the state that is showing. The confirmation says how many will go, and the Admin log gets one `reporter_removed` entry with the count. (#167)
- Admin > Reporters has ignore rules. **Ignore…** on a reporter's details, or the form under the table, adds a rule for a key, an address or a version (`*` for "anything"); a report from a reporter a rule matches is refused with a 403, so its sessions stop appearing on the fleet until the rule is removed. Each rule has **Remove rule**. (#167)
- Admin > Settings has **Forget old reporters**, off by default: with it on, the hourly sweep removes reporters not heard from for the set number of days (30 by default) and writes a `reporters_forgotten` entry to the Admin log. (#167)
- Admin has a **Reporters** tab: every machine that has reported to the server, one row each, kept after its sessions are deleted. The strip on top counts reporters by state (Reporting, Idle, Silent, Not since restart) and filters the list; each row shows the machine, person, reporter version (with a warning outside the supported range), last report and session count, with search, sorting and paging, and it asks the server again every 10 seconds so a reporter that stops moves to Silent without a reload. Silent means only that nothing arrived; the server cannot tell a reporter that is off from one that cannot reach it, and the page says so. Selecting a row shows its versions, compatibility, machine, source address, the token's key id (never the token), recent sessions and recent refused reports from its address (kept in memory, lost on restart), and **Remove from list** takes it off the list until it reports again. A reporter is one machine, keyed on the machine id it sends, or on its source address when it sends none (a reporter with no user name, or the settings hooks). Admin only, since addresses and machine names are personal data. New migration 11 (`reporters`, `reporter_sessions`), three Admin routes (`GET reporters`, `GET reporters/:key`, `DELETE reporters/:key`) and the admin log kind `reporter_removed`. The report format and the mod are unchanged, so the mod's options are not shown. (#142)
- Log lines are now scrubbed for common secret shapes, not only Podium's own tokens. Every string value, including the message and event, has these replaced with `[redacted]`: `Bearer` and `Basic` credentials, `password=`, `passwd=`, `secret=`, `token=` and `api_key=` style assignments (in text, query strings and JSON fragments), the password in a URL's `user:pass@`, and well-known key formats (`sk-`, `ghp_` and `github_pat_`, `AKIA`, `xoxb-`, and JWTs). Matching is conservative: ordinary text, session ids, model names, paths and numbers pass through, and `tokens=1234` is not touched. It is pattern matching only, so a secret in a shape it does not know still gets through. Server only. (#155)
- The server has real logging. Each line is an event with a name an agent can search for (`report.rejected`, `auth.failed`, `session.started`, `session.ended`, `reporter.connected`, `reporter.silent`, `sweep.removed`, `admin.*`, `ingest.failed`, `server.start` with the settings in use, and more), a level and fields such as the session id, route, status and reason. `PODIUM_LOG_LEVEL` picks debug, info (the default), warn or error; debug adds one `http.request` line per request. `PODIUM_LOG_FORMAT=json` prints one JSON object per line; the default `text` prints exactly what it printed before: the new events show in text only at `debug`, and the JSON format and shipping carry them at their own level. Set `PODIUM_LOG_SHIP_URL` to push every line to a central platform such as VictoriaLogs (`/insert/jsonline`, gzipped NDJSON, headers from `PODIUM_LOG_SHIP_HEADERS`); it is off by default, never holds up a report, keeps up to `PODIUM_LOG_SHIP_BUFFER` lines (2000) while the endpoint is down or answers with an error, says once when it starts dropping the oldest, and drops only a batch the endpoint refuses as malformed or too large (400, 413, 422), saying so once. No token, admin secret, header value, prompt, answer or activity text is logged or shipped. `podiumctl config set` takes the five new keys and passes them to the server in both modes, `podiumctl config` hides the header values and a ship URL's user name, password and query values (`--show-token` shows them), and `podiumctl --help` lists them. The user guide has a new Logs section with the events, the VictoriaLogs setup and example queries for the VictoriaLogs MCP server. Server only; the mod is unchanged and no dependency was added. (#140)
- The fleet page has a **Refresh every** dropdown in its info row, to the left of the Theme controls: 2s (the default), 5s, 10s, 20s, 30s or 60s, remembered per browser. The page now redraws from new data, and moves its elapsed times, once per interval instead of on every message, which lowers the browser's GPU load. A session that starts waiting for you or goes stale, an agent that fails, and a lost or restored connection still show at once. The pulse and blink beat is unchanged, and the server sends events as before. Fleet page only; History and Admin are not live. UI only. (#138)

### Changed

- The History page shows a day a page at a time. `GET /api/fleet/history` takes `page` and `pageSize` (25, 50 or 100; default 50) and answers `{ day, sessions, total, page, pageSize }`; the page has Admin's pager under the table (Previous, Next, rows per page). "N sessions ended" is still the day's total. The day, page, rows per page and opened session are kept in the address, so the browser's Back button returns to the same page from an opened session. A request with a bad `page` or `pageSize` is a 400. (#195)
- The fleet page's **Subagents running** tile now shows only the number running. The "of N this run" beside it and the "forks included" caption under it are gone; the number still counts forks, and the tiles in the row keep their height. (#196)
- The orchestrator page's three charts now fill the height of their row. When the header beside them is taller than the charts, each chart grows to fill it: the title and readout stay at the top, "60s ago" and "now" stay at the bottom, and the graph takes the space between, with no empty space under it and no maximum height. A chart is never shorter than the 46 px it was. The three stay equal in height. UI only. (#197)
- The orchestrator page's Plan and Files panel now matches the approved mockup. Plan steps use the mockup's marks, one shape per state (a green circle with a check, a ring with a filled dot, a ring with a slash, an empty ring, and a dashed ring for the inferred next step), a hairline separates the progress bar from the first step, and the "Read from TaskCreate and TaskUpdate calls in the session." footnote under a populated plan is gone. The Files tab has the mockup's summary line, rows (status letter, name over folder, signed counts, then the five-block bar) and a "Showing 1–20 of 47" pager footer; paging is unchanged. UI only. (#200)
- The orchestrator page is rebuilt to match the fleet card (mockup `mockup/podium-orchestrator.html`). The header, the facts and a new status band are one bordered surface, with the band as the last row, full width and at least 58 px tall. The band replaces the status chip beside the name and the waiting, background-wait and heartbeat-lost callouts: one bold line and one detail line, in the card band's shapes, sentences and tints, with **Remove now** laid over its right end. The page also says "Delegating to N agents." with the blue ring shape, as SPEC 8.1 allows for this page. The facts are a grid of eight cells in fixed places (four columns, two at 520 px and narrower). **Blowouts** is always there ("none" when clear) and, when there are blowouts, opens the blowout detail between the header and the facts; a level 2 blowout gives the surface the card's red top edge. The settings-hooks and reporter-version callouts are gone: their text is the Reporter cell's tooltip, and an out-of-range version shows a warning shape. **Copy resume command** is now a quiet **Resume** cell ("Copy command"). The plan, Files and agent panels use the card's hairlines, and a blocked plan step has a slash as well as its color. UI only. (#165)
- Admin > Reporters: **Ignore rules** is its own section after the reporters section, with a heading, a help line and its own panel like the other Admin pages. The notes under the table are gone: what **Silent** and **Not since restart** mean is now the tooltip on a state and on its strip button, how an unnamed reporter is named is the tooltip on "no name set", and what **Remove from list** does is the tooltip on that button. (#181)
- Admin > People no longer shows an "administrator" pill beside a person in the Administrators group. Their name is drawn in orange instead, from a new `--admin-text` color in every theme and mode (checked at 4.5:1 by `scripts/theme-contrast.ts`), with the tooltip "Administrator: can open Admin with their own token" and a screen-reader label so color is not the only signal. A revoked administrator keeps the muted look, and the "built in" tag in Admin > Groups is unchanged. UI only. (#182)
- The fleet page's connection pill now reads "N reporters live" (or "1 reporter live") and no longer shows "synced Xs ago", so its text stops changing every tick. The connected, reconnecting and lost states are unchanged. UI only. (#178)
- The fleet page's second tile and the orchestrator page's running-agents chart now read **Subagents running** instead of "Agents running", so the name no longer sounds like it counts the orchestrators. The tile's caption is now "forks included", because the count covers forks too. The number is unchanged. (#169)
- The fleet cards are redesigned (#144). Every card is now four layers in a fixed order: who and where (name, model, effort, path, git, with small tags for "nobody attached", "settings hooks" and a reporter warning only when they apply), what it is doing (plan, agents and the tokens-per-second sparkline), cost and health (Cost, Tokens, Time and Context as four readouts), and a **status band** that is always the last thing in the card, full width, at the same height on every card. The band replaces the status chip and the floating colored bar, so "Waiting for your input." and the blue background wait no longer sit at a different height on each card. It says "Running", "Done", the waiting sentences or the heartbeat-lost line; waiting and heartbeat lost get a heavier tint, and every band has the same thin top line. Each state has its own shape, beside the name and in the band. A context blowout keeps the red card edge, the count and a red context figure, and its sentence moves to the Context readout's tooltip and the orchestrator page. Every fact that was on a card is still reachable. UI only. The approved mockup is `mockup/podium-card.html`. (#144)
- The Admin page is redesigned (#143). A side menu replaces the six tabs, in three groups: People and access (People, Groups, Reporters), Server (Settings, Model prices, Reporting and security) and Activity (Admin log). On a narrow screen it becomes a strip along the top. Every page follows one pattern: a header, then sections, each a title and a line of help above a panel. People and Groups each have a **Create user** / **Create group** section above the list, searches have their label to the left of the field, and every list has the same pager (Groups and Reporters gained the full one). **Model prices** moves out of Settings to its own page, and the Admin has the left rail's footer (Theme credits, License, version, copyright). Nothing about what Admin does has changed. `GET /api/admin/session` now also returns the server `version`, which the footer shows. The patterns are written down in `docs/ARCHITECTURE.md`, and the approved mockup is `mockup/podium-admin.html`.
- The cards on the fleet page's wall now stretch to fill the row, in at most four columns. A card is never narrower than 360 px: the wall holds as many as fit (four from a 1476 px wall, three from 1104, two from 732, otherwise one), never more columns than there are cards, so three cards on a wide wall are thirds. A lone card is half the wall, or the full width when the wall is under 732 px. Later rows keep the same column width, left-aligned, so five cards on a four-column wall are 4 + 1. Every band in the People and Group views uses the same columns, worked out from the total shown, so a band of nine and a band of two line up. The columns follow the wall's own width, so they change as the window or a pane is resized, and a card now resizes when a pane opens or closes. It applies to the wall on the fleet page only. UI only. (#145)

### Fixed

- The Orchestrator page's **Tokens per second** readout no longer sticks at `0/s` while the graph shows activity. It read the newest single second, and tokens reach the server in bursts, so that second was usually 0. It now shows the average of the last 10 seconds (its tooltip says so) and reads 0/s only after 10 idle seconds. Hovering the chart still shows the second under the pointer. The graph, the report format and the other charts are unchanged. UI only. (#191)
- The Admin side menu is now as wide as the fleet page's left pane (252 px, 224 px below 1280 px); it was 216 px. Both read one shared width, so they cannot drift apart. The phone layout is unchanged. UI only. (#180)
- A simulator run no longer leaves a row in Admin > Reporters. The simulator's reports say `hostSurface` `simulator`, and the server stores their sessions as before but never notes that sender as a reporter. `podium-smoke.sh` and `podium-soak.sh` already use a throwaway database, and the mod's tests use a fake `fetch`, so nothing else writes to a real server. Rows an earlier run already left (version `0.1.0-sim`) stay until you remove them with **Remove from list**. Server and simulator only; the mod and the report format are unchanged. (#168)
- Admin > Reporters no longer grows a row each time a container comes back on a new address. A reporter with no user name was keyed on its source address, so every restart added a row. A session belongs to one reporter, so a report whose session is already recorded under another row is now filed under that row, and a row made for the new address first is merged into it; first-seen time and sessions are kept. Migration 12 merges the duplicates that already exist. A reporter that reports with the admin secret instead of a token made for one person is now always flagged: an **Admin secret** badge with a warning icon in a new Token column (the token's key id for everyone else), a band above the list that counts them with **Show only these**, and a warning at the top of its details that says what is wrong and how to fix it. `GET reporters` returns `adminSecret` (the count) and takes `admin=1` and `sort=token`, and rows carry `credential` and `adminSecret`. An unnamed reporter is now shown by its newest project, or its address, with "no name set" beside it; hovering or focusing a reporter's state or that label explains it for that row (when it was last heard, when the server started), and the page note says why most rows read Not since restart after a restart. Server and UI only; the report format and the mod are unchanged. (#166)
- `podiumctl config set DETACHED_HIDE_AFTER_MS=...` was refused as an unknown key, and a value set another way never reached the container, although the server reads it and the README lists it. It is now in the list of settings `podiumctl` passes through. A new test reads every setting the server code reads and fails if `podiumctl config set` would not take it, so the two cannot drift apart again; no other setting was missing. (#157)
- `podiumctl config set` with more than one `KEY=VALUE` stored them glued together as one value of the first key. It now sets each pair, and `config unset` takes several keys. If any argument is not `KEY=VALUE` or names an unknown key, nothing is changed. A value with spaces still needs quotes. `podiumctl` only. (#156)
- The icons beside agents in the agent tree were empty grey boxes. A row now shows the same marker as the card's agent strip: a square in the model's color for a subagent, a circle for a fork, faded when done, outlined red when failed and dashed when queued, inside a thin border in the model color mixed toward the theme's ink so it follows light and dark. UI only. (#141)
- The Activity header now lines up: "Activity" and the Expand button sit on the same line as "Refresh every" and its dropdown, in the panel and in both themes. The left group inherited the toolbar's 12px bottom margin, which lifted it above the right group; the margin is gone, and Expand and the dropdown now share a font size, line height and padding, so the two controls are the same height. UI only. (#147)
- The Activity feed's footer no longer jumps or wraps onto two lines as it updates. "Updated just now" was wider than "Updated 3s ago", so in a narrow panel the row wrapped for a second at every refresh and pushed the note below it down. The time now reads "Updated Ns ago" from the first second, each text stays on one line in a fixed-height row, and a long count is cut with an ellipsis (its full text is the tooltip). The modal has the same footer. UI only. (#146)
- The server test suite no longer fails about one run in ten with a 404, a 401 or an empty body in a different test each time. supertest's servers listened on the wildcard address and the tests connected to `127.0.0.1`, and on macOS another process bound to `127.0.0.1` on the same port wins those connections, so a busy machine could answer a test with another server. A vitest setup file now binds those servers to `127.0.0.1`. Tests only; nothing changes at run time. (#137)
- "Est. cost today" no longer drops to nearly zero in the evening. The container ran in UTC, so the day rolled over at UTC midnight (5pm Pacific); `podiumctl` now gives it the host's timezone (or a `TZ` set with `podiumctl config set TZ=...`), which takes effect when the container is started again. The tile, the spend panel and the per-person split also now count what was spent since midnight, so a session left running overnight adds only today's part instead of nothing (#139).

### Documentation

- The README, the user guide, `docs/SPEC.md` and `docs/GOTCHAS.md` now say where a session's plan comes from: Claude's `TaskCreate` and `TaskUpdate` tools (or `TodoWrite`). A session that does not have those tools, or does not use them for the work, shows "No plan reported. Agents were launched ad hoc."; plan mode does not produce a plan, because Podium does not read it. A new gotcha, "A session shows no plan", says how to turn the task tools on. (#170)

## [0.13.0] - 2026-10-13

### Added

- The agent panel, and the orchestrator's, has an **Activity** section that shows what the agent is doing while it works: its recent tool calls (the tool and a short summary of its arguments, such as the command or the file) and the text it writes between them, newest at the bottom, the last 20. It refreshes every 5 seconds by default (10, 20, 30 or 60 seconds to choose from, remembered per browser), only while the panel is open and the tab is visible, follows the newest entry until you scroll up, and **Expand** opens it in a larger window that closes with Esc, the X or a click outside. It is observed only: nothing is captured, sent or kept unless someone is watching that agent. The server keeps the last 20 entries in memory while a viewer's short lease lasts and drops them when it lapses, when the session leaves or on restart; there is no history, and a viewer who comes back starts empty. Each entry is redacted and cut to 300 characters; the model's thinking is never sent. It needs the new reporter option `activityFeed` (Send an agent's recent activity), off by default; until it is on, the section says how. The report reply now lists the loops being watched (`watch`), reports carry `activity` and `session.activityFeed`, and there is a new route, `GET /api/fleet/sessions/:id/agents/:agentId/activity`. Mod 0.13.0; the server reads reporters up to 0.13.0. The simulator sends a scripted feed for watched loops. (#118)
- Admin > Settings has a new **Feature flags** group, above the wall notices, with one switch so far: **Agent activity feed**, on by default. Turning it off stops the activity feed for everyone on the server whatever each machine's `activityFeed` option says: the server grants no watch lease, tells every mod nothing is watched, drops what it held and keeps nothing sent anyway, and the activity route answers `enabled: false`. Open panels say "The activity feed is turned off by the Admin." and keep checking, so turning it back on resumes the feed without a reload. Flags are stored in the settings table, survive a restart, reach open browsers in the state (`features`), and each change is in the admin log (`feature_changed`). Server and console only; the mod is unchanged. (#118)
- The Podium logo and name at the top left are now a link to the fleet page on the wall, History and Admin, with a keyboard focus ring and a hover state. On the wall itself it changes nothing. UI only. (#133)

### Documentation

- Bug reports now ask for the output of `/podium`, run inside the Claude Code session that shows the problem, next to `podiumctl status`. The bug report template, `CONTRIBUTING.md` and the user guide's troubleshooting say how to run it, what it tells us, and to remove any secret before posting (it never prints the token). (#132)

## [0.12.0] - 2026-10-13

### Added

- Admin > Settings has a **Model prices** group: one row per model with five prices in US dollars per million tokens (input, output, cache read, 5-minute cache write, 1-hour cache write), starting from Anthropic's pricing sheet of 2026-10-13, with Reset to built-in, models you add by id (so a local model can be priced), and a second set for Haiku 5.5 prompts over 100,000 tokens. A saved price changes every cost at once: the wall, orchestrator and agent costs, the facts bar, Est. cost today, the spend panel and History; it is stored on the server, validated, and written to the admin log. The reporter now sends tokens per model and prompt-size tier (`usageByModel`, session and each agent) and the server prices them, so the session figure is an estimate from your prices instead of Claude Code's ledger when the reporter is 0.12.0 or newer; older reporters keep the cost they send. Mod 0.12.0; the reporter's own fallback prices were refreshed (Sonnet 5.5 cache reads $0.10, Opus 4.1 and 4 at $15/$75, Haiku 3.5). The cost-per-minute sparkline still follows the ledger. (#117)
- The model chip now shows the version as well as the family: `Sonnet 5.5`, `Opus 4.8`, `Haiku 4.5`, taken from the model id (`claude-sonnet-5-5`), on the wall, rail, history, orchestrator page, agent rows and panel. An alias such as `sonnet` or `opus[1m]` still shows the family alone, a non-Claude model keeps its raw name, and the color stays tied to the family. UI only; no protocol or mod change. (#116)

### Fixed

- Admin > Settings content sat flush against the edge of its panel, and opening it moved the whole page about 7 px sideways compared with the other Admin tabs, because its long page brought a scrollbar the others did not have. Settings now has the same padding as the other tabs, and every Admin tab reserves the scrollbar's space. (#117)

## [0.11.2] - 2026-10-13

### Added

- `/podium` now lists the background work the reporter holds, one line per entry (type, status and description), or `Background work: none`. Mod 0.11.2. (#128)

### Fixed

- A session no longer says it is waiting on background monitors when the only ones listed are Claude Code's artifact live-update watchers (`live updates for artifact <url> (re-armed on session resume)`). They run as long as the session does, so ten of them kept the card on "Waiting for 10 background monitors to finish" after every turn. The mod (0.11.2) and the server's settings-hooks path both leave them out; any other monitor still counts. (#128)

## [0.11.1] - 2026-10-13

### Added

- Claude Code's status line now starts with the reporter's version, `podium v0.11.1 ● 3 live`, in every state (connecting, offline, token refused, and the update hints). When the server supports a newer major.minor than the mod, it ends in `· update available`, and `/podium` says which versions are involved. Mod 0.11.1; no protocol or server change. (#125)
- The facts bar on the orchestrator page now shows the reporter's version in a **Reporter** cell just before Copy resume command, for example `0.11.0`. A session with no mod says "Settings hooks", and a reporter outside the range the server supports shows `0.3.0 · update` or `0.99.0 · upgrade server` in amber, with the same tooltip as the card's chip. No protocol or mod change. (#124)

## [0.11.0] - 2026-10-13

### Added

- Wall notices now sit at the bottom of the wall, one per row, each with an X. Closing one turns it off for everyone and shows a confirmation that names it and links to the new **Settings** tab in Admin, which has an On/Off switch for every notice and a **Show background sessions on the wall** switch. That second switch replaces the per-tab state behind Show them, so the choice now holds across reloads and browsers. The settings are stored on the server and pushed to open tabs. (#114)

### Fixed

- A session idle on a background shell, monitor, agent or workflow, or on a scheduled wake-up, now says "Waiting for 1 background shell to finish." (or "Waiting for a scheduled wake-up at 14:30.") instead of "Waiting for your input." It is drawn in blue with a pulsing ring on the card, rail, orchestrator page and activity feed, and is not counted in "waiting on you" (#119). The mod (0.11.0) reads `background_tasks` and `session_crons` from the Stop hook and sends `session.background`; a shell's command is never sent. Settings-hook sessions get the same wording without a wake-up time.
- An agent's Tokens is back to the context at its latest request, without its output tokens added. Adding every output token the agent had written (#108) counted earlier output twice, because the newest request's context already contains it, so the figure ran further above Claude Code's the longer the agent worked (592k against 464.6k in a real run). The orchestrator row and the totals are unchanged. (#120)
- The facts bar on the orchestrator page now adds up. The orchestrator's row showed the whole session's cost, the same figure as the bar, so the rows summed to far more than the total; it now shows its own share (the session's cost less each agent's estimate) and the rows add up to the bar. A real run confirmed that Claude Code's session figure includes every agent: it rose by about the new agent's estimate when one finished. The Agents cell counts the orchestrator (running while the session runs, done once it is done, neither while it is stale), as do the rail and the card. A new **Agent time** cell sums the orchestrator's time and every agent's, beside the wall-clock **Running for**. The Orchestrator model and Context cells are gone, because the orchestrator's row in the agent table already shows its model, effort and context. The wall's "agents running" tile still counts agents only. (#109)

### Documentation

- Mockup for a session that is idle on a background process or a scheduled wake-up (#119): it says what it is waiting on, in blue, and is not counted as waiting on you.

## [0.10.0] - 2026-10-12

### Added

- The agent panel has a **Report** group with two buttons, Task prompt and Final answer, that open the text in a modal with markdown rendered as formatting. A button is dimmed and inert when there is nothing to show (and the answer says "not finished" while the agent runs). The modal blurs the page behind it, closes with the X, Esc or a click outside, keeps focus inside and gives it back, and has a Copy button. Raw HTML in the text is shown as text. The whole prompt and answer need the new opt-in `fullPrompts` reporter option (mod 0.10.0, off by default): they are redacted, cut at 20,000 characters, sent once, stored in a new `agent_texts` table and fetched when the modal opens from `GET /api/fleet/sessions/:id/agents/:agentId/text`. Without it, or with an older mod, the modal shows the 400-character excerpt and says why. The supported reporter range is now 0.2.0–0.10.0. (#97)
- `npm run podium:sim -- --nested` keeps one session running agents that launch agents: a subagent under a subagent four levels deep, a fork under a subagent and a subagent under a fork. In every scenario an agent now waits for the agents it launched before it finishes, and a nested fork inherits its parent agent's model and effort. (#101)

### Changed

- Agents that launch agents now show correctly everywhere. A real run on Claude Code 2.1.296 showed that a subagent can launch a subagent or a fork, and a fork a subagent, and that the mod already reports the real parent at every depth, so the mod is unchanged (SPEC 5.3 records what the engine gives). Sorting the agent tree by a column used to flatten it into one list; it now keeps every agent under the one that launched it and sorts each group of siblings, and "Show as tree" is now "Launch order". Past two levels the Task column widens and the table scrolls sideways, so a deep row keeps its text, and each row's full task is its tooltip. The agent panel says who launched the agent and, for an agent that launched others, adds its branch up ("With its agents"). Cost tooltips say that an agent's row is its own estimate and that the orchestrator's row, the facts bar and the card are the whole session. The card's squares follow the tree and name a nested agent's parent, and a nested launch in Activity says which agent launched it. The note on a settings-hooks session now says it cannot show who launched an agent. (#101)
- A row in the agent tree that is running while agents it launched are running now reads "delegating" (blue, hollow dot) instead of "running", and so does the orchestrator in the page header; hover it for the agents it waits on. This covers an agent waiting on its own subagents and forks too. It is display-only: the session status, the fleet wall, the filters and every count still say running, and a session waiting on you still shows "waiting on you". New `--deleg` colors are defined for every theme and mode, and `scripts/theme-contrast.ts` checks them. A background agent also counts, since Podium cannot tell the launch modes apart. (#98)
- An agent's Tokens figure now matches Claude Code's own agent line. It was a running total of input, output, cache read and cache write, so each request counted the whole cached context again and the number read about 100 times too large (38.95M against 395.4k for the same agent). It is now the context the agent holds at its newest request. The orchestrator row shows its own context, and the facts bar and wall card add the orchestrator and its agents. Every Tokens label has a tooltip with this definition, and the agent panel lists the running totals under "Used so far". The tokens-per-second charts and the "tokens in the last minute" tile are unchanged. (#96)

### Fixed

- The Agents tile on the orchestrator page no longer wraps "· 0 done" onto its own line and leaves the dot hanging. The tile now reads "N running / N done" on one line that never wraps (the done count in muted ink), with the "N failed" button after it. It sizes to its content (about 320 px at "9999 running / 9999 done" with a "9999 failed" button), and the Est. cost, Tokens and Running for tiles now start at their content width instead of 110 px to leave it room, so the facts bar stays on one row down to about 860 px wide (950 px with the failed button); when the bar is too narrow, whole tiles move to a second row instead of text wrapping inside one. No other tile had a separator inside a wrapping item. (#100)

## [0.9.0] - 2026-10-12

### Added

- A people view for a Podium that several people report to. Once any live session belongs to a named person (from a person's token, see #36), the wall groups orchestrators into a band per person: the person's monogram and name, their group, the machines they report from, how many sessions are live, waiting or stale, and their share of today's estimated spend. Each card names its machine. Sessions sent with the admin secret are under Admin and sessions with no owner under Unassigned, after the people. Group by switches between People, Group (a band per group from Admin, each card naming its owner, people without a group under No group) and None (the flat wall with an owner on each card). Bands can be ordered by who needs attention, by spend or by name, and collapse to their header. The left list groups the same way, and clicking a person or group there narrows the wall to them. "You are" tells this browser who is looking (remembered in `localStorage`), which pins your own band first and makes "Only me" work. The right panel starts with "Spend today, by person" (or by group), as a bar chart or a table. With no named person the console looks exactly as before. The simulator takes `--person NAME[=TOKEN]` and `--unnamed` to demo it. (#34)
- Sessions now say which machine they run on. A reporter with a `userName` set also sends `machine`: the short host name and a random id the mod keeps in its own store, so two machines with the same host name stay apart. An unnamed reporter sends neither, and nothing is read from the operating system user or `git config`. The server stores it (database migration 7, `sessions.machine_json`) and returns it on every session with the owner's group (`machine`, `ownerGroup`), and the KPIs split today's estimated spend by owner (`costTodayByOwner`). The mod moves to 0.9.0 and the supported reporter range to 0.2.0–0.9.0; an older reporter works unchanged. (#34)

### Changed

- The Fleet page's top bar drops the local-time clock and gets a "Fleet" pill after the logo and name, the same kind of pill the Admin page has, so each page says which one it is. Nothing is placed to the right of the connection pill, because its width changes as "synced Xs ago" ticks. (#91)
- The legend (what the agent squares mean, and the model colors) is now a footer at the bottom of the middle column instead of the last thing in the wall's content. It no longer scrolls away with the cards or sinks off screen when there are many sessions. It shows on the fleet wall and on the orchestrator page, is centered on a background halfway between the card color and the page, with a top border, and stays visible in wall mode. The left rail and the right panel keep their full height beside it. In the stacked layout below 1040 px it is the last thing on the page, with extra padding. The wording and swatches are unchanged. (#92)

### Fixed

- The heartbeat-lost message on a card, and the same notice on the orchestrator page, now reads as one sentence.
  It used to show wide gaps around the time and a gap before the final period (`Last heartbeat 0:34 ago. Goes
  away in 41 s .`), because the alert box spaced every piece of text and every time as a separate item. The
  wording and the countdown format are unchanged. (#87)
- In the activity list the colored square now sits level with the time and the first line of text. It used to
  be centered in the row, so on a row that wrapped to two lines (the text and the `Open agent` link) it floated
  between them. The square keeps its size and color; the yellow ring on a waiting row moves with it. (#88)

## [0.8.0] - 2026-10-12

### Added

- An Admin section where the server owner makes a token for each person, bound to that person's name. Open it from the new Admin button in the top bar's upper right (`#/admin`) and enter the admin secret, which is the `PODIUM_TOKEN` that `podiumctl token` prints. Admin has four tabs, People, Groups, Reporting and security and Admin log, and every list is paged by the server (50 rows by default, at most 100) with a search over name, group and machine. A token (`pdm_<key id>_<secret>`, 192 bits of randomness) is shown once with the settings to paste, then only its last four characters; the database keeps a SHA-256, never the token. A report is accepted only when its token is live and the `userName` it sends is that token's person, so a valid token with another person's name, an unknown name, a revoked token or a token rotated away is refused with a 401. The server decides who a session belongs to from the token and stores it in `sessions.owner`; the shared `PODIUM_TOKEN` keeps working for reporting (owner `Admin`, with a switch in Admin to turn that off), so an existing setup is unchanged. Groups are labels for arranging people, one per person, and deleting a group moves its people to "No group". Admin locks after 10 idle minutes, five wrong secrets lock a source address for 15 minutes, every change needs an `X-Podium-Admin` header and the server's own origin, responses are `no-store`, and unlocks, failed unlocks, changes and their source addresses go in the admin log; no token or secret is logged, returned again or kept in browser storage. Without a `PODIUM_TOKEN` Admin is off. This adds a database migration (version 6: `people`, `groups`, `person_machines`, `admin_log`, `settings` and `sessions.owner`), `userName` on the report and `owner` on a session, a `userName` mod option, and moves the mod to 0.8.0 and the supported reporter range to 0.2.0–0.8.0. The mod now treats a 401 as a refused credential: it keeps its events, logs it once, shows `podium ○ token refused` and tries again about once a minute, where it used to retry with a short backoff and say nothing. Tokens still travel over plain HTTP, so a server reachable over a network needs a trusted network or a TLS proxy. (#36)

## [0.7.0] - 2026-10-12

### Added

- A session nobody is attached to is marked and then set aside. After `/exit` under the Claude Code daemon the conversation keeps running as a background job, and its card used to look like any live session. Now the card turns dashed and muted with a "nobody attached" chip and a countdown, and after `DETACHED_HIDE_AFTER_MS` (60 seconds by default) it leaves the wall behind a "N background sessions hidden" line with a Show them button. `claude attach` brings it back at once. The mod reads `$.session.surfaces()` and the `session.attach` and `session.detach` events and reports `session.attached`; the server stores it with a database migration (version 5) and serves `attached` and `hideAt`. A report with no field, from a mod older than 0.7.0, counts as attached. Mod 0.7.0. (#45)

### Changed

- The dashboard uses still less GPU. The running-dot pulse and the agent and plan-step blinks no longer each run their own CSS animation. They all step on one shared beat, four times every 1.8 seconds, so the page changes a few times a second instead of at a different moment for every dot. With ten simulated sessions and a hundred agents on screen, Chrome on an M5 MacBook Pro went from about 31% to about 24% GPU (a plain page reads about 15%), alternating the previous build and this one in one tab. The animation looks the same as the stepped one from the last release. Reduced motion and a hidden tab still stop it. Applying incoming data on the same beat was tried and measured no gain, so it was left out. (#81)
- The dashboard uses less GPU. With ten simulated sessions and a hundred agents on screen, Chrome on an M5 MacBook Pro went from about 41% to about 27% GPU (a plain page reads about 15%), measured with `scripts/gpu-sample.sh` alternating the old and new styling in one tab. The running-dot pulse is now a ring that scales and fades instead of animating `box-shadow`, and the pulse and the agent and plan-step blinks move in a few steps a second instead of a smooth fade, because a smooth animation that never ends makes the browser draw a frame on every display refresh for as long as the tab is open. The progress bars no longer slide between values, and every animation pauses while the tab is hidden. The pulse and blink look slightly more stepped than before; reduced motion still turns them off. Safari and Firefox were not measured. (#81)

### Documentation

- The README and the user guide now say that load grows with the number of sessions and agents reporting, what grows on the server and in each open tab, an example measurement from #81, how to measure your own with `scripts/gpu-sample.sh`, and what lowers it. (#107)

## [0.6.0] - 2026-10-12

### Added

- The orchestrator page's plan section is now two tabs, Plan and Files. Files lists every file the session changed, with its status and the lines added and removed (`+12 −3`), a summary with the totals, and a pager at 20 files a page. It reads the changes from `git diff` against the commit the session started on, so committed work stays listed after the git row's `N modified` has gone, and a binary file shows the word `binary` instead of counts. The left column grows from 300 to 400 px while Files is open. With nothing changed the tab says where files will appear, and when the session's mod is older than 0.6.0 a note says to update it. The report gains `session.files` (SPEC 5.7, 6.2), stored in a new `sessions.files_json` column (migration 4) and cut at 200 files with totals over all of them. This moves the mod to 0.6.0 and the supported reporter range to 0.2.0–0.6.0; an older mod keeps working and shows the empty tab. File paths and line counts now leave the session, never contents (README). (#26)

## [0.5.0] - 2026-10-12

### Changed

- A session that runs a model that is not a Claude model, such as one served by Ollama, is no longer priced as Sonnet or given a 1,000,000-token window. It keeps its own model name with an "other" chip that says it is not a Claude model, its cost reads "n/a" with the reason, its context shows as unknown when Claude Code does not report a window, and the "Est. cost today" tile leaves it out and says how many sessions it skipped. A model whose name merely contains `opus`, `sonnet`, `haiku` or `fable` (`my-sonnet-finetune`) is no longer taken for that family; only a bare alias or an id containing `claude` is. Claude models are unchanged. A report can now carry `null` for an agent's `costUsdEst`, so this moves the mod to 0.5.0 and the supported reporter range to 0.2.0–0.5.0; a 0.5.0 mod talking to an older server may have a report with a null cost rejected, and the version notice says to upgrade the server. (#66)

## [0.4.0] - 2026-10-12

### Added

- The orchestrator panel now shows Steps, the tools it used as chips (most used first, as in the agent panel) and Skills loaded, on the live page and on the History page. They are the orchestrator's own: calls made by the agents it launched stay in those agents' panels. This adds a `loop` block to the report's `session` (SPEC 6.2), a database migration (version 3, a nullable `sessions.loop_json`), and moves the mod to 0.4.0 and the supported reporter range to 0.2.0–0.4.0. A mod older than 0.4.0 sends no `loop`, so its panel stays as it was and one note says the rows need podium-reporter 0.4.0 or later; a settings-hooks session shows neither the rows nor the note. The update notes (this one and the agent panel's tool-counts one) now ignore a version that is not plain `major.minor.patch`, such as the simulator's `0.1.0-sim`, and this one is not shown for an ended session. (#75)
- The agent panel now says why it shows a Last tool line instead of tool chips: when the session's mod is older than 0.2.0, a note says tool counts need podium-reporter 0.2.0 or later and how to update it. A current mod and a settings-hooks session show no note. (#76)

## [0.3.0] - 2026-10-12

### Added

- Podium now says when a reporter and the server are on versions that do not match. The server keeps a range of reporter versions it supports (SPEC 6.8) and tells each reporter where it stands in the reply to a report. The mod shows `update mod` or `upgrade server` on its status line, in `/podium` and as a toast. The dashboard marks the affected cards, counts them in the top bar and says what to do on the session's page. Reports from a mismatched reporter are still accepted. The left rail footer now shows the server's version beside the credits and the license. This adds `serverVersion`, `reporterSupport` and `reporterCompat` to the reply, `reporterVersion` and `compat` to each session, a `server` block to the state, `--reporter-version` to `npm run podium:sim`, and a mod bump to 0.3.0. (#49)
- The orchestrator's row in the agent tree is now a button, like an agent row. Clicking it, or pressing Enter on it, opens an orchestrator panel on the right with its name, status, model, effort, context, tokens, cost, time and git line, and a Back button. It works the same on the History page and for a session reported by settings hooks. Steps, tools and skills were left out of it at first, because the report did not carry them for the main loop; #75 adds them. (#63)

### Changed

- A session that is waiting on you now reads as a plain message in the activity feed, in the same yellow as the card: "Waiting for your approval." or, for a question, "Waiting for your input.", with the tool name (`Bash`, `ExitPlanMode`, `AskUserQuestion`) in a chip under it, instead of the raw tool call cut off at 160 characters. Once the session logs anything newer, the row turns plain and reads "Waited for your approval." The card and the orchestrator page use the same two sentences, so the card now says "approval" for a permission prompt and "input" for a question, where it used to say "input" for both. Events already stored read the same way. (#68)
- Four more activity feed rows read as plain sentences. A turn that ended after a failing call says "Turn ended with an error after a failing call." with the tool in a chip, instead of printing the whole call. A session end says "Session ended (cleared)." instead of `session.end · clear`, a session start from settings hooks says "Session started." (or resumed, or continued after compaction), and an agent seen only by settings hooks says "Spawned Explore." Events already stored read the same way. (#68)
- The orchestrator page's waiting callout now leads with "Waiting for your approval. Answer in its terminal." (or "input" for a question) and shows the tool name, such as `Tool: ExitPlanMode`, as a muted line under it, instead of the raw tool call cut off at 160 characters. A note that was cut off is left out rather than shown as if it were the whole prompt. The card and the activity feed are unchanged. (#64)

### Fixed

- Clicking an agent row no longer flashes orange patches behind its cells. A clicked row now shows only the
  selected background. Opening an agent from an activity entry still flashes its row, now as one band across
  the whole row. (#70)
- Cards on the fleet wall keep a steady 360 px width (narrower only when the area itself is). Collapsing or
  expanding the left pane, the right pane or the top bar, or entering Wall mode, now adds or removes columns
  instead of shrinking every card, and a short last row stays left-aligned. (#65)

## [0.2.0] - 2026-10-12

### Added

- The agent panel shows every tool an agent used as chips with their call counts, most used first, five at a time with a Show all / Show fewer button, and marks the tool used last. This adds `toolCounts` to each agent in the report, a database migration (version 2), and a mod bump to 0.2.0. A reporter older than 0.2.0 still works and the panel shows its Last tool line as before. (#25)
- Color themes: a Theme dropdown in the row under the top bar (Podium, Solarized, Nord, Gruvbox, Catppuccin, GitHub) with a Light, Dark or System mode for each, replacing the Theme toggle button. A footer in the bottom left of the left rail links the palette credits and the license and shows the copyright. Podium stays the default, an old light or dark choice carries over, and the choice is applied before first paint. The palettes are credited in `THIRD_PARTY_NOTICES.md`, and `scripts/theme-contrast.ts` checks contrast for every theme and mode. (#32)
- The left pane, the right pane and the top bar collapse and expand on their own, from edge buttons and from `[`, `]` and `\`, and are remembered across reloads. A Wall mode button (or `w`) collapses all three at once, asks for fullscreen, hides the cursor and its own buttons after a few idle seconds, and leaves with `Esc` or the Exit button. A lost connection still shows its red alert with everything collapsed. (#33)
- A heartbeat-lost card, its rail row and its page have a Remove control that takes the session off the wall at once in every open tab. The session stays in History and returns if it reports again. (#41)

### Changed

- A heartbeat-lost card now counts down to when it goes away ("Goes away in 37 s") instead of showing a fixed "Dropped from the fleet at 1:15". The server sends the time as `dropAt`, so it is right after a server restart and for hook-only sessions. (#41)
- Effort shows as five colored bars with no text, and the level is in a tooltip and the meter's accessible name. Each level has its own color (low orange, medium green, high blue, xhigh purple, max rainbow). The Agents table's Effort column shrank to fit and its freed width went to the Context, Tokens, Cost and Time columns. (#24)
- The README, `docs/GOTCHAS.md` and `docs/SPEC.md` now explain the `⚠` in front of Podium's status line:
  Claude Code adds it, with the mod's name, to every mod's status line, and it is not a Podium warning or a
  trust state. (#29)

### Fixed

- Two sessions no longer show the same running time because the engine reported them one shared start. The
  server keeps a session's reported start only when it is within 2 minutes of the first report; otherwise
  the session counts from when the server first heard of it, and the start never changes after that. A
  resumed session therefore counts from its first report. (#43)
- With the server in a container, project and working-directory paths under your home now show as `~/...`
  on the wall, in the focused view and on the history page, as they do in standalone mode. `podiumctl`
  passes the host's home to the container as `PODIUM_HOST_HOME`; an unset or non-absolute value is
  ignored, so no wrong `~` is shown. (#20)
- A long branch name on a session card no longer wraps mid-name: it ends in an ellipsis, and a long
  worktree name does the same, with the full value in the tooltip. A project path that does not fit is
  now cut from the front, so the last folders stay visible, and its tooltip shows the full path. The focused
  view still shows both in full. (#19)
- A session card whose content is shorter than the card beside it now starts at the top, with the extra
  space at the bottom, instead of centering its content vertically. The cards in a row still stretch to the
  same height. (#17)
- A session card for a session waiting on you now says only `Waiting for your input.`, for a permission
  prompt and a question alike, instead of a block of the prompt's text that filled most of the card. The
  orchestrator page still shows the full note. (#50)
- In the agent detail panel, the Kind row is now an icon and one word (`Subagent`, `Fork` or `Teammate`) on
  one line, aligned with its label. The icon takes the agent's model color, as the squares in the session
  card's agent strip do. The explanation moved into a tooltip, on hover or keyboard focus, and is the
  value's accessible description. (#28)
- Sessions nobody asked for no longer show up as cards. Claude Code's background daemon runs a parked
  twin of an interactive window and a pool of pre-warmed spares, and each one loads the reporter and
  reported as a session of its own. Opening one window in a project could put three identical "waiting on
  you" cards on the wall. A session now appears once it has done something (tokens, cost, context, an agent,
  a plan or a blowout, or it is running), and stays off the wall, the activity feed, the history and the
  cleared-today count until then. Sessions known only from settings hooks are not filtered, since hooks
  carry no usage. (#42)
- `podiumctl start --mode standalone` no longer reports "Podium is up" when another process already holds
  the port. It fails before spawning, names the port and suggests `podiumctl status` or `--port`. If the
  server it spawned exits during startup, `start` now fails, shows the end of `podium.log` and leaves no
  pid file behind.
- In the Agents table, the Status text and icon no longer sit about a pixel lower than the Tokens, Cost and
  Time values on the same row. The Model and Effort cells had the same small offset and are centred with it.
  (#31)
- On a session card, the cost, token count and duration line no longer breaks in the middle of a value.
  When the three do not fit beside the sparkline, whole values move to the next line, so `15h 54m` stays
  together. (#18)
- In the Agents table, the Time column is wide enough for the longest duration the dashboard shows
  (`23h 59m`, or `999d 23h` for a very long session) and no longer wraps `16h 21m` onto two lines. A test
  fails if the duration format ever gets longer than the column. (#23)

### Removed

- **Breaking:** the usage dashboard is gone: the "Usage dashboard" link in the top bar, the `#/usage` page
  (a `#/usage` link now opens the fleet console), the `/api/claude-code` and `/api/api-usage` routes, and
  the `recharts` dependency. The `ANTHROPIC_ADMIN_API_KEY` setting is retired: `podiumctl` ignores a
  leftover value and `podiumctl config unset ANTHROPIC_ADMIN_API_KEY` clears it. (#30)

## [0.1.0] - 2026-10-11

First release. The repo started as a usage dashboard and became Podium, a live
fleet console for Claude Code sessions, with a container, a command-line manager
and a plugin you can install from a marketplace.

### Added

- **Podium fleet console** (`#/`, the default view). Every Claude Code session
  running with the reporter mod shows up in one browser tab within about two
  seconds: model and effort, plan, the agents it launched (subagents and forks),
  estimated cost, context-window fill, context blowouts, failures with the
  failing call and its last output, and the git branch or worktree. Sessions
  appear and leave on their own. Podium only observes; it never sends a prompt or
  touches a session. (PR #2)
- **Reporter mod** (`mod/podium-reporter/`): a Claude Code mod that reports a
  full snapshot plus unacknowledged events, redacts anything that looks like a
  secret, queues reports while the server is down, and adds the `/podium`
  command and a status line entry. Options: `serverUrl`, `token`,
  `flushIntervalMs`, `heartbeatMs`, `sessionName`, `showStatus`,
  `explainFailures`. (PR #2)
- **Server** (`server/src/fleet/`): hand-written validation of every report,
  SQLite storage through `node:sqlite`, Server-Sent Events for live updates,
  stale and drop timers, retention, and a `/history` endpoint. A shared token
  (`PODIUM_TOKEN`) guards reports, hooks and deletes. (PR #2)
- **Settings-hook ingest** (`POST /api/fleet/hook`): a reduced view of sessions
  started without the mod, from Claude Code's settings hooks. (PR #2)
- **History page** (`#/history`) listing the sessions that ended on a chosen
  day. (PR #2)
- **Simulator, smoke and soak scripts** (`scripts/podium-sim.ts`,
  `podium-smoke.sh`, `podium-soak.sh`) for developing and checking Podium with no
  real sessions. (PR #2)
- **`podiumctl`** (`bin/podiumctl.mjs`): start, stop, restart, status, logs,
  health, token, config, enable and disable (start on boot through launchd or a
  systemd user unit), shell and rm, in either a Podman container or a standalone
  Node process. The first start generates an auth token and saves it to
  `~/.podium/config.env`. (PR #3)
- **Container image** (`Containerfile`): a two-stage Node 24 build that runs as
  a non-root user and keeps its database in a `/data` volume. (PR #3)
- **Marketplace install.** `podium-reporter` is listed in
  `eengelking-marketplace` (`eengelking/skills`):
  `/plugin install podium-reporter@eengelking-marketplace`. (`eengelking/skills`
  PRs #32 and #33)
- **Docs:** `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DEMO.md`,
  `docs/DECISIONS.md`, `docs/GOTCHAS.md`, `docs/USER_GUIDE.md`, `CONTRIBUTING.md`
  and the `.github/` community files, issue and PR templates, and CI.
  (PRs #1, #4, #6 and this release)
- **Usage dashboard** (`#/usage`, the earlier app): charts Claude Code and
  Anthropic Admin API usage from local logs and the Admin API.

### Changed

- The project was renamed from `claude-dashboard` to `podium`
  (`eengelking/podium`). (PR #5)

[Unreleased]: https://github.com/eengelking/podium/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/eengelking/podium/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/eengelking/podium/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/eengelking/podium/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/eengelking/podium/compare/v0.14.3...v1.0.0
[0.14.3]: https://github.com/eengelking/podium/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/eengelking/podium/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/eengelking/podium/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/eengelking/podium/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/eengelking/podium/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/eengelking/podium/compare/v0.11.2...v0.12.0
[0.11.2]: https://github.com/eengelking/podium/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/eengelking/podium/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/eengelking/podium/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/eengelking/podium/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/eengelking/podium/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/eengelking/podium/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/eengelking/podium/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/eengelking/podium/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/eengelking/podium/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/eengelking/podium/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/eengelking/podium/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/eengelking/podium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/eengelking/podium/releases/tag/v0.1.0
