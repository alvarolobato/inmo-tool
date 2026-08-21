/**
 * Zero-candidate diagnosis result shape (issue #194) — client-safe (no `pg`
 * import). Split out of lib/profile-diagnostics.ts for the same reason
 * lib/profiles-schema.ts is split from lib/db/profiles.ts: that module
 * imports lib/db-write (the `pg` client). ZeroCandidatesDiagnostic.tsx needs
 * the *type* but must never import the diagnostic function itself.
 * lib/profile-diagnostics.ts re-exports everything here for server-side
 * callers (the API route).
 */

export interface NearestPropertyResult {
  propertyId: number;
  distanceKm: number;
}

/**
 * Whether the connector fleet has ever actually crawled the geography a
 * profile sits in — issue #217's fourth acceptance criterion. Until this
 * existed, `geography_empty` could only say "no matches nearby", which reads
 * as "there is nothing here" when the truth was often "nobody has looked
 * here yet". Derived from `connector_scope_state` (written by
 * `etl.orchestrator`), whose rows carry the center/radius of each scope a
 * connector resolved, so this can be answered from a lat/lon alone without
 * reimplementing any connector's Python-side geography resolution.
 *
 * - `never_crawled`: no connector resolves ANY scope covering this point.
 *   Adding a connector or extending one's coverage table is the fix; waiting
 *   will not help.
 * - `awaiting_turn`: at least one connector covers this point but has never
 *   actually reached it — the shared circuit breaker was already open before
 *   its turn came (issue #217's starvation bug). Waiting WILL help; D-030's
 *   rotation bounds how long.
 * - `crawled`: a scope covering this point was genuinely attempted at least
 *   once, so "no matches nearby" is a real answer about real inventory.
 */
export type AreaCoverage =
  /**
   * No connector has a coverage circle containing this point. Note the
   * claim is deliberately weak — "we have no record of a crawl here", not
   * "nobody covers this area". Coverage circles are conservative
   * under-estimates of the municipality actually crawled (see
   * `_MUNICIPAL_COVERAGE_RADIUS_KM` in `etl/orchestrator.py`), and a scope
   * gets no row at all until its first attempt or budget-skip, so a
   * genuinely covered area can land here for a run or two.
   */
  | { kind: "never_crawled" }
  /** A covering scope exists and has never been attempted — waiting helps. */
  | { kind: "awaiting_turn"; connectorNames: string[] }
  /**
   * A covering scope HAS been attempted, but no `discover()` for it has
   * ever succeeded (PR #228 review, finding 1). Distinct from `crawled`:
   * "no matches nearby" is NOT a real statement about real inventory here,
   * because nothing was ever successfully retrieved for this area.
   */
  | { kind: "attempted_never_succeeded"; connectorNames: string[]; lastAttemptedAt: string }
  /**
   * A covering scope's `discover()` genuinely succeeded, so "no matches
   * nearby" is a real answer about real inventory.
   */
  | { kind: "crawled"; lastCrawledAt: string };

export type ZeroCandidateDiagnosis =
  | { kind: "not_zero"; matchedCount: number }
  | { kind: "never_materialized" }
  | {
      kind: "geography_empty";
      // Issue #659/D-147: `radiusKm`/`areaCoverage` are meaningless for an
      // "everywhere" scope (there is no center to measure distance/coverage
      // from) — null for that case rather than a fabricated radius or a
      // fabricated coverage claim. `nearest` stays null too (nothing to
      // compute nearest-to), which the UI already renders as "no active
      // listing in the whole database yet" — the exactly correct message
      // for an unfiltered profile's zero-candidate case.
      radiusKm: number | null;
      nearest: NearestPropertyResult | null;
      connectorLastRunFinishedAt: string | null;
      areaCoverage: AreaCoverage | null;
    }
  | { kind: "type_empty"; geographyCount: number; propertyTypes: string[] }
  | {
      kind: "price_size_empty";
      typeCount: number;
      priceMin: number | undefined;
      priceMax: number | undefined;
      sizeMin: number | undefined;
      sizeMax: number | undefined;
    }
  | { kind: "exclusion_empty"; priceSizeCount: number; excludedBy: string[] }
  | { kind: "stale_materialization"; funnelCount: number };
