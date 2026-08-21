/**
 * Zero-candidate diagnostic — issue #194 (design: docs comment on #176 §4).
 *
 * Real incident this exists for: a profile named "Dos Hermanas" returned 0
 * of 238 ingested properties. Cause: the connector fleet's geography
 * resolution (#169) crawled Sevilla capital, ~13 km from the profile's
 * actual center, and the nearest real listing sat 7.6 km outside the
 * profile's 7 km radius — missed by 600 m. Nothing in the UI said so; the
 * operator only found out after an afternoon of manual SQL. This module
 * exists so that specific failure mode (and every other reason a profile
 * can show zero) renders a name, not a blank "0".
 *
 * Server-only: imports lib/db-write (the `pg` client) — never import this
 * from a client component.
 *
 * ## Ordered checks (issue #194 §2)
 *
 * 0. Scope invalid — NOT handled here. A malformed-scope profile (issue
 *    #113) is already rendered as its own visibly-broken row upstream
 *    (lib/db/profiles.ts's `ProfileListEntry`); this module only ever
 *    receives an already-parsed `SearchProfileRow`, so that branch can't
 *    reach this file at all.
 * 1. Never materialized (`last_materialized_at IS NULL`, issue #191).
 * 2. Materialized, zero matches — run the funnel
 *    (`lib/filtering/scope-query.ts`'s `buildScopeFunnelStages`) one stage
 *    at a time against `property`/`listing`:
 *    a. geography (+ active-listing existence) = 0 → nearest matching
 *       property regardless of distance, + global connector recency.
 *    b. + property type = 0
 *    c. + price/size = 0
 *    d. + hard exclusions = 0
 * 3. Funnel finds candidates (stage d's count > 0) but the profile's real
 *    matched_count is still 0 → stale materialization (scope edited after
 *    the last run, or a bug).
 *
 * Each stage's COUNT(*) query is independently cheap (bounded by the same
 * WHERE fragment scope-query.ts already produces, which the property table
 * is indexed for — idx_property_lat_lon, the property_type CHECK column,
 * etc.). Deliberately NOT combined into the Perfiles list's one aggregate
 * query (issue #192): this only ever runs lazily, for a profile a caller
 * has already established is at zero candidates — a small minority of rows,
 * never during the page's initial load.
 */

import { sql } from "@/lib/db-write";
import { buildScopeFunnelStages, extractFallbackExpr } from "@/lib/filtering/scope-query";
import type { SearchProfileRow } from "@/lib/profiles-schema";
import type { AreaCoverage, NearestPropertyResult, ZeroCandidateDiagnosis } from "@/lib/profile-diagnostics-types";

export type { AreaCoverage, NearestPropertyResult, ZeroCandidateDiagnosis } from "@/lib/profile-diagnostics-types";

/** Human labels for scope.hard_exclusions keys — mirrors ProfileForm.tsx's checkbox copy exactly. */
const EXCLUSION_LABELS: Record<string, string> = {
  requires_elevator: "el filtro de ascensor",
  excludes_ground_floor: "el filtro de planta baja",
};

async function countProperties(whereSql: string, params: unknown[]): Promise<number> {
  const rows = await sql<{ count: number }>(`SELECT COUNT(*) AS count FROM property WHERE ${whereSql}`, params);
  return rows[0]?.count ?? 0;
}

function boundingBoxDeltas(latDeg: number, radiusKm: number, padFactor = 1.15): { latDelta: number; lonDelta: number } {
  // Same padded-box formula as lib/analytics/area-price.ts (1 deg lat ~=
  // 111.0 km everywhere; 1 deg lon ~= 111.320*cos(lat) km at this latitude);
  // the box is only ever a superset of the circle it bounds, so it can never
  // exclude a point the exact Haversine check below would have kept.
  return {
    latDelta: (radiusKm / 111.0) * padFactor,
    lonDelta: (radiusKm / (111.32 * Math.cos((latDeg * Math.PI) / 180))) * padFactor,
  };
}

/**
 * The single nearest property with an active listing to `[lat, lon]`,
 * regardless of distance — issue #194's literal "Dos Hermanas" case: when a
 * profile's geography-only count is zero, this is what names how far away
 * the nearest real candidate actually is.
 *
 * Bounded via the same bounding-box prefilter pattern
 * `lib/analytics/area-price.ts` uses (measured there: 355ms/1.65M buffer
 * reads -> 7.5ms/27k reads once idx_property_lat_lon can satisfy the range
 * condition) — tried first at a generous fixed box (comfortably larger than
 * any single-city search), falling back to an unfiltered full-table scan
 * only if that box is empty (rare in practice: it means literally nothing
 * in the entire ingested inventory is within ~200 km of the profile).
 *
 * `listing.operation = 'sale'` (issue #31 Opus-review fix, PR #199): this
 * function backs `ZeroCandidatesDiagnostic`, which tells the user "the
 * nearest active listing is X km away, widen your radius" — the exact
 * screen shown when a profile has zero sale candidates nearby, which is
 * also where a rental listing is most likely to be the physically nearest
 * active row now that `operation='rent'` rows exist. Without this filter
 * the diagnostic could point at a rental and advise widening the radius
 * when the real issue is that there's no sale inventory there at all.
 */
export async function findNearestProperty(center: [number, number]): Promise<NearestPropertyResult | null> {
  const [lat, lon] = center;
  const BOUNDED_BOX_KM = 200;
  const { latDelta, lonDelta } = boundingBoxDeltas(lat, BOUNDED_BOX_KM);

  const haversineExpr =
    "(6371 * acos(least(1, greatest(-1, " +
    "cos(radians($1)) * cos(radians(property.lat)) * " +
    "cos(radians(property.lon) - radians($2)) + " +
    "sin(radians($1)) * sin(radians(property.lat))" +
    "))))";

  const bounded = await sql<{ id: number; distance_km: string }>(
    `SELECT property.id, ${haversineExpr} AS distance_km
       FROM property
      WHERE property.lat IS NOT NULL AND property.lon IS NOT NULL
        AND EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')
        AND property.lat BETWEEN $1 - $3 AND $1 + $3
        AND property.lon BETWEEN $2 - $4 AND $2 + $4
      ORDER BY distance_km ASC
      LIMIT 1`,
    [lat, lon, latDelta, lonDelta],
  );
  if (bounded.length > 0) {
    return { propertyId: bounded[0].id, distanceKm: Number(bounded[0].distance_km) };
  }

  // Fallback: nothing within the generous box — try the whole table. Rare
  // (an almost-empty inventory, or a profile centered somewhere with no
  // ingested coverage anywhere nearby); correctness over speed here.
  const unbounded = await sql<{ id: number; distance_km: string }>(
    `SELECT property.id, ${haversineExpr} AS distance_km
       FROM property
      WHERE property.lat IS NOT NULL AND property.lon IS NOT NULL
        AND EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')
      ORDER BY distance_km ASC
      LIMIT 1`,
    [lat, lon],
  );
  if (unbounded.length === 0) return null;
  return { propertyId: unbounded[0].id, distanceKm: Number(unbounded[0].distance_km) };
}

/**
 * Global connector recency (`MAX(connector_runs.finished_at)`) — no new
 * per-connector query, reuses the same `connector_runs` table
 * `lib/db/connectors.ts` already reads from, just the single global max the
 * design calls for ("no crawl has run in a while" vs. "a crawl ran, but
 * nothing is that close" read differently).
 */
async function getConnectorLastRunFinishedAt(): Promise<string | null> {
  const rows = await sql<{ max: string | null }>(`SELECT MAX(finished_at) AS max FROM connector_runs`);
  return rows[0]?.max ?? null;
}

/**
 * Has any connector ever actually crawled the area around `center`?
 * Issue #217 / D-030.
 *
 * `connector_scope_state` holds one row per (connector, resolved scope) the
 * ETL orchestrator has ever been able to resolve, carrying the circle that
 * scope's connector actually CRAWLS — the resolved municipality's centroid
 * plus a conservative extent, never the profile's own search radius (PR
 * #228 review, finding 2; see `_scope_coverage_columns`). So "has anyone
 * crawled a scope covering this point" is a plain containment test here —
 * no need to mirror each connector's Python geography resolution in
 * TypeScript.
 *
 * The four outcomes are genuinely different advice, which is the whole
 * point of the issue: no covering row means we have no record of a crawl
 * here; a covering scope never attempted means waiting is exactly the right
 * move; a covering scope attempted but never successfully discovered means
 * something is broken and waiting will not fix it; only a scope whose
 * `discover()` actually SUCCEEDED lets "no matches" be a real statement
 * about real inventory.
 *
 * Every uncertainty in here resolves toward claiming LESS coverage, never
 * more — telling a user their area was crawled and is empty when nothing
 * ever looked at it is precisely the misdiagnosis issue #217 was filed
 * about. Hence: `coverage_radius_km` is COALESCEd to 0 rather than to some
 * default (a row without a radius came from a scope with no derivable crawl
 * footprint at all, and inventing one would fabricate a coverage claim),
 * and `crawled` is driven off `last_discovered_at`, never off
 * `last_attempted_at`.
 */
export async function getAreaCoverage(center: [number, number]): Promise<AreaCoverage> {
  const [lat, lon] = center;
  const rows = await sql<{
    connector_name: string;
    last_attempted_at: string | null;
    last_discovered_at: string | null;
  }>(
    `SELECT connector_name, last_attempted_at, last_discovered_at
       FROM connector_scope_state
      WHERE coverage_center_lat IS NOT NULL AND coverage_center_lon IS NOT NULL
        AND (6371 * acos(least(1, greatest(-1,
              cos(radians($1)) * cos(radians(coverage_center_lat)) *
              cos(radians(coverage_center_lon) - radians($2)) +
              sin(radians($1)) * sin(radians(coverage_center_lat))
            )))) <= COALESCE(coverage_radius_km, 0)`,
    [lat, lon],
  );

  if (rows.length === 0) return { kind: "never_crawled" };

  // Most recent real SUCCESS wins — a point can sit inside several
  // connectors' scopes, and the freshest successful crawl is what the
  // user's "has anyone actually looked here?" question is really about.
  const discovered = rows.filter((r) => r.last_discovered_at !== null);
  if (discovered.length > 0) {
    const lastCrawledAt = discovered
      .map((r) => r.last_discovered_at as string)
      .sort()
      .at(-1)!;
    return { kind: "crawled", lastCrawledAt };
  }

  const attempted = rows.filter((r) => r.last_attempted_at !== null);
  if (attempted.length === 0) {
    return { kind: "awaiting_turn", connectorNames: rows.map((r) => r.connector_name).sort() };
  }
  return {
    kind: "attempted_never_succeeded",
    connectorNames: attempted.map((r) => r.connector_name).sort(),
    lastAttemptedAt: attempted
      .map((r) => r.last_attempted_at as string)
      .sort()
      .at(-1)!,
  };
}

/**
 * Diagnoses why `profile` currently has zero matched candidates. Callers
 * must only invoke this for a profile already known/believed to be at zero
 * (issue #194: lazy, on-demand, never part of the list's main aggregate) —
 * this function still defensively re-checks the real matched_count first
 * and returns `{kind: "not_zero", ...}` if a race (e.g. a materialize ran
 * between the caller's check and this call) means it no longer is, rather
 * than confidently rendering a stale diagnosis.
 */
export async function diagnoseZeroCandidates(profile: SearchProfileRow): Promise<ZeroCandidateDiagnosis> {
  const matchedRows = await sql<{ count: number }>(
    `SELECT COUNT(*) AS count FROM profile_listing_state WHERE profile_id = $1 AND matched = true`,
    [profile.id],
  );
  const matchedCount = matchedRows[0]?.count ?? 0;
  if (matchedCount > 0) {
    return { kind: "not_zero", matchedCount };
  }

  // 1. Never materialized.
  if (profile.last_materialized_at === null) {
    return { kind: "never_materialized" };
  }

  // 2. Materialized, zero matches — run the funnel one stage at a time.
  const stages = buildScopeFunnelStages(profile.scope);
  const geographyStage = stages.find((s) => s.key === "geography")!;
  const typeStage = stages.find((s) => s.key === "type")!;
  const priceSizeStage = stages.find((s) => s.key === "price_size")!;
  const exclusionsStage = stages.find((s) => s.key === "exclusions")!;

  const geographyCount = await countProperties(geographyStage.whereSql, geographyStage.params);
  if (geographyCount === 0) {
    // Issue #659/D-147: an "everywhere" scope has no center — there is
    // nothing to measure "nearest property" or "area coverage" against.
    // Zero matches here means literally no property in the whole pool has
    // an active SALE listing, an edge case worth naming plainly rather than
    // forcing it through center-shaped fields it cannot honestly fill.
    if (profile.scope.geography.type === "everywhere") {
      const connectorLastRunFinishedAt = await getConnectorLastRunFinishedAt();
      return {
        kind: "geography_empty",
        radiusKm: null,
        nearest: null,
        connectorLastRunFinishedAt,
        areaCoverage: null,
      };
    }
    const [nearest, connectorLastRunFinishedAt, areaCoverage] = await Promise.all([
      findNearestProperty(profile.scope.geography.center),
      getConnectorLastRunFinishedAt(),
      getAreaCoverage(profile.scope.geography.center),
    ]);
    return {
      kind: "geography_empty",
      radiusKm: profile.scope.geography.radius_km,
      nearest,
      connectorLastRunFinishedAt,
      areaCoverage,
    };
  }

  const typeCount = await countProperties(typeStage.whereSql, typeStage.params);
  if (typeCount === 0) {
    // Unreachable when property_types === "all" (the type stage adds no
    // extra condition in that case, so typeCount === geographyCount, which
    // is already > 0 by this point) — the Array.isArray guard is here only
    // to keep this branch honestly typed rather than asserting it away.
    return {
      kind: "type_empty",
      geographyCount,
      propertyTypes: Array.isArray(profile.scope.property_types) ? profile.scope.property_types : [],
    };
  }

  const priceSizeCount = await countProperties(priceSizeStage.whereSql, priceSizeStage.params);
  if (priceSizeCount === 0) {
    return {
      kind: "price_size_empty",
      typeCount,
      priceMin: profile.scope.price_min,
      priceMax: profile.scope.price_max,
      sizeMin: profile.scope.size_min,
      sizeMax: profile.scope.size_max,
    };
  }

  const exclusionsCount = await countProperties(exclusionsStage.whereSql, exclusionsStage.params);
  if (exclusionsCount === 0) {
    const activeExclusions = Object.entries(profile.scope.hard_exclusions ?? {}).filter(([, v]) => v === true);
    // Test each active exclusion in isolation (on top of the price/size
    // stage) to name which one alone drives the count to zero — an
    // interaction between two exclusions (neither alone zeroes it, only the
    // combination does) falls back to naming all active exclusions, since
    // there's no single culprit to point at.
    const soleCulprits: string[] = [];
    for (const [key] of activeExclusions) {
      const isolatedConditions = [priceSizeStage.whereSql];
      const isolatedParams = [...priceSizeStage.params];
      // These isolated predicates MUST match buildScopeFunnelStages' hard
      // exclusions exactly (issue #182): both now consult the #28 extract
      // fallback via `extractFallbackExpr`, and requires_elevator is
      // `IS NOT FALSE` (excludes only a confidently-known missing elevator),
      // so the "which stage zeroed the count" attribution stays faithful to
      // what the real filter did. `extractFallbackExpr` binds no params, so
      // the `$${isolatedParams.length}` numbering below is unaffected.
      if (key === "requires_elevator") {
        isolatedConditions.push(extractFallbackExpr("has_elevator") + " IS NOT FALSE");
      } else if (key === "excludes_ground_floor") {
        isolatedParams.push("bajo");
        isolatedConditions.push(
          `LOWER(COALESCE(${extractFallbackExpr("floor")}, '')) <> $${isolatedParams.length}`,
        );
      } else {
        continue;
      }
      const isolatedCount = await countProperties(isolatedConditions.join(" AND "), isolatedParams);
      if (isolatedCount === 0) soleCulprits.push(EXCLUSION_LABELS[key] ?? key);
    }
    const excludedBy =
      soleCulprits.length > 0 ? soleCulprits : activeExclusions.map(([key]) => EXCLUSION_LABELS[key] ?? key);
    return { kind: "exclusion_empty", priceSizeCount, excludedBy };
  }

  // 3. Funnel finds candidates, but the real matched_count is still 0 —
  // stale materialization (scope edited since the last run, or a bug).
  return { kind: "stale_materialization", funnelCount: exclusionsCount };
}
