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
  | { kind: "never_crawled" }
  | { kind: "awaiting_turn"; connectorNames: string[] }
  | { kind: "crawled"; lastAttemptedAt: string };

export type ZeroCandidateDiagnosis =
  | { kind: "not_zero"; matchedCount: number }
  | { kind: "never_materialized" }
  | {
      kind: "geography_empty";
      radiusKm: number;
      nearest: NearestPropertyResult | null;
      connectorLastRunFinishedAt: string | null;
      areaCoverage: AreaCoverage;
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
