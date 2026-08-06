---
id: D-005
title: Use BIGSERIAL integer primary keys, not UUIDs or NUMERIC
date: 2026-08-02
group: Data / connectors
rule: Real-estate schema tables use `BIGSERIAL` integer PKs, not `NUMERIC` (no source-system precision constraint like the archived project had) or UUIDs (no distributed-write requirement).
order: 9
---

# D-005: Use BIGSERIAL integer primary keys, not UUIDs or NUMERIC

*Decided: 2026-08-02*

**Context**: The source project (powershop-analytics) used `NUMERIC(20,3)` primary keys throughout, because the 4D source system's REAL-typed PKs (e.g. `RegArticulo`, `RegCliente`) have 3-decimal-place values and lose precision if stored as `FLOAT8` or rounded to a coarser `NUMERIC` scale — see the archived `docs/decisions/archive/D-017-signed-int16-stock.md` and the source project's own type-conventions comment for the incident history behind that choice. inmo-tool has no such source system: every row (`property`, `listing`, `search_profile`, etc.) is created by this application itself, not mirrored from an external database with a pre-existing numeric key format to preserve losslessly.

**Decision**: All tables in `etl/schema/init.sql`'s real-estate schema use `BIGSERIAL` (or `SERIAL` where row counts will never approach 2^31) integer primary keys. Foreign keys are plain `BIGINT` referencing those.

**Alternatives rejected**:
- **`NUMERIC(20,3)` (the source project's convention)** — solves a precision problem that doesn't exist here. Carrying it over "because that's what the codebase does" would be cargo-culting a decision whose entire rationale (4D REAL-type precision) is inapplicable, and would confuse every future reader into thinking there's a hidden precision constraint to worry about.
- **UUIDs** — no requirement for globally-unique, generation-before-insert, or multi-writer-safe keys in this system (single Postgres instance, no distributed write path, no client-generated IDs needed before an INSERT returns). UUIDs would cost index size and readability (harder to eyeball in logs/`psql` output during development) for no corresponding benefit.

**Rationale**: Plain integer PKs are simpler, smaller, faster to index, and easier to work with during development and debugging. Nothing about this system's actual constraints calls for anything else.

**See**: `etl/schema/init.sql`, `docs/architecture/data-model.md`.
