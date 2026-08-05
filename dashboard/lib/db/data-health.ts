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
import {
  connectorHealthLevel,
  hostToPortal,
  type ConnectorHealth,
  type DataHealthResponse,
  type PortalCaptureHealth,
  type SourceDataQuality,
  type StaleProfile,
} from "@/lib/data-health";

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
  const [connectorRes, portalRes, sourceRes, staleRes] = await Promise.all([
    // 1. Latest run per connector + the prior run's error_count. LEAD over a
    //    DESC ordering returns the NEXT (older) row — i.e. the previous run.
    query(
      `SELECT connector_name, status, started_at,
              discovered_count, fetched_count, error_count, skipped_count,
              error_msg, prev_error_count
         FROM (
           SELECT c.connector_name, c.status, c.started_at,
                  c.discovered_count, c.fetched_count, c.error_count,
                  c.skipped_count, c.error_msg,
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
           AVG(ec.fields_extracted::numeric / NULLIF(ec.fields_available, 0))
             FILTER (WHERE ec.status = 'done' AND ec.fields_available > 0
               AND ec.created_at > NOW() - INTERVAL '7 days')              AS avg_fields_ratio_7d,
           AVG(COALESCE(array_length(l.photo_urls, 1), 0))
             FILTER (WHERE ec.status = 'done'
               AND ec.created_at > NOW() - INTERVAL '7 days')              AS avg_photo_count_7d
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

    // 4. Stale profiles: newest listing data (globally) is newer than the
    //    profile's last materialization. Archived profiles excluded. Returns
    //    ONLY the stale ones — an empty result is the healthy state.
    query(
      `WITH newest AS (SELECT MAX(last_seen_at) AS ts FROM listing)
       SELECT sp.id, sp.name, sp.last_materialized_at, newest.ts AS newest_listing_at
         FROM search_profile sp
         CROSS JOIN newest
        WHERE sp.archived_at IS NULL
          AND newest.ts IS NOT NULL
          AND (sp.last_materialized_at IS NULL OR sp.last_materialized_at < newest.ts)
        ORDER BY sp.last_materialized_at ASC NULLS FIRST, sp.id`,
    ),
  ]);

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
    const ratio = numOrNull(row[5]);
    const photos = numOrNull(row[6]);
    const existing = portalMap.get(portal);
    if (!existing) {
      portalMap.set(portal, {
        portal,
        pending_count: pending,
        oldest_pending_age_seconds: oldest,
        done_7d: done,
        failed_7d: failed,
        avg_fields_ratio_7d: ratio,
        avg_photo_count_7d: photos,
      });
    } else {
      existing.pending_count += pending;
      existing.done_7d += done;
      existing.failed_7d += failed;
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

  const stale_profiles: StaleProfile[] = staleRes.rows.map((row) => ({
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
