---
id: D-038
title: Ad-hoc ETL runs go through etl_manual_trigger + the connector run lock
date: 2026-08-04
group: Data / connectors
rule: Ad-hoc runs enqueue an `etl_manual_trigger` row (`connector_name` NULL=all); `etl/manual_trigger.py` polls it, runs `run_all_connectors` under `RUN_ADVISORY_LOCK_ID` (shared w/ scheduler), skips the D-009 guard.
order: 45
---

# D-038: Ad-hoc ETL runs go through etl_manual_trigger + the connector run lock

*Decided: 2026-08-04*

**Context**: The dashboard could not trigger a connector sweep on demand. `etl_manual_trigger` (inherited from the PowerShop source project) was wired on the write side but **nothing in the connector orchestrator polled it**, and `POST /api/etl/run` returned a hard `501`. The only ad-hoc path was `ps connector run <name>`, which needs a shell on the machine running the stack (issue #244). A proven, live analog already existed: `extension_capture` (issue #75) and `suggested_merge_action` (dedup review queue) both use the "signal via a Postgres row, pick it up on a short poll" pattern, because the dashboard (Node) and orchestrator (Python) run in separate containers with no shared filesystem or RPC channel.

**Decision**:
1. **Revive `etl_manual_trigger`, don't invent an HTTP path.** A new `connector_name TEXT` column scopes a run to one connector (`NULL` = full sweep of every enabled connector, matching `force_tables`' "empty = everything" convention). `connector_run_id`/`finished_at`/`error_msg` record the outcome; the status CHECK is widened to `pending → running → done|failed` (`picked_up` kept only for the inherited helpers/tests). The old `run_id` FK (→ the orphaned `etl_sync_runs`) is left alone — the connector pipeline links `connector_runs` via the new column instead.
2. **`etl/manual_trigger.py` polls it** (~10s), mirroring `etl/capture.py`'s shape: its own daemon thread started in `etl/main.py`, claims the oldest pending row with `FOR UPDATE SKIP LOCKED`, and calls `run_all_connectors` (all connectors, or one when scoped) — the **same** run machinery a scheduled sweep uses, never a second code path.
3. **Compose with the connector run lock, not a new guardrail.** Both the manual-trigger poll loop and `run_scheduler_loop` now acquire the project-wide `RUN_ADVISORY_LOCK_ID` (`postgres.try_acquire_run_lock`) around their sweep. A manual trigger that arrives while a scheduled sweep is running leaves its row pending and retries next poll — it never runs a second sweep concurrently and double-writes the same listings. The lock is session-scoped (auto-frees on connection close), so a killed container never wedges it.
4. **Ad-hoc runs bypass the restart-burst guard (D-009), on purpose.** A UI-triggered run — like `ps connector run <name>` — is a deliberate operator action, so it calls `run_all_connectors` directly, never `run_all_connectors_respecting_restart_guard`. It still goes through each connector's own rate limiter + circuit breaker.
5. **`POST /api/etl/run` inserts a trigger** (admin-gated) and returns its id; `GET /api/etl/run?id=` reports status. A named connector is validated against `connector_registry` first (404 unknown / 409 deregistered) so a row that could never run is never queued. The single-pending partial index returns 409 (with the existing pending id) rather than piling up rows.

**Alternatives rejected**:
- *A synchronous HTTP endpoint on the ETL container* — the source project's own `D-016` rejected this for the same cross-container reason; the queue-table pattern is already the house style (capture, dedup actions).
- *A new advisory lock / rate-limit concept for ad-hoc runs* — unnecessary; `RUN_ADVISORY_LOCK_ID` already existed for exactly "another scheduler instance, a parallel manual trigger" (its docstring said so) and was simply unused until now.
- *Routing ad-hoc runs through the restart guard* — that guard exists for unattended crash-loops, not a human pressing a button; gating a deliberate action behind it would silently no-op the button.

**Rationale**: Reuses proven machinery end-to-end (one run path, one lock, existing rate limiter/breaker), so an ad-hoc run is observably identical to a scheduled one — no drift, no bypass. Cleanly enables issue #245 (quick-refresh-on-profile-change): a profile edit just enqueues a scoped `etl_manual_trigger` row, calling this mechanism rather than adding a second trigger path.

**See**: `etl/manual_trigger.py`, `etl/orchestrator.py` (`run_scheduler_loop`, `run_all_connectors`), `etl/db/postgres.py` (`try_acquire_run_lock`, `create_manual_trigger`), `etl/schema/init.sql` (`etl_manual_trigger`), `dashboard/app/api/etl/run/route.ts`, `dashboard/components/connectors/RunNowButton.tsx`, `docs/roadmap/connector-etl-ops.md` §3. Related: [D-009](D-009-restart-burst-guard.md) (restart-burst guard), [D-036](D-036-dedup-run-reconciliation.md) (advisory-lock single-runner pattern), [D-030](D-030-scope-fairness-rotation.md) (scope fairness, unchanged). Issue #244.
