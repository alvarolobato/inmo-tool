/**
 * GET /api/etl/stats
 *
 * Returns aggregated time-series data for ETL monitoring charts.
 * Uses the last 30 runs (except for KPIs scoped to a fixed 24h window).
 *
 * Response shape:
 *   {
 *     duration_trend: [{ started_at, duration_ms, status }],
 *     rows_trend: [{ started_at, total_rows_synced }],
 *     table_durations: [{ table_name, avg_duration_ms, last_duration_ms }],
 *     top_tables_by_rows: [{ table_name, rows_synced }],
 *     success_rate: { total, success, partial, failed },
 *     last_run: {
 *       run_id: number | null,
 *       duration_ms: number | null,
 *       total_rows_synced: number | null,
 *       throughput_rows_per_sec: number | null
 *     },
 *     watermarks: { max_age_seconds: number | null, table_name: string | null },
 *     errors_24h: { runs_failed: number, tables_failed: number }
 *   }
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
import { toIsoOrNull } from "@/lib/format";

export interface DurationTrendPoint {
  started_at: string;
  duration_ms: number | null;
  status: string;
}

export interface RowsTrendPoint {
  started_at: string;
  total_rows_synced: number | null;
}

export interface TableDuration {
  table_name: string;
  avg_duration_ms: number;
  last_duration_ms: number | null;
}

export interface TableRows {
  table_name: string;
  rows_synced: number;
}

export interface SuccessRate {
  total: number;
  success: number;
  partial: number;
  failed: number;
}

export interface LastRunSummary {
  run_id: number | null;
  duration_ms: number | null;
  total_rows_synced: number | null;
  throughput_rows_per_sec: number | null;
}

export interface WatermarkInfo {
  max_age_seconds: number | null;
  table_name: string | null;
}

export interface Errors24h {
  runs_failed: number;
  tables_failed: number;
}

export interface EtlStatsResponse {
  duration_trend: DurationTrendPoint[];
  rows_trend: RowsTrendPoint[];
  table_durations: TableDuration[];
  top_tables_by_rows: TableRows[];
  success_rate: SuccessRate;
  last_run: LastRunSummary;
  watermarks: WatermarkInfo;
  errors_24h: Errors24h;
}

const LAST_N_RUNS = 30;
const TOP_TABLES_BY_ROWS = 10;

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();

  try {
    // All queries are independent reads -- run in parallel.
    const [
      trendResult,
      tableDurResult,
      rateResult,
      topRowsResult,
      lastRunResult,
      watermarkResult,
      errorsResult,
    ] = await Promise.all([
      query(
        `SELECT started_at, duration_ms, status, total_rows_synced
         FROM etl_sync_runs
         ORDER BY started_at DESC
         LIMIT $1`,
        [LAST_N_RUNS],
      ),

      // Per-table avg and last duration scoped to last N runs.
      query(
        `SELECT
             t.table_name,
             COALESCE(ROUND(AVG(t.duration_ms))::int, 0) AS avg_duration_ms,
             (SELECT t2.duration_ms
              FROM etl_sync_run_tables t2
              JOIN etl_sync_runs r2 ON r2.id = t2.run_id
              WHERE t2.table_name = t.table_name
              ORDER BY r2.started_at DESC
              LIMIT 1) AS last_duration_ms
        FROM etl_sync_run_tables t
        JOIN etl_sync_runs r ON r.id = t.run_id
        WHERE r.id IN (
              SELECT id FROM etl_sync_runs
              ORDER BY started_at DESC
              LIMIT $1
            )
        GROUP BY t.table_name
        ORDER BY avg_duration_ms DESC`,
        [LAST_N_RUNS],
      ),

      query(
        `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'success') AS success,
             COUNT(*) FILTER (WHERE status = 'partial') AS partial,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM (
              SELECT status FROM etl_sync_runs
              ORDER BY started_at DESC
              LIMIT $1
            ) sub`,
        [LAST_N_RUNS],
      ),

      // Top N tables by rows synced in the most recent finished (success/partial) run.
      // Returns empty if the latest finished run has no etl_sync_run_tables rows.
      query(
        `SELECT t.table_name, t.rows_synced
         FROM etl_sync_run_tables t
         WHERE t.run_id = (
             SELECT r.id FROM etl_sync_runs r
             WHERE r.status IN ('success', 'partial')
             ORDER BY r.started_at DESC
             LIMIT 1
         )
         ORDER BY t.rows_synced DESC
         LIMIT $1`,
        [TOP_TABLES_BY_ROWS],
      ),

      // Summary for the "last run" KPI row. Throughput is computed server-side
      // to avoid the browser having to handle the divide-by-zero case.
      query(
        `SELECT
             id,
             duration_ms,
             total_rows_synced,
             CASE
                 WHEN duration_ms IS NULL OR duration_ms <= 0 THEN NULL
                 ELSE (total_rows_synced::numeric / (duration_ms / 1000.0))::numeric(12, 2)
             END AS throughput_rows_per_sec
         FROM etl_sync_runs
         WHERE status IN ('success', 'partial')
         ORDER BY started_at DESC
         LIMIT 1`,
      ),

      // Oldest watermark age (seconds). Only considers watermarks known to be
      // watermark-backed (status='ok' or 'error'), mirroring how set_watermark
      // writes rows from the ETL. A fresh DB returns NULL.
      query(
        `SELECT table_name,
                EXTRACT(EPOCH FROM (NOW() - last_sync_at))::bigint AS age_seconds
         FROM etl_watermarks
         WHERE status IN ('ok', 'error')
         ORDER BY last_sync_at ASC
         LIMIT 1`,
      ),

      // Error counts in the rolling 24h window — one query returns both
      // aggregates so the route stays on a single round-trip.
      query(
        `SELECT
             (SELECT COUNT(*) FROM etl_sync_runs
              WHERE status = 'failed'
                AND started_at > NOW() - INTERVAL '24 hours') AS runs_failed,
             (SELECT COUNT(*) FROM etl_sync_run_tables t
              JOIN etl_sync_runs r ON r.id = t.run_id
              WHERE t.status = 'failed'
                AND r.started_at > NOW() - INTERVAL '24 hours') AS tables_failed`,
      ),
    ]);

    const reversedRows = [...trendResult.rows].reverse();

    const durationTrend: DurationTrendPoint[] = reversedRows.map((row) => ({
      started_at: toIsoOrNull(row[0]) ?? "",
      duration_ms: row[1] != null ? Number(row[1]) : null,
      status: String(row[2]),
    }));

    const rowsTrend: RowsTrendPoint[] = reversedRows.map((row) => ({
      started_at: toIsoOrNull(row[0]) ?? "",
      total_rows_synced: row[3] != null ? Number(row[3]) : null,
    }));

    const tableDurations: TableDuration[] = tableDurResult.rows.map((row) => ({
      table_name: String(row[0]),
      avg_duration_ms: Number(row[1]),
      last_duration_ms: row[2] != null ? Number(row[2]) : null,
    }));

    const topTablesByRows: TableRows[] = topRowsResult.rows.map((row) => ({
      table_name: String(row[0]),
      rows_synced: Number(row[1] ?? 0),
    }));

    const rr = rateResult.rows[0] ?? [0, 0, 0, 0];
    const successRate: SuccessRate = {
      total: Number(rr[0]),
      success: Number(rr[1]),
      partial: Number(rr[2]),
      failed: Number(rr[3]),
    };

    const lastRunRow = lastRunResult.rows[0];
    const lastRun: LastRunSummary = lastRunRow
      ? {
          run_id: lastRunRow[0] != null ? Number(lastRunRow[0]) : null,
          duration_ms: lastRunRow[1] != null ? Number(lastRunRow[1]) : null,
          total_rows_synced:
            lastRunRow[2] != null ? Number(lastRunRow[2]) : null,
          throughput_rows_per_sec:
            lastRunRow[3] != null ? Number(lastRunRow[3]) : null,
        }
      : {
          run_id: null,
          duration_ms: null,
          total_rows_synced: null,
          throughput_rows_per_sec: null,
        };

    const wmRow = watermarkResult.rows[0];
    const watermarks: WatermarkInfo = wmRow
      ? {
          table_name: wmRow[0] != null ? String(wmRow[0]) : null,
          max_age_seconds: wmRow[1] != null ? Number(wmRow[1]) : null,
        }
      : { table_name: null, max_age_seconds: null };

    const errRow = errorsResult.rows[0] ?? [0, 0];
    const errors24h: Errors24h = {
      runs_failed: Number(errRow[0] ?? 0),
      tables_failed: Number(errRow[1] ?? 0),
    };

    const response: EtlStatsResponse = {
      duration_trend: durationTrend,
      rows_trend: rowsTrend,
      table_durations: tableDurations,
      top_tables_by_rows: topTablesByRows,
      success_rate: successRate,
      last_run: lastRun,
      watermarks,
      errors_24h: errors24h,
    };
    return NextResponse.json(response);
  } catch (err) {
    console.error(`[${requestId}] Error loading ETL stats:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las estadísticas de ETL. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
