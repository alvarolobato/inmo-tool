/**
 * Shared shapes for the connector-observability API routes (issue #104).
 *
 * These describe `connector_runs` / `connector_run_results` (Phase 1.3,
 * issue #11; extended by issue #99 with `connectors_skipped` and the
 * 'skipped' result status) — NOT the source project's `etl_sync_runs` /
 * `etl_sync_run_tables`, which this dashboard used to read. Those tables
 * still exist in `etl/schema/init.sql` but are orphaned: nothing has
 * written to them since Phase 1.1 deleted the per-table sync modules, so
 * every route here was pointed at permanently-empty tables.
 *
 * Model shift, in one line: PowerShop synced N *tables* per run; this
 * project runs N *connectors* per run. A "table" row in the old model is a
 * connector's result row in this one.
 */

/** A single orchestrator sweep — one row of `connector_runs`. */
export interface ConnectorRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  /** running | success | partial | failed (connector_runs status CHECK). */
  status: string;
  total_connectors: number | null;
  connectors_ok: number | null;
  connectors_failed: number | null;
  /**
   * Issue #99. Counted separately from ok/failed so "nothing ran because I
   * disabled it" is distinguishable from a healthy-but-empty run — exactly
   * the confusion that column was added to end. NULL on runs predating #99.
   */
  connectors_skipped: number | null;
  /**
   * Derived (SUM over this run's result rows), not stored columns — the old
   * model had `etl_sync_runs.total_rows_synced`; `connector_runs` has no
   * equivalent, so the routes aggregate it from `connector_run_results`.
   */
  total_discovered: number | null;
  total_fetched: number | null;
  trigger: string;
}

/**
 * One resolved geography a run actually ran against (issue #109, D-079). One
 * entry per `ConnectorScope` the orchestrator walked, tagged with what happened
 * to that specific geography — persisted as `connector_run_results.geography_scope`
 * (JSONB). This is the queryable audit trail that replaces reverse-engineering
 * `error_msg`: an operator can see, per city, whether it was crawled, found
 * empty, uncovered, or unresolvable.
 */
export interface GeographyScopeEntry {
  /** The site-specific scope key, or null when the connector resolves none. */
  scope_key: string | null;
  /** [lat, lon] of the profile centre, or null for a free-text scope. */
  center: [number, number] | null;
  radius_km: number | null;
  rooms: number | null;
  /**
   * crawled | empty | uncovered | unresolvable | budget | soft_block |
   * fresh_this_cycle | duplicate | failed — what happened to this geography.
   */
  outcome: string;
  /**
   * Issue #530: the search_profile id(s) this scope came from — the union of
   * every profile whose geography deduped onto this one scope (a scope shared
   * by two profiles is still crawled once, but names both). Makes each outcome
   * attributable to its profile(s) so a (connector × profile) view is possible
   * (enables #531/#532). Empty `[]` for an unattributed scope (a global
   * `geography_override` or a manual/test scope) — never null. Historical rows
   * written before #530 lack the field; treat a missing value as `[]` at the
   * read boundary (no `|| legacy` fallback elsewhere).
   */
  profile_ids: number[];
}

/**
 * Issue #171 (D-086): the run-over-run degradation trend attached to a run's
 * extraction-quality summary. `baseline_mean` is the trailing average of the
 * connector's recent healthy runs (null until it has enough history);
 * `degraded` is true only when this run's mean fell meaningfully below it.
 */
export interface ExtractionQualityTrend {
  baseline_mean: number | null;
  baseline_n_runs: number;
  /** current mean_score − baseline_mean; null when there's no baseline yet. */
  delta: number | null;
  degraded: boolean;
}

/**
 * Issue #171 (D-086): the run-level aggregate of the per-listing
 * extraction-quality grades (#80/D-084) of the listings THIS run produced —
 * `connector_run_results.extraction_quality_summary` (JSONB). The signal that
 * makes a silently-degrading connector (status='ok', zero fetch errors, but
 * average extraction completeness quietly dropping) visible in the monitor.
 * Null on a run that produced no scored listings.
 */
export interface ExtractionQualitySummary {
  /** How many scored listings this run produced. */
  n: number;
  /** Mean weighted-completeness fraction (0..1) across those listings. */
  mean_score: number;
  grade_histogram: { A: number; B: number; C: number; F: number };
  /** Listings graded C or F — the ones worth an operator's attention. */
  low_quality_count: number;
  weights_version: number | null;
  trend?: ExtractionQualityTrend;
}

/** One connector's outcome within a run — a row of `connector_run_results`. */
export interface ConnectorRunResult {
  id: number;
  connector_name: string;
  started_at: string;
  finished_at: string | null;
  /** Derived from finished_at - started_at; the table stores no duration. */
  duration_ms: number | null;
  /** ok | failed | circuit_open | skipped. */
  status: string;
  /**
   * The ingestion funnel — the reason this project's monitor can show more
   * than PowerShop's could: how many listings the connector *found* vs. how
   * many it successfully *fetched and stored* vs. how many errored. A wide
   * discovered→fetched gap is the signal that a site changed its markup or
   * started soft-blocking, visible long before the run itself fails.
   */
  discovered_count: number;
  fetched_count: number;
  error_count: number;
  /**
   * On a non-'ok' status this carries the orchestrator's per-scope detail
   * (including its "scopes ok: …" summary), which is currently the only
   * place the geography scope a connector actually ran against is recorded
   * — `connector_run_results` has no scope column. On 'skipped' it carries
   * the reason (e.g. "disabled via connector_config").
   */
  error_msg: string | null;
  /**
   * Issue #242 (D-079): the typed, queryable failure kind — one of
   * soft_block | network | structure_change | unresolvable | uncovered |
   * empty_result | other, or null for a clean run with no notable failure
   * signal. The trend-analyzable counterpart to `error_msg`'s prose.
   */
  failure_classification: string | null;
  /**
   * Issue #109 (D-079): the resolved geographies this run actually ran
   * against, each with its per-scope outcome. Null only on rows that somehow
   * ran with zero scopes.
   */
  geography_scope: GeographyScopeEntry[] | null;
  /**
   * Issue #171 (D-086): the run-level extraction-quality aggregate + trend, or
   * null on a run that produced no scored listings.
   */
  extraction_quality_summary: ExtractionQualitySummary | null;
}
