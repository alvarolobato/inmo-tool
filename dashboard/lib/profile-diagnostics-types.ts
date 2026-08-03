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

export type ZeroCandidateDiagnosis =
  | { kind: "not_zero"; matchedCount: number }
  | { kind: "never_materialized" }
  | {
      kind: "geography_empty";
      radiusKm: number;
      nearest: NearestPropertyResult | null;
      connectorLastRunFinishedAt: string | null;
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
