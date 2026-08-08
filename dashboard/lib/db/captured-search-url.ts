/**
 * Captured Idealista search URLs (issue #475, part of #471) — server-only
 * (imports lib/db-write's `pg` client). Never import from a client component.
 *
 * A row is one raw results-page URL the owner captured via the browser
 * extension's "Capturar URL de búsqueda" action — kept VERBATIM (incl. the
 * `shape=` drawn-zone param) so #471 P1 can decode Idealista's polygon grammar.
 * Unlike search_url_example, nothing is decoded/normalised here.
 */

import { sql } from "@/lib/db-write";

/** A `captured_search_urls` row as read back by the review surface. */
export interface CapturedSearchUrlRow {
  id: number;
  portal: string;
  url: string;
  title: string | null;
  captured_at: string;
  notes: string | null;
}

/**
 * Persist a captured search URL verbatim. `portal` is derived server-side from
 * the URL host by the caller (never client-claimed). Returns the new row id and
 * timestamp. Always inserts — a re-capture of the same zone is a distinct,
 * worth-keeping capture (its encoding may differ).
 */
export async function saveCapturedSearchUrl(
  portal: string,
  url: string,
  title?: string | null,
  notes?: string | null,
): Promise<{ id: number; captured_at: string }> {
  const rows = await sql<{ id: number; captured_at: string }>(
    `INSERT INTO captured_search_urls (portal, url, title, notes)
       VALUES ($1, $2, $3, $4)
     RETURNING id, captured_at`,
    [portal, url, title ?? null, notes ?? null],
  );
  return { id: rows[0].id, captured_at: rows[0].captured_at };
}

/**
 * The most recently captured search URLs, newest first. `limit` is clamped to a
 * sane range so a bad caller can't ask for an unbounded scan.
 */
export async function listCapturedSearchUrls(
  limit = 200,
): Promise<CapturedSearchUrlRow[]> {
  const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit) || 200));
  return sql<CapturedSearchUrlRow>(
    `SELECT id, portal, url, title, captured_at, notes
       FROM captured_search_urls
      ORDER BY captured_at DESC, id DESC
      LIMIT $1`,
    [safeLimit],
  );
}
