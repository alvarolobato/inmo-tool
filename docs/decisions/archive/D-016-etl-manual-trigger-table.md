---
id: D-016
title: Proposed PostgreSQL trigger table for manual ETL sync
date: 2026-04-18
---

# D-016: Proposed PostgreSQL trigger table for manual ETL sync

*Decided: 2026-04-18*

**Context**: Issue #271 defines a "Sincronizar ahora" button for the ETL Monitor dashboard page.
The button needs to signal the ETL container (a pure Python scheduler with no HTTP API) to start an out-of-schedule sync.
**Proposed design**: Use a PostgreSQL `etl_manual_trigger` table. Dashboard writes a `pending` row; ETL polls the table every 10 s and atomically picks it up (`FOR UPDATE SKIP LOCKED`).
**Alternatives rejected**:
- ETL HTTP endpoint: requires adding Flask/aiohttp, exposing a new port in docker-compose, and handling concurrency in a single-threaded scheduler process.
- Shared filesystem flag file: fragile across container restarts, no atomicity.
**Rationale**: PG is already the shared state store for both containers. No new deps, no new ports, idempotent polling, single source of truth.
**Status**: Implemented. `etl_manual_trigger` is in `etl/schema/init.sql`; the dashboard writes via `dashboard/app/api/etl/run/route.ts` and the ETL polls via `etl/db/postgres.py`. D-020 extended the table with `force_full` / `force_tables`.
