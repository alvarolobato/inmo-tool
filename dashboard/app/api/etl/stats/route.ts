/**
 * GET /api/etl/stats
 *
 * Fleet-wide crawl rollups for the Estado board's "Rastreo" band.
 * Uses the last 30 runs (except the error counts, scoped to a fixed 24h
 * window).
 *
 * Issue #104 repointed this off the source project's orphaned
 * `etl_sync_runs`/`etl_sync_run_tables` onto `connector_runs`/
 * `connector_run_results`. Two shape changes worth calling out:
 *
 *   - "rows synced" became the ingestion funnel. The old model had a
 *     single `total_rows_synced` per run; this one distinguishes
 *     *discovered* (listings a connector found) from *fetched* (listings
 *     it actually parsed and stored). The gap between them is the useful
 *     signal — it widens when a site changes markup or starts
 *     soft-blocking, well before a run outright fails.
 *   - The watermark-age KPI is gone. It read `etl_watermarks`, which the
 *     per-table delta sync populated; the connector orchestrator has no
 *     watermark concept and nothing writes that table anymore, so the KPI
 *     could only ever render "—". Replaced by connector error counts,
 *     which are real here.
 *
 * Issue #642 P2 shrank this from six aggregates to three. `duration_trend`,
 * `connector_durations` and `top_connectors_by_listings` existed only to feed
 * `EvolutionCharts`, which died with `/etl`; the sole consumer left is the
 * Estado board's `<CrawlRollup/>`, which renders `success_rate`, `last_run`
 * and `errors_24h`. The two duration aggregates are not parked here waiting
 * for #647 (Velocidad): that issue needs PER-SOURCE throughput and a
 * `freshness_cycle_history` ledger this endpoint does not have, so it builds
 * its own reads. Keeping three unread aggregates alive "just in case" is
 * exactly the inherited dead weight this tracker is deleting.
 *
 * Error codes:
 *   500 - Database error
 */

import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

export interface SuccessRate {
  total: number;
  success: number;
  partial: number;
  failed: number;
}

export interface LastRunSummary {
  run_id: number | null;
  duration_ms: number | null;
  total_discovered: number | null;
  total_fetched: number | null;
  /** fetched / discovered, 0–1. NULL when nothing was discovered. */
  fetch_rate: number | null;
}

export interface Errors24h {
  runs_failed: number;
  connectors_failed: number;
}

export interface EtlStatsResponse {
  success_rate: SuccessRate;
  last_run: LastRunSummary;
  errors_24h: Errors24h;
}

const LAST_N_RUNS = 30;

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();

  try {
    // All queries are independent reads -- run in parallel.
    const [rateResult, lastRunResult, errorsResult] = await Promise.all([
      query(
        `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'success') AS success,
             COUNT(*) FILTER (WHERE status = 'partial') AS partial,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM (
              SELECT status FROM connector_runs
              ORDER BY started_at DESC
              LIMIT $1
            ) sub`,
        [LAST_N_RUNS],
      ),

      // "Last run" KPI row. fetch_rate is computed server-side to keep the
      // divide-by-zero case out of the browser.
      query(
        `SELECT
             r.id,
             r.duration_ms,
             agg.total_discovered,
             agg.total_fetched,
             CASE
                 WHEN COALESCE(agg.total_discovered, 0) = 0 THEN NULL
                 ELSE (agg.total_fetched::numeric / agg.total_discovered)::numeric(6, 4)
             END AS fetch_rate
         FROM connector_runs r
         LEFT JOIN LATERAL (
             SELECT SUM(res.discovered_count) AS total_discovered,
                    SUM(res.fetched_count)    AS total_fetched
             FROM connector_run_results res
             WHERE res.run_id = r.id
         ) agg ON TRUE
         WHERE r.status IN ('success', 'partial')
         ORDER BY r.started_at DESC
         LIMIT 1`,
      ),

      // Rolling 24h error counts. A connector result counts as failed for
      // both 'failed' and 'circuit_open' — a tripped breaker is a real
      // ingestion problem, not a neutral outcome. 'skipped' is deliberately
      // excluded: an operator disabling a connector is not an error.
      query(
        `SELECT
             (SELECT COUNT(*) FROM connector_runs
              WHERE status = 'failed'
                AND started_at > NOW() - INTERVAL '24 hours') AS runs_failed,
             (SELECT COUNT(*) FROM connector_run_results c
              JOIN connector_runs r ON r.id = c.run_id
              WHERE c.status IN ('failed', 'circuit_open')
                AND r.started_at > NOW() - INTERVAL '24 hours') AS connectors_failed`,
      ),
    ]);

    // total/success/partial/failed are all COUNT(*) — bigint — real JS
    // numbers via the driver-level int8 type parser (db-shared.ts, #155).
    const rr = rateResult.rows[0] ?? [0, 0, 0, 0];
    const successRate: SuccessRate = {
      total: rr[0] as number,
      success: rr[1] as number,
      partial: rr[2] as number,
      failed: rr[3] as number,
    };

    // run_id (bigserial) and total_discovered/total_fetched (implicit
    // SUM(integer) => bigint) arrive as real JS numbers via the parser too.
    // duration_ms is INTEGER and fetch_rate is an explicit ::numeric(6,4)
    // cast — those Number() calls are unrelated to #155 and stay.
    const lastRunRow = lastRunResult.rows[0];
    const lastRun: LastRunSummary = lastRunRow
      ? {
          run_id: lastRunRow[0] != null ? (lastRunRow[0] as number) : null,
          duration_ms: lastRunRow[1] != null ? Number(lastRunRow[1]) : null,
          total_discovered:
            lastRunRow[2] != null ? (lastRunRow[2] as number) : null,
          total_fetched: lastRunRow[3] != null ? (lastRunRow[3] as number) : null,
          fetch_rate: lastRunRow[4] != null ? Number(lastRunRow[4]) : null,
        }
      : {
          run_id: null,
          duration_ms: null,
          total_discovered: null,
          total_fetched: null,
          fetch_rate: null,
        };

    // runs_failed/connectors_failed are COUNT(*) — bigint — real JS numbers
    // via the driver-level parser.
    const errRow = errorsResult.rows[0] ?? [0, 0];
    const errors24h: Errors24h = {
      runs_failed: (errRow[0] as number) ?? 0,
      connectors_failed: (errRow[1] as number) ?? 0,
    };

    const response: EtlStatsResponse = {
      success_rate: successRate,
      last_run: lastRun,
      errors_24h: errors24h,
    };
    return NextResponse.json(response);
  } catch (err) {
    console.error(`[${requestId}] Error loading connector stats:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las estadísticas de conectores. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
