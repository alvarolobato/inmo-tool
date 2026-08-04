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
 * interquartile range of comps' EUR/m²/month, divided by their median.
 *
 * **Opus review (PR #199) correction**: the gate originally only fired for
 * 8+ samples (demoting `high` -> `low`), while a 3-7 sample's dispersion
 * was computed and silently discarded — so `[5, 10, 30]` (relative IQR
 * 1.25, wildly scattered) still produced a full `low`-confidence yield
 * block off 3 comparables. Post-#205's fetch_detail() wall (see the
 * connector's own module docstring) makes 3-7 comps the NORMAL case, not
 * an edge case, so this gap mattered in practice, not just in theory. The
 * gate now applies at every tier: an 8+ sample failing it still demotes to
 * `low` (unchanged); a 3-7 sample failing it demotes to `insufficient_data`
 * instead — there is no tier below `low` to demote a small, wildly-
 * scattered sample INTO, so declaring it unusable is the only honest move.
 * This can still never PROMOTE anything (a small sample never becomes
 * `high`, tight dispersion never turns `insufficient_data` into usable) —
 * only ever demotes, in both directions the count gate alone used to leave
 * alone.
 *
 * ## Recency (issue #31 Opus review must-fix #3, PR #199)
 *
 * `discovers_full_inventory = False` on the rental connector (module
 * docstring's own "not claiming full inventory" flag) means
 * `_reconcile_missed_discoveries` never runs for it — nothing in this
 * codebase ever marks a rental `listing.status` as `'withdrawn'`, and
 * `normalize()` (inherited from `MilanunciosConnector`) hardcodes
 * `status="active"` on every row it produces. Left unfiltered, a rental ad
 * ingested once in the app's first week stays `status='active'` and
 * therefore comp-eligible forever, even after the actual apartment was
 * rented out months ago — rental turnover is measured in weeks, not the
 * years a `status='active'` filter alone would tolerate.
 *
 * `MAX_COMP_AGE_DAYS = 30`: a comp is only used if `listing.last_seen_at`
 * is within this many days of query time. **What this bound actually
 * guarantees, precisely** (worth being exact about, since it's easy to
 * over-claim): `_update_last_seen_for_discovered` (etl/orchestrator.py)
 * bumps `last_seen_at = NOW()` for every id `discover()` returns on EVERY
 * run, regardless of whether `fetch_detail()` ever runs or succeeds that
 * run — so the bound tracks **presence** ("this ad still appeared on page
 * 1 of the rental category search within N days"), not **price
 * freshness** ("this ad's price was re-verified within N days"). Given
 * `fetch_detail()`'s GeeTest wall (~5 successes per run, city-wide,
 * D-017), most rental listings' `current_price` was set once, at
 * first-successful-fetch, and may be considerably older than
 * `last_seen_at` implies — a price change on a still-listed ad would not
 * be caught until `fetch_detail()` happens to succeed for it again. The
 * bound rules out "this ad was removed from the site weeks ago and nobody
 * ever told us"; it does not rule out "this ad's price is stale but the ad
 * itself is still up." `oldest_comp_age_days` on `MarketComparableRent`
 * surfaces the worst-case presence age among the comps actually used, so
 * the UI states this rather than implying a false precision.
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
 * `yield.ts`, per the swap-in-without-a-signature-change design
 * `RentConfidence`'s `"high"`/`"low"` values were reserved for from the
 * start.
 *
 * **Honesty about what this actually unblocks (Opus review, PR #199)**:
 * this module is real, measured-comparable machinery, not a stand-in —
 * but its data source is thin. `MilanunciosRentalConnector` inherits
 * `fetch_detail()` from the sale connector verbatim, and post-#205 that
 * method hits a GeeTest wall after ~5 successes per run, city-wide (see
 * the connector's own module docstring, D-017). That means a realistic
 * run rarely clears `MIN_HIGH_CONFIDENCE_SAMPLE_SIZE` (8) for any single
 * property's size/location band — `"high"` confidence is reachable in
 * principle but not in the data volume this connector can currently
 * produce, and `"low"` (or, after the dispersion-gate widening above,
 * `insufficient_data`) is the realistic outcome for most properties for
 * the foreseeable future. This module correctly computes whatever
 * comparables exist; it does not, by itself, mean "measured rental yield
 * is now generally available" — see `milanuncios_rental.py`'s module
 * docstring and D-015 for the connector-side honesty note, and issue #211
 * (tracking a viable rental data source, referenced from both).
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
 * Max age (days) of `listing.last_seen_at` for a rental comp to be used —
 * see module docstring's "Recency" section for exactly what this bound
 * does and doesn't guarantee. 30 days: rental turnover is measured in
 * weeks, and this is a documented, tunable module constant (same
 * convention as every other threshold here), not derived from a
 * measurement — revisit once real rental-market turnover data exists.
 */
export const MAX_COMP_AGE_DAYS = 30;

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
  /** null when comparable_count < MIN_LOW_CONFIDENCE_SAMPLE_SIZE, OR (Opus review widening) when a 3-7 sample's dispersion exceeds MAX_HIGH_CONFIDENCE_RELATIVE_IQR — see module docstring's "Confidence" section. */
  confidence: "high" | "low" | null;
  /**
   * Age in days (floor) of the LEAST-recently-confirmed-present comp among
   * those actually used — i.e. the worst-case bound on this estimate's
   * freshness. Null exactly when comparable_count is 0. See module
   * docstring's "Recency" section for precisely what this age does and
   * doesn't guarantee (last_seen_at tracks presence, not price freshness).
   */
  oldest_comp_age_days: number | null;
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
  /** Worst-case (largest) age in days among the comps used, as a float — see module docstring's "Recency" section. Null when sample_size is 0. */
  max_age_days: string | null;
}

const INSUFFICIENT: MarketComparableRent = {
  eur_per_m2_month: null,
  estimated_monthly_rent: null,
  comparable_count: 0,
  confidence: null,
  oldest_comp_age_days: null,
};

/**
 * Runs the size-banded, radius-bounded, recency-bounded comparable-rent
 * query for one property. Pure DB read, no side effects — split out from
 * `estimateRent` so the SQL and its tiering logic are independently
 * testable/reviewable, same separation `area-price.ts` uses internally
 * (one function, one job).
 */
async function queryMarketComparableRent(
  property: { id: number; lat: number; lon: number; property_type: string; m2_built: number },
  opts: { radiusKm?: number; sizeBandRatio?: number; maxAgeDays?: number } = {},
): Promise<MarketComparableRent> {
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  const sizeBandRatio = opts.sizeBandRatio ?? SIZE_BAND_RATIO;
  const maxAgeDays = opts.maxAgeDays ?? MAX_COMP_AGE_DAYS;

  const rows = await sql<RawComparableRentRow>(
    `WITH comps AS (
       -- LATERAL, one qualifying listing per property (Opus review
       -- must-fix #4 + #3, PR #199): the original MIN(current_price)
       -- subquery could pick a price with no way to also know THAT row's
       -- last_seen_at, and had no price>0 or recency filter at all — a
       -- "precio a consultar" ad (current_price=0, common — see
       -- milanuncios.py's _to_decimal) silently dragged the median down
       -- toward zero, and a listing.status='active' row from months ago
       -- (the rental connector never withdraws — see module docstring)
       -- counted as a live comp forever. A LATERAL join picks ONE row —
       -- the cheapest qualifying listing per property — so current_price
       -- and last_seen_at always come from the same physical row.
       SELECT (cand.current_price / p.m2_built) AS eur_per_m2_month, cand.last_seen_at
       FROM property p
       JOIN LATERAL (
         SELECT l.current_price, l.last_seen_at
         FROM listing l
         WHERE l.property_id = p.id
           AND l.status = 'active'
           AND l.operation = 'rent'
           -- current_price > 0 (must-fix #4): excludes "precio a
           -- consultar" rows (current_price=0) from the aggregate
           -- entirely, rather than letting a real Decimal("0") divide
           -- into the median as if it were a genuine low rent.
           AND l.current_price > 0
           -- Recency bound (must-fix #3) — see module docstring's
           -- "Recency" section for exactly what this does and doesn't
           -- guarantee (last_seen_at tracks presence, not price
           -- freshness). NULL last_seen_at (never discovered since
           -- ingestion, shouldn't happen in practice but not assumed)
           -- fails this comparison and is correctly excluded.
           AND l.last_seen_at >= NOW() - ($8 * INTERVAL '1 day')
         ORDER BY l.current_price ASC
         LIMIT 1
       ) cand ON true
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
     )
     SELECT
       COUNT(*)::text AS sample_size,
       (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY eur_per_m2_month))::text AS median_eur_per_m2_month,
       (PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY eur_per_m2_month))::text AS p25_eur_per_m2_month,
       (PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY eur_per_m2_month))::text AS p75_eur_per_m2_month,
       (MAX(EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0))::text AS max_age_days
     FROM comps`,
    [
      property.id,
      property.lat,
      property.lon,
      property.property_type,
      property.m2_built * (1 - sizeBandRatio),
      property.m2_built * (1 + sizeBandRatio),
      radiusKm,
      maxAgeDays,
    ],
  );

  const row = rows[0];
  const sampleSize = Number(row.sample_size);
  const oldestCompAgeDays = row.max_age_days !== null ? Math.floor(Number(row.max_age_days)) : null;

  if (sampleSize < MIN_LOW_CONFIDENCE_SAMPLE_SIZE) {
    return { ...INSUFFICIENT, comparable_count: sampleSize, oldest_comp_age_days: oldestCompAgeDays };
  }

  const median = Number(row.median_eur_per_m2_month);
  const p25 = Number(row.p25_eur_per_m2_month);
  const p75 = Number(row.p75_eur_per_m2_month);

  // Defensive median > 0 guard (Opus review must-fix #4, belt-and-braces
  // on top of the query's own current_price > 0 filter): every comp now
  // divides a positive current_price by a positive m2_built, so median
  // should always be > 0 in practice — but yield.ts's gate downstream only
  // checks `=== null`, so a 0 (or NaN from an unexpected empty-string
  // parse) sliding through here would render a fabricated "0,0 %" yield
  // labelled "estimado" instead of the honest insufficient-data state.
  if (!(median > 0)) {
    return { ...INSUFFICIENT, comparable_count: sampleSize, oldest_comp_age_days: oldestCompAgeDays };
  }

  const relativeIqr = (p75 - p25) / median;
  const meetsHighCount = sampleSize >= MIN_HIGH_CONFIDENCE_SAMPLE_SIZE;
  const dispersionOk = relativeIqr <= MAX_HIGH_CONFIDENCE_RELATIVE_IQR;

  // Dispersion gate applies at every tier (Opus review widening — see
  // module docstring's "Confidence" section for the [5,10,30] example this
  // fixes). An 8+ sample failing dispersion demotes high -> low (original
  // behaviour). A 3-7 sample failing dispersion has no lower tier to
  // demote INTO, so it demotes past "low" entirely, to insufficient_data.
  if (!dispersionOk && !meetsHighCount) {
    return { ...INSUFFICIENT, comparable_count: sampleSize, oldest_comp_age_days: oldestCompAgeDays };
  }

  const confidence: "high" | "low" = meetsHighCount && dispersionOk ? "high" : "low";

  return {
    eur_per_m2_month: median,
    estimated_monthly_rent: median * property.m2_built,
    comparable_count: sampleSize,
    confidence,
    oldest_comp_age_days: oldestCompAgeDays,
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
