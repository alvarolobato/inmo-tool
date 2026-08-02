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
}

const MAX_MAP_CANDIDATES = 500;

interface RawMapRow {
  property_id: number;
  address: string | null;
  lat: string | null;
  lon: string | null;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  min_price: string | null;
  pipeline_stage: string;
  listings: MapListingSummary[];
}

export async function listMapCandidates(profileId: number): Promise<MapCandidates> {
  const rows = await sql<RawMapRow>(
    `SELECT
       p.id AS property_id,
       p.address,
       p.lat,
       p.lon,
       p.property_type,
       p.m2_built,
       p.rooms,
       pls.pipeline_stage,
       (SELECT MIN(l2.current_price)
          FROM listing l2
         WHERE l2.property_id = p.id AND l2.status = 'active') AS min_price,
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
           WHERE l.property_id = p.id AND l.status = 'active'),
         '[]'
       ) AS listings
     FROM profile_listing_state pls
     JOIN property p ON p.id = pls.property_id
     WHERE pls.profile_id = $1
       AND pls.matched = true
     ORDER BY p.id DESC
     LIMIT $2`,
    [profileId, MAX_MAP_CANDIDATES],
  );

  const items: MapCandidateRow[] = [];
  let unplottableCount = 0;

  for (const r of rows) {
    if (r.lat === null || r.lon === null) {
      unplottableCount += 1;
      continue;
    }
    items.push({
      property_id: Number(r.property_id),
      address: r.address,
      lat: Number(r.lat),
      lon: Number(r.lon),
      property_type: r.property_type,
      m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
      rooms: r.rooms,
      min_price: r.min_price !== null ? Number(r.min_price) : null,
      pipeline_stage: r.pipeline_stage,
      listings: r.listings,
    });
  }

  return { items, unplottableCount };
}
