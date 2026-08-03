/**
 * Rent estimation — issue #31 (comparable-rental data ingestion + rent
 * estimation), replacing the assumption-only stand-in #151/#33 shipped in
 * PR #181.
 *
 * ## Where the data comes from (the schema decision, stated explicitly)
 *
 * #31's own suggested technical approach proposed a new `rental_listing`
 * table. That's superseded: `etl/schema/init.sql` already carries
 * `listing.operation TEXT ... CHECK (operation IN ('sale', 'rent'))`,
 * added ahead of this issue with an explicit note — "Issue #31's
 * implementer should confirm this representation still fits before
 * ingesting rental data." It does, for three independent reasons found
 * while confirming it:
 *
 * 1. `etl/connectors/base.py`'s `CanonicalListingVersion.operation` is
 *    already `Literal["sale", "rent"] | None`, and the orchestrator's
 *    upsert path already COALESCEs it end to end — the whole connector
 *    framework was already built assuming rentals land in `listing`, not
 *    a parallel table.
 * 2. `property` already carries exactly what a comparable-rent query
 *    needs (`lat`, `lon`, `property_type`, `m2_built`) — a second table
 *    would either duplicate that geometry or require a join back to
 *    `property` anyway, for no benefit.
 * 3. `lib/analytics/area-price.ts` and `lib/investment-metrics.ts`
 *    (PR #181) already filter every sale-side query with
 *    `listing.operation = 'sale'` — a defensive filter that only makes
 *    sense if the authors expected `operation = 'rent'` rows to start
 *    appearing in the SAME tables, not a separate one.
 *
 * A live check (2026-08-03, this session) of a real Milanuncios rental ad
 * confirmed the site publishes rent through the identical `price.cashPrice
 * .value` JSON field sale ads use — so `listing.current_price` (already a
 * generic "the listing's price" column, not sale-specific) holds monthly
 * rent for an `operation='rent'` row with zero schema change. No new
 * `monthly_rent` column, no new table.
 *
 * **Cross-contamination guard (issue #31 EC-3, generalized from "listing
 * vs rental_listing" to "operation='sale' vs operation='rent' rows in the
 * same tables")**: the moment `operation='rent'` rows exist, every query
 * that materializes/matches/dedupes *sale* candidates without an explicit
 * `operation = 'sale'` filter would silently start treating rental
 * properties as sale candidates. Two such gaps were found and fixed
 * alongside this module (both invisible until now, since no connector had
 * ever produced `operation='rent'` rows before): `lib/filtering/
 * scope-query.ts`'s `buildScopeWhereClause` (the query that decides which
 * properties materialize into `profile_listing_state` for every search
 * profile) and `etl/dedup/engine.py`'s `fetch_listing_records` (the
 * pairwise-match candidate pool) — see those files' own comments.
 *
 * ## Comparable selection (issue #31's Technical approach + this issue's
 * own brief: "band by size, since EUR/m2/month is strongly size-dependent")
 *
 * Same shape as `area-price.ts`'s sale-comparable query (median, a padded
 * lat/lon bounding-box prefilter ahead of the exact Haversine expression,
 * same `idx_property_lat_lon` index) with two deliberate differences:
 *
 * - **Size-banded, not just type-matched.** Sale comps aren't banded by
 *   size because condition and exact location dominate price/m² there
 *   more than size does. Rent is the opposite: a 40m² studio rents for
 *   far more per m² than a 150m² flat in the same building, so an
 *   unbanded EUR/m²/month median would systematically mis-scale for any
 *   property far from the local size mix. `SIZE_BAND_RATIO = 0.35`: comps
 *   within +/-35% of the target's own `m2_built` — documented, tunable,
 *   not fixed forever, same convention as `area-price.ts`'s constants.
 * - **Looser radius** (`DEFAULT_RADIUS_KM = 1.5` vs. sale's `1`): rental
 *   inventory is far sparser than sale inventory today (one new connector
 *   vs. several existing sale connectors), so a tighter radius would push
 *   most properties straight to `insufficient_data` regardless of how
 *   well-located the actual comps are. Revisit once rental ingestion has
 *   run for a while and real sample sizes are known.
 *
 * ## Confidence (issue #31's Technical approach + this issue's brief:
 * "confidence must mean something... tied to sample size and dispersion")
 *
 * Issue #31 itself specifies the sample-size bands verbatim: below 3
 * comparables -> no estimate (`insufficient_data`); 3-7 ->
 * `market_comparable_low`; 8+ -> `market_comparable_high`. On top of that,
 * this module adds a dispersion gate the issue's Technical approach didn't
 * ask for but the brief explicitly did: a sample can be large and still
 * too scattered to trust. `MAX_HIGH_CONFIDENCE_RELATIVE_IQR = 0.6` — the
 * interquartile range of comps' EUR/m²/month, divided by their median —
 * downgrades an otherwise-`high` (8+) sample to `low` when the comps
 * disagree with each other by more than that. This can only ever demote
 * `high` to `low`, never promote a small sample to `high` and never turn
 * a real sample into `insufficient_data` — the count gate alone still
 * decides usable vs. not.
 *
 * ## Precedence vs. the profile's own assumption (this issue's brief:
 * "do not silently replace the user's number... decide the precedence
 * rule and make it visible")
 *
 * The profile's `thesis_params.rent_assumption`, when set, remains the
 * figure `yield.ts` actually uses (`method: "profile_assumption"`,
 * unchanged from PR #181) — a human explicitly typed it in, possibly
 * encoding information no algorithm here can see (a specific building's
 * condition, a negotiated rate, local knowledge). It is NEVER silently
 * replaced by a measured estimate. But the market-comparable estimate is
 * ALWAYS computed and attached (`market_comparable`, whenever the property
 * has lat/lon/property_type to query with) regardless of whether an
 * assumption is set, and `disagreement_pct` is populated whenever both
 * numbers exist — so the UI can show both and flag a disagreement rather
 * than hide it (see `YieldSection.tsx`). When no assumption is set at
 * all, the market-comparable estimate becomes the PRIMARY figure fed to
 * `yield.ts` — this is the actual point of issue #31: unblocking yield for
 * any profile that never set a manual assumption, per the swap-in-without-
 * a-signature-change design `RentConfidence`'s `"high"`/`"low"` values
 * were reserved for from the start.
 *
 * Server-only: imports lib/db-write (the `pg` client), same reasoning as
 * area-price.ts — never import this from a client component.
 */

import { sql } from "@/lib/db-write";
import type { ThesisParams } from "@/lib/profiles-schema";

export const DEFAULT_RADIUS_KM = 1.5;
export const SIZE_BAND_RATIO = 0.35;
export const MIN_LOW_CONFIDENCE_SAMPLE_SIZE = 3;
export const MIN_HIGH_CONFIDENCE_SAMPLE_SIZE = 8;
export const MAX_HIGH_CONFIDENCE_RELATIVE_IQR = 0.6;

/**
 * `"high" | "low"` are the real comparable-count/dispersion tiers this
 * module now produces (see module docstring) — no longer reserved-but-
 * unreachable placeholders. `"assumption"` remains a distinct value space
 * (user-stated, not measured) per the original design in PR #181: a
 * profile's assumption must never masquerade as a measurement just
 * because it shares a confidence slot with one.
 */
export type RentConfidence = "high" | "low" | "assumption" | null;

export interface MarketComparableRent {
  /** Median EUR/m²/month among comparable active rental listings, or null if fewer than MIN_LOW_CONFIDENCE_SAMPLE_SIZE. */
  eur_per_m2_month: number | null;
  /** eur_per_m2_month * the target property's own m2_built, or null if eur_per_m2_month is null. */
  estimated_monthly_rent: number | null;
  /** Count of comparable rental listings actually used — always populated, even in the insufficient-data case (mirrors area-price.ts's sample_size convention). */
  comparable_count: number;
  /** null exactly when comparable_count < MIN_LOW_CONFIDENCE_SAMPLE_SIZE. */
  confidence: "high" | "low" | null;
}

export interface RentEstimateResult {
  /** The PRIMARY figure — what yield.ts actually uses. Assumption wins when set (see module docstring's precedence rule); otherwise the market comparable, when usable. */
  estimated_monthly_rent: number | null;
  confidence: RentConfidence;
  /** Count backing the PRIMARY figure specifically (0 for "profile_assumption" and every gate — mirrors market_comparable.comparable_count exactly when the market estimate is primary). */
  comparable_count: number;
  method:
    | "profile_assumption"
    | "market_comparable_high"
    | "market_comparable_low"
    | "insufficient_data"
    | "no_property_size"
    | "no_property_location";
  /** The EUR/m²/month figure actually used for the PRIMARY estimate. Null when no estimate was produced. */
  eur_per_m2_month_used: number | null;
  /** The m² figure the PRIMARY estimate was scaled by. Null when no estimate was produced. */
  m2_used: number | null;
  /**
   * Always attached when the property has lat/lon/property_type to query
   * with (regardless of which source is PRIMARY) — null only when there's
   * nothing to query against at all (`no_property_location`) or the
   * property lacks m2_built (`no_property_size`, needed both to band
   * comps and to scale the result). This is what lets the UI show the
   * market signal even when a profile assumption is primary (issue
   * brief's "show both").
   */
  market_comparable: MarketComparableRent | null;
  /** The profile's own assumption-derived monthly rent, echoed whenever `thesis_params.rent_assumption` is set — regardless of whether it's PRIMARY. Null when the profile never set one. */
  assumption_monthly_rent: number | null;
  /** (assumption_monthly_rent - market_comparable.estimated_monthly_rent) / market_comparable.estimated_monthly_rent — populated only when BOTH figures exist, null otherwise. Never used to pick a winner; purely informational (see module docstring's precedence rule). */
  disagreement_pct: number | null;
}

interface RawComparableRentRow {
  sample_size: string;
  median_eur_per_m2_month: string | null;
  p25_eur_per_m2_month: string | null;
  p75_eur_per_m2_month: string | null;
}

/**
 * Runs the size-banded, radius-bounded comparable-rent query for one
 * property. Pure DB read, no side effects — split out from `estimateRent`
 * so the SQL and its tiering logic are independently testable/reviewable,
 * same separation `area-price.ts` uses internally (one function, one job).
 */
async function queryMarketComparableRent(
  property: { id: number; lat: number; lon: number; property_type: string; m2_built: number },
  opts: { radiusKm?: number; sizeBandRatio?: number } = {},
): Promise<MarketComparableRent> {
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  const sizeBandRatio = opts.sizeBandRatio ?? SIZE_BAND_RATIO;

  const rows = await sql<RawComparableRentRow>(
    `WITH comps AS (
       SELECT p.id, p.m2_built,
         (SELECT MIN(l.current_price) FROM listing l
           WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'rent') AS monthly_rent
       FROM property p
       WHERE p.id <> $1
         AND p.property_type = $4
         AND p.lat IS NOT NULL AND p.lon IS NOT NULL
         AND p.m2_built IS NOT NULL AND p.m2_built > 0
         -- Size band: comps within +/-sizeBandRatio of the target's own
         -- m2_built (see module docstring — rent is strongly size-
         -- dependent in a way sale price/m2 isn't, so an unbanded median
         -- would mis-scale for anything far from the local size mix).
         AND p.m2_built BETWEEN $5 AND $6
         -- Padded bounding-box prefilter ahead of the exact Haversine
         -- computation, identical technique and identical index
         -- (idx_property_lat_lon) as area-price.ts — see that file's own
         -- comment for the full derivation of the 111.0/111.320*cos(lat)
         -- constants and the 1.15 safety pad.
         AND p.lat BETWEEN $2 - (($7 / 111.0) * 1.15) AND $2 + (($7 / 111.0) * 1.15)
         AND p.lon BETWEEN $3 - (($7 / (111.320 * cos(radians($2)))) * 1.15)
                        AND $3 + (($7 / (111.320 * cos(radians($2)))) * 1.15)
         AND (6371 * acos(least(1, greatest(-1,
               cos(radians($2)) * cos(radians(p.lat)) *
               cos(radians(p.lon) - radians($3)) +
               sin(radians($2)) * sin(radians(p.lat))
             )))) <= $7
         AND EXISTS (
           SELECT 1 FROM listing l2
           WHERE l2.property_id = p.id AND l2.status = 'active' AND l2.operation = 'rent'
         )
     ),
     valid_comps AS (
       SELECT (monthly_rent / m2_built) AS eur_per_m2_month
       FROM comps
       WHERE monthly_rent IS NOT NULL
     )
     SELECT
       (SELECT COUNT(*) FROM valid_comps)::text AS sample_size,
       (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY eur_per_m2_month) FROM valid_comps)::text AS median_eur_per_m2_month,
       (SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY eur_per_m2_month) FROM valid_comps)::text AS p25_eur_per_m2_month,
       (SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY eur_per_m2_month) FROM valid_comps)::text AS p75_eur_per_m2_month`,
    [
      property.id,
      property.lat,
      property.lon,
      property.property_type,
      property.m2_built * (1 - sizeBandRatio),
      property.m2_built * (1 + sizeBandRatio),
      radiusKm,
    ],
  );

  const row = rows[0];
  const sampleSize = Number(row.sample_size);

  if (sampleSize < MIN_LOW_CONFIDENCE_SAMPLE_SIZE) {
    return { eur_per_m2_month: null, estimated_monthly_rent: null, comparable_count: sampleSize, confidence: null };
  }

  const median = Number(row.median_eur_per_m2_month);
  const p25 = Number(row.p25_eur_per_m2_month);
  const p75 = Number(row.p75_eur_per_m2_month);
  // median > 0 is guaranteed here: every valid_comps row divides a
  // positive current_price by a positive m2_built (both gated above), so
  // eur_per_m2_month > 0 for every row and therefore so is its median.
  const relativeIqr = (p75 - p25) / median;

  const meetsHighCount = sampleSize >= MIN_HIGH_CONFIDENCE_SAMPLE_SIZE;
  // Dispersion can only ever demote high -> low, never promote a small
  // sample or turn a real sample into insufficient (see module docstring).
  const confidence: "high" | "low" = meetsHighCount && relativeIqr <= MAX_HIGH_CONFIDENCE_RELATIVE_IQR ? "high" : "low";

  return {
    eur_per_m2_month: median,
    estimated_monthly_rent: median * property.m2_built,
    comparable_count: sampleSize,
    confidence,
  };
}

/**
 * `m2_built` is used, not `m2_useful` — same reasoning as scope-query.ts's
 * size filter and the original PR #181 rent-estimate.ts: built area is
 * published far more consistently across sources, so an estimate keyed on
 * it degrades less often to "no data" than one keyed on useful area. Kept
 * as the single size field for BOTH the assumption path and the market
 * path, deliberately — using m2_useful for one and m2_built for the other
 * would make the two numbers this module produces silently incomparable.
 */
export async function estimateRent(
  property: { id: number; lat: number | null; lon: number | null; property_type: string | null; m2_built: number | null },
  thesisParams: Pick<ThesisParams, "rent_assumption">,
): Promise<RentEstimateResult> {
  const assumption = thesisParams.rent_assumption;
  const m2 = property.m2_built;

  // m2_built is required by BOTH paths (the assumption multiplies by it;
  // the market estimate both bands comps by it and scales the median
  // EUR/m²/month back up by it) — checked once, up front, rather than
  // duplicated inside each path. This subsumes PR #181's original
  // "no_property_size" gate (which only guarded the assumption path) and
  // extends it to the market path for the same reason.
  if (m2 === null || m2 <= 0) {
    return {
      estimated_monthly_rent: null,
      confidence: null,
      comparable_count: 0,
      method: "no_property_size",
      eur_per_m2_month_used: null,
      m2_used: null,
      market_comparable: null,
      assumption_monthly_rent: null,
      disagreement_pct: null,
    };
  }

  const assumptionMonthlyRent = assumption !== undefined ? assumption.eur_per_m2_month * m2 : null;

  const canQueryMarket = property.lat !== null && property.lon !== null && property.property_type !== null;
  const marketComparable = canQueryMarket
    ? await queryMarketComparableRent({
        id: property.id,
        lat: property.lat as number,
        lon: property.lon as number,
        property_type: property.property_type as string,
        m2_built: m2,
      })
    : null;

  const disagreementPct =
    assumptionMonthlyRent !== null && marketComparable?.estimated_monthly_rent
      ? (assumptionMonthlyRent - marketComparable.estimated_monthly_rent) / marketComparable.estimated_monthly_rent
      : null;

  // Precedence: the profile's own assumption, when set, is ALWAYS primary
  // — never silently replaced by a measured estimate (module docstring).
  if (assumptionMonthlyRent !== null) {
    return {
      estimated_monthly_rent: assumptionMonthlyRent,
      confidence: "assumption",
      comparable_count: 0,
      method: "profile_assumption",
      eur_per_m2_month_used: (assumption as NonNullable<typeof assumption>).eur_per_m2_month,
      m2_used: m2,
      market_comparable: marketComparable,
      assumption_monthly_rent: assumptionMonthlyRent,
      disagreement_pct: disagreementPct,
    };
  }

  // No assumption set — nothing to query against geographically means
  // nothing to fall back on either. Distinct from "insufficient_data"
  // (module docstring / Opus-review-style precedent set by PR #181's
  // no_property_size vs no_rent_assumption split): the UI must say "we
  // don't know where this is" rather than "not enough nearby rentals".
  if (marketComparable === null) {
    return {
      estimated_monthly_rent: null,
      confidence: null,
      comparable_count: 0,
      method: "no_property_location",
      eur_per_m2_month_used: null,
      m2_used: null,
      market_comparable: null,
      assumption_monthly_rent: null,
      disagreement_pct: null,
    };
  }

  if (marketComparable.confidence === null) {
    return {
      estimated_monthly_rent: null,
      confidence: null,
      comparable_count: marketComparable.comparable_count,
      method: "insufficient_data",
      eur_per_m2_month_used: null,
      m2_used: null,
      market_comparable: marketComparable,
      assumption_monthly_rent: null,
      disagreement_pct: null,
    };
  }

  return {
    estimated_monthly_rent: marketComparable.estimated_monthly_rent,
    confidence: marketComparable.confidence,
    comparable_count: marketComparable.comparable_count,
    method: marketComparable.confidence === "high" ? "market_comparable_high" : "market_comparable_low",
    eur_per_m2_month_used: marketComparable.eur_per_m2_month,
    m2_used: m2,
    market_comparable: marketComparable,
    assumption_monthly_rent: null,
    disagreement_pct: null,
  };
}
