---
id: D-020
title: Force-resync trigger channel for ETL Monitor
date: 2026-04-23
---

# D-020: Force-resync trigger channel for ETL Monitor

*Decided: 2026-04-23*

**Context**: Issue #398. After D-017's signed-int16 fix the nightly ETL only rewrites rows with a fresh `Exportaciones.FechaModifica`, so historical negative-stock rows already stored as 65535 persist until origin changes. Also, `etl_sync_runs.total_rows_synced` was hard-coded to zero because `finish_run` was never called with the accumulator.
**Decision**:
- Add two NOT-NULL-DEFAULT columns to `etl_manual_trigger`: `force_full BOOLEAN DEFAULT FALSE` and `force_tables TEXT[] DEFAULT '{}'`. The dashboard writes them via `/api/etl/run` (new JSON body `{force_full?, tables?}`); the scheduler reads them with `get_trigger_force_flags` and calls `reset_watermarks(names)` **before** `create_run` so the next sync degrades to a full refresh for the selected watermark-backed tables.
- Maintain a single sync-name registry in `etl/main.py` (`SYNC_NAMES`, `SYNC_NAMES_WITH_WATERMARK`) used both as the whitelist inside `run_full_sync` and mirrored as `ALLOWED_FORCE_TABLES` in the dashboard route. Unknown names from the body cause a 400; unknown names from the DB are filtered with a warning (defense-in-depth).
- `finish_run` now receives the accumulated `total_rows_synced`; failed syncs contribute 0 and never skew the total. The Monitor ETL "Filas sincronizadas" KPI and `rows_trend` chart now reflect real work.
- Extend `/api/etl/stats` with throughput (rows/sec computed server-side to avoid divide-by-zero), oldest watermark age, 24h error counts, and top tables by rows — all returned in parallel with the existing queries.
**Alternatives rejected**: Adding an ETL HTTP endpoint (scope creep; see D-016). Silently wiping *all* watermarks when `tables=[]` (accidental-rebuild risk). Deriving totals client-side (masks data-layer bugs).
**Rationale**: Keeps the read-only SQL policy (no destructive DDL on source). The write path to `etl_watermarks` is the only change, and it is idempotent. Operators can request a targeted rebuild of `stock` without waiting for every historical Exportaciones row to change on the server.
**See**: `etl/schema/init.sql`, `etl/db/postgres.py`, `etl/main.py`, `dashboard/app/api/etl/run/route.ts`, `dashboard/app/api/etl/stats/route.ts`, `dashboard/components/etl/ForceResyncDialog.tsx`, `dashboard/app/etl/page.tsx`.
