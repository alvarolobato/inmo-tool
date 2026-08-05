/**
 * Capture-worklist persistence (issue #237) — server-only (imports
 * lib/db-write, the `pg` client). Never import from a client component; use
 * lib/worklist.ts for the client-safe types/helpers instead.
 */

import { sql } from "@/lib/db-write";
import {
  portalForUrl,
  worklistMatchKey,
  type WorklistPortalSummary,
  type WorklistRow,
  type WorklistStatus,
} from "@/lib/worklist";

/** Outcome of a manual add: how many URLs landed vs. were rejected/duplicate. */
export interface AddWorklistResult {
  added: number;
  duplicate: number;
  invalid: { url: string; reason: string }[];
}

/**
 * List worklist rows (optionally filtered to one portal), newest first, plus
 * per-portal status roll-ups for the page header. One round trip each.
 */
export async function listWorklist(
  portal?: string,
): Promise<{ rows: WorklistRow[]; summaries: WorklistPortalSummary[] }> {
  const rows = portal
    ? await sql<WorklistRow>(
        `SELECT id, url, source_portal, status, added_via, external_id, note,
                matched_capture_id, created_at, updated_at
           FROM capture_worklist WHERE source_portal = $1
          ORDER BY created_at DESC, id DESC`,
        [portal],
      )
    : await sql<WorklistRow>(
        `SELECT id, url, source_portal, status, added_via, external_id, note,
                matched_capture_id, created_at, updated_at
           FROM capture_worklist
          ORDER BY created_at DESC, id DESC`,
      );

  const summaryRows = await sql<{
    source_portal: string;
    status: WorklistStatus;
    n: string;
  }>(
    `SELECT source_portal, status, COUNT(*)::text AS n
       FROM capture_worklist GROUP BY source_portal, status`,
  );

  const byPortal = new Map<string, WorklistPortalSummary>();
  for (const r of summaryRows) {
    const s =
      byPortal.get(r.source_portal) ??
      ({
        source_portal: r.source_portal,
        total: 0,
        pending: 0,
        captured: 0,
        failed: 0,
        skipped: 0,
        stale: 0,
      } satisfies WorklistPortalSummary);
    const n = Number(r.n);
    s[r.status] += n;
    s.total += n;
    byPortal.set(r.source_portal, s);
  }
  const summaries = [...byPortal.values()].sort((a, b) =>
    a.source_portal.localeCompare(b.source_portal),
  );
  return { rows, summaries };
}

/** How a batch of URLs entered the worklist. */
export type WorklistAddedVia = "manual" | "derived";

/**
 * Add URLs to the worklist. Each URL is validated (http/https + a known capture
 * host), canonicalised to a match_key, and inserted with the given `addedVia`
 * (default `'manual'` — the operator's pasted list; `'derived'` when the browser
 * extension harvested them off a listing page for batch capture, issue #262).
 * Re-adding an existing listing is idempotent (ON CONFLICT (match_key) DO
 * NOTHING) and reported as a duplicate rather than an error — an overlapping
 * batch (pasted or harvested) is expected.
 */
export async function addWorklistUrls(
  urls: string[],
  addedVia: WorklistAddedVia = "manual",
): Promise<AddWorklistResult> {
  const result: AddWorklistResult = { added: 0, duplicate: 0, invalid: [] };
  const seenKeys = new Set<string>();

  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      result.invalid.push({ url, reason: "URL inválida" });
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      result.invalid.push({ url, reason: "Debe usar http o https" });
      continue;
    }
    const portal = portalForUrl(url);
    if (!portal) {
      result.invalid.push({
        url,
        reason: "El portal no es capturable (host no reconocido)",
      });
      continue;
    }
    const matchKey = worklistMatchKey(url);
    if (!matchKey) {
      result.invalid.push({ url, reason: "No se pudo normalizar la URL" });
      continue;
    }
    // De-dupe within this same batch before hitting the DB (two cosmetically
    // different URLs for the same listing pasted together).
    if (seenKeys.has(matchKey)) {
      result.duplicate += 1;
      continue;
    }
    seenKeys.add(matchKey);

    const inserted = await sql<{ id: number }>(
      `INSERT INTO capture_worklist (url, match_key, source_portal, added_via)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (match_key) DO NOTHING
       RETURNING id`,
      [url, matchKey, portal, addedVia],
    );
    if (inserted.length > 0) result.added += 1;
    else result.duplicate += 1;
  }
  return result;
}

/**
 * Set a worklist row's status directly. The operator surface for this is
 * "skip" (dismiss a URL they don't want to capture) and "reset to pending"
 * (re-queue a failed one). Returns true if a row was updated.
 */
export async function setWorklistStatus(
  id: number,
  status: WorklistStatus,
): Promise<boolean> {
  const rows = await sql<{ id: number }>(
    `UPDATE capture_worklist SET status = $2 WHERE id = $1 RETURNING id`,
    [id, status],
  );
  return rows.length > 0;
}
