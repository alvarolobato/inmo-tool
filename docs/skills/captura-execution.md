# Captura — task-driven guided-capture execution UI

**Page:** `dashboard/app/captura/page.tsx` — top-level, next to Perfiles (issues #268/#284 → task-driven in #289 → redesign #413, part of #237).
**Decisions:** [D-045](../decisions/D-045-capture-execution-top-level.md) — execution is top-level, setup is admin-gated (superseded in its *location* clause by issue #642 P1: setup moved from `/etl/*` to `/admin/fuentes/[name]`; the execution-vs-setup split itself stands). [D-048](../decisions/D-048-task-driven-captura.md) — Captura is a list of discrete recurring TASKS with a per-task staleness window. [D-112](../decisions/D-112-batch-capture-pending-search-queue.md) — the extension-side pending-search queue this page's batch button feeds. [D-113](../decisions/D-113-capturar-todo-batch-queue-piggyback.md) — how "Capturar todo" hands additional searches to the extension with no direct dashboard→extension channel. [D-114](../decisions/D-114-global-capture-selection.md) — "Capturar todo" is ONE page-level control across every VISIBLE profile (not one per profile), selection keyed by `(profileId, taskId)`, per-task ticking exposed without expanding anything.

**#413 redesign note**: the page is now a SERVER component that stacks every
active profile (no more one-profile-at-a-time dropdown); under each profile
its connectors (portals) render as collapsible sections — DUE/A-MEDIAS start
expanded, "al día" collapses to a stats line. The "Composition" table and flow
description below predate that redesign in places (e.g. `PortalCaptureCard`
was replaced by `CapturaProfiles`/`CapturaProfileSection`/`ConnectorSection`)
— treat the **Components** section below as current, the surrounding prose as
historical context for the task-driven model itself.

## What it is

The first-class, owner-facing EXECUTION surface for guided capture. Distinct
from the admin SETUP surfaces (extension install, API key, connector config,
the capture worklist ledger) — those lived under `/etl/*` through issue #642
P1, which merged connector config (`/etl/connectors`) and the worklist ledger
(`/etl/captura`) into `/admin/fuentes` (list) + `/admin/fuentes/[name]`
(detail, one page per source); both old routes 301 there. The day-to-day loop:

1. Pick a search profile (`GET /api/profiles`).
2. See a list of discrete capture **TASKS** — one openable pre-filtered search
   per (portal × searchable section), grouped by portal. Because Idealista
   searches one property-type section at a time, a multi-type profile yields
   SEPARATE tasks, each its own button. No merged "ampliada" note — each section
   is its own task.
3. Per task: a **checkbox** (issue #556, ALWAYS visible outside the
   connector's collapsible — issue #559 — pre-ticked exactly when the task is
   due — see "Capturar todo" below) and a **button** that (a) records the run
   (`POST /capture-task-runs`) then (b) opens the URL in a new tab — the
   extension's batch capture (#262) takes over. A **last-done** note ('hecho
   hace 3 días' / 'nunca'). Any `loosened` flags inline.
4. A task run within its **staleness window** greys out (done / not due); once
   the window elapses it returns to colour (due again). Graying is a visual cue
   — the button stays clickable for an optional re-run, never blocked. The
   same is true of the checkbox: ticking/unticking is independent of the
   greying, and never blocked either.
5. **ONE "Capturar todo" button for the whole page** (issue #556, corrected to
   be page-level rather than per-profile by issue #559/D-114 — owner: *"te
   pedí un seleccionar todo que funcione en todos los perfiles a la vez y un
   capturar para todos también, no por perfil"*), spanning every profile
   currently VISIBLE under the optional profile filter, labelled with the live
   ticked count ("Capturar 7 tareas"), plus ONE Todo/Nada pair (select-all/none)
   — never a per-profile copy of either. Clicking it records a
   `capture_task_run` for every ticked task (against ITS OWN profile's
   endpoint), then opens ONLY the first ticked task's tab (in the click's user
   gesture) — the rest are handed to the extension's OWN pending-search queue
   (#555/D-112), which opens them itself, one at a time. See "Capturar todo —
   the batch button" below for the full mechanism and why it works this way.

It never captures or navigates itself (that's the extension), and never
re-implements the URL grammar or the batch loop (it reuses their APIs).

## Composition (reuses existing infra — do not duplicate)

| Piece | Source |
|-------|--------|
| Profile list | `GET /api/profiles` → `SearchProfileRow[]` |
| Per-(portal×section) tasks + loosened flags | `GET /api/profiles/[id]/search-urls` → `{ tasks: {id, portal, label, url, loosened[]} }` (#267/#289, `lib/search-url/`) |
| REAL per-portal capture activity (headline) | `extension_capture` (status='done', by URL host) → `getPortalCaptureActivity()` (#289) |
| Per-portal worklist roll-up (secondary line) | `GET /api/etl/worklist` (#260, `lib/worklist.ts`) |
| Last-run ledger + staleness config + activity | `GET/POST /api/profiles/[id]/capture-task-runs` (#289) |
| Pure view-model (normalise + staleness) | `dashboard/lib/captura-tasks.ts` — `normalizeTasks`, `taskStaleness`, `lastDoneLabel`, `resolveStalenessDays`, `groupTasksByPortal` |
| Staleness config reader (server) | `dashboard/lib/captura-staleness-config.ts` — `getStalenessConfig()` |
| Persistence (server) | `dashboard/lib/db/capture-task-run.ts` — `getTaskRuns`, `recordTaskRun`; table `capture_task_run (profile_id, task_id, last_run_at)` |
| Per-profile stacked list + optional filter + GLOBAL "Capturar todo" (#556, page-level since #559/D-114) | `dashboard/components/captura/CapturaProfiles.tsx` |
| Per-profile TRANSLATOR: maps the global selection down to plain per-task ids (#559) | `dashboard/components/captura/CapturaProfileSection.tsx` |
| Per-connector (portal) collapsible section + the ALWAYS-VISIBLE per-task checklist (#559) | `dashboard/components/captura/ConnectorSection.tsx` |
| Per-task FULL detail row (button, loosened flags, last-done — no checkbox of its own, #559) | `dashboard/components/captura/CaptureTaskRow.tsx` |
| Per-profile selection→queue pure mapping (#556, kept, still used internally) | `dashboard/lib/captura-tasks.ts` — `defaultTickedTaskIds`, `allProfileTasks`, `buildCaptureBatchPlan`, `capCaptureBatchPlan` |
| Cross-profile selection→queue pure mapping (#559, D-114) | `dashboard/lib/captura-tasks.ts` — `selectionKey`, `ProfileTask`, `allTasksAcrossProfiles`, `defaultTickedSelectionKeys`, `buildGlobalCaptureBatchPlan`, `capGlobalCaptureBatchPlan` |
| Batch-queue URL-fragment piggyback (#556, D-113 — untouched by #559) | `dashboard/lib/extension-capture.ts` — `withCaptureQueue`, `encodeCaptureQueue`/`decodeCaptureQueue`, `CAPTURE_QUEUE_SIGNAL`, `MAX_QUEUE_ENTRIES` |

### `tasks[]` normaliser (transitional)

`normalizeTasks()` consumes the restructured `tasks[]` verbatim when present and
**adapts the legacy `urls[]` shape** (one PortalSearchUrl per portal) into tasks
— synthesising a deterministic `id` (`fallbackTaskId`, djb2 over `portal|url`)
and a Title-case label — so the UI + tests work before the search-url `tasks[]`
restructure merges. `TODO(#289)`: drop the `urls[]` branch once it lands.

## Progress = REAL captures, not just seeded worklist

The **headline** per-portal progress is the owner's REAL capture activity —
`extension_capture` rows that reached 'done', keyed to a portal by URL host
(`getPortalCaptureActivity()`, same host logic as `portalForUrl` / etl/capture.py)
— shown as "N propiedades capturadas · última hace X". This is critical because
captures made by opening detail pages one by one seed **no** `capture_worklist`
row: a worklist-only progress reads empty even after 10 successful captures
(live-owner bug, #289). The seeded-worklist roll-up is kept as a **secondary**
line ("lista: M/T …") for batch runs that do seed it. The totals strip sums the
real captured count across the profile's portals. Activity is GLOBAL per portal
(extension_capture has no profile column), framed against the profile — same
framing as the worklist roll-up.

## Staleness window (settings)

Config keys in `config/schema.yaml`, section **Captura**, read via the config
loader (env > config.yaml > default):

- `capture.staleness_days` (int, default **7**) — global window.
- `capture.staleness_days_<portal>` (e.g. `_idealista`, `_aliseda`; default
  null) — per-portal override; unset inherits the global.

`resolveStalenessDays(portal, config)` = per-portal ?? global. The pure
`taskStaleness(lastRunAt, windowDays, now)` decides `{done, muted, due}`: never
run → due; run < window ago → muted; run ≥ window ago → due again.

## "Capturar todo" — the batch button (issue #556, corrected to page-level by #559/D-113/D-114)

**ONE button for the whole page**, below the profile-filter select, labelled
with the live ticked count (`CapturaProfiles.tsx` — moved here from
`CapturaProfileSection.tsx` by #559; that component is now a thin per-profile
translator, see the Composition table). Owns ONE cross-profile `Set<string>`
of `selectionKey(profileId, taskId)` pairs — pre-populated by
`defaultTickedSelectionKeys` (every task where `ConnectorTaskView.due ===
true`, across EVERY profile — D-048's staleness computation, never
re-derived) — plus ONE Todo/Nada pair (select-all/none, acting on every task
of every currently VISIBLE profile, expanded or collapsed connectors alike),
and the LIFTED `runOverrides` (optimistic per-task "just ran" state, keyed the
same way, shared with every `ConnectorSection` on the page). **Why keyed by
`(profileId, taskId)` and not the bare task id**: `CaptureTask.id` is a hash
of portal + normalized filters — stable for one profile's filters, but NOT
globally unique, so two different profiles can legitimately produce the same
task id (see D-114).

**"Visible" is defined by the profile filter** (`captura-profile-filter`,
default "Todos los perfiles"): the button's count, the select-all/none, and
the click itself all act on `allTasksAcrossProfiles(visible)` only — never
every profile that exists. A scope note (`captura-batch-scope-note`) names the
active filter whenever it narrows the set, so the count can never silently
mean something other than what the owner can currently see. The underlying
ticked Set is still seeded once from EVERY profile (so toggling the filter
never discards a tick on a now-hidden profile).

**Every task is tickable without expanding its connector** (issue #559 —
owner: *"los checkbox están dentro del desplegable lo que me obliga a
abrirlo. ponlo fuera"*). `ConnectorSection` renders a compact checklist
(checkbox + label + a muted/"hecho" cue) immediately after its header,
unconditionally — the full per-task detail (execute button, loosened flags,
exact last-run time, `CaptureTaskRow`) stays behind `expanded` as before, but
carries no checkbox of its own; there is exactly one checkbox per task on the
page. This makes the common case — "everything due is already ticked, press
one button" — cost zero expansions.

Clicking the button:

1. Opens **exactly ONE** tab — the first ticked task, in display order
   (profile order, then each profile's own connector/task order), via
   `window.open` SYNCHRONOUSLY inside the click's gesture, before any
   `await` (byte-identical to the single-task flow for that ONE tab, which
   stays untouched) — regardless of how many DIFFERENT profiles the ticked
   tasks belong to.
2. The rest ride on that ONE url as `#inmo-capture-queue=<json>` — the URL
   **FRAGMENT**, never the query string (`withCaptureQueue`; a fresh-context
   review, D-113, moved this off the query string after finding it could
   poison a learned/pinned search-url template — see D-113 for the full
   story; this transport is 100% unchanged by #559). A cap
   (`MAX_QUEUE_ENTRIES = 24`, `capGlobalCaptureBatchPlan`) bounds how many
   ride along; anything past it is **neither queued nor recorded** — a
   dropped task must never look "done" — and the status message names WHICH
   VISIBLE PROFILES lost tasks to the cap (not just a bare count — the button
   spanning profiles means the cap can now bite mid-profile). Composition
   order matters: `withCaptureSignal(withCaptureQueue(url, queue))` — the
   queue claims the fragment, so the signal falls back to its OWN pre-existing
   query form.
3. THEN best-effort POSTs `capture_task_run` for every task that actually got
   opened/queued — each one against ITS OWN profile's endpoint
   (`/api/profiles/{profileId}/capture-task-runs`), parallel, one call per
   task — AFTER `window.open`, never before (open-before-record is strictly
   safer for the popup-blocker gesture and lets a blocked open be reported
   honestly).
4. The status message distinguishes what's CONFIRMED (the one tab that
   visibly opened) from what's merely QUEUED and depends on the extension
   being installed and running — the due-cue must never imply a task was
   captured when nobody, including the dashboard, actually saw it happen.
5. Launching a task — via EITHER this button OR a single-task button —
   immediately greys it out AND un-ticks it (the shared `runOverrides`), so a
   second "Capturar todo" click before the page reloads doesn't re-fire the
   same batch.
6. Nothing ticked (among the VISIBLE profiles) → a status message ("No has
   marcado ninguna tarea…"), no fetch, no `window.open` — never a silent
   no-op.

The dashboard has **no other channel** to the extension (no
`externally_connectable`, no content script on the dashboard's own origin —
the same constraint `background.js`'s `sendHeartbeat` docstring already
records the other way). The opened tab's content script decodes the fragment
(`detect.js` `parseCaptureQueue`, from BOTH the auto-start path and the
manual in-page-banner path) and forwards it as an extra `queue` field on the
SAME `START_BATCH` message it already sends; `background.js`'s `startBatch`
appends each entry to **#555/D-112's own** pending-search queue
(`InmoBatch.enqueueSearch`, which also DEDUPES an exact `(portal, searchUrl)`
repeat — guards against an accidental tab reload re-enqueuing the whole
tail) — never a second queue, never a second message channel. The extension
then opens each queued search itself, one at a time, via `chrome.tabs`
(exempt from the page-level popup blocker).

**A future agent extending this must NOT**: open more than one tab from the
dashboard side (popup blockers + Chrome background-tab render throttling both
break it — see D-043/D-112's own rationale); put the queue payload back in
the query string (every portal URL-grammar parser in `lib/search-url/portals/*.ts`
reads pathname+query only, never `.hash` — the fragment is what makes a
learned-template poisoning attack structurally impossible, not just avoided by
convention, see D-113); add a second pending-search queue; wire
`externally_connectable`/direct extension messaging to "solve" the hand-off —
piggybacking on the one allowed tab is the deliberate, narrowest mechanism
(D-113 records the alternatives considered and why they were rejected); key
cross-profile selection by a bare task id (two profiles CAN share one —
D-114); or re-add a per-profile button/select-all pair alongside the global
one — the owner explicitly rejected having both ("nada que sea global y por
perfil", D-114).

## Re-capturing listings that already have bad data (issue #677, D-156)

When a parser bug leaves a cohort holding bad data, **do not build a queue for
it** — the rows are already in `capture_worklist` at `status='captured'`, and
the extension batch driver already drains `pending`. Re-capture is a requeue:

- **Where**: `/admin/fuentes/<portal>` → Captura → "Marcar un conjunto para
  recaptura" (`dashboard/components/worklist/RecapturePanel.tsx`). The old
  `/etl/captura` home was deleted by #676/D-154 and 301s here.
- **Cohort**: portal + one of a closed predicate enum (`few_photos`,
  `stale_capture`, `never_requeued`) + "solo candidatos vivos" (default ON).
  Adding a case means adding a named predicate in `dashboard/lib/recapture.ts`
  **and** its SQL branch in `dashboard/lib/db/recapture.ts` — never a
  free-text filter.
- **Flow**: `Calcular` (GET, read-only) → count + time + storage estimate →
  reason → two-step armed confirm (D-133/D-135) → POST, which re-resolves the
  cohort and 409s if the count moved.
- **Marking**: `requeued_at` / `requeue_reason` / `requeue_rank`, never a new
  `status`. `status='pending' AND requeued_at IS NULL` is "never captured";
  `requeued_at IS NOT NULL` is "queued again" — the distinction survives an
  interrupted pass.
- **Eligibility**: only `captured` rows. `skipped`/`stale`/`failed`/`pending`
  are deliberately untouched — enforced twice, by the cohort resolver and
  again by `AND w.status = 'captured'` on the UPDATE itself, which is what
  covers the window between resolving a cohort and flipping it.
- **Source gate**: a portal switched off in Fuentes yields an empty cohort
  (D-055's shared `activeSourceClause`, same fragment the list and map feeds
  use), and a portal with `capture_enabled = false` is refused outright by the
  POST — otherwise the browsing happens and `etl/capture.py` never processes
  a single row of it.

**Before triggering a bulk pass, read the estimate.** The panel measures both
costs for real: the Idealista cohort (3,258 rows) is ~14.6 h of continuous
foreground browsing, and while `ETL_RETAIN_CAPTURE_HTML_FOR` names the portal
(D-150) it also writes ~1.4 GB raw / ~355 MB on disk. Consider turning
retention off first.

Only the **manual** batch path ("Capturar todas") drains in `requeue_rank`
order. Auto mode re-ranks by portal due-ness in `selectNextPendingUrls`, which
must stay in step with `browser-extension/batch.js selectNextPending`, so a
requeued cohort drains oldest-first there — correct, but not value-first.
**Turn Auto off before starting a value-ordered pass**; the panel says so
next to the estimate, because with Auto on the ordering it just promised is
moot.

## Per-listing timing — read the three legs, never the total (D-162)

`/admin/fuentes/<portal>` shows three medians under **Tiempo por anuncio**, and
they are separate on purpose:

| Leg | Column | What it means |
|-----|--------|---------------|
| Espera de render | `extension_capture.render_wait_ms` | Browser waited for the page to paint. **Portal-caused** — the one worth fixing. |
| Espera en cola | derived: `(processed_at - created_at) - processing_ms` | **Idle.** `run_capture_poll_loop` ticks every 10s, so this is ~5s on *every* portal. |
| Procesado | `extension_capture.processing_ms` | Real ETL work (`normalize` + upsert). |

**Do not add them up and report one number, and do not reach for
`processed_at - created_at`.** That subtraction is what made "hipoges tarda
mucho por anuncio" unanswerable: measured over 3906 production
captures it is flat-uniform across 0–10s (pure poll wait), so Hipoges (5.3s
mean) and Idealista (5.8s mean) were indistinguishable — both were just half
the poll interval. Full trace in
[D-162](../decisions/D-162-per-listing-timing-three-legs.md).

`—` means **not measured**, which is different from 0. `render_wait_ms` is NULL
for captures from an extension build that predates it and for the
manual/forced path, which never waits for render.

**Any change to `browser-extension/` that alters what the extension SENDS must
bump `manifest.json`'s version in the same PR.** The dashboard prompts the
operator to reload only when `updateAvailable(installed, served)` sees a
higher served version, so shipping a new field without a bump leaves every
operator on the old build: the server-side column exists, nothing ever
populates it, and the column reads `—` forever with no error anywhere. That is
the #693 failure shape, and `render_wait_ms` (0.17.0 → 0.18.0) is the second
time it nearly landed. Hipoges render readiness (0.18.0 → 0.19.0, #701/D-165)
is the third.

**Abandoned render waits (issue #701, D-165 — the gap #700 recorded).** A page
that never renders used to give up *without POSTing*, so it left no row
anywhere: timing covered successful captures only, and a portal that mostly
timed out looked, in this data, exactly like a portal nobody visited. It now
POSTs `outcome: 'never_rendered'`, landing a **terminal**
`extension_capture` row (never `pending`, so `etl/capture.py` never tries to
parse it) with `render_wait_ms` set and a one-line `error_msg` naming which
readiness test was still failing and how much of the page had arrived.

**The render budget is per portal**, not one global ceiling — read it with
`D.maxWaitMsFor(portal)` and never from `MAX_WAIT_MS`. Idealista is ready in
about a second; Hipoges gets 45 s because it server-renders its chrome first
and streams its adverts in afterwards. Raising the global number instead would
make every portal's give-up slower to pay for one portal's slowness.

**Readiness is asked separately for detail and listing pages**
(`portal.detailReadySelectors` / `listingReadySelectors`). A results page's
readiness is not a selector question at all: `isRenderReadyListing()` waits for
the harvest itself to return something, hold steady, **and look complete** —
complete meaning it reached the total the page's own heading states
(`expectedResultCount`), or the list has no pending result left, or the page
states no total to compare against. "Has it stopped changing" on its own is too
weak: 3 polls × 500 ms is 1.5 s, and a stall mid-paint satisfies it at 9 of 17.

Two traps worth knowing before you touch any of this:

- **A pending-result count is not a count of placeholder tags.** On Hipoges
  every *painted* card carries a `<p-skeleton>` for its photo carousel, so the
  raw tag count never reaches zero and anything gating on it deadlocks.
  `pendingPlaceholderCount()` excludes placeholders inside a
  `resultCardSelectors` element for exactly this reason.
- **Selectors read off a real capture are not guesses; selectors chosen for a
  page nobody has looked at are.** Hipoges shipped `["main","h1"]` as though it
  were calibrated and it cost two owner reports and a production total of two
  listings — but the fix for that is to go read a capture, not to refuse
  selectors on principle.

See D-165.

The crawl-side counterpart is **Tiempo por anuncio (rastreo)**:
`connector_run_results.fetch_ms_total / fetched_count`, with the rate limiter's
sleep already subtracted at the write site (`RateLimiter.slept_seconds`).
Never time `fetch_detail` without that subtraction — `throttle` is
`limiter.acquire` and sleeps *inside* the call, so an unsubtracted stopwatch
reports Fotocasa's 20s pacing interval as work (measured: 67× inflation).

## Sitios en evaluación — queueing pages from a portal we don't support (#705, D-167)

The other half of the queue. `capture_worklist` only accepts hosts that HAVE a
capture connector; a candidate site you are still assessing has none, and
`etl/capture.py` would file its page as `failed` ("no capture-capable
connector"). So prospective-site pages get their own small queue and their own
destination:

| | Supported portal | Site under evaluation |
|---|---|---|
| Queue | `capture_worklist` | `capture_spike_request` |
| Seeding | paste box on `/admin/fuentes/<portal>` | paste box on **`/admin/diagnostics`** (+ a required site name) |
| Auto unit | `drain` (or `harvest`) | `spike`, planned FIRST, capped |
| Lands in | `extension_capture` → `listing` | `extension_diagnostic` (D-153) |
| Terminal states | `captured`/`failed`/`skipped`/`stale` | `captured`/`skipped`/**`unreachable`** — no `failed` |
| Advances on | the capture POST | the DELIVERY statement (server-side), + `spikeRequestId` echoed back |

**The two paste boxes are mutually exclusive by host** — the worklist one
refuses a host without a connector, the spike one refuses a host with one — so
a mistyped idealista link is refused by both and can never quietly become a
spike capture. That, plus naming the site, is the "explicit choice"; don't
replace it with a checkbox.

**Nothing fetches the candidate site.** The extension opens a tab, waits for
the load plus one jittered dwell, reads the DOM and POSTs it to
`/api/extension/diagnostic` — the same route and payload the #675 "Forzar
captura + diagnóstico" button uses. This is the only capture path compatible
with the WAF-protected sites we have refused to build against (D-026/D-027/
D-033); keep it that way.

**Host permission**: a candidate site is covered only by the manifest's
`optional_host_permissions`, and Chrome grants an origin only from a user
gesture on an extension PAGE. So the popup's "Permitir sitios en evaluación"
button asks; `background.js` only ever calls `permissions.contains`. An
ungranted origin is skipped and stays `pending` — never `unreachable`, and this
is enforced where it cannot be forgotten: the driver sends the origins it holds
(`grantedSpikeOrigins`) on `GET /api/etl/auto-plan`, and the planner only ever
hands out (and only ever charges) rows on one of them. The grant prompt is
derived from `pending` **and** `unreachable` rows, so it never disappears at
the moment it is needed.

**How a row advances — server-side, always.** `attempts` is incremented by the
statement that DELIVERS the row (`claimSpikeRequestsForDelivery`, inside the
auto-plan GET), never by anything the extension reports back; there is no
"I tried and it failed" verb on the API at all. A landed page closes its row by
echoing the `spikeRequestId` it was handed on the diagnostic POST — **not** by
match key, which is derived from `window.location.href` and therefore breaks on
any redirect (locale prefix, canonical slug, consent-wall bounce, SPA
`pushState`); redirect-heavy servicer portals are the target population. If you
are tempted to add a client-side report here, read #705's review first: both
starvation bugs it found were the same shape.

**What a spike unit costs the listing drain**: it preempts harvest and drain, so
the honest worst case is
`ceil(MAX_PENDING_SPIKE_REQUESTS / SPIKE_UNIT_LIMIT) × MAX_SPIKE_ATTEMPTS`
= `ceil(50/5) × 3` = **30 ticks ≈ 30 min** of zero listing drain if nothing
renders, longer if the pages do render. Bounded and self-clearing, but not
"a couple of ticks" — raise the cap and you raise that number linearly.

**Never point it at ourselves**: `validateSpikeUrls` refuses `localhost`,
`127.0.0.1`, private/link-local/CGNAT ranges, `.local`/`.internal`, and the
dashboard's own host. `manifest.json` pre-declares `http://localhost/*` and
Chrome match patterns **ignore the port**, so without that denylist
`http://localhost:4000/admin/...` would be opened with the operator's
`ps_admin` cookie and the rendered admin page uploaded as a "candidate sample".

**Retention**: `purge_extension_diagnostics()` had no caller anywhere until
#705; it now runs once per ETL scheduler sweep at
`etl.diagnostic_retention_days` (default 30). Don't add another store of
scraped third-party pages — see #698 for what that turns into.

## Loosened searches (#267 caveat)

Pre-filtered URLs are reverse-engineered and unverified. Each task surfaces its
`loosened` constraints inline, prefixed via `loosenedPrefixLabel()`
(`dashboard/lib/search-url/labels.ts`) — "ampliada: <reason>" (broader, never
narrower) for every constraint except `"grammar"`, which reads "sin
confirmar: <reason>" instead (see below) — so the owner can eyeball that the
link lands filtered — failures are shown, never hidden. Aliseda always
loosens geography (no radius search).

**Hipoges (issue #561, D-115, revised after a fresh-context review of the
first version — PR #562) carries a `"grammar"` flag scoped to its `:operation`
token alone** — a different kind of honesty note from the others. Every
other portal's flags (and Hipoges' own price/size flags) name a specific
dropped/broadened VALUE inside an otherwise-confirmed grammar, so "ampliada:"
("broadened:") is accurate for them. `"grammar"` instead flags that ONE
TOKEN in the URL is an unconfirmed guess — the search may not be broader at
all, it may be a wrong page entirely (Hipoges silently redirects home on an
invalid route token, per the site's own public bundle) — so it renders
"sin confirmar:" instead. The FIRST version of this flag claimed the WHOLE
route vocabulary was unconfirmed; a review found four of five typology
tokens were provably wrong (readable from the site's public bundle with no
probing) and the town format didn't exist on the real site either — see
[search-url-builder.md](search-url-builder.md#confirmed-vs-reverse-engineered-grammar)
for the corrected, confirmed grammar. It renders through the SAME inline
flag mechanism, no new UI.

## Auth

The whole app is admin-gated (`middleware.ts`, single-operator tool). Same-origin
browser fetches carry the `ps_admin` cookie, so `/captura` reaches the
admin-gated `/api/*` routes (worklist, search-urls, capture-task-runs) with no
separate auth surface.

## Tests

- Unit: `lib/__tests__/captura-tasks.test.ts` — the per-profile plumbing
  (#556: `defaultTickedTaskIds`/`allProfileTasks`/`buildCaptureBatchPlan`/
  `capCaptureBatchPlan`, kept, still used internally) AND the cross-profile
  plumbing (#559/D-114: `selectionKey`, `allTasksAcrossProfiles`,
  `defaultTickedSelectionKeys`, `buildGlobalCaptureBatchPlan` — incl. two
  DIFFERENT profiles sharing the same bare task id staying distinct — and
  `capGlobalCaptureBatchPlan`, incl. the cap cutting across a profile
  boundary and naming every affected profile), `lib/__tests__/captura-staleness-config.test.ts`,
  `lib/__tests__/extension-capture.test.ts` (#556's `withCaptureQueue` — the
  FRAGMENT carrier, untouched by #559 — its query-string fallback, and its
  composition with `withCaptureSignal` — plus
  `encodeCaptureQueue`/`decodeCaptureQueue` round trip), `lib/db/__tests__/capture-task-run.test.ts`,
  `components/captura/__tests__/CaptureTaskRow.test.tsx` (#559: no checkbox of
  its own), `components/captura/__tests__/CapturaProfileSection.test.tsx`
  (#559: the per-profile TRANSLATION of the global `selectionKey`-keyed maps
  down to plain task ids — including that a tick keyed to a DIFFERENT
  profile's same bare task id does NOT leak in), `app/__tests__/captura-page.test.tsx`
  (`describe("CapturaProfiles — global 'Capturar todo' (issue #559)")`: ONE
  button/select-all/select-none spanning two profiles, a task tickable with
  every connector collapsed, a click recording runs against each task's OWN
  profile, the count + select-all/none scoped correctly under an active
  profile filter, and the cap naming every affected profile),
  `app/api/profiles/[id]/__tests__/capture-task-runs-route.test.ts`.
- Extension-side unit (Node, real `browser-extension/` modules — see
  `docs/skills/connectors.md`-adjacent pattern, untouched by #559):
  `__tests__/extension-detect.test.ts`
  (`parseCaptureQueue`/`stripCaptureQueue`, incl. the fragment-branch
  percent-decode), `__tests__/extension-background-batch-queue.test.ts`
  (`startBatch`'s `queue` field appending into #555/D-112's real queue wiring,
  both when the search claims the run and when it queues itself, plus the N6
  write-skip when `queue` is empty), `__tests__/extension-batch.test.ts`
  (`enqueueSearch`'s N3 dedupe — an exact `(portal, searchUrl)` repeat is
  dropped, a genuinely different search or a null-searchUrl entry is not).
- E2e (D-041): `dashboard/e2e/captura-tasks.spec.ts` — seeds a profile + worklist
  rows, asserts tasks render with buttons, executing one grays it with a
  'hecho …' last-done, a different task stays active, and no error surface.
  Auto-run now that CI globs specs (#275/#288). The `describe("Capturar todo
  — GLOBAL across profiles (issue #559, correcting #556/#558)")` block seeds
  TWO profiles into a known due/muted state via direct SQL and asserts: ONE
  button + ONE select-all/none pair spans BOTH (`page.getByTestId`'s own
  strict-mode uniqueness check backs this up — a stray per-profile duplicate
  would fail it outright); a task on a COLLAPSED connector is tickable
  without expanding anything, and stays collapsed after; the count/scope-note
  track an active profile filter correctly, and a filtered select-all/none
  never touches a hidden profile's ticks; and a click spanning both profiles
  opens exactly ONE tab (never one per ticked task, even across profiles)
  carrying the queue in the `#inmo-capture-queue=` FRAGMENT, while EACH
  ticked task's `capture_task_run.last_run_at` DOES advance against ITS OWN
  profile (DB-checked). The over-cap message is unit-tested only (see above)
  — producing 24+ real tasks from seeded profiles isn't practical for e2e.
