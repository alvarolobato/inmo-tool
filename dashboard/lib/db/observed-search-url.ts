/**
 * Passively-observed Idealista search URLs (issue #488, part of #471) —
 * server-only (imports lib/db-write's `pg` client). Never import from a client
 * component.
 *
 * A row is one DISTINCT search/results URL the extension's passive observer saw
 * the owner browsing — kept VERBATIM (incl. any `shape=` drawn-zone param) so
 * #471 can analyse Idealista's filtering grammar in bulk. Distinct from
 * captured_search_urls (#476), which holds the owner's INTENTIONAL captures:
 * keeping the passive noise in its own table stops it drowning the deliberate
 * ones. De-dup is by `norm_key` (host + path + sorted query, derived
 * server-side): a re-observation UPSERTs, bumping `seen_count` + `last_seen`.
 */

import { sql } from "@/lib/db-write";

/** An `observed_search_urls` row as read back by the review surface. */
export interface ObservedSearchUrlRow {
  id: number;
  portal: string;
  url: string;
  title: string | null;
  seen_count: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Persist (or bump) an observed search URL. `portal` and `normKey` are derived
 * server-side from the URL (never client-claimed). On a repeat observation of
 * the same `normKey` the row is UPSERTed: `seen_count` increments, `last_seen`
 * refreshes, and the verbatim `url`/`title` are refreshed to the latest sighting
 * (a param may have been added/reordered — the newest verbatim form is kept).
 * Returns the row id, seen count and timestamps.
 */
export async function saveObservedSearchUrl(
  portal: string,
  url: string,
  normKey: string,
  title?: string | null,
): Promise<{ id: number; seen_count: number; first_seen: string; last_seen: string }> {
  const rows = await sql<{
    id: number;
    seen_count: number;
    first_seen: string;
    last_seen: string;
  }>(
    `INSERT INTO observed_search_urls (portal, url, norm_key, title)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (norm_key) DO UPDATE
       SET seen_count = observed_search_urls.seen_count + 1,
           last_seen  = NOW(),
           url        = EXCLUDED.url,
           title      = COALESCE(EXCLUDED.title, observed_search_urls.title)
     RETURNING id, seen_count, first_seen, last_seen`,
    [portal, url, normKey, title ?? null],
  );
  return rows[0];
}

/**
 * The most recently observed search URLs, newest sighting first. `limit` is
 * clamped to a sane range so a bad caller can't ask for an unbounded scan.
 */
export async function listObservedSearchUrls(
  limit = 200,
): Promise<ObservedSearchUrlRow[]> {
  const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit) || 200));
  return sql<ObservedSearchUrlRow>(
    `SELECT id, portal, url, title, seen_count, first_seen, last_seen
       FROM observed_search_urls
      ORDER BY last_seen DESC, id DESC
      LIMIT $1`,
    [safeLimit],
  );
}
