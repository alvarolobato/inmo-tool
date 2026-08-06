/**
 * GET /api/etl/runs/[id]
 *
 * Returns a single connector orchestrator run with its per-connector results.
 *
 * Reads `connector_runs` + `connector_run_results` (issue #104). The old
 * per-table equivalents (`etl_sync_runs`/`etl_sync_run_tables`) are
 * orphaned — nothing has written to them since Phase 1.1.
 *
 * Response shape:
 *   { run: ConnectorRun, connectors: ConnectorRunResult[] }
 *
 * Error codes:
 *   400 - Invalid ID
 *   404 - Run not found
 *   500 - Database error
 */

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { toIsoOrNull } from "@/lib/format";
import type { ConnectorRun, ConnectorRunResult } from "../../types";

export type { ConnectorRun, ConnectorRunResult };

export interface EtlRunDetailResponse {
  run: ConnectorRun;
  connectors: ConnectorRunResult[];
}

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  if (n <= 0) return null;
  return n;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);

  if (id === null) {
    return NextResponse.json(
      formatApiError(
        "El identificador del run no es válido (debe ser un entero positivo).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const runResult = await query(
      `SELECT r.id, r.started_at, r.finished_at, r.duration_ms, r.status,
              r.total_connectors, r.connectors_ok, r.connectors_failed,
              r.connectors_skipped, r.trigger,
              agg.total_discovered, agg.total_fetched
       FROM connector_runs r
       LEFT JOIN LATERAL (
           SELECT SUM(res.discovered_count) AS total_discovered,
                  SUM(res.fetched_count)    AS total_fetched
           FROM connector_run_results res
           WHERE res.run_id = r.id
       ) agg ON TRUE
       WHERE r.id = $1`,
      [id],
    );

    if (runResult.rows.length === 0) {
      return NextResponse.json(
        formatApiError(
          "Ejecución de conectores no encontrada.",
          "NOT_FOUND",
          `No existe ninguna ejecución con ID ${id}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    // r.id (bigserial) and agg.total_discovered/total_fetched (implicit
    // SUM(integer) => bigint) arrive as real JS numbers via the
    // driver-level int8 type parser (db-shared.ts, #155). duration_ms/
    // total_connectors/connectors_ok/connectors_failed/connectors_skipped
    // are plain INTEGER — those Number() calls are unrelated and stay.
    const r = runResult.rows[0];
    const run: ConnectorRun = {
      id: r[0] as number,
      started_at: toIsoOrNull(r[1]) ?? "",
      finished_at: toIsoOrNull(r[2]),
      duration_ms: r[3] != null ? Number(r[3]) : null,
      status: String(r[4]),
      total_connectors: r[5] != null ? Number(r[5]) : null,
      connectors_ok: r[6] != null ? Number(r[6]) : null,
      connectors_failed: r[7] != null ? Number(r[7]) : null,
      connectors_skipped: r[8] != null ? Number(r[8]) : null,
      trigger: String(r[9]),
      total_discovered: r[10] != null ? (r[10] as number) : null,
      total_fetched: r[11] != null ? (r[11] as number) : null,
    };

    // duration_ms is derived here: connector_run_results stores start/finish
    // timestamps but no duration column (unlike etl_sync_run_tables did).
    const resultsResult = await query(
      `SELECT id, connector_name, started_at, finished_at, status,
              discovered_count, fetched_count, error_count, error_msg,
              failure_classification, geography_scope, extraction_quality_summary,
              CASE
                  WHEN started_at IS NULL OR finished_at IS NULL THEN NULL
                  ELSE ROUND(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::bigint
              END AS duration_ms
       FROM connector_run_results
       WHERE run_id = $1
       ORDER BY started_at ASC, connector_name ASC`,
      [id],
    );

    // id (bigserial) and duration_ms (explicit ::bigint cast above) arrive
    // as real JS numbers via the driver-level int8 type parser
    // (db-shared.ts, #155). discovered_count/fetched_count/error_count are
    // plain INTEGER — those Number() calls are unrelated and stay.
    // geography_scope (JSONB, #109) arrives already parsed as a JS array by the
    // pg driver; error_msg/failure_classification are TEXT.
    const connectors: ConnectorRunResult[] = resultsResult.rows.map((row) => ({
      id: row[0] as number,
      connector_name: String(row[1]),
      started_at: toIsoOrNull(row[2]) ?? "",
      finished_at: toIsoOrNull(row[3]),
      status: String(row[4]),
      discovered_count: row[5] != null ? Number(row[5]) : 0,
      fetched_count: row[6] != null ? Number(row[6]) : 0,
      error_count: row[7] != null ? Number(row[7]) : 0,
      error_msg: row[8] != null ? String(row[8]) : null,
      failure_classification: row[9] != null ? String(row[9]) : null,
      geography_scope: (row[10] as ConnectorRunResult["geography_scope"]) ?? null,
      // extraction_quality_summary (JSONB, #171) arrives already parsed as a JS
      // object by the pg driver, same as geography_scope above.
      extraction_quality_summary:
        (row[11] as ConnectorRunResult["extraction_quality_summary"]) ?? null,
      duration_ms: row[12] != null ? (row[12] as number) : null,
    }));

    const response: EtlRunDetailResponse = { run, connectors };
    return NextResponse.json(response);
  } catch (err) {
    console.error(`[${requestId}] Error loading connector run ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la ejecución de conectores. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
