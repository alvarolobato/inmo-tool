---
id: D-044
title: Every listing-ingest path must trigger a dashboard re-materialize
date: 2026-08-05
---

# D-044: Every listing-ingest path must trigger a dashboard re-materialize

*Decided: 2026-08-05*

**Context**: The "Pisos en Estepona" profile showed **0 matches** live (2026-08-05)
while 10 qualifying cheap pisos (142.900–191.000 €) sat in the mirror. The profile
was last materialized 2026-08-04 15:28; the qualifying listings were ingested
*later* and never folded into `profile_listing_state` — it held only 58 stale
over-ceiling rows (all `matched=false`). A manual `POST /api/profiles/materialize-all`
fixed it (0→5). Issue #94 had already wired `notify_materialize_all` into
`run_all_connectors`, so **connector sweeps** (scheduled and ad-hoc via
`etl_manual_trigger`, including D-040's profile-refresh sweep) re-materialize on
completion. But that covered only *one* of the two ways a listing enters the DB.
The **browser-extension capture path** (`etl/capture.py`, the ONLY ingestion path
for capture-only portals like Idealista/Aliseda, and a bulk one since the
batch-capture-a-search-page feature D-043/#262) writes listings via the same
`_upsert_canonical_listing` but never notified the dashboard — so every capture
left active profiles silently stale until a human clicked something.

**Decision**: Every code path that ingests listings into the mirror must, after
committing, trigger a dashboard re-materialize of all active profiles — reusing
the existing `orchestrator.notify_materialize_all()` (which POSTs
`/api/profiles/materialize-all`). Concretely today that is two paths:
`run_all_connectors` (issue #94) and `etl/capture.py::process_pending_captures`
(this decision). The notification fires **once per batch** and **only when at
least one listing was actually ingested**, is **best-effort and fully swallowed**
(ingest is already committed; materialize is idempotent, so a down/misconfigured
dashboard only defers scoring to the next sweep/manual trigger), and reuses the
TypeScript materializer via HTTP — the materialization logic is **never**
re-implemented in Python. Any future third ingestion path inherits the same
obligation.

**Alternatives rejected**:
- *Scoped re-materialize (only profiles whose geography overlaps the ingest)*:
  premature at current scale — a handful of active profiles, each a single scope
  query + upsert + scoring, so `materializeAllProfiles` is cheap. Revisit only if
  profile count grows enough to make a full recompute per batch measurable.
- *A queue table the dashboard drains* (mirroring capture/dedup): the dashboard is
  request-driven Next.js with no background worker, so it cannot consume a queue.
  The ETL→dashboard direction must be an outbound HTTP call from Python.
- *Fire per captured listing*: materialization is a full recompute of every
  profile — per-listing calls are pure waste. Batch-level firing is correct.

**Rationale**: The bug was not in the materializer or in #94's connector wiring —
both were correct — but in an *unenumerated* ingest path that quietly bypassed the
hook. Stating the invariant at the ingest layer ("if you wrote listings, you owe a
re-materialize") is what stops the next ingest path from silently reintroducing the
same class of stale-profile bug.

**See**: issue #269; `etl/capture.py::process_pending_captures`;
`etl/orchestrator.py::notify_materialize_all` (issue #94);
`dashboard/lib/filtering/materialize.ts`; D-040 (profile-refresh quick refresh),
D-043 (batch capture), D-038 (ad-hoc run lock).
