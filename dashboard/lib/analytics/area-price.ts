/**
 * Price-per-m² vs. neighbourhood average — issue #32.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/candidates.ts, never import this from a client component.
 *
 * ## "Neighbourhood" definition (issue #32's Context asks this be decided
 * explicitly with the data that exists)
 *
 * `property` has no zone/district/neighbourhood field — only `lat`/`lon`
 * and a free-text `city`/`province`/`address`. Rather than inventing a
 * neighbourhood-boundary concept this schema can't back, this reuses
 * exactly the radius-from-a-point approach task 2.4's geography filter
 * already ships (`lib/filtering/scope-query.ts`'s Haversine expression) —
 * a real, already-validated technique in this codebase, not a new one.
 * `DEFAULT_RADIUS_KM = 1`: a walkable-neighbourhood scale for a dense
 * Spanish city centre; callers needing a different notion of "area" (a
 * whole municipality, a much larger radius for a rural property) can pass
 * `opts.radiusKm`. This is an explicit simplification (documented per
 * issue #32's own acceptance of it): accuracy is bounded by how much of
 * the market within that radius has actually been ingested, not by a
 * request for external market-index data.
 *
 * ## Minimum sample size (issue #32 EC-2)
 *
 * `MIN_SAMPLE_SIZE = 5` — issue #32's own suggested threshold ("e.g. ≥5").
 * Below it, `area_median_price_per_m2`/`pct_vs_average` come back null (an
 * explicit "insufficient data" result, `sample_size` still reported) rather
 * than a noisy comparison from a handful of listings — "a '23% below
 * market' badge computed from three listings is worse than no badge" (PR
 * brief). This mirrors #31's own confidence-tiering philosophy (never a
 * silent flat cutoff presented with the same visual weight regardless of
 * how much data backs it) — the tier here is simpler (one hard gate, not a
 * high/low split), which issue #32 itself asks for explicitly (unlike #31,
 * which asks for a tiered confidence, #32 only asks for a single min-sample
 * gate).
 *
 * ## Dedup correctness (issue #32 EC-3)
 *
 * `property` rows ARE the deduplicated unit (task 2.2's dedup engine
 * unions listings from different sites onto one `property.id` — see
 * etl/schema/init.sql's comment on `profile_listing_state`'s keying). This
 * query groups by `property.id` throughout (one price-per-m² per property,
 * via `MIN(current_price)` across that property's own active listings,
 * exactly `scope-query.ts`'s price-band convention) — a property
 * duplicated across two sites contributes exactly one comparable, never
 * two, with no separate de-dup step needed here beyond querying `property`
 * (not `listing`) as the grouping level.
 */

import { sql } from "@/lib/db-write";

export const DEFAULT_RADIUS_KM = 1;
export const MIN_SAMPLE_SIZE = 5;

export interface AreaPriceComparison {
  /** Median price/m² among comparable, deduplicated properties within the radius — null if sample_size < MIN_SAMPLE_SIZE. */
  area_median_price_per_m2: number | null;
  /** This property's own MIN(active listing price) / m2_built — null if it has no active priced listing or no m2_built. */
  property_price_per_m2: number | null;
  /** Fraction, not a pre-multiplied percentage (e.g. -0.23 = "23% below average"; matches acquisition-costs.ts's total_pct_of_price convention). Null whenever either input to the ratio is null. */
  pct_vs_average: number | null;
  /** Count of comparable properties actually used (or that WOULD be used, if fewer than MIN_SAMPLE_SIZE) — always populated, even in the insufficient-data case, so the UI can say "solo 3 comparables en la zona". */
  sample_size: number;
}

interface RawComparisonRow {
  target_min_price: string | null;
  target_m2_built: string | null;
  sample_size: string;
  median_price_per_m2: string | null;
}

/**
 * Returns null only when the property itself doesn't exist or lacks
 * lat/lon/property_type (nothing to compare against geographically).
 * Otherwise always returns a result — possibly with every average-related
 * field null (insufficient sample, or this property's own price/m2
 * unavailable), per the "insufficient data" pattern above.
 */
export async function computeAreaPriceComparison(
  propertyId: number,
  opts: { radiusKm?: number; minSampleSize?: number } = {},
): Promise<AreaPriceComparison | null> {
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  const minSampleSize = opts.minSampleSize ?? MIN_SAMPLE_SIZE;

  const rows = await sql<RawComparisonRow>(
    `WITH target AS (
       SELECT id, lat, lon, property_type, m2_built,
         -- Padded bounding box around the target point, used as a cheap
         -- pre-filter before the exact (and expensive) Haversine
         -- computation below. 1 degree of latitude is ~111.0 km
         -- everywhere; 1 degree of longitude is ~111.320*cos(lat) km, so
         -- dividing the radius by each gives the half-width of a box that
         -- exactly bounds the circle at this latitude. *1.15 pads it
         -- further so floating-point/great-circle-vs-equirectangular
         -- rounding can never exclude a point the exact Haversine filter
         -- would have kept — the box is only ever a superset of the
         -- circle, so results are bit-for-bit identical to the unfiltered
         -- query, just computed over far fewer candidate rows (Opus
         -- review measurement: 355ms/1.65M buffer reads -> 7.5ms/27k reads
         -- on a 203k-property table once idx_property_lat_lon can be used
         -- to satisfy this range condition instead of a full scan).
         ($2 / 111.0) * 1.15 AS lat_delta_deg,
         ($2 / (111.320 * cos(radians(lat)))) * 1.15 AS lon_delta_deg,
         (SELECT MIN(l.current_price) FROM listing l
           WHERE l.property_id = property.id AND l.status = 'active' AND l.operation = 'sale') AS min_price
       FROM property
       WHERE id = $1 AND lat IS NOT NULL AND lon IS NOT NULL AND property_type IS NOT NULL
     ),
     comps AS (
       SELECT p.id, p.m2_built,
         (SELECT MIN(l.current_price) FROM listing l
           WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale') AS min_price
       FROM property p, target t
       WHERE p.id <> t.id
         AND p.property_type = t.property_type
         AND p.lat IS NOT NULL AND p.lon IS NOT NULL
         -- Bounding-box pre-filter: sargable against idx_property_lat_lon
         -- (btree on (lat, lon)), unlike the Haversine expression below,
         -- which can't use an index at all. This is what turns a full
         -- table scan into an index-bounded scan over a small candidate
         -- set — see the comment on lat_delta_deg/lon_delta_deg above.
         AND p.lat BETWEEN t.lat - t.lat_delta_deg AND t.lat + t.lat_delta_deg
         AND p.lon BETWEEN t.lon - t.lon_delta_deg AND t.lon + t.lon_delta_deg
         AND (6371 * acos(least(1, greatest(-1,
               cos(radians(t.lat)) * cos(radians(p.lat)) *
               cos(radians(p.lon) - radians(t.lon)) +
               sin(radians(t.lat)) * sin(radians(p.lat))
             )))) <= $2
         AND EXISTS (
           SELECT 1 FROM listing l2
           WHERE l2.property_id = p.id AND l2.status = 'active' AND l2.operation = 'sale'
         )
     ),
     valid_comps AS (
       SELECT id, (min_price / m2_built) AS price_per_m2
       FROM comps
       WHERE min_price IS NOT NULL AND m2_built IS NOT NULL AND m2_built > 0
     )
     SELECT
       target.min_price::text AS target_min_price,
       target.m2_built::text AS target_m2_built,
       (SELECT COUNT(*) FROM valid_comps)::text AS sample_size,
       (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_per_m2) FROM valid_comps)::text AS median_price_per_m2
     FROM target`,
    [propertyId, radiusKm],
  );

  if (rows.length === 0) return null; // property missing lat/lon/property_type, or doesn't exist

  const row = rows[0];
  const sampleSize = Number(row.sample_size);
  const hasEnoughSample = sampleSize >= minSampleSize;

  const targetMinPrice = row.target_min_price !== null ? Number(row.target_min_price) : null;
  const targetM2Built = row.target_m2_built !== null ? Number(row.target_m2_built) : null;
  const propertyPricePerM2 =
    targetMinPrice !== null && targetM2Built !== null && targetM2Built > 0
      ? targetMinPrice / targetM2Built
      : null;

  const areaMedianPricePerM2 = hasEnoughSample && row.median_price_per_m2 !== null ? Number(row.median_price_per_m2) : null;

  const pctVsAverage =
    areaMedianPricePerM2 !== null && propertyPricePerM2 !== null
      ? (propertyPricePerM2 - areaMedianPricePerM2) / areaMedianPricePerM2
      : null;

  return {
    area_median_price_per_m2: areaMedianPricePerM2,
    property_price_per_m2: propertyPricePerM2,
    pct_vs_average: pctVsAverage,
    sample_size: sampleSize,
  };
}
