/**
 * Reads the materialized candidate set for a search profile (task 2.4,
 * `profile_listing_state.matched = true`) grouped at the `property` level.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/db/profiles.ts, never import this from a client component.
 *
 * One row out = one deduplicated property (issue #19: "one card per
 * property_id, not per listing" — a property with 2+ linked listings after
 * task 2.2's dedup engine merges cross-site duplicates must render as a
 * single candidate with multiple source badges, never as separate cards).
 */

import { sql } from "@/lib/db-write";

export interface CandidateListingSummary {
  id: number;
  source: string;
  url: string | null;
  current_price: number | null;
}

export interface CandidateRow {
  property_id: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  property_type: string | null;
  m2_built: number | null;
  rooms: number | null;
  /** MIN(listing.current_price) across the property's *active* listings — same convention as task 2.4's price-band filter (see data-model.md). Null if no active listing has a price. */
  min_price: number | null;
  /** Earliest first_seen_at across all of the property's listings. */
  first_seen_at: string | null;
  listings: CandidateListingSummary[];
}

export interface CandidatePage {
  items: CandidateRow[];
  /** Pass back as `cursor` to fetch the next page; null when this is the last page. */
  nextCursor: number | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface RawCandidateRow {
  property_id: number;
  address: string | null;
  lat: string | null;
  lon: string | null;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  min_price: string | null;
  first_seen_at: string | null;
  listings: CandidateListingSummary[];
}

/**
 * Keyset (cursor) pagination on `property.id DESC`, not OFFSET — this table
 * is expected to grow into the thousands (issue #19 Technical approach #3:
 * "don't fetch-all-and-filter-client-side"), and OFFSET pagination degrades
 * linearly with page depth while keyset pagination stays O(limit) regardless
 * of how deep the caller pages.
 */
export async function listCandidates(
  profileId: number,
  opts: { cursor?: number | null; limit?: number } = {},
): Promise<CandidatePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const cursor = opts.cursor ?? null;

  // Fetch one extra row so we can tell whether a next page truly exists
  // instead of assuming it does whenever a page is exactly full (that
  // false-positive was showing a dead "Cargar más" on the last page).
  const rows = await sql<RawCandidateRow>(
    `SELECT
       p.id AS property_id,
       p.address,
       p.lat,
       p.lon,
       p.property_type,
       p.m2_built,
       p.rooms,
       (SELECT MIN(l2.current_price)
          FROM listing l2
         WHERE l2.property_id = p.id AND l2.status = 'active') AS min_price,
       (SELECT MIN(l3.first_seen_at)
          FROM listing l3
         WHERE l3.property_id = p.id) AS first_seen_at,
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
       AND ($2::bigint IS NULL OR p.id < $2::bigint)
     ORDER BY p.id DESC
     LIMIT $3`,
    [profileId, cursor, limit + 1],
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: CandidateRow[] = pageRows.map((r) => ({
    // pg returns bigint columns as strings; property_id needs to be a real
    // JSON number (Phase 3's scoring/ranking will compare/sort on it) —
    // unlike lat/lon/m2_built this one was missed and shipped as a string
    // ("179" not 179) in the live API response.
    property_id: Number(r.property_id),
    address: r.address,
    lat: r.lat !== null ? Number(r.lat) : null,
    lon: r.lon !== null ? Number(r.lon) : null,
    property_type: r.property_type,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    first_seen_at: r.first_seen_at,
    listings: r.listings,
  }));

  const nextCursor = hasMore ? items[items.length - 1].property_id : null;

  return { items, nextCursor };
}
