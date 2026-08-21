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

import { effectiveConnectors, type Scope } from "@/lib/profiles-schema";

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
 * lib/db-write.ts) that work correctly in production.
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
 * The `property` columns whose NULLs the hard-filter engine can fill from an
 * LLM-recovered value in `ai_assessment` (assessment_type='extract', #28) —
 * exactly the fields that flow writes into `result`, minus `m2_useful` (no
 * current scope filter reads it — see data-model.md). `rooms`/`bathrooms`
 * aren't consulted by any filter today either, but are kept here so a future
 * filter that adds them gets the fallback for free.
 */
export type ExtractFallbackColumn =
  | "m2_built"
  | "rooms"
  | "bathrooms"
  | "floor"
  | "has_elevator";

/**
 * Per-column SQL cast for the JSON *text* value pulled out of
 * `ai_assessment.result` (`->>` always yields text), so the fallback compares
 * and behaves exactly like the real `property.<col>`. `floor` is inherently
 * free text, so it takes no cast.
 */
const EXTRACT_FALLBACK_CAST: Record<ExtractFallbackColumn, string> = {
  m2_built: "::numeric",
  rooms: "::integer",
  bathrooms: "::integer",
  floor: "",
  has_elevator: "::boolean",
};

/**
 * Minimum per-field confidence an extracted value must clear before a HARD
 * filter is allowed to trust it (D-067). Below this the field is treated as
 * UNKNOWN: the subquery returns no row, so the COALESCE falls straight
 * through to `property.<col>` (i.e. NULL when the connector never structured
 * it). A shaky extraction must never be able to *confidently exclude* a real
 * match — a false negative from a low-confidence guess is a worse failure
 * mode for a hard filter than simply lacking the datum (issue #182 EC-2).
 */
export const EXTRACT_FALLBACK_MIN_CONFIDENCE = 0.6;

/**
 * `COALESCE(property.<col>, <latest high-confidence extract value>)` for one
 * field, as a bare SQL fragment.
 *
 * `property.<col>` ALWAYS wins when present (issue #182 EC-3) — a
 * connector-structured value is never shadowed by an LLM inference, and a
 * later sync that fills the column silently retires the fallback. Only when
 * `property.<col>` is NULL does the scalar subquery supply the extracted
 * value, and only when that field's `confidence_per_field` entry clears
 * `EXTRACT_FALLBACK_MIN_CONFIDENCE` (issue #182 EC-1/EC-2).
 *
 * The "latest row for the type" shape mirrors `getLatestAssessment`
 * (ai-assessment/cache.ts) and `loadFlags` (candidates.ts) exactly
 * (`ORDER BY generated_at DESC, id DESC`), inlined as a correlated
 * `LIMIT 1` subquery so this module stays a PURE, DB-connectionless SQL
 * string builder (its documented contract). It binds NO params: the column
 * comes from a closed union (never user input) and the threshold is a fixed
 * policy literal, so the funnel stages' positional-`$n` ordering is
 * untouched — every existing placeholder keeps its number.
 */
export function extractFallbackExpr(column: ExtractFallbackColumn): string {
  const valueExpr = "(ax.result->>'" + column + "')" + EXTRACT_FALLBACK_CAST[column];
  return (
    "COALESCE(property." +
    column +
    ", (SELECT " +
    valueExpr +
    " FROM ai_assessment ax WHERE ax.property_id = property.id" +
    " AND ax.assessment_type = 'extract'" +
    " AND (ax.result->'confidence_per_field'->>'" +
    column +
    "')::numeric >= " +
    EXTRACT_FALLBACK_MIN_CONFIDENCE +
    " ORDER BY ax.generated_at DESC NULLS LAST, ax.id DESC LIMIT 1))"
  );
}

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

  // --- Geography (radius-from-point, or the "everywhere" sentinel — issue
  // #659/D-147; polygon not yet supported, see docs/architecture/data-model.md
  // "Deliberately deferred") + the unconditional active-listing requirement,
  // as ONE stage: a property with no currently-active listing must never
  // count as a candidate regardless of geography alone, so "geography-only"
  // (issue #194 §2a) already means "geography AND has an active listing",
  // not geography in isolation. ---
  if (scope.geography.type === "radius") {
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
  } else if (scope.geography.type === "everywhere") {
    // Issue #659/D-147: "everywhere" drops the radius/haversine condition
    // entirely — no lat/lon params, no NOT NULL requirement. This is a
    // deliberate recall gain, not an oversight: today's radius clause
    // implies `lat/lon IS NOT NULL`, so every un-geocoded property (695 in
    // production at design time) is invisible to every radius profile. An
    // "everywhere" profile is the first thing that can ever match them. The
    // unconditional active-SALE EXISTS below still applies unconditionally
    // — dropping the radius clause must never also drop that gate.
  } else {
    // Exhaustiveness guard: ScopeSchema only defines "radius"/"everywhere"
    // (a discriminated union) today, so this branch is unreachable through
    // validated input — guarded here anyway so a future geography type
    // doesn't silently fall through with no filter at all (which would
    // match every property in the country as an unintended side effect,
    // rather than "everywhere" being the one deliberate way to do that).
    throw new Error(
      "Unsupported geography type: " + (scope.geography as { type: string }).type,
    );
  }
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
  //
  // `AND listing.source = ANY(...)` — per-profile connector selection (issue
  // #660, part of #658). Folded into this SAME EXISTS rather than a separate
  // clause/stage: the single enforcement point every downstream consumer
  // (feed, counts, scoring, assessment eligibility) inherits automatically
  // through `matched`, per the design's explicit warning against a second
  // WHERE drifting from this one. Reads as the funnel's "fuentes" dimension
  // conceptually (a future zero-candidate diagnostic branch could name it
  // that way), but there is deliberately no separate SQL clause/stage for it
  // — "all" (or an absent field) omits the condition entirely, same as
  // property_types' "all" sentinel (D-013/D-147): never bind an empty/NULL
  // array, which Postgres would evaluate to zero rows for every property.
  const connectors = effectiveConnectors(scope);
  const sourceCondition =
    connectors === "all"
      ? ""
      : (() => {
          params.push(connectors);
          return " AND listing.source = ANY(" + ph(params.length) + "::text[])";
        })();
  conditions.push(
    "EXISTS (SELECT 1 FROM listing WHERE listing.property_id = property.id AND listing.status = 'active' AND listing.operation = 'sale'" +
      sourceCondition +
      ")",
  );
  stages.push({ key: "geography", whereSql: conditions.join(" AND "), params: [...params] });

  // --- Property type(s). "all" (issue #659/D-147) omits the condition
  // entirely — never bind `undefined`/NULL into ANY($n::text[]), which
  // Postgres evaluates to zero rows (the exact silent-zero-matches failure
  // D-013 exists to prevent). A missing/absent property_types is rejected
  // at parse time (ScopeSchema); by the time a Scope reaches here it is
  // always either "all" or a real, non-empty array. ---
  if (scope.property_types !== "all") {
    params.push(scope.property_types);
    conditions.push("property.property_type = ANY(" + ph(params.length) + "::text[])");
  }
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
  // m2_built with the #28 extract fallback (issue #182): a private-seller
  // listing whose portal never structured m² but stated it in prose still
  // gets size-filtered, via the high-confidence extracted value, instead of
  // silently failing every size band. `property.m2_built` still wins when
  // present (EC-3).
  if (scope.size_min !== undefined) {
    params.push(scope.size_min);
    conditions.push(extractFallbackExpr("m2_built") + " >= " + ph(params.length));
  }
  if (scope.size_max !== undefined) {
    params.push(scope.size_max);
    conditions.push(extractFallbackExpr("m2_built") + " <= " + ph(params.length));
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
    // `IS NOT FALSE`, not `IS TRUE` (changed by issue #182 EC-2). A hard
    // exclusion removes only what is KNOWN-bad — the same philosophy
    // excludes_ground_floor already applies to an unpublished floor (see
    // GROUND_FLOOR_VALUE's note). Once the #28 extract fallback can supply a
    // value, `IS TRUE` would wrongly reject a property whose elevator is
    // genuinely UNKNOWN (NULL, or a below-threshold extraction the fallback
    // deliberately drops) — indistinguishable, post-gate, from a confident
    // "no elevator". `IS NOT FALSE` keeps unknowns and excludes only a
    // property whose elevator is confidently known to be absent
    // (property.has_elevator = false, or a >= 0.6 extraction of false).
    conditions.push(extractFallbackExpr("has_elevator") + " IS NOT FALSE");
  }
  if (exclusions?.excludes_ground_floor) {
    params.push(GROUND_FLOOR_VALUE);
    conditions.push(
      "LOWER(COALESCE(" + extractFallbackExpr("floor") + ", '')) <> " + ph(params.length),
    );
  }
  stages.push({ key: "exclusions", whereSql: conditions.join(" AND "), params: [...params] });

  return stages;
}

export function buildScopeWhereClause(scope: Scope): ScopeQuery {
  const stages = buildScopeFunnelStages(scope);
  const last = stages[stages.length - 1];
  return { whereSql: last.whereSql, params: last.params };
}
