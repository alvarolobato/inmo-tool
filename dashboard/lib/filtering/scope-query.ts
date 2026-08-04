/**
 * Turns a validated `Scope` (search_profile.scope, see lib/profiles-schema.ts
 * and docs/architecture/data-model.md) into a SQL WHERE fragment + params
 * that can be embedded into `SELECT property.id FROM property WHERE <whereSql>`.
 *
 * Pure function, no DB access — task 2.4 (#18)'s query-builder half. The
 * other half (lib/filtering/materialize.ts) runs the query this produces and
 * writes the result into profile_listing_state.
 *
 * Client-safe: this file has no `pg` import, only string/param assembly, so
 * it can be imported from either server or client code without the
 * Node-built-ins-in-browser-bundle break documented in profiles-schema.ts.
 */

import type { Scope } from "@/lib/profiles-schema";

export interface ScopeQuery {
  /** SQL boolean expression referencing the `property` table alias `property`. */
  whereSql: string;
  /** Positional params, in the order their `$n` placeholders appear in whereSql. */
  params: unknown[];
}

/**
 * Builds a `$n` placeholder as plain string concatenation.
 *
 * CORRECTED ROOT CAUSE (a prior version of this comment blamed Next.js's
 * production minifier "folding" `` `$${n}` `` template literals into
 * corrupted SQL — that explanation was wrong and has been retracted).
 * String constant-folding is semantics-preserving by construction: merging
 * adjacent literals concatenates their exact byte content, it cannot delete
 * a character (e.g. a separating space) from the middle of one. If it did,
 * most JavaScript in existence would break, not just this file — and in
 * fact this codebase has ~16 other live call sites using the exact same
 * `` `$${n}` `` idiom (lib/conversations.ts, lib/sql-filters.ts,
 * app/api/admin/interactions/route.ts) that work correctly in production.
 * The actual defect in the original draft of this file was an ordinary
 * missing-separator bug in hand-written string concatenation (a fragment
 * boundary without the intervening `" * "`/space), unrelated to template
 * literals, minification, or SWC — it was overwritten in the same commit
 * that introduced `ph()`, so the exact original line no longer exists to
 * cite. `ph()` itself carries no special bug-avoidance property; it was
 * simply rewritten carefully. What actually prevents a regression is the
 * `haversineKm` SQL-shape test below (`buildScopeWhereClause` tests),
 * which asserts the generated expression is well-formed — added specifically
 * because this bug was only caught by hitting a real running container,
 * and a plain string-concatenation typo like this should be a unit-test
 * failure, not a live-environment discovery.
 */
function ph(n: number): string {
  return "$" + n;
}

/**
 * Ground-floor detection is a case-insensitive exact match against the
 * connectors' normalized value ('bajo') — see etl/connectors/*_mapping.py.
 * A NULL/unknown floor is never treated as ground floor: excludes_ground_floor
 * only removes properties *known* to be ground floor, it doesn't penalize
 * properties whose floor wasn't published.
 */
const GROUND_FLOOR_VALUE = "bajo";

/**
 * Radius geography uses the Haversine formula directly in SQL rather than a
 * PostGIS/earthdistance extension — good enough at city scale (issue #18
 * Technical approach item 1) and avoids an extension dependency for the
 * first geography filter this project ships. Distance in km.
 */
function haversineKm(latPlaceholder: string, lonPlaceholder: string): string {
  const parts = [
    "(6371 * acos(least(1, greatest(-1, ",
    "cos(radians(" + latPlaceholder + ")) * cos(radians(property.lat)) * ",
    "cos(radians(property.lon) - radians(" + lonPlaceholder + ")) + ",
    "sin(radians(" + latPlaceholder + ")) * sin(radians(property.lat))",
    "))))",
  ];
  return parts.join("");
}

/**
 * One incremental funnel stage — the cumulative WHERE/params up through
 * (and including) this stage's own predicate(s). Consumed by the
 * zero-candidate diagnostic (issue #194), which re-applies each stage in
 * order against `property` to find which layer of the filter first drops
 * the count to zero (e.g. "14 pisos in the zone, but none in the price
 * band" vs. "0 properties in the zone at all").
 */
export interface ScopeFunnelStage {
  key: "geography" | "type" | "price_size" | "exclusions";
  whereSql: string;
  params: unknown[];
}

/**
 * Builds the scope's WHERE fragment as four cumulative snapshots (geography
 * -> +type -> +price/size -> +hard exclusions), one per funnel stage.
 * `buildScopeWhereClause` is a thin wrapper over this (`stages.at(-1)`), so
 * both share exactly one implementation of the geography/haversine
 * expression the `ph()` docstring above already warns is easy to get subtly
 * wrong via hand-written string concatenation.
 */
export function buildScopeFunnelStages(scope: Scope): ScopeFunnelStage[] {
  const stages: ScopeFunnelStage[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  // --- Geography (radius-from-point; polygon not yet supported, see
  // docs/architecture/data-model.md "Deliberately deferred") + the
  // unconditional active-listing requirement, as ONE stage: a property with
  // no currently-active listing must never count as a candidate regardless
  // of geography alone, so "geography-only" (issue #194 §2a) already means
  // "geography AND has an active listing", not geography in isolation. ---
  if (scope.geography.type !== "radius") {
    // ScopeSchema only defines "radius" today (z.literal("radius")), so this
    // branch is unreachable through validated input — guarded here anyway so
    // a future geography type doesn't silently fall through with no filter
    // at all (which would match every property in the country).
    throw new Error("Unsupported geography type: " + (scope.geography as { type: string }).type);
  }
  const [lat, lon] = scope.geography.center;
  params.push(lat);
  const latPh = ph(params.length);
  params.push(lon);
  const lonPh = ph(params.length);
  params.push(scope.geography.radius_km);
  const radiusPh = ph(params.length);
  conditions.push(
    "property.lat IS NOT NULL AND property.lon IS NOT NULL AND " +
      haversineKm(latPh, lonPh) +
      " <= " +
      radiusPh,
  );
  // A property with no currently-active listing (sold, withdrawn, expired —
  // or every listing simply removed) must never materialize as a live
  // candidate, independent of whether a price band is set. This used to
  // live only inside the price-band subquery below, which meant a profile
  // with no price filter had no status requirement at all and could
  // materialize sold/withdrawn properties (issue #18 names listing-level
  // status explicitly). Kept as its own EXISTS rather than folded into the
  // price subquery so it applies unconditionally.
  //
  // `AND listing.operation = 'sale'` — added by issue #31. Every search
  // profile in this schema is a SALE-candidate thesis (there is no rental
  // equivalent of `search_profile`); once #31's rental connector started
  // producing `operation = 'rent'` rows in the very same `property`/
  // `listing` tables (see rent-estimate.ts's module docstring for why
  // rentals reuse these tables instead of a separate one), a rental
  // property with no active SALE listing at all would otherwise still
  // pass this EXISTS check on the strength of its active RENT listing and
  // materialize into `profile_listing_state` as if it were a sale
  // candidate — a real cross-contamination bug, invisible until rental
  // data existed, caught while building #31 (not a pre-existing reported
  // issue). This is the one gate every profile depends on unconditionally,
  // so it's the one place this filter is load-bearing; the price-band
  // subquery below gets the same filter for the same reason, but a
  // profile with no price filter set relies on THIS EXISTS alone.
  conditions.push(
    "EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')",
  );
  stages.push({ key: "geography", whereSql: conditions.join(" AND "), params: [...params] });

  // --- Property type(s) ---
  params.push(scope.property_types);
  conditions.push("property.property_type = ANY(" + ph(params.length) + "::text[])");
  stages.push({ key: "type", whereSql: conditions.join(" AND "), params: [...params] });

  // --- Size band (m2_built specifically, not m2_useful — see data-model.md)
  // + price band: MIN(current_price) across the property's *active*
  // listings (a deduplicated property can have 2+ listings at different
  // prices — see data-model.md's price_min/price_max note). Expressed as a
  // scalar subquery rather than a JOIN + GROUP BY/HAVING so this stays a
  // single composable WHERE fragment (the query-builder's stated contract),
  // not a query shape materialize.ts has to know about. A property with zero
  // active listings (e.g. every listing withdrawn) has a NULL subquery
  // result, which correctly fails any price condition rather than matching.
  if (scope.size_min !== undefined) {
    params.push(scope.size_min);
    conditions.push("property.m2_built >= " + ph(params.length));
  }
  if (scope.size_max !== undefined) {
    params.push(scope.size_max);
    conditions.push("property.m2_built <= " + ph(params.length));
  }
  if (scope.price_min !== undefined || scope.price_max !== undefined) {
    // `AND listing.operation = 'sale'` — same issue #31 reasoning as the
    // EXISTS clause above: without it, a rental property's monthly rent
    // (an order of magnitude smaller than any sale price) could pass a
    // price-band filter meant for purchase prices.
    const minPriceExpr =
      "(SELECT MIN(listing.current_price) FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale')";
    if (scope.price_min !== undefined) {
      params.push(scope.price_min);
      conditions.push(minPriceExpr + " >= " + ph(params.length));
    }
    if (scope.price_max !== undefined) {
      params.push(scope.price_max);
      conditions.push(minPriceExpr + " <= " + ph(params.length));
    }
  }
  stages.push({ key: "price_size", whereSql: conditions.join(" AND "), params: [...params] });

  // --- Hard exclusions ---
  const exclusions = scope.hard_exclusions;
  if (exclusions?.requires_elevator) {
    conditions.push("property.has_elevator IS TRUE");
  }
  if (exclusions?.excludes_ground_floor) {
    params.push(GROUND_FLOOR_VALUE);
    conditions.push("LOWER(COALESCE(property.floor, '')) <> " + ph(params.length));
  }
  stages.push({ key: "exclusions", whereSql: conditions.join(" AND "), params: [...params] });

  return stages;
}

export function buildScopeWhereClause(scope: Scope): ScopeQuery {
  const stages = buildScopeFunnelStages(scope);
  const last = stages[stages.length - 1];
  return { whereSql: last.whereSql, params: last.params };
}
