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
 * Builds a `$n` placeholder as plain string concatenation, deliberately NOT
 * via the `` `$${n}` `` template-literal idiom (a literal "$" immediately
 * followed by an interpolation): Next.js's production build (SWC/Terser)
 * folds this file's several adjacent `` `...` + `...` `` template-literal
 * concatenations into merged literals, and one such fold corrupted the
 * multi-part Haversine expression into invalid SQL ("$1cos(radians(..."
 * with no space/paren separating the placeholder from the next token) —
 * `next build`/vitest-on-unminified-source never caught it; only hitting the
 * real running container did. `ph()` sidesteps the whole class of bug: no
 * "$" character ever sits directly adjacent to a template interpolation
 * marker anywhere in this file.
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

export function buildScopeWhereClause(scope: Scope): ScopeQuery {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // --- Geography (radius-from-point; polygon not yet supported, see
  // docs/architecture/data-model.md "Deliberately deferred") ---
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

  // --- Property type(s) ---
  params.push(scope.property_types);
  conditions.push("property.property_type = ANY(" + ph(params.length) + "::text[])");

  // --- Size band (m2_built specifically, not m2_useful — see data-model.md) ---
  if (scope.size_min !== undefined) {
    params.push(scope.size_min);
    conditions.push("property.m2_built >= " + ph(params.length));
  }
  if (scope.size_max !== undefined) {
    params.push(scope.size_max);
    conditions.push("property.m2_built <= " + ph(params.length));
  }

  // --- Price band: MIN(current_price) across the property's *active*
  // listings (a deduplicated property can have 2+ listings at different
  // prices — see data-model.md's price_min/price_max note). Expressed as a
  // scalar subquery rather than a JOIN + GROUP BY/HAVING so this stays a
  // single composable WHERE fragment (the query-builder's stated contract),
  // not a query shape materialize.ts has to know about. A property with zero
  // active listings (e.g. every listing withdrawn) has a NULL subquery
  // result, which correctly fails any price condition rather than matching.
  if (scope.price_min !== undefined || scope.price_max !== undefined) {
    const minPriceExpr =
      "(SELECT MIN(listing.current_price) FROM listing WHERE listing.property_id = property.id AND listing.status = 'active')";
    if (scope.price_min !== undefined) {
      params.push(scope.price_min);
      conditions.push(minPriceExpr + " >= " + ph(params.length));
    }
    if (scope.price_max !== undefined) {
      params.push(scope.price_max);
      conditions.push(minPriceExpr + " <= " + ph(params.length));
    }
  }

  // --- Hard exclusions ---
  const exclusions = scope.hard_exclusions;
  if (exclusions?.requires_elevator) {
    conditions.push("property.has_elevator IS TRUE");
  }
  if (exclusions?.excludes_ground_floor) {
    params.push(GROUND_FLOOR_VALUE);
    conditions.push("LOWER(COALESCE(property.floor, '')) <> " + ph(params.length));
  }

  return { whereSql: conditions.join(" AND "), params };
}
