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
  /** Task 3.2 (#21): null until this profile has a trained model, or the property hasn't been rescored since one was trained. */
  score: number | null;
  /** Task 3.3 (#22): human-readable, model-grounded explanation of `score` — a cold-start message when `score` is null because no model exists yet, not because this specific property hasn't been rescored. */
  rank_explanation: string | null;
}

export interface CandidatePage {
  items: CandidateRow[];
  /**
   * Opaque cursor string — pass back as `cursor` to fetch the next page; null
   * when this is the last page. Encodes both `score` and `property_id` (a
   * compound keyset key), not just an id, because results are ordered
   * globally by score (see `listCandidates`) — a single-id cursor can't
   * resume a score-ordered scan correctly. Callers must not parse this
   * themselves; treat it as opaque.
   */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * `score` is a sigmoid output, always in (0, 1) when set (task 3.2) — -1 is
 * a safe sentinel for "no score yet" that still sorts correctly last under
 * `ORDER BY effective_score DESC`, letting the keyset comparison stay a
 * plain numeric compound compare instead of needing NULL-aware branching.
 */
const NO_SCORE_SENTINEL = -1;

interface CandidateCursor {
  score: number;
  id: number;
}

function encodeCursor(score: number | null, id: number): string {
  const effectiveScore = score ?? NO_SCORE_SENTINEL;
  return Buffer.from(JSON.stringify([effectiveScore, id])).toString("base64url");
}

/** Returns null on any malformed input — callers should treat that as an invalid cursor (400), not silently fall back to page 1. */
export function decodeCursor(raw: string): CandidateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === "number" &&
      Number.isInteger(parsed[1]) &&
      parsed[1] > 0
    ) {
      return { score: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

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
  score: string | null;
  rank_explanation: string | null;
}

/**
 * Keyset (cursor) pagination on `(effective_score DESC, property.id DESC)`,
 * not OFFSET — this table is expected to grow into the thousands (issue #19
 * Technical approach #3: "don't fetch-all-and-filter-client-side"), and
 * OFFSET pagination degrades linearly with page depth while keyset
 * pagination stays O(limit) regardless of how deep the caller pages.
 *
 * Task 3.4 (#23), EC-1: ordering is global (by score, best first), not just
 * within a page — an earlier version of this function sorted only the
 * already-fetched page client-side, which meant a high-scoring candidate on
 * page 2 could render below a low-scoring one on page 1 (a real bug, not a
 * documented tradeoff: "Cargar más" appends pages, so per-page sorting
 * actively defeated the point of scoring for any profile with more matched
 * candidates than one page). The compound `(score, id)` keyset below fixes
 * this: `p.id` alone is no longer sufficient to resume the scan once the
 * primary sort key is `score`, so the cursor must carry both.
 */
export async function listCandidates(
  profileId: number,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<CandidatePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rawCursor = opts.cursor ?? null;

  let cursorScore: number | null = null;
  let cursorId: number | null = null;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) {
      throw new Error("Cursor no válido.");
    }
    cursorScore = decoded.score;
    cursorId = decoded.id;
  }

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
       pls.score,
       pls.rank_explanation,
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
       AND (
         $2::double precision IS NULL
         OR COALESCE(pls.score, ${NO_SCORE_SENTINEL}) < $2::double precision
         OR (COALESCE(pls.score, ${NO_SCORE_SENTINEL}) = $2::double precision AND p.id < $3::bigint)
       )
     ORDER BY COALESCE(pls.score, ${NO_SCORE_SENTINEL}) DESC, p.id DESC
     LIMIT $4`,
    [profileId, cursorScore, cursorId, limit + 1],
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
    score: r.score !== null ? Number(r.score) : null,
    rank_explanation: r.rank_explanation,
  }));

  // Cursor is derived from the *last row of the SQL result*, which is
  // already in final (score, id) DESC order — there is no separate
  // client-side re-sort of `pageRows` to accidentally derive it from
  // afterward (that was the bug: a previous version sorted `pageRows` by
  // score for display *after* the cursor should have been captured from
  // the id-ordered fetch, corrupting the keyset scan).
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(lastRow.score !== null ? Number(lastRow.score) : null, Number(lastRow.property_id))
    : null;

  return { items, nextCursor };
}
