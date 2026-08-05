# Captura — task-driven guided-capture execution UI

**Page:** `dashboard/app/captura/page.tsx` — top-level, next to Perfiles (issues #268/#284 → task-driven in #289, part of #237).
**Decisions:** [D-045](../decisions/D-045-capture-execution-top-level.md) — execution is top-level, setup stays in `/etl`. [D-048](../decisions/D-048-task-driven-captura.md) — Captura is a list of discrete recurring TASKS with a per-task staleness window.

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
3. Per task: a **button** that (a) records the run (`POST /capture-task-runs`)
   then (b) opens the URL in a new tab — the extension's batch capture (#262)
   takes over. A **last-done** note ('hecho hace 3 días' / 'nunca'). Any
   `loosened` flags inline.
4. A task run within its **staleness window** greys out (done / not due); once
   the window elapses it returns to colour (due again). Graying is a visual cue
   — the button stays clickable for an optional re-run, never blocked.

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
| Per-task row | `dashboard/components/captura/CaptureTaskRow.tsx` |

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

- Unit: `lib/__tests__/captura-tasks.test.ts`, `lib/__tests__/captura-staleness-config.test.ts`,
  `lib/db/__tests__/capture-task-run.test.ts`, `components/captura/__tests__/CaptureTaskRow.test.tsx`,
  `app/__tests__/captura-page.test.tsx`, `app/api/profiles/[id]/__tests__/capture-task-runs-route.test.ts`.
- E2e (D-041): `dashboard/e2e/captura-tasks.spec.ts` — seeds a profile + worklist
  rows, asserts tasks render with buttons, executing one grays it with a
  'hecho …' last-done, a different task stays active, and no error surface.
  Auto-run now that CI globs specs (#275/#288).
