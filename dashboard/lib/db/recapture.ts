/**
 * Re-capture cohort resolution and requeue (issue #677) — server-only
 * (imports lib/db-write). Client-safe types/estimates live in lib/recapture.ts.
 *
 * The cohort is resolved in three steps, deliberately:
 *
 *   1. SQL selects the LISTINGS the predicate matches (photos, capture age,
 *      profile candidacy) — all of that lives on `listing`/`profile_listing_state`.
 *   2. TS maps each listing URL through `worklistMatchKey()`.
 *   3. SQL intersects those keys with `capture_worklist.match_key`.
 *
 * Step 2 is not an accident of laziness. `capture_worklist` has no FK to
 * `listing`; the correlation is `match_key`, a canonicalisation that exists in
 * exactly two places — dashboard/lib/worklist.ts and etl/capture.py — kept
 * byte-identical by a shared table of cases asserted in BOTH test suites (see
 * the table comment in etl/schema/init.sql). Doing the join in SQL would mean
 * a THIRD copy of that canonicalisation, in a third language, with no shared
 * fixture pinning it. Reusing the existing function is the only way to be sure
 * the cohort we flip is the cohort we counted.
 */

import { sql } from "@/lib/db-write";
import {
  activeSourceClause,
  DISABLED_SOURCES_CTE,
} from "@/lib/db/source-active";
import { worklistMatchKey } from "@/lib/worklist";
import {
  estimateBatchSeconds,
  type RecaptureCohortPreview,
  type RecaptureCohortRequest,
  type RecaptureEstimate,
} from "@/lib/recapture";

/** How many recent captures to average when measuring retained-HTML size. */
const HTML_SAMPLE_SIZE = 200;

/**
 * Only `captured` rows are requeue-able.
 *
 *   'pending' — already queued; requeueing is a no-op that would only reset
 *               a rank the operator did not ask to change.
 *   'failed'  — already has a "Reactivar" affordance on the row.
 *   'skipped' — the owner said no to this URL. A bulk cohort must not
 *               silently overturn a per-row decision.
 *   'stale'   — the listing dropped out of the portal's sitemap; there is
 *               nothing there to capture.
 *
 * That leaves exactly the rows this feature exists for: ones that produced
 * data once, and produced bad data.
 */
const REQUEUEABLE_STATUS = "captured";

/**
 * "Live, unrejected candidate in at least one profile."
 *
 * Both notions of rejected are excluded, because they are set by different
 * surfaces and either one means the owner is done with the property:
 * `pipeline_stage = 'rejected'` (set on the property detail page's triage bar
 * and the dedup review surfaces) and a latest `feedback_event` of 'reject'
 * (the feed's thumbs-down, undone by 'clear'). `closed` is terminal too, per
 * the schema's stage-ordering comment.
 *
 * Note this is only the PROFILE-side half of "live". The SOURCE-side half —
 * D-055's disabled-connector gate — is applied separately and
 * unconditionally in `selectCohortListings`, because a listing from a portal
 * the owner has switched off is hidden from every other surface and must not
 * be re-captured either, whether or not "solo candidatos vivos" is ticked.
 */
const LIVE_CANDIDATE_PREDICATE = `
  EXISTS (
    SELECT 1
      FROM profile_listing_state pls
      JOIN search_profile sp ON sp.id = pls.profile_id
     WHERE pls.property_id = l.property_id
       AND pls.matched = true
       AND sp.archived_at IS NULL
       AND pls.pipeline_stage NOT IN ('rejected', 'closed')
       AND COALESCE((
             SELECT fe.feedback_type
               FROM feedback_event fe
              WHERE fe.profile_id = pls.profile_id
                AND fe.property_id = pls.property_id
                AND fe.feedback_type IN ('accept','reject','star','clear')
              ORDER BY fe.created_at DESC, fe.id DESC
              LIMIT 1
           ), 'none') <> 'reject'
  )`;

/**
 * Best profile score for the listing's property — the value signal the queue
 * is ordered by. NULL for a listing no profile has scored.
 */
const BEST_SCORE_EXPR = `
  (SELECT MAX(pls2.score)
     FROM profile_listing_state pls2
     JOIN search_profile sp2 ON sp2.id = pls2.profile_id
    WHERE pls2.property_id = l.property_id
      AND pls2.matched = true
      AND sp2.archived_at IS NULL
      AND pls2.pipeline_stage NOT IN ('rejected', 'closed'))`;

interface CohortListingRow {
  url: string;
  photo_count: number;
  best_score: string | null;
}

/**
 * Listings matching the predicate, already in value order: best-scoring
 * property first, then fewest photos (the most broken listing gains the most
 * from a re-capture), then newest.
 */
async function selectCohortListings(
  req: RecaptureCohortRequest,
): Promise<CohortListingRow[]> {
  const params: unknown[] = [req.portal];
  let predicateSql: string;

  switch (req.predicate) {
    case "few_photos": {
      params.push(req.threshold);
      predicateSql = `COALESCE(cardinality(array_remove(l.photo_urls, NULL)), 0) < $${params.length}`;
      break;
    }
    case "stale_capture": {
      params.push(req.threshold);
      // NULL last_fetched_at means "never re-fetched" — a first-class member
      // of a staleness cohort, not an absence to skip.
      predicateSql = `(l.last_fetched_at IS NULL
                       OR l.last_fetched_at < NOW() - make_interval(days => $${params.length}::int))`;
      break;
    }
    case "never_requeued": {
      // Every listing of the portal; the worklist-side intersection below
      // narrows it to rows that have never carried a requeue.
      predicateSql = `TRUE`;
      break;
    }
  }

  const candidateFilter = req.onlyLiveCandidates
    ? `AND ${LIVE_CANDIDATE_PREDICATE}`
    : "";

  // D-055: a listing whose connector is switched off is hidden from the list
  // feed (candidates.ts) and the map feed (map-candidates.ts) alike, via this
  // exact shared fragment. Re-capture uses it too rather than defining a third
  // notion of "live listing" — re-capturing a portal the owner turned off is
  // browsing time spent on data no surface will ever show.
  return sql<CohortListingRow>(
    `WITH ${DISABLED_SOURCES_CTE}
     SELECT l.url,
            COALESCE(cardinality(array_remove(l.photo_urls, NULL)), 0) AS photo_count,
            ${BEST_SCORE_EXPR} AS best_score
       FROM listing l
      WHERE l.source = $1
        AND ${activeSourceClause("l")}
        -- 'active' only, so 'reserved' listings are excluded. Inherited
        -- deliberately rather than by accident: every candidate-facing query
        -- in the codebase (candidates.ts, map-candidates.ts) draws the live
        -- line at status = 'active' too, so a reserved listing is already
        -- invisible in the feed. Re-capturing one would spend browsing time
        -- refreshing a card nobody can see. If that line ever moves, it moves
        -- in all three places at once.
        AND l.status = 'active'
        AND l.operation = 'sale'
        AND l.url IS NOT NULL
        AND ${predicateSql}
        ${candidateFilter}
      ORDER BY ${BEST_SCORE_EXPR} DESC NULLS LAST,
               COALESCE(cardinality(array_remove(l.photo_urls, NULL)), 0) ASC,
               l.id DESC`,
    params,
  );
}

/**
 * The requeue-able worklist rows for these listings, in the order the listings
 * came in (i.e. value order) — that order becomes `requeue_rank`.
 *
 * `never_requeued` additionally drops rows that already carry a `requeued_at`.
 */
async function selectCohortRows(
  req: RecaptureCohortRequest,
  listings: CohortListingRow[],
): Promise<{ ids: number[]; alreadyRequeued: number }> {
  const keys = listings
    .map((l) => worklistMatchKey(l.url))
    .filter((k) => k.length > 0);
  if (keys.length === 0) return { ids: [], alreadyRequeued: 0 };

  const rankByKey = new Map<string, number>();
  keys.forEach((k, i) => {
    if (!rankByKey.has(k)) rankByKey.set(k, i);
  });

  const neverRequeuedFilter =
    req.predicate === "never_requeued" ? "AND w.requeued_at IS NULL" : "";

  const rows = await sql<{
    id: number;
    match_key: string;
    requeued_at: string | null;
  }>(
    `SELECT w.id, w.match_key, w.requeued_at
       FROM capture_worklist w
      WHERE w.source_portal = $1
        AND w.status = $2
        AND w.match_key = ANY($3::text[])
        ${neverRequeuedFilter}`,
    [req.portal, REQUEUEABLE_STATUS, [...rankByKey.keys()]],
  );

  rows.sort(
    (a, b) =>
      (rankByKey.get(a.match_key) ?? Number.MAX_SAFE_INTEGER) -
      (rankByKey.get(b.match_key) ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    ids: rows.map((r) => r.id),
    alreadyRequeued: rows.filter((r) => r.requeued_at !== null).length,
  };
}

/**
 * Whether the ETL will actually PROCESS captures for this portal —
 * `connector_config.capture_enabled`, the exact flag
 * `etl/capture.py::_connector_capture_enabled` reads before touching a
 * pending `extension_capture` row (issue #263). A missing row means enabled,
 * matching that function's own default.
 *
 * Checked separately from D-055's `activeSourceClause` even though the two
 * read the same column for a capture-only portal, because the failure they
 * describe is different and the operator needs to be told which one they hit.
 * D-055 says "this portal's listings are hidden everywhere"; this says "the
 * browsing would happen, and every capture it produced would sit unprocessed
 * forever". Silently returning a cohort of zero for either is what a whole
 * evening of browsing gets spent on.
 */
export async function isCaptureProcessingEnabled(
  portal: string,
): Promise<boolean> {
  const rows = await sql<{ capture_enabled: boolean }>(
    `SELECT capture_enabled FROM connector_config WHERE connector_name = $1`,
    [portal],
  );
  return rows.length === 0 ? true : rows[0].capture_enabled !== false;
}

/**
 * Measure, from this database's own recent captures, what one more capture of
 * this portal costs in `extension_capture.html`.
 *
 * Measured rather than assumed on purpose. Whether HTML survives a successful
 * parse is an ETL-side config decision (`ETL_RETAIN_CAPTURE_HTML_FOR`, D-150)
 * that the dashboard process cannot see — but its effect is plainly visible in
 * the rows the ETL already wrote. If no recent `done` capture kept its HTML,
 * retention is off for this portal and a re-capture pass stores nothing.
 */
async function measureHtmlCost(
  portal: string,
): Promise<{ raw: number; stored: number; on: boolean }> {
  const rows = await sql<{
    retained: string;
    avg_raw: string | null;
    avg_stored: string | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE html IS NOT NULL)              AS retained,
            AVG(octet_length(html))  FILTER (WHERE html IS NOT NULL) AS avg_raw,
            AVG(pg_column_size(html)) FILTER (WHERE html IS NOT NULL) AS avg_stored
       FROM (SELECT html
               FROM extension_capture
              WHERE connector_name = $1 AND status = 'done'
              ORDER BY id DESC
              LIMIT ${HTML_SAMPLE_SIZE}) recent`,
    [portal],
  );
  const r = rows[0];
  const retained = Number(r?.retained ?? 0);
  if (!r || retained === 0) return { raw: 0, stored: 0, on: false };
  return {
    raw: Math.round(Number(r.avg_raw ?? 0)),
    stored: Math.round(Number(r.avg_stored ?? 0)),
    on: true,
  };
}

async function buildEstimate(
  portal: string,
  pages: number,
): Promise<RecaptureEstimate> {
  const seconds = estimateBatchSeconds(pages);
  const html = await measureHtmlCost(portal);
  return {
    seconds,
    secondsPerListing: pages > 0 ? Math.round((seconds / pages) * 10) / 10 : 0,
    storedHtmlBytes: html.stored * pages,
    rawHtmlBytes: html.raw * pages,
    htmlRetentionOn: html.on,
  };
}

/**
 * Resolve a cohort and report what requeueing it would cost. **Read-only** —
 * this is what the "Calcular" button runs, and nothing here writes.
 */
export async function previewRecaptureCohort(
  req: RecaptureCohortRequest,
): Promise<RecaptureCohortPreview> {
  const listings = await selectCohortListings(req);
  const { ids, alreadyRequeued } = await selectCohortRows(req, listings);
  return {
    request: req,
    rowCount: ids.length,
    listingCount: listings.length,
    alreadyRequeuedCount: alreadyRequeued,
    estimate: await buildEstimate(req.portal, ids.length),
  };
}

export interface RequeueResult {
  requeued: number;
  /** The count the operator was shown and confirmed against. */
  expected: number;
}

/**
 * Flip a cohort back to 'pending' and stamp it as a requeue.
 *
 * The cohort is **re-resolved here from the same predicate**, never taken as a
 * client-supplied list of row ids: a browser that has been sitting on a
 * preview for ten minutes must not be able to flip rows that have since
 * stopped matching, and a hand-crafted request must not be able to name
 * arbitrary ids.
 *
 * `expectedCount` is the number the operator confirmed against. When the
 * cohort has moved underneath them the write is refused rather than silently
 * doing something other than what the confirm said — the operator re-runs
 * "Calcular" and sees the new number.
 *
 * Note this is a COUNT guard, not a set-identity guard: an exactly
 * compensating swap between preview and confirm (one row drops out, another
 * drops in) passes it, and a row the operator never saw in a preview gets
 * requeued. Deliberately left as a count — the swapped-in row satisfies the
 * same predicate the operator chose, so the cohort is still the cohort they
 * asked for, and hashing the id set would trade that for spurious 409s on a
 * queue that legitimately churns. The per-row protection that does matter is
 * `AND w.status = $4` on the UPDATE below.
 */
export async function requeueRecaptureCohort(
  req: RecaptureCohortRequest,
  reason: string,
  expectedCount: number,
): Promise<RequeueResult> {
  const listings = await selectCohortListings(req);
  const { ids } = await selectCohortRows(req, listings);

  if (ids.length !== expectedCount) {
    return { requeued: 0, expected: ids.length };
  }
  if (ids.length === 0) return { requeued: 0, expected: 0 };

  // requeue_rank is the position in the value ordering, 1-based. Applied with
  // a single UPDATE ... FROM unnest() so the whole cohort flips atomically —
  // a partial flip would leave the operator unable to tell how far it got.
  const ranks = ids.map((_, i) => i + 1);
  const rows = await sql<{ id: number }>(
    `UPDATE capture_worklist w
        SET status         = 'pending',
            requeued_at    = NOW(),
            requeue_reason = $2,
            requeue_rank   = c.rank
       FROM unnest($1::bigint[], $3::int[]) AS c(id, rank)
      WHERE w.id = c.id
        AND w.status = $4
      RETURNING w.id`,
    [ids, reason.slice(0, 500), ranks, REQUEUEABLE_STATUS],
  );

  return { requeued: rows.length, expected: ids.length };
}
