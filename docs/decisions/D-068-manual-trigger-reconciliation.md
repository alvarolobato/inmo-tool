---
id: D-068
title: Orphaned etl_manual_trigger 'running' rows are age-reconciled to 'failed'
date: 2026-08-06
---

# D-068: Orphaned `etl_manual_trigger` 'running' rows are age-reconciled to 'failed'

*Decided: 2026-08-06*

**Context**: Follow-up from PR #252 review (issue #253). D-038 (issue #244)
revived ad-hoc execution: `etl/manual_trigger.py` claims the oldest pending
`etl_manual_trigger` row by committing it to `status='running'`
(`_claim_pending_trigger`, setting `picked_up_at = NOW()`), runs a full
`run_all_connectors` sweep, then marks it `done`/`failed`. A SIGKILL / container
restart / OOM *between* that claim-commit and the finishing UPDATE leaves the
row stuck at `status='running'` with `finished_at=NULL` **forever** — nothing
else transitions it, and `GET /api/etl/run?id=` reports a phantom "still
running" run from a process that no longer exists. This is exactly the gap
D-036 closed for `dedup_runs`. It is non-breaking (the single-pending partial
index `WHERE status='pending'` means the orphan never re-runs and never blocks a
future trigger), but it misreports status indefinitely.

**Decision**: Add an **age-based** reconciler
`etl/manual_trigger.py:reconcile_orphaned_manual_triggers(conn,
max_runtime_seconds)`, mirroring D-036's `_reconcile_orphaned_dedup_runs`. It
marks every `etl_manual_trigger` row still at `status='running'` whose
`COALESCE(picked_up_at, requested_at)` is older than `max_runtime_seconds` as
`status='failed'`, sets `finished_at = NOW()`, and writes an explanatory
`error_msg` (only when NULL, via `COALESCE`). It runs (best-effort) at ETL
startup (`etl/main.py`, right after the dedup reconcile, before the first
sweep) **and** at the start of every manual-trigger poll iteration
(`process_pending_trigger`, before acquiring the run lock). Idempotent — a
second pass over already-reconciled rows updates nothing.

- **Terminal state = `'failed'`.** Already in the status CHECK constraint
  (`pending | picked_up | running | done | failed`) and already the value
  `_mark_failed` writes and the dashboard understands — so **no new status
  value and no `init.sql` migration** are needed.
- **Age signal = `picked_up_at`.** Set to `NOW()` the instant the row flips to
  'running'; a natural, already-persisted start marker, so no heartbeat column
  is added. (`COALESCE(..., requested_at)` guards the never-observed NULL case.)
- **Threshold** is configurable: `etl.manual_trigger_max_runtime_seconds` /
  `ETL_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS`, default **7200s (2h)**, coerced to
  the default if non-positive/garbage. A manual trigger runs a full
  `run_all_connectors` sweep that *itself includes a dedup pass*, so 2h sits
  comfortably above the longest realistic sweep+dedup runtime — matching
  D-036's dedup threshold.

**Not-stomp-a-live-run safety**: on the single-worker deployment (one ETL
container) the manual-trigger poll loop is single-threaded and runs one trigger
to completion inside `process_pending_trigger` before it polls again, so a
genuinely in-flight run is never concurrently reconciled by the same thread.
The age threshold is the belt-and-suspenders that also protects against a
theoretical second poller and is what keeps the reconciler from ever failing a
run still doing real work. **Assumption**: there is no per-run heartbeat column
beyond `picked_up_at`, so a run that legitimately overruns
`max_runtime_seconds` while still alive is the residual exposure — the default
is set well above the longest realistic sweep to avoid it, exactly as D-036
does for dedup.

**Alternatives rejected**:
- *A heartbeat / `last_progress_at` column* — unnecessary complexity for a
  bounded, single-worker operation; `picked_up_at` + a generous age threshold
  is sufficient (same reasoning D-036 gave for dedup).
- *Blindly failing every 'running' row on startup (à la `_reconcile_stale_runs`
  for `connector_runs`)* — would stomp a run that is legitimately still in
  flight if the reconciler ever ran off the single-poller path; age-based is
  the safe form.
- *A new status like `'stale'`/`'timed_out'`* — the system already understands
  `'failed'`; a new value would need a CHECK-constraint migration and dashboard
  changes for no benefit.

**Rationale**: Reuses D-036's proven pattern verbatim (age-based reconcile,
startup + per-poll, idempotent, explanatory `error_msg`), so a wedged manual
trigger self-heals the same way a wedged dedup run does — no new column, no
migration, no new status. Closes the last "row stuck at 'running' forever"
surface in the ad-hoc ETL path.

**See**: `etl/manual_trigger.py` (`reconcile_orphaned_manual_triggers`,
`process_pending_trigger`, `run_manual_trigger_poll_loop`), `etl/main.py`
(startup reconcile + `--once` drain + poll thread), `etl/config.py`
(`_get_manual_trigger_max_runtime_seconds`), `config/schema.yaml`,
`etl/tests/test_manual_trigger.py`. Issue #253, PR #252. Related:
[D-036](D-036-dedup-run-reconciliation.md) (the dedup analog),
[D-038](D-038-adhoc-etl-run-lock.md) (the ad-hoc trigger mechanism this
protects).
