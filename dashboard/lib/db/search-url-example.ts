/**
 * Learned search-URL examples (capture-to-infer, issue #293) — server-only
 * (imports lib/db-write, the `pg` client). Never import from a client
 * component; the client-safe parsing/types live in lib/search-url/*.
 *
 * A row is one real search URL the owner navigated and batch-started a capture
 * on (see browser-extension/background.js `startBatch`). Auto-trusted: the
 * owner navigated it, so it's treated as a correct example with no review step
 * (owner decision, 2026-08-05). Decoded once at save time into `filters` +
 * `category_key` + `template` so the resolver never re-parses on the read path.
 */

import { sql } from "@/lib/db-write";
import { worklistMatchKey } from "@/lib/worklist";
import { parseSearchUrl } from "@/lib/search-url/parsers";
import type { ParsedSearchFilters } from "@/lib/search-url/types";

/** A `search_url_example` row as read back by the resolver. */
export interface SearchUrlExampleRow {
  id: number;
  portal: string;
  url: string;
  match_key: string;
  filters: ParsedSearchFilters;
  category_key: string;
  template: string;
  created_at: string;
}

/** Outcome of a save attempt (the route reports it back to the extension). */
export type SaveExampleResult =
  | { stored: true; id: number; categoryKey: string; inserted: boolean }
  | { stored: false; reason: "unparseable" | "invalid_url" };

/**
 * Decode a real search URL for `portal` and upsert it as a learned example.
 * Idempotent on the canonical `match_key` (cosmetic URL differences dedupe to
 * the same row); a re-capture of the same page refreshes the decoded
 * `filters`/`template` and bumps `created_at` so the most recent navigation
 * wins. No-ops (returns `stored:false`) — never throws — when the portal has no
 * parser or the URL isn't its search grammar.
 */
export async function saveSearchUrlExample(
  portal: string,
  url: string,
  resultCount?: number | null,
): Promise<SaveExampleResult> {
  const parsed = parseSearchUrl(portal, url);
  if (!parsed) return { stored: false, reason: "unparseable" };

  const matchKey = worklistMatchKey(url);
  if (!matchKey) return { stored: false, reason: "invalid_url" };

  // Issue #376: the real harvested count `enumerateResultsPages()` computes
  // (previously discarded). The extension re-POSTs the same search URL WITH
  // this count at the end of enumeration; keyed by (portal, match_key) =
  // (connector, resolved scope/filter). A COALESCE on the update preserves an
  // existing count when a later call omits it (e.g. the batch-start save that
  // fires before enumeration has a count), so a known count is never wiped by
  // a countless refresh of the same example.
  const count =
    typeof resultCount === "number" && Number.isFinite(resultCount)
      ? Math.max(0, Math.trunc(resultCount))
      : null;

  // `xmax = 0` is true only for a freshly-inserted row, so `inserted`
  // distinguishes a new example from a refresh of an existing one.
  const rows = await sql<{ id: number; inserted: boolean }>(
    `INSERT INTO search_url_example (portal, url, match_key, filters, category_key, template, last_result_count)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (portal, match_key) DO UPDATE
       SET url = EXCLUDED.url,
           filters = EXCLUDED.filters,
           category_key = EXCLUDED.category_key,
           template = EXCLUDED.template,
           last_result_count = COALESCE(EXCLUDED.last_result_count, search_url_example.last_result_count),
           created_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      portal,
      url,
      matchKey,
      JSON.stringify(parsed.filters),
      parsed.categoryKey,
      parsed.template,
      count,
    ],
  );

  return { stored: true, id: rows[0].id, categoryKey: parsed.categoryKey, inserted: rows[0].inserted };
}

/**
 * Every learned example for a portal, newest first — the resolver's read set.
 * At the expected volume (a handful per portal) loading all of them and
 * matching in memory is simpler and cheaper than a per-lookup SQL query.
 */
export async function findExamplesForPortal(
  portal: string,
): Promise<SearchUrlExampleRow[]> {
  return sql<SearchUrlExampleRow>(
    `SELECT id, portal, url, match_key, filters, category_key, template, created_at
       FROM search_url_example
      WHERE portal = $1
      ORDER BY created_at DESC, id DESC`,
    [portal],
  );
}
