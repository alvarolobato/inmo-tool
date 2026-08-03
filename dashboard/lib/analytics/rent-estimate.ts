/**
 * Rent estimation — issue #151, standing in for #31 until it lands.
 *
 * ## The decision, stated explicitly (per #151's honesty constraint: "do
 * not invent a rent figure and present it as derived")
 *
 * Issue #31 (comparable-rental ingestion: a `rental_listing` table + a
 * per-site rental connector + a nearest-comparable-median estimator) is
 * **not built**, and building it is out of this PR's scope — it requires a
 * new connector under `etl/connectors/`, which other in-flight work on this
 * repo owns (see the PR body's "stay out of etl/" boundary). Without it,
 * there is no comparable rental signal anywhere in the database: no
 * `rental_listing` table, no rent data on any ingested row.
 *
 * Given that, three options were on the table (issue #151's Context
 * section names them explicitly):
 *   1. Build a minimal rent input now — a per-profile €/m²/month assumption
 *      the user states.
 *   2. Estimate from whatever comparable signal exists.
 *   3. Ship the cost side only, gate yield behind #31.
 *
 * Option 2 is unavailable: there is *no* comparable signal in this schema
 * today (no rental_listing table, no rent field anywhere) — "whatever
 * exists" is nothing, so any attempt at (2) would be indistinguishable from
 * inventing a number, exactly what's banned. This module implements a
 * hybrid of (1) and (3): a rent estimate is produced ONLY when the
 * profile's own investment thesis states an explicit €/m²/month assumption
 * (`thesis_params.rent_assumption`, see profiles-schema.ts) — never a
 * system-invented default. If the profile hasn't set one, this returns an
 * explicit "no assumption" result (mirrors #31's own
 * `method: "insufficient_data"` empty-state shape) and yield.ts gates its
 * output on that, satisfying (3) for any profile that hasn't opted in.
 *
 * `confidence` here is intentionally a *different* value space from #31's
 * planned `"high" | "low" | null` comparable-count tiers — `"assumption"`
 * is not a point on that scale, it's a different kind of number entirely
 * (user-stated, not measured), and conflating the two would let a
 * profile's assumption silently masquerade as a measurement once #31 ships
 * real comparables. When #31 lands, this module should be replaced (not
 * extended) by the comparable-median estimator issue #31 specifies, and
 * yield.ts's confidence handling updated to use its high/low tiers for any
 * profile that hasn't set an explicit rent_assumption override.
 */

import type { ThesisParams } from "@/lib/profiles-schema";

/**
 * `"high" | "low"` are #31's future comparable-count tiers (not produced by
 * this module today — see docstring above) — included in the type now, not
 * added later, so yield.ts's confidence-propagation contract (issue #33
 * EC-4) is written once against the tiering issue #31 actually specifies,
 * and doesn't need a signature change when #31 replaces this module's
 * implementation. `"assumption"` is this module's own present-day value: a
 * user-stated figure, not a measurement, and deliberately not collapsed
 * into "high"/"low" (see docstring above).
 */
export type RentConfidence = "high" | "low" | "assumption" | null;

export interface RentEstimateResult {
  estimated_monthly_rent: number | null;
  /** Always 0 today — no comparable rental data exists yet (see module docstring). Kept so this shape is a strict superset of #31's eventual touchpoint contract. */
  comparable_count: number;
  confidence: RentConfidence;
  method: "profile_assumption" | "no_rent_assumption";
  /** The €/m²/month figure actually applied, echoed back for transparency (issue #151: "show the inputs, not just the output"). Null when method is "no_rent_assumption". */
  eur_per_m2_month_used: number | null;
  /** The m² figure the assumption was multiplied by. Null when no estimate was produced. */
  m2_used: number | null;
}

/**
 * `m2_built` is used, not `m2_useful` — same reasoning as scope-query.ts's
 * size filter and the data model's general guidance: built area is
 * published far more consistently across sources, so an estimate keyed on
 * it degrades less often to "no data" than one keyed on useful area.
 */
export function estimateRent(
  property: { m2_built: number | null },
  thesisParams: Pick<ThesisParams, "rent_assumption">,
): RentEstimateResult {
  const assumption = thesisParams.rent_assumption;
  const m2 = property.m2_built;

  if (assumption === undefined || m2 === null || m2 <= 0) {
    return {
      estimated_monthly_rent: null,
      comparable_count: 0,
      confidence: null,
      method: "no_rent_assumption",
      eur_per_m2_month_used: null,
      m2_used: null,
    };
  }

  return {
    estimated_monthly_rent: assumption.eur_per_m2_month * m2,
    comparable_count: 0,
    confidence: "assumption",
    method: "profile_assumption",
    eur_per_m2_month_used: assumption.eur_per_m2_month,
    m2_used: m2,
  };
}
