# Captura — task-driven guided-capture execution UI

**Page:** `dashboard/app/captura/page.tsx` — top-level, next to Perfiles (issues #268/#284 → task-driven in #289 → redesign #413, part of #237).
**Decisions:** [D-045](../decisions/D-045-capture-execution-top-level.md) — execution is top-level, setup stays in `/etl`. [D-048](../decisions/D-048-task-driven-captura.md) — Captura is a list of discrete recurring TASKS with a per-task staleness window. [D-112](../decisions/D-112-batch-capture-pending-search-queue.md) — the extension-side pending-search queue this page's batch button feeds. [D-113](../decisions/D-113-capturar-todo-batch-queue-piggyback.md) — how "Capturar todo" hands additional searches to the extension with no direct dashboard→extension channel. [D-114](../decisions/D-114-global-capture-selection.md) — "Capturar todo" is ONE page-level control across every VISIBLE profile (not one per profile), selection keyed by `(profileId, taskId)`, per-task ticking exposed without expanding anything.

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
from the admin SETUP surfaces under `/etl/*` (extension install, API key,
connector config, the raw `/etl/captura` worklist table). The day-to-day loop:

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

**ONE button for the whole page**, above the profile-filter select, labelled
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

## Loosened searches (#267 caveat)

Pre-filtered URLs are reverse-engineered and unverified. Each task surfaces its
`loosened` constraints inline as "ampliada: <reason>" (broader, never narrower)
so the owner can eyeball that the link lands filtered — failures are shown,
never hidden. Aliseda always loosens geography (no radius search).

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
