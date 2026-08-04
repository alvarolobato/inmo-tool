---
id: D-036
title: Orphaned dedup runs are age-reconciled + a single-runner advisory lock prevents overlap
date: 2026-08-04
---

# D-036: Orphaned dedup runs are age-reconciled + a single-runner advisory lock prevents overlap

*Decided: 2026-08-04*

**Context**: On the live instance, `dedup_runs` rows got stuck at
`status='running'` with `finished_at=NULL` **forever** whenever a dedup pass
was killed mid-run (SIGKILL, container restart, OOM, host reboot) — the
finishing `UPDATE dedup_runs` in `_finish_dedup_run` never executed, and
nothing else ever transitions the row. Three rows were orphaned at once (9h,
10h, 19h old), all indistinguishable from "still in progress" to `ps dedup
status` or any monitor. A dedup pass currently takes ~84 min (dropping once
#221/#226's photo-hash persistence deploys, but it can still crash), so this
is a recurring failure mode. Separately, the three concurrent `running` rows
show there was **no overlap guard at all**: `run_dedup` is reachable from two
independent processes — the scheduler (`run_all_connectors` → `run_dedup`) and
a manual `ps dedup run` (its own process/connection) — and neither took a
lock, so two ~84-min passes could run against the same corpus at once, wasting
the cost and risking double-writes. The advisory-lock helper
(`try_acquire_run_lock`/`release_run_lock` in `etl/db/postgres.py`) already
existed but was **dead code, called from nowhere**. `_reconcile_stale_runs`
already existed for `connector_runs` but had no dedup equivalent.

**Decision**: Two complementary guards, wired into `run_dedup`.

1. **Age-based orphan reconciliation** — `_reconcile_orphaned_dedup_runs(conn,
   max_runtime_seconds)` marks every `dedup_runs` row still at
   `status='running'` whose `started_at` is older than `max_runtime_seconds`
   (default 7200s / 2h, configurable via `ETL_DEDUP_MAX_RUNTIME_SECONDS` /
   `etl.dedup_max_runtime_seconds`) as `status='failed'`, sets `finished_at`
   and `duration_ms`, and writes an explanatory `error_msg` ("orphaned: still
   'running' after Ns … reconciled as failed"). It runs at ETL startup
   (`etl/main.py`, before the first sweep) and at the start of every
   `run_dedup` pass, so a stuck row never lingers. Idempotent.

   Deliberately **age-based**, unlike `_reconcile_stale_runs` (which blindly
   fails *every* running `connector_runs` row). Because dedup can be triggered
   from two independent processes, a genuinely-active concurrent pass may exist
   at reconcile time; the age threshold is what keeps the reconciler from
   failing a run that is still doing real work. The threshold (2h) sits
   comfortably above the ~84-min real runtime and far below the 9-19h the live
   orphans reached.

2. **Single-runner advisory lock** — `run_dedup` acquires a session-scoped
   PostgreSQL advisory lock (`DEDUP_ADVISORY_LOCK_ID`, distinct from the
   connector `RUN_ADVISORY_LOCK_ID` so a sweep and a dedup pass never block
   each other) before creating its run row. If another process holds it, the
   call logs the reason and **returns `None`** (skipped) rather than starting
   an overlapping pass — the CLI prints a benign "already running" message and
   exits 0. The lock is session-scoped, so a killed process frees it on
   connection teardown; it never wedges future runs. `run_dedup`'s return type
   is now `DedupRunResult | None` — callers that print a result must handle
   `None`.

The two compose: the lock stops two *live* passes overlapping, and the
age-based reconciler cleans up a *dead* pass's row.

What protects a pass that legitimately exceeds the 2h threshold is **the age
filter plus self-healing**, NOT the lock. The reconciler runs and commits at
the very start of `run_dedup`, *before* the lock is acquired (deliberately, so
it runs even on the path that then skips on the lock) — so it is not true that
"the reconciler only runs in a process about to hold the lock." The real
guarantees are: (a) the reconciler only touches rows older than the threshold,
so a &lt;2h pass is never eligible; and (b) if a pass ever does overrun 2h and a
concurrent trigger reconciles its row to `failed`, `_finish_dedup_run` rewrites
that row's status and clears `error_msg` on success — so the wrong status is
transient and self-corrects. The residual exposure is a narrow overrun-plus-
concurrent-trigger window producing a briefly-wrong status; the thin ~36-min
margin between the ~84-min pass and the 2h threshold is the thing to widen if
dedup ever slows again (it should get much faster once D-025 photo-hash
persistence deploys).

**Alternatives rejected**:
1. **A heartbeat / `last_progress_at` column** — rejected as unnecessary
   complexity for this shape. A dedup pass is one bounded operation with no
   natural mid-run checkpoints, and 84 min ≪ the 2h threshold, so `started_at`
   + max-runtime distinguishes dead from alive just as reliably as a heartbeat
   would, with no new column, no write path in the hot loop, and a trivially
   idempotent (unchanged) `init.sql`.
2. **Blindly failing all `running` rows on a new pass** (the
   `_reconcile_stale_runs` approach) — rejected: dedup's two-process trigger
   surface means a concurrent live pass can exist, and blindly failing it would
   kill a run that is still working. The age threshold is the precise
   discriminator.
3. **A new `status='skipped'` value / a row for lock-contended skips** —
   rejected: would need a `CHECK` constraint change for a benign non-event.
   A lock-skipped pass logs its reason and records nothing; the in-flight run
   is the one that will record the result.

**Rationale**: Reuses the existing (previously-dead) advisory-lock helper and
mirrors the existing `_reconcile_stale_runs` shape, adding no schema change.
The core requirement — a stuck row must not linger and must say *why* — is met
by the age reconciler + `error_msg` (now surfaced in `ps dedup status`); the
overlap requirement is met by the lock. Single-operator-sized: no new table,
no dashboard page, just enough for `ps dedup status` to tell the truth.

**See**: `etl/orchestrator.py` (`_reconcile_orphaned_dedup_runs`, `run_dedup`,
the `dedup_max_runtime_seconds` threading through `run_all_connectors` /
`run_all_connectors_respecting_restart_guard` / `run_scheduler_loop`),
`etl/db/postgres.py` (`DEDUP_ADVISORY_LOCK_ID`, the `lock_id` param on
`try_acquire_run_lock`/`release_run_lock`), `etl/main.py` (startup
reconciliation + config threading), `etl/dedup/cli.py` (`_cmd_run` None
handling), `etl/config.py` + `config/schema.yaml`
(`etl.dedup_max_runtime_seconds`), `cli/commands/dedup.sh` (`error_msg` in
`status`), `etl/tests/test_dedup_run_reconciliation.py`, issue #185 (the
`dedup_runs` table this hardens), D-024/D-025 (the dedup subsystem), the
connector-side precedent `_reconcile_stale_runs`.
