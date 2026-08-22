/**
 * Data-health / observability aggregation (issue #272) — server-only.
 *
 * Read-only: every query here is a SELECT, so it runs through the read-only
 * `query()` pool (lib/db) rather than the write pool. Four independent reads,
 * run in parallel, feeding the "Salud de datos" page:
 *
 *   1. Per-connector last-run health   — connector_run_results (latest run
 *      per connector, + the prior run's error_count for a trend).
 *   2. Per-portal capture health       — extension_capture grouped by url
 *      host, joined to listing for the avg photo count.
 *   3. Per-source stored data quality  — listing grouped by source.
 *   4. Stale profiles                  — search_profile whose newest listing
 *      data is newer than last_materialized_at.
 *
 * The clean-vs-error distinction (a budget/soft-block `ok`-with-notice is
 * healthy, not red) lives in the pure helpers in lib/data-health.ts; this
 * module only splits error_msg into `notice` (when ok) vs `error_msg` (when
 * the run needs attention) so the client never has to re-derive it.
 */

import { query } from "@/lib/db";
import { toIsoOrNull } from "@/lib/format";
import { getZeroResultRegressions } from "@/lib/db/zero-result-regression";
import { getRecentBlockEpisodes } from "@/lib/db/extension-blocks";
import {
  connectorHealthLevel,
  hostToPortal,
  type ConnectorHealth,
  type DataHealthResponse,
  type PortalCaptureHealth,
  type SourceDataQuality,
  type StaleProfile,
} from "@/lib/data-health";

/**
 * The stale-profile query, exported so the Estado "perfiles por
 * re-materializar" queue tile (issue #640) counts the SAME population this
 * page lists instead of re-deriving it. It MUST agree with the reconciler it
 * surfaces — etl/materialize_reconciler.py::_stale_profiles_exist (#285): the
 * newest-listing timestamp is MAX(GREATEST(last_seen_at, last_fetched_at,
 * first_seen_at)), not last_seen_at alone (GREATEST catches every path a
 * listing's data can change; Postgres GREATEST ignores NULLs). Archived
 * profiles excluded. Returns ONLY the stale ones — an empty result is the
 * healthy state. Always gate it with {@link SWEEP_IN_PROGRESS_SQL}.
 */
export const STALE_PROFILES_SQL = `WITH newest AS (
         SELECT MAX(GREATEST(last_seen_at, last_fetched_at, first_seen_at)) AS ts
           FROM listing
       )
       SELECT sp.id, sp.name, sp.last_materialized_at, newest.ts AS newest_listing_at
         FROM search_profile sp
         CROSS JOIN newest
        WHERE sp.archived_at IS NULL
          AND newest.ts IS NOT NULL
          AND (sp.last_materialized_at IS NULL OR sp.last_materialized_at < newest.ts)
        ORDER BY sp.last_materialized_at ASC NULLS FIRST, sp.id`;

/**
 * Running-sweep guard (mirrors `_sweep_in_progress`, #285). While a sweep
 * runs, `last_seen_at` is bumped mid-sweep before `last_materialized_at`
 * catches up, so an unguarded staleness check flags nearly every active
 * profile for the whole ~hourly sweep — a false-positive flood an
 * observability surface must not produce. Exported alongside
 * {@link STALE_PROFILES_SQL} so every consumer applies the same guard.
 */
export const SWEEP_IN_PROGRESS_SQL = `SELECT EXISTS (
         SELECT 1 FROM connector_runs WHERE status = 'running' LIMIT 1
       ) AS sweeping`;

/** Coerce a pg value (number | numeric-string | null) to a number, 0 on null. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Like num() but preserves null (for averages that are legitimately absent). */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aggregate every data-health signal in four parallel reads. Each query is
 * self-contained and cheap (grouped counts over indexed columns); the page
 * polls this at a slow cadence, not per-widget.
 */
export async function getDataHealth(): Promise<DataHealthResponse> {
  const [
    connectorRes,
    portalRes,
    sourceRes,
    staleRes,
    sweepRes,
    zeroResultRegressions,
    extensionBlocks,
  ] = await Promise.all([
    // 1. Latest run per connector + the prior run's error_count. LEAD over a
    //    DESC ordering returns the NEXT (older) row — i.e. the previous run.
    query(
      `SELECT connector_name, status, started_at,
              discovered_count, fetched_count, error_count, skipped_count,
              error_msg, prev_error_count, ms_per_listing
         FROM (
           SELECT c.connector_name, c.status, c.started_at,
                  c.discovered_count, c.fetched_count, c.error_count,
                  c.skipped_count, c.error_msg,
                  -- Issue #700: real work per listing on this run. NULLIF
                  -- guards the no-fetch run — a 0 denominator must yield NULL
                  -- ("didn't fetch"), never 0 ("instant").
                  ROUND(c.fetch_ms_total::numeric
                        / NULLIF(c.fetched_count, 0)) AS ms_per_listing,
                  ROW_NUMBER() OVER w AS rn,
                  LEAD(c.error_count) OVER w AS prev_error_count
             FROM connector_run_results c
             JOIN connector_runs r ON r.id = c.run_id
           WINDOW w AS (
             PARTITION BY c.connector_name
             ORDER BY r.started_at DESC, c.id DESC
           )
         ) t
        WHERE rn = 1
        ORDER BY connector_name`,
    ),

    // 2. Per-portal capture health, grouped by the url host (there is no
    //    source_portal column on extension_capture). Success/quality windowed
    //    to the last 7 days; pending is point-in-time (a stuck row could be
    //    weeks old — that's the signal, so it is NOT windowed).
    query(
      `SELECT
           COALESCE(
             lower(regexp_replace(substring(ec.url FROM '^[a-zA-Z]+://([^/]+)'),
                                  '^www\\.', '')),
             'desconocido'
           ) AS host,
           COUNT(*) FILTER (WHERE ec.status = 'pending')                    AS pending_count,
           EXTRACT(EPOCH FROM (NOW() - MIN(ec.created_at)
             FILTER (WHERE ec.status = 'pending')))::bigint                 AS oldest_pending_age_seconds,
           COUNT(*) FILTER (WHERE ec.status = 'done'
             AND ec.created_at > NOW() - INTERVAL '7 days')                 AS done_7d,
           COUNT(*) FILTER (WHERE ec.status = 'failed'
             AND ec.created_at > NOW() - INTERVAL '7 days')                 AS failed_7d,
           COUNT(*) FILTER (WHERE ec.status = 'listing'
             AND ec.created_at > NOW() - INTERVAL '7 days')                 AS listing_7d,
           AVG(ec.fields_extracted::numeric / NULLIF(ec.fields_available, 0))
             FILTER (WHERE ec.status = 'done' AND ec.fields_available > 0
               AND ec.created_at > NOW() - INTERVAL '7 days')              AS avg_fields_ratio_7d,
           AVG(COALESCE(array_length(l.photo_urls, 1), 0))
             FILTER (WHERE ec.status = 'done'
               AND ec.created_at > NOW() - INTERVAL '7 days')              AS avg_photo_count_7d,
           -- Issue #700: the three legs of per-listing latency, kept apart.
           -- percentile_cont ignores NULLs, so a portal with no measured
           -- sample yields NULL rather than a fabricated 0. The FILTER
           -- deliberately does NOT require status='done': a capture that
           -- FAILED still cost the owner its render wait and its processing
           -- time, and excluding failures would make a portal look fastest
           -- exactly when it is breaking most.
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ec.render_wait_ms)
             FILTER (WHERE ec.created_at > NOW() - INTERVAL '7 days')      AS median_render_wait_ms_7d,
           -- processing_ms IS NOT NULL is required, not COALESCEd to 0:
           -- D-162 rule 2 — a row captured before processing_ms existed has
           -- an UNKNOWN work leg, and coercing it to 0 would silently bill
           -- its whole created→processed delta as queue idle.
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (ec.processed_at - ec.created_at)) * 1000
               - ec.processing_ms)
             FILTER (WHERE ec.processed_at IS NOT NULL
               AND ec.processing_ms IS NOT NULL
               AND ec.created_at > NOW() - INTERVAL '7 days')              AS median_queue_wait_ms_7d,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ec.processing_ms)
             FILTER (WHERE ec.created_at > NOW() - INTERVAL '7 days')      AS median_processing_ms_7d
         FROM extension_capture ec
         LEFT JOIN listing l ON l.id = ec.listing_id
        GROUP BY host
        ORDER BY host`,
    ),

    // 3. Per-source stored-listing quality: how many listings, and how many
    //    photos on average (surfaces the under-extraction class per source).
    query(
      `SELECT source,
              COUNT(*)                                    AS listing_count,
              AVG(COALESCE(array_length(photo_urls, 1), 0)) AS avg_photo_count
         FROM listing
        GROUP BY source
        ORDER BY source`,
    ),

    // 4. Stale profiles + the running-sweep guard that gates them. Both SQL
    //    strings live at the top of this file as exported constants — issue
    //    #640's Estado queue tile counts the same population and must never
    //    re-derive it. When a sweep IS running we DON'T evaluate staleness
    //    (empty list + a UI annotation), same as the reconciler defers to the
    //    sweep's own end-of-sweep materialize-all.
    query(STALE_PROFILES_SQL),
    query(SWEEP_IN_PROGRESS_SQL),

    // 5. Zero-results regression monitor (issue #376): (connector, scope) pairs
    //    that used to return listings and now return 0 for N consecutive runs.
    //    Its own read + pure detector — see lib/db/zero-result-regression.ts.
    getZeroResultRegressions(),

    // 6. Extension block/challenge episodes (issue #634) — its own read, see
    //    lib/db/extension-blocks.ts.
    getRecentBlockEpisodes(),
  ]);

  const sweepInProgress = Boolean(sweepRes.rows[0]?.[0]);

  const connectors: ConnectorHealth[] = connectorRes.rows.map((row) => {
    const status = String(row[1]);
    const errorMsg = row[7] != null ? String(row[7]) : null;
    const healthy = connectorHealthLevel(status) === "healthy";
    return {
      connector_name: String(row[0]),
      last_status: status,
      last_run_at: toIsoOrNull(row[2]),
      discovered_count: num(row[3]),
      fetched_count: num(row[4]),
      error_count: num(row[5]),
      skipped_count: num(row[6]),
      prev_error_count: row[8] != null ? num(row[8]) : null,
      // Split error_msg: a healthy run's message is an informational notice
      // (clean budget/soft-block stop); an attention-level run's is the error.
      notice: healthy ? errorMsg : null,
      error_msg: healthy ? null : errorMsg,
      ms_per_listing: numOrNull(row[9]),
    };
  });

  // Multiple hosts can map to the same portal (e.g. www vs bare already
  // normalised, or a mobile subdomain) — fold them together so the page shows
  // one row per portal, not one per host.
  const portalMap = new Map<string, PortalCaptureHealth>();
  for (const row of portalRes.rows) {
    const portal = hostToPortal(String(row[0]));
    const pending = num(row[1]);
    const oldest = numOrNull(row[2]);
    const done = num(row[3]);
    const failed = num(row[4]);
    const listing = num(row[5]);
    const ratio = numOrNull(row[6]);
    const photos = numOrNull(row[7]);
    const renderWait = numOrNull(row[8]);
    const queueWait = numOrNull(row[9]);
    const processing = numOrNull(row[10]);
    const existing = portalMap.get(portal);
    if (!existing) {
      portalMap.set(portal, {
        portal,
        pending_count: pending,
        oldest_pending_age_seconds: oldest,
        done_7d: done,
        failed_7d: failed,
        listing_7d: listing,
        avg_fields_ratio_7d: ratio,
        avg_photo_count_7d: photos,
        median_render_wait_ms_7d: renderWait,
        median_queue_wait_ms_7d: queueWait,
        median_processing_ms_7d: processing,
      });
    } else {
      existing.pending_count += pending;
      existing.done_7d += done;
      existing.failed_7d += failed;
      existing.listing_7d += listing;
      // Oldest across hosts (nulls ignored) — the worst wait is the signal.
      existing.oldest_pending_age_seconds = maxDefined(
        existing.oldest_pending_age_seconds,
        oldest,
      );
      // Averages: without per-host sample sizes a weighted mean isn't
      // available, so surface the worse (min) ratio / photo count when two
      // hosts fold into one portal. Rare in practice.
      existing.avg_fields_ratio_7d = minDefined(existing.avg_fields_ratio_7d, ratio);
      existing.avg_photo_count_7d = minDefined(existing.avg_photo_count_7d, photos);
      // Timings fold the OTHER way from the quality ratios above: for quality
      // the worse value is the smaller one, for latency the worse value is the
      // LARGER one. A median of two medians isn't a median either way, but
      // "the worst host folded into this portal" is the honest summary and the
      // one that can't hide a problem. Rare in practice (one host per portal).
      existing.median_render_wait_ms_7d = maxDefined(
        existing.median_render_wait_ms_7d,
        renderWait,
      );
      existing.median_queue_wait_ms_7d = maxDefined(
        existing.median_queue_wait_ms_7d,
        queueWait,
      );
      existing.median_processing_ms_7d = maxDefined(
        existing.median_processing_ms_7d,
        processing,
      );
    }
  }
  const portals = [...portalMap.values()].sort((a, b) =>
    a.portal.localeCompare(b.portal),
  );

  const sources: SourceDataQuality[] = sourceRes.rows.map((row) => ({
    source: String(row[0]),
    listing_count: num(row[1]),
    avg_photo_count: numOrNull(row[2]),
  }));

  // While a sweep is running the staleness signal is not trustworthy — defer
  // to the sweep's own end-of-sweep materialize (the reconciler does the same)
  // and surface nothing rather than a flood of freshly-swept false positives.
  const stale_profiles: StaleProfile[] = sweepInProgress
    ? []
    : staleRes.rows.map((row) => ({
        id: num(row[0]),
        name: String(row[1]),
        last_materialized_at: toIsoOrNull(row[2]),
        newest_listing_at: toIsoOrNull(row[3]),
      }));

  return {
    connectors,
    portals,
    sources,
    stale_profiles,
    zero_result_regressions: zeroResultRegressions,
    sweep_in_progress: sweepInProgress,
    extension_blocks: extensionBlocks,
    generated_at: new Date().toISOString(),
  };
}

/** Smaller of two optionally-null numbers; null only when both are null. */
function minDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Larger of two optionally-null numbers; null only when both are null. */
function maxDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
