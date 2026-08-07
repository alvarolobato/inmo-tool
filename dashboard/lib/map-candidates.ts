/**
 * Reads a search profile's matched candidates for the map view (task 2.7,
 * #43), grouped at the `property` level like `lib/candidates.ts` (task 2.5)
 * — one row per deduplicated property, never per listing.
 *
 * Unlike `listCandidates`, this is not keyset-paginated: a map wants all
 * plottable pins in view at once, not a "load more" flow. Capped at
 * MAX_MAP_CANDIDATES to avoid an unbounded query as listing volume grows —
 * a v1 tradeoff (issue #43's own "don't over-engineer" scope note), not a
 * fully worked-out solution for map performance at scale.
 *
 * Server-only: imports lib/db-write (the `pg` client) — never import this
 * from a client component.
 */

import { sql } from "@/lib/db-write";
import { DISABLED_SOURCES_CTE, activeSourceClause } from "@/lib/db/source-active";

export interface MapListingSummary {
  id: number;
  source: string;
  url: string | null;
  current_price: number | null;
}

export interface MapCandidateRow {
  property_id: number;
  address: string | null;
  lat: number;
  lon: number;
  property_type: string | null;
  m2_built: number | null;
  rooms: number | null;
  min_price: number | null;
  pipeline_stage: string;
  listings: MapListingSummary[];
}

export interface MapCandidates {
  items: MapCandidateRow[];
  /** Matched properties excluded from `items` because lat or lon is null (issue #43 EC-2: surfaced as a count, never silently dropped). */
  unplottableCount: number;
  /**
   * True when more than MAX_MAP_CANDIDATES plottable matches exist and some
   * were cut by the LIMIT. The LIMIT is applied only to plottable rows (see
   * the WHERE clause below) so this never conflates "no coordinates" with
   * "too many to show" — a bug in an earlier version applied LIMIT before
   * excluding null-coordinate rows, which could silently drop real
   * plottable candidates whenever unplottable rows happened to sort first.
   */
  truncated: boolean;
}

const MAX_MAP_CANDIDATES = 500;

interface RawMapRow {
  property_id: number;
  address: string | null;
  lat: string;
  lon: string;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  min_price: string | null;
  pipeline_stage: string;
  listings: MapListingSummary[];
}

interface RawCountRow {
  plottable_count: number;
  unplottable_count: number;
}

export async function listMapCandidates(
  profileId: number,
  includeRejected = false,
): Promise<MapCandidates> {
  const [rows, counts] = await Promise.all([
    sql<RawMapRow>(
      // Issue #319 / D-055: the map is the SAME candidate feed as the list, so
      // it hides disabled-source data identically — no pin, badge, or price for
      // a source whose connector is OFF. The `disabled_sources` CTE and the
      // per-subquery filters mirror listCandidates exactly (see
      // lib/db/source-active.ts and lib/candidates.ts).
      `WITH ${DISABLED_SOURCES_CTE}
       SELECT
         p.id AS property_id,
         p.address,
         p.lat,
         p.lon,
         p.property_type,
         p.m2_built,
         p.rooms,
         pls.pipeline_stage,
         -- AND operation = 'sale' on both subqueries (issue #31,
         -- defense-in-depth — see candidates.ts's identical pair for the
         -- full reasoning): every row here already comes through
         -- profile_listing_state, gated on an active SALE listing by
         -- scope-query.ts, so this shouldn't be reachable with a rent
         -- listing today either.
         (SELECT MIN(l2.current_price)
            FROM listing l2
           WHERE l2.property_id = p.id AND l2.status = 'active' AND l2.operation = 'sale'
             AND ${activeSourceClause("l2")}) AS min_price,
         COALESCE(
           (SELECT json_agg(
                     json_build_object(
                       'id', l.id,
                       'source', l.source,
                       'url', l.url,
                       'current_price', l.current_price
                     )
                     ORDER BY l.source
                   )
              FROM listing l
             WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale'
               AND ${activeSourceClause("l")}),
           '[]'
         ) AS listings
       FROM profile_listing_state pls
       JOIN property p ON p.id = pls.property_id
       -- Latest accept/reject/star verdict for this profile/property (#379/#417),
       -- derived latest-wins exactly like the feed's fb LATERAL in
       -- lib/candidates.ts. Feeds the reject exclusion below so the map hides the
       -- same pins the feed and prev/next hide. Index-fed by
       -- idx_feedback_event_profile_property.
       LEFT JOIN LATERAL (
         SELECT fe.feedback_type
           FROM feedback_event fe
          WHERE fe.profile_id = $1 AND fe.property_id = p.id
            AND fe.feedback_type IN ('accept', 'reject', 'star', 'clear')
          ORDER BY fe.created_at DESC, fe.id DESC
          LIMIT 1
       ) fb ON true
       WHERE pls.profile_id = $1
         AND pls.matched = true
         AND p.lat IS NOT NULL
         AND p.lon IS NOT NULL
         -- Reject exclusion (#417) mirroring the feed's identical clause in
         -- candidates.ts ($N = true OR feedback_state IS DISTINCT FROM 'reject'):
         -- a property whose latest verdict is 'reject' drops no pin by default,
         -- so map, feed and prev/next agree. $3 = true (the show-rejected escape
         -- hatch) keeps it. A trailing 'clear' or a NULL verdict always shows.
         AND ($3::boolean = true OR fb.feedback_type IS DISTINCT FROM 'reject')
         -- Issue #319 / D-055: drop a property whose active-sale listings are
         -- ALL from disabled sources (identical to listCandidates); a property
         -- with no active-sale listing at all keeps its prior behaviour.
         AND (
           NOT EXISTS (
             SELECT 1 FROM listing ld
              WHERE ld.property_id = p.id AND ld.status = 'active' AND ld.operation = 'sale'
           )
           OR EXISTS (
             SELECT 1 FROM listing lv
              WHERE lv.property_id = p.id AND lv.status = 'active' AND lv.operation = 'sale'
                AND ${activeSourceClause("lv")}
           )
         )
       ORDER BY p.id DESC
       LIMIT $2`,
      [profileId, MAX_MAP_CANDIDATES, includeRejected],
    ),
    sql<RawCountRow>(
      // Issue #319 / D-055: the counts must match what's plotted — a property
      // whose active-sale listings are all from disabled sources neither shows
      // a pin nor counts (owner: "ni cuentan en métricas"). Same drop condition
      // as the rows query above.
      `WITH ${DISABLED_SOURCES_CTE}
       SELECT
         COUNT(*) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS plottable_count,
         COUNT(*) FILTER (WHERE p.lat IS NULL OR p.lon IS NULL) AS unplottable_count
       FROM profile_listing_state pls
       JOIN property p ON p.id = pls.property_id
       -- Same latest-verdict LATERAL + reject exclusion as the rows query, so
       -- the counts never include a rejected property the map doesn't plot
       -- (#417). $2 = true keeps rejected (the show-rejected escape hatch).
       LEFT JOIN LATERAL (
         SELECT fe.feedback_type
           FROM feedback_event fe
          WHERE fe.profile_id = $1 AND fe.property_id = p.id
            AND fe.feedback_type IN ('accept', 'reject', 'star', 'clear')
          ORDER BY fe.created_at DESC, fe.id DESC
          LIMIT 1
       ) fb ON true
       WHERE pls.profile_id = $1
         AND pls.matched = true
         AND ($2::boolean = true OR fb.feedback_type IS DISTINCT FROM 'reject')
         AND (
           NOT EXISTS (
             SELECT 1 FROM listing ld
              WHERE ld.property_id = p.id AND ld.status = 'active' AND ld.operation = 'sale'
           )
           OR EXISTS (
             SELECT 1 FROM listing lv
              WHERE lv.property_id = p.id AND lv.status = 'active' AND lv.operation = 'sale'
                AND ${activeSourceClause("lv")}
           )
         )`,
      [profileId, includeRejected],
    ),
  ]);

  const items: MapCandidateRow[] = rows.map((r) => ({
    // property_id/plottable_count/unplottable_count (bigint) arrive as real
    // JS numbers via the driver-level int8 type parser (db-shared.ts, #155).
    // lat/lon/m2_built/min_price below are NUMERIC — those coercions stay.
    property_id: r.property_id,
    address: r.address,
    lat: Number(r.lat),
    lon: Number(r.lon),
    property_type: r.property_type,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    pipeline_stage: r.pipeline_stage,
    listings: r.listings,
  }));

  const plottableCount = counts.length > 0 ? counts[0].plottable_count : 0;
  const unplottableCount = counts.length > 0 ? counts[0].unplottable_count : 0;

  return { items, unplottableCount, truncated: plottableCount > MAX_MAP_CANDIDATES };
}
