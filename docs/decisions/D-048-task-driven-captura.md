---
id: D-048
title: Task-driven Captura with per-task staleness window
date: 2026-08-05
group: Data / connectors
rule: '`/captura` is a list of discrete recurring TASKS (one per portal×section from the search-url `tasks[]`), each a button that records a run in `capture_task_run (profile_id, task_id, last_run_at)` then opens the URL. A `capture.staleness_days` window (global + per-portal) grays a done task until it elapses; graying is a visual due-cue, never a block. Headline portal progress = REAL `extension_capture` activity (what landed), not just seeded `capture_worklist`.'
order: 51
---

# D-048: Task-driven Captura with per-task staleness window

*Decided: 2026-08-05*

**Context**: The first `/captura` page (issues #268/#284, D-045) modelled guided
capture as one card per portal with a single "Abrir búsqueda" link and a merged
"búsqueda ampliada" note. That doesn't match how the owner actually captures:
Idealista searches ONE property-type section at a time, so a piso+ático+garaje
profile is really three separate searches, each opened and captured on its own.
There was also no memory of what had been done — every portal looked the same
whether it was captured five minutes ago or never, so the owner had to track "did
I already do this one?" in their head. Owner (2026-08-05, evolving #268) asked for
a task-driven surface: discrete recurring tasks, each a button, with a last-done
time and a staleness window that grays out done tasks.

**Decision**:
- `/captura` renders a list of discrete capture **TASKS**, grouped by portal —
  one task per (portal × searchable section), taken from the restructured
  search-url builder response `GET /api/profiles/[id]/search-urls` →
  `{ tasks: [{ id, portal, label, url, loosened[] }] }`. `id` is
  stable/deterministic for the same profile+filters. There is no merged
  "ampliada" task — each section is its own task, its own button.
- Each task's button (a) records the run via `POST
  /api/profiles/[id]/capture-task-runs { taskId }` then (b) opens `task.url` in a
  new tab (the extension's batch capture, #262, takes over). Recording is
  best-effort — a failed POST never blocks opening the search.
- Runs persist in `capture_task_run (profile_id BIGINT REFERENCES
  search_profile ON DELETE CASCADE, task_id TEXT, last_run_at TIMESTAMPTZ,
  PRIMARY KEY (profile_id, task_id))`. It is a "last touched" ledger, NOT a
  capture-outcome table (outcomes live in `capture_worklist` / `extension_capture`).
- A **staleness window** — `capture.staleness_days` (config/settings, default 7),
  with optional per-portal overrides `capture.staleness_days_<portal>` that
  inherit the global when unset — decides each task's visual state via the pure
  `taskStaleness(lastRunAt, windowDays, now)`: never run → **due** (full colour);
  run inside the window → **muted** (greyed, "hecho hace N…"); run ≥ window ago →
  **due** again. Graying is a visual due/not-due cue ONLY — the button stays
  clickable so the owner can re-run any time, which just bumps `last_run_at`.
- The per-portal worklist roll-up (#284/#260) is kept as a secondary line; the
  URL grammar and the batch loop are never re-implemented here.
- **Progress reflects REAL captures, not just seeded worklist.** The headline
  per-portal progress ("N propiedades capturadas · última hace X") comes from
  `extension_capture` (status='done', keyed to a portal by URL host via the same
  logic as `portalForUrl`/etl/capture.py), surfaced by `getPortalCaptureActivity()`
  in the `capture-task-runs` GET response as `activity[]`. Captures made by
  opening detail pages one by one seed NO `capture_worklist` row, so a
  worklist-only progress reads empty even after successful captures (live-owner
  bug). The seeded-worklist roll-up stays as a secondary "lista: M/T" line for
  batch runs. `capture_task_run.last_run_at` tracks when a task was LAUNCHED;
  the activity tracks what actually LANDED — both are shown, distinctly.

**Alternatives rejected**:
- *One button per portal (the #284 model)*: hides that Idealista is multiple
  independent section searches, and gives the owner no per-search memory.
- *Blocking a task while it is fresh*: rejected — the owner sometimes wants to
  re-capture a section immediately (new listings, a missed page). Graying informs,
  never forbids.
- *A status/outcome column on `capture_task_run`*: outcomes already live in the
  worklist / capture tables; duplicating them here would be a second source of
  truth to keep in sync. This ledger records only "when last run".
- *Computing task ids on the client from the URL only*: the deterministic id is
  the builder's responsibility (it owns the grammar); the UI consumes `tasks[].id`.
  A transitional `normalizeTasks()` synthesises a stable fallback id from
  `portal|url` ONLY while the builder still returns the legacy `urls[]` shape.

**Rationale**: Matching the real capture loop (discrete, recurring, one-at-a-time
searches with memory) makes the page a checklist the owner works down, and the
staleness window turns "what still needs doing" into an at-a-glance colour cue
without ever getting in the way. Keeping the ledger a pure "last run" fact — and
the staleness decision a pure function — keeps the persistence small and the
grey/due logic unit-testable in isolation (the class of bug D-041 guards against).

**See**: `dashboard/app/captura/page.tsx`, `dashboard/components/captura/CaptureTaskRow.tsx`,
`dashboard/lib/captura-tasks.ts`, `dashboard/lib/captura-staleness-config.ts`,
`dashboard/lib/db/capture-task-run.ts`,
`dashboard/app/api/profiles/[id]/capture-task-runs/route.ts`,
`config/schema.yaml` (section Captura), `etl/schema/init.sql` (`capture_task_run`),
`dashboard/e2e/captura-tasks.spec.ts`, `docs/skills/captura-execution.md`.
Related: [D-045](D-045-capture-execution-top-level.md) (top-level placement),
[D-041](archive/D-041-e2e-required-for-features.md) (e2e gate). Issue #289, part of #237.
