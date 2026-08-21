/**
 * Capture-worklist persistence (issue #237) — server-only (imports
 * lib/db-write, the `pg` client). Never import from a client component; use
 * lib/worklist.ts for the client-safe types/helpers instead.
 */

import { sql } from "@/lib/db-write";
import { sightingIdsByPortal } from "@/lib/capture-sightings";
import {
  CAPTURE_PORTAL_NAMES,
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
 *
 * `portal` scopes BOTH halves. It used to scope only `rows`, leaving
 * `summaries` global — harmless for the old unscoped `/etl/captura`, which
 * fetched every portal and filtered client-side, but a correctness bug for a
 * per-source page: `/admin/fuentes/aliseda` rendered aliseda's rows next to
 * every other portal's progress bar, attributing another source's numbers to
 * this one. A wrong number under the wrong heading is worse than a missing
 * one, so the predicate lives here rather than in each caller.
 *
 * The guided-capture surface is scoped to extension-capturable portals
 * (`CAPTURE_PORTAL_NAMES`, issue #454): rows for an ETL-fetched connector (e.g.
 * cimenta2) are vestigial — the extension never drains them — so they are
 * filtered out here rather than shown as a misleading "0/N pending forever".
 */
export async function listWorklist(
  portal?: string,
): Promise<{ rows: WorklistRow[]; summaries: WorklistPortalSummary[] }> {
  const capturePortals = [...CAPTURE_PORTAL_NAMES];
  const rows = portal
    ? await sql<WorklistRow>(
        `SELECT id, url, source_portal, status, added_via, external_id, note,
                matched_capture_id, created_at, updated_at
           FROM capture_worklist
          WHERE source_portal = $1 AND source_portal = ANY($2)
          ORDER BY created_at DESC, id DESC`,
        [portal, capturePortals],
      )
    : await sql<WorklistRow>(
        `SELECT id, url, source_portal, status, added_via, external_id, note,
                matched_capture_id, created_at, updated_at
           FROM capture_worklist
          WHERE source_portal = ANY($1)
          ORDER BY created_at DESC, id DESC`,
        [capturePortals],
      );

  const summaryRows = portal
    ? await sql<{
        source_portal: string;
        status: WorklistStatus;
        n: string;
      }>(
        `SELECT source_portal, status, COUNT(*)::text AS n
           FROM capture_worklist
          WHERE source_portal = $1 AND source_portal = ANY($2)
          GROUP BY source_portal, status`,
        [portal, capturePortals],
      )
    : await sql<{
        source_portal: string;
        status: WorklistStatus;
        n: string;
      }>(
        `SELECT source_portal, status, COUNT(*)::text AS n
           FROM capture_worklist
          WHERE source_portal = ANY($1)
          GROUP BY source_portal, status`,
        [capturePortals],
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

/** One pending worklist entry, for the auto-driver's next-batch selection (#424). */
export interface PendingWorklistItem {
  url: string;
  portal: string;
  /** ISO timestamp the row was added — the oldest-first tiebreak. */
  createdAt: string;
}

/**
 * The still-`pending` worklist entries (optionally one portal), OLDEST FIRST, as
 * `{ url, portal, createdAt }`. Backs the auto-capture continuous driver (issue
 * #424): the API route re-ranks these due-first then hands the extension the next
 * ≤N to drain. Oldest-first here is the stable tiebreak once due-priority ties.
 */
export async function listPendingWorklist(
  portal?: string,
): Promise<PendingWorklistItem[]> {
  // Scope to extension-capturable portals (issue #454): the auto-capture driver
  // must never be handed a vestigial ETL-connector URL (e.g. cimenta2) that the
  // extension cannot capture.
  const capturePortals = [...CAPTURE_PORTAL_NAMES];
  const rows = portal
    ? await sql<{ url: string; source_portal: string; created_at: string }>(
        `SELECT url, source_portal, created_at
           FROM capture_worklist
          WHERE status = 'pending' AND source_portal = $1
            AND source_portal = ANY($2)
          ORDER BY created_at ASC, id ASC`,
        [portal, capturePortals],
      )
    : await sql<{ url: string; source_portal: string; created_at: string }>(
        `SELECT url, source_portal, created_at
           FROM capture_worklist
          WHERE status = 'pending' AND source_portal = ANY($1)
          ORDER BY created_at ASC, id ASC`,
        [capturePortals],
      );
  return rows.map((r) => ({
    url: r.url,
    portal: r.source_portal,
    createdAt: r.created_at,
  }));
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
  // Issue #639 review, C1: THIS is the production sighting path, not
  // etl/capture.py's `_record_sightings` (which only runs for a
  // manually-captured single results page -- the D-088 results-page walk
  // that actually enumerates a portal's search pages POSTs its harvested
  // detail URLs straight here, `via: 'derived'`, and never touches
  // POST /api/extension/capture at all). Every valid, portal-resolved URL
  // in this batch -- added AND duplicate alike, since a duplicate still
  // means this enumeration just re-confirmed a listing it already knew
  // about -- feeds the same `last_seen_at` bump `etl.capture.py`'s sighting
  // logic performs, via the TypeScript mirror in lib/capture-sightings.ts.
  const sightingPairs: { portal: string; url: string }[] = [];

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
    if (addedVia === "derived") sightingPairs.push({ portal, url });
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

  if (sightingPairs.length > 0) {
    await recordSightings(sightingPairs);
  }

  return result;
}

/**
 * Bump `listing.last_seen_at` for every already-known listing this batch of
 * harvested detail URLs enumerated (issue #639, review C1 -- the actual
 * production sighting path; see `addWorklistUrls`'s own comment).
 *
 * A results-page enumeration proves an advert is STILL LISTED, nothing
 * more -- so this only ever writes `last_seen_at`, never `status`, never
 * `last_fetched_at` (the same distinction `etl.capture._record_sightings`
 * makes on the Python side, D-039's staleness surfacing already documents,
 * and no dashboard reader of `last_seen_at` assumes something stronger).
 * `GREATEST(last_seen_at, NOW())` mirrors `etl.orchestrator.
 * _update_last_seen_for_discovered`'s monotonic write -- this call runs
 * synchronously in the request that just harvested the URLs (no queue
 * delay the way `extension_capture` can have), so NOW() is the true
 * observation instant here; GREATEST still guards against a rarer race
 * with a concurrent, more recent write from another path.
 *
 * Best-effort: the worklist rows this batch seeded are already committed by
 * the time this runs, so a failure here must never turn a successful
 * `POST /api/etl/worklist` into an error -- it is only logged.
 */
async function recordSightings(
  pairs: readonly { portal: string; url: string }[],
): Promise<void> {
  const byPortal = sightingIdsByPortal(pairs);
  for (const [portal, externalIds] of byPortal) {
    if (externalIds.length === 0) continue;
    try {
      await sql(
        `UPDATE listing SET last_seen_at = GREATEST(last_seen_at, NOW())
          WHERE source = $1 AND external_id = ANY($2)`,
        [portal, externalIds],
      );
    } catch (err) {
      console.error(
        `[worklist] last_seen_at sighting update failed for portal=${portal} ` +
          `(${externalIds.length} id(s)) -- the worklist rows themselves are unaffected:`,
        err,
      );
    }
  }
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
