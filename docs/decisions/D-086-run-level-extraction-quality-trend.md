---
id: D-086
title: Run-level extraction-quality aggregate + degradation trend on connector_run_results
date: 2026-08-06
rule: "connector_run_results.extraction_quality_summary (JSONB) aggregates issue #80's per-listing extraction-quality scores per connector-run and carries a run-over-run degradation trend. Reuse the stored per-listing scores — never recompute the scoring. NULL when a run scored no listings; no historical backfill."
group: "Data / connectors"
---

# D-086: Run-level extraction-quality aggregate + degradation trend

*Decided: 2026-08-06*

**Context**: Issue #171. The per-listing extraction-quality grade (issue #80,
D-084) lives on `listing.raw_extra.extraction_quality` — the right signal for a
human inspecting *one* property, but it cannot answer the question an operator
watching the ETL monitor actually has: *is a connector's extraction quality
degrading in aggregate, run over run, before it becomes a wall of
individually-thin listings someone has to notice one by one?* A connector can
partially break (a site renames one JSON key, one CSS selector goes stale) and,
thanks to `first_present()`'s deliberate fallback-chain design (issue #77), keep
reporting `status='ok'` with zero fetch errors while more and more listings
quietly fall through to a weaker fallback or a `None` field — run after run.
Nothing fails, nothing trips the circuit breaker, nothing counts toward
`error_count`. `connector_run_results.status` (ok/failed/circuit_open/skipped)
cannot represent it, and `error_msg` is free text nobody parses trends out of.
This is downstream of #80 landing the per-listing score (D-084) and adjacent to
#242/#109 (D-079), which land on the same `_record_connector_result` write site.

**Decision**:
- Add one additive, idempotent column to `connector_run_results`:
  `extraction_quality_summary JSONB` (nullable). Written by the orchestrator at
  `_record_connector_result` time from the per-listing scores of exactly the
  listings *this run* produced — selected by `source = connector` AND
  `last_fetched_at >= run start` (the same unconditional-`NOW()` write the
  persist path already does on every real fetch), so skip-if-seen listings the
  run never re-fetched are correctly excluded and the aggregate reflects what
  the run actually extracted. Shape:
  `{n, mean_score, grade_histogram:{A,B,C,F}, low_quality_count, weights_version,
  trend:{baseline_mean, baseline_n_runs, delta, degraded}}`.
- **Reuse, never recompute.** The aggregation + trend layer
  (`etl/extraction_quality_summary.py`, pure and unit-tested) consumes #80's
  stored per-listing dicts verbatim. It does not recompute, redefine, or
  re-weight the per-listing scoring — that stays D-084's sole responsibility.
- **Trend / degradation signal.** `trend` compares this run's `mean_score`
  against the trailing average of the connector's last `TREND_WINDOW` (5)
  *healthy* (`status='ok'`) runs that carry a summary under the **same**
  `weights_version` (a rubric bump makes older means apples-to-oranges), and
  flags `degraded=true` only when the drop is at least
  `DEGRADATION_DROP_THRESHOLD` (0.10, i.e. 10 percentage points) AND there is at
  least `MIN_BASELINE_RUNS` (2) of baseline history — so a brand-new connector
  never false-flags off a single data point.
- **NULL, not an empty object,** when a run produced no scored listings (a
  failed/empty run, or one that only skip-if-seen'd), so
  `WHERE extraction_quality_summary IS NOT NULL` stays a usable filter and a
  fetch-nothing run never fabricates a quality number. **No historical
  backfill** — the per-run listing set a past row aggregated is not
  reconstructable once `last_fetched_at` has moved on; old rows stay NULL and
  re-populate naturally as each connector runs again.
- **Monitor surface.** The run-detail view (`dashboard/components/etl/RunDetail.tsx`)
  renders it as a "Calidad" column: a grade + mean-completeness percent, plus a
  red degraded badge that shows **even on an `ok` run** — the whole point is
  that a genuinely-healthy run and a silently-degrading one are now visibly
  distinct. Per D-041 an e2e (`dashboard/e2e/etl-monitor.spec.ts`) seeds a
  degraded `status='ok'` connector alongside a healthy one and asserts the
  badge with no error surface.

**Alternatives rejected**:
- *An automated alert threshold analogous to the circuit breaker's rolling
  window* — issue #171 explicitly leaves this as possible later work. A visible
  number an operator glances at is enough for v1; the threshold/window are named
  module constants so tightening into an alert later is a small change.
- *Collecting scores in-memory through the deep `run_connector` call stack* —
  rejected in favour of a single query at the write site: idempotent, colocated
  with the row it annotates, and immune to threading state through the fetch
  loop.
- *A first-class per-field column instead of JSONB* — the histogram + trend are
  a cohesive descriptor read as a unit by one UI cell, matching the JSONB
  posture #109's `geography_scope` already set on this table.

**Rationale**: Makes the "silently degrading connector" failure mode a
queryable, glanceable signal on the exact table and write site #242/#109 already
extended, at zero cost to the per-listing scorer it composes with. The
degradation flag is computed from the connector's own recent history, so it
adapts per connector rather than assuming an absolute quality floor.

**See**: `etl/extraction_quality_summary.py`, `etl/orchestrator.py`
(`_record_connector_result`, `_extraction_quality_summary_for_run`,
`_run_listing_scores`, `_baseline_quality_means`), `etl/schema/init.sql`
(`connector_run_results.extraction_quality_summary`),
`dashboard/components/etl/RunDetail.tsx`, `dashboard/e2e/etl-monitor.spec.ts`,
`docs/architecture/connectors.md`. Builds on D-084 (per-listing score) and
D-079 (#242/#109, same write site). Issue #171.
