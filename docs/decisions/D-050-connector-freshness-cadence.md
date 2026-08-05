---
id: D-050
title: Per-connector freshness cadence — refresh only when due, resume until fresh
date: 2026-08-05
---

# D-050: Per-connector freshness cadence — refresh only when due, resume until fresh

*Decided: 2026-08-05*

**Context**: The scheduler (`etl/orchestrator.py run_scheduler_loop`) sweeps
every enabled connector on a fixed hourly tick. There was no notion of "how
often do I actually want fresh data for connector X" — every enabled
connector's `discover()` was attempted on every tick, forever, regardless of
whether its data was already fresh. Separately, a connector whose full scope set
needs several ticks to cover (budget caps, rate limits, the shared circuit
breaker tripping mid-sweep — #270's Fotocasa `circuit_open` findings) had no
connector-level signal of whether a *complete* pass had happened since data was
last considered fresh vs. "still finishing the same refresh". Issue #295 asked
for a configurable per-connector cadence, a due-check that gates the discover
loop, a multi-tick refresh "cycle" that resumes on the existing per-scope
bookkeeping, cycle-completion detection, and dashboard surfacing.

**Decision** (Phase 1, backend):

- **State model — minimal, reuse first.** One new table
  `connector_freshness_state(connector_name PK, last_fresh_at, cycle_started_at,
  cycle_target_scope_count, updated_at)` and one new nullable column
  `connector_config.freshness_interval_hours` (per-connector override, same
  override-vs-global-default shape as `min_refetch_interval_seconds`/#143; NULL =
  use the global default, never "no tracking"). Two config knobs:
  `etl.default_freshness_interval_hours` (24h — matches the dashboard's
  `FRESHNESS_STALE_THRESHOLD_HOURS`, #241) and
  `etl.freshness_cycle_stuck_after_hours` (168h/7d, visibility only). No new
  per-scope progress table: "remaining work this cycle" is a **live query**
  against the existing `connector_scope_state` (#217/D-030) —
  `last_discovered_at >= cycle_started_at` means "done this cycle". The only
  genuinely new state is the two-column cycle marker
  (`last_fresh_at` + `cycle_started_at`). No backfill: a connector with no row is
  simply "never fresh" = due immediately.

- **Due-check** (`run_all_connectors`, per connector per tick, right after the
  `enabled=False` skip, before the per-scope loop): manual/CLI triggers
  (`trigger != "scheduler"` — `ps connector run`, "Ejecutar ahora",
  `etl_manual_trigger`) **bypass the gate entirely** (D-038 precedent — a
  deliberate operator action must never silently no-op). A cycle already in
  flight (`cycle_started_at IS NOT NULL`) **always continues**, regardless of the
  interval — the interval gates only *starting* a cycle. Never-fresh
  (`last_fresh_at IS NULL`) or interval-elapsed → **start** (`cycle_started_at =
  NOW()`). Fresh and inside the interval → **skip** the connector entirely: **no
  `connector_run_results` row** (same "genuinely nothing to do" posture as the
  empty-`scopes` early-continue, #71/#99), logged at INFO. This is distinct from
  the operator-disabled `skipped` status row (#99) — conflating them would make
  "disabled" and "not due yet" indistinguishable in `connectors_skipped` counts.

- **Resume** (per-scope loop): one query up front for
  `scope_key`s discovered since `cycle_started_at`; any such scope is skipped in
  the loop (no `discover()`/rate-limiter/breaker cost), recorded under a new
  `skipped_scopes` reason `"fresh_this_cycle"` (extending #217's
  `budget`/`uncovered`/`unresolvable` vocabulary), never an error. Composes with
  #217/D-030's fairness ordering (which already puts the genuinely-remaining,
  oldest-attempted scopes first) — this makes "never redundantly re-crawl an
  already-done scope" a guarantee rather than an accident of leftover budget.

- **Completion / stuck** (end of each connector's per-run block): compute the
  live target scope-key set from this tick's resolved scopes (excluding
  `None`/unresolvable), count how many were discovered since `cycle_started_at`;
  100% (including the vacuous zero-target case) → mark fresh (`last_fresh_at =
  NOW()`, `cycle_started_at = NULL`); otherwise leave the cycle in progress for
  the next tick. A cycle older than `freshness_cycle_stuck_after_hours` with
  partial coverage logs a **WARNING and is flagged stuck (derived from the age of
  `cycle_started_at`), NEVER force-completed** — a connector that can't finish
  (Fotocasa tripping the breaker every tick, #270) reads as "still refreshing,
  taking unusually long" forever, never falsely "fresh".

- **Clean-run semantics**: a mid-cycle "continue" tick and a "complete" tick are
  both perfectly normal `connector_run_results` rows with whatever status their
  own scopes earned. The cycle's "still refreshing" state lives entirely in
  `connector_freshness_state.cycle_started_at IS NOT NULL`, a separate,
  connector-level, non-error signal. A partial "will continue next run" is a
  CLEAN outcome (consistent with #270/D-047's per-run framing), never an error.

**Alternatives rejected**:
- *A per-scope "cycle progress" table.* Rejected — `connector_scope_state`
  already records `last_discovered_at`, so "remaining this cycle" is a live query;
  a second table would drift, need crash reconciliation, and duplicate a source of
  truth (AGENTS.md: no duplicate state).
- *Force-completing a stuck cycle* (reset the interval clock so it backs off).
  Rejected as the default — trades honesty for eventual back-off. Only Fotocasa
  exhibits this today (#270) and its breaker/rate-limiter already bound the cost
  of repeated attempts; ship the honest version and revisit if it proves noisy.
- *A new `skipped` run status for "not due".* Rejected — that value is reserved
  for operator-disabled (#99); "not due" produces no run row at all.

**Rationale**: The scheduler tick stays hourly (owner's explicit instruction);
cadence is layered on top as a cheap per-connector gate. Reusing
`connector_scope_state` keeps the only new state to two columns and makes
crash-resume free (no `running` status to wedge, just a timestamp + a live
query). The manual-trigger bypass and the "clean partial" framing match existing
precedents (D-038, D-047) so operators and the health surface behave consistently.

**Side effects worth stating** (call out for Phase 2 / owner): once a connector
truly sweeps only once per interval, withdrawal detection's
`_WITHDRAWAL_THRESHOLD=3` consecutive-missed-sweeps now spans ~3 intervals
(≈3 days at 24h) instead of ~3 hours — arguably more correct (matches the
connector's declared cadence) but a real behavior change. Phase 2 will replace
`dashboard/lib/db/freshness.ts`'s "any `ok` run within 24h" heuristic with the
connector-level `last_fresh_at`/`cycle_started_at` (strictly more accurate) and
add the settings control + `stuck`/`refreshing` states.

**Scope**: Phase 1 is backend only (schema, config, orchestrator due/resume/
completion, tests, `ps connector status` surfacing). Phase 2 (dashboard settings
control + observability) depends on this PR merging. #289's manual-capture
staleness window is recommended to consume `connector_config.freshness_interval_
hours` rather than introduce its own `capture_staleness_days` — flagged as an
owner decision, not implemented here.

**Decision-id note**: rebased onto a `main` that has decisions through D-049
(D-047/#300, D-048/#299, D-049/#302). D-050 is the next free sequential id.

**See**: issue #295 (+ its full spec comment); `etl/schema/init.sql`
(`connector_freshness_state`, `connector_config.freshness_interval_hours`);
`etl/orchestrator.py` (`_freshness_decision`, `_finalize_connector_freshness_cycle`,
the gate in `run_all_connectors`); `config/schema.yaml` + `etl/config.py`;
`etl/tests/test_connector_freshness_cadence.py`; `cli/commands/connector.sh`;
D-030 (scope fairness), D-038 (manual-trigger bypass), D-047 (clean soft-block
outcome), #270, #289, #272, #241.
