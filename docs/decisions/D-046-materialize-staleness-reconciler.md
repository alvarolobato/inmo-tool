---
id: D-046
title: Self-healing staleness reconciler for profile re-materialization
date: 2026-08-05
group: Data / connectors
rule: A sweep-independent ETL poll loop (`etl/materialize_reconciler.py`, default 120s) re-fires `notify_materialize_all` whenever an active profile's `last_materialized_at` is behind the newest listing (or NULL), self-healing a missed best-effort notify (D-044). The connector-path notify also moves into a `finally`. Skips while a sweep is `running`; never re-implements the materializer in Python.
order: 49
---

# D-046: Self-healing staleness reconciler for profile re-materialization

*Decided: 2026-08-05*

**Context**: D-044 established that every listing-ingest path must trigger a
dashboard re-materialize (`notify_materialize_all` → `POST
/api/profiles/materialize-all`) after it commits — the connector sweep (#94)
and the browser-extension capture drain (#269). But that notify is
**best-effort and swallowed**, and — on the connector path — it was **not** in
a `finally`. A transient dashboard outage, or an unexpected raise in the
end-of-sweep bookkeeping (`_finish_connector_run`, the dedup pass) *before* the
notify ran, silently **skipped** the re-materialize, and **nothing retried it**
until the next ingest happened to succeed. That single-missed-notify-never-
retried failure is the likely real cause of the live "Pisos en Estepona"
incident (2026-08-05): a profile stranded at 0/stale matches for ~13h despite
qualifying listings sitting in the mirror. D-044 closed the *enumeration* gap
(which paths must notify); it did not make any single notify *durable*.

**Decision**: Add a **sweep-independent staleness reconciler** as the durable
backstop, plus two hardening changes:

1. **Periodic reconciler** (`etl/materialize_reconciler.py`): a poll loop
   started as its own daemon thread from `etl/main.py` (same pattern as the
   capture / manual-trigger / worklist-seed loops), default cadence **120s**
   (`etl.materialize_reconciler_interval_seconds` /
   `ETL_MATERIALIZE_RECONCILER_INTERVAL_SECONDS`). Each tick runs one cheap
   query: is any active profile stale — `last_materialized_at IS NULL`, or
   older than `MAX(GREATEST(listing.last_seen_at, last_fetched_at,
   first_seen_at))`? If so, it fires the **same** `notify_materialize_all`
   (trigger=`reconciler`) the ingest paths use. A missed notify therefore
   self-heals within one tick. It **skips while a connector sweep is
   `running`** (that sweep fires its own end-of-sweep notify), so it never
   races a redundant materialize while `last_seen_at` is bumped mid-sweep — it
   is a pure after-the-fact backstop (and the only re-materialize trigger for
   the capture path, which records no `connector_runs` row).
2. **`finally` on the connector-path notify**: `run_all_connectors` wraps
   `_finish_connector_run` + dedup in a `try` and moves `notify_materialize_all`
   into the `finally`, so a raise in that bookkeeping still *attempts* the
   notify instead of skipping it.
3. **`last_materialized_at` is authoritative**: verified that every materialize
   path (`materialize-all`, the single-profile route, D-040's
   `refreshProfileForScope`) goes through `materializeProfile`, which sets
   `last_materialized_at = NOW()` **unconditionally** inside its transaction
   (including the zero-matches case) — so the staleness comparison is accurate.
   No change needed; stated here so the invariant is not silently broken later.

The reconciler **never re-implements the TypeScript materializer in Python**
(D-044) — it only *detects* staleness in SQL and re-fires the existing HTTP
hook. Full `materializeAllProfiles` is fine at current scale (~30-70ms).

**Alternatives rejected**:
- *Only the `finally` (no reconciler)*: the `finally` fixes the bookkeeping-
  raise case but not a dashboard that is genuinely down at notify time — that
  notify is still lost with nothing to retry it. The reconciler is the part
  that makes recovery *durable*.
- *A durable outbox/queue the notify writes and the dashboard drains*: the
  dashboard is request-driven Next.js with no background worker, so it can't
  consume a queue (same reasoning D-044 gives). A periodic Python-side
  staleness check needs no new table and no dashboard-side consumer.
- *Per-profile scoped re-materialize (only the profiles the newest listing
  matches)*: premature at current scale and would require re-implementing the
  scope filter in Python — exactly what D-044 forbids. Coarse "some listing is
  newer than some profile's last materialize → materialize all" is always
  correct and cheap.
- *Not skipping while a sweep runs (fully sweep-independent)*: a long sweep
  bumps `last_seen_at` for the whole run while `last_materialized_at` hasn't
  advanced, so an unguarded reconciler fires a redundant materialize every tick
  for the entire sweep. Deferring to a `running` sweep (which fires its own
  notify) removes that noise while keeping the backstop.

**Rationale**: The bug class is "a single best-effort side effect was skipped
and never retried." Enumerating the paths (D-044) is necessary but not
sufficient; the durable fix is a cheap, idempotent reconciler that continuously
compares the mirror's newest ingest against each profile's last materialize and
heals any gap — independent of *why* a given notify was missed.

**See**: issue #285; D-044 (ingest-triggers-rematerialize); D-040 (quick
refresh); D-038 (ad-hoc run lock); `etl/materialize_reconciler.py`;
`etl/orchestrator.py::run_all_connectors` / `notify_materialize_all`;
`dashboard/lib/filtering/materialize.ts::materializeProfile`.
