/**
 * GET /api/etl/runs/[id]
 *
 * Returns a single ETL sync run with all per-table stats.
 *
 * Response shape:
 *   { run: EtlSyncRun, tables: EtlSyncRunTable[] }
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
import type { EtlSyncRun } from "../../types";

export interface EtlSyncRunTable {
  id: number;
  table_name: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: string;
  rows_synced: number | null;
  rows_total_after: number | null;
  sync_method: string | null;
  watermark_from: string | null;
  watermark_to: string | null;
  error_msg: string | null;
}

export interface EtlRunDetailResponse {
  run: EtlSyncRun;
  tables: EtlSyncRunTable[];
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
      `SELECT id, started_at, finished_at, duration_ms, status,
              total_tables, tables_ok, tables_failed, total_rows_synced, trigger,
              kind
       FROM etl_sync_runs
       WHERE id = $1`,
      [id],
    );

    if (runResult.rows.length === 0) {
      return NextResponse.json(
        formatApiError(
          "Run de ETL no encontrado.",
          "NOT_FOUND",
          `No existe ningún run con ID ${id}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    const r = runResult.rows[0];
    const run: EtlSyncRun = {
      id: Number(r[0]),
      started_at: toIsoOrNull(r[1]) ?? "",
      finished_at: toIsoOrNull(r[2]),
      duration_ms: r[3] != null ? Number(r[3]) : null,
      status: String(r[4]),
      total_tables: r[5] != null ? Number(r[5]) : null,
      tables_ok: r[6] != null ? Number(r[6]) : null,
      tables_failed: r[7] != null ? Number(r[7]) : null,
      total_rows_synced: r[8] != null ? Number(r[8]) : null,
      trigger: String(r[9]),
      kind: r[10] === "delta" ? "delta" : "full",
    };

    const tablesResult = await query(
      `SELECT id, table_name, started_at, finished_at, duration_ms, status,
              rows_synced, rows_total_after, sync_method,
              watermark_from, watermark_to, error_msg
       FROM etl_sync_run_tables
       WHERE run_id = $1
       ORDER BY started_at ASC`,
      [id],
    );

    const tables: EtlSyncRunTable[] = tablesResult.rows.map((row) => ({
      id: Number(row[0]),
      table_name: String(row[1]),
      started_at: toIsoOrNull(row[2]) ?? "",
      finished_at: toIsoOrNull(row[3]),
      duration_ms: row[4] != null ? Number(row[4]) : null,
      status: String(row[5]),
      rows_synced: row[6] != null ? Number(row[6]) : null,
      rows_total_after: row[7] != null ? Number(row[7]) : null,
      sync_method: row[8] != null ? String(row[8]) : null,
      watermark_from: toIsoOrNull(row[9]),
      watermark_to: toIsoOrNull(row[10]),
      error_msg: row[11] != null ? String(row[11]) : null,
    }));

    const response: EtlRunDetailResponse = { run, tables };
    return NextResponse.json(response);
  } catch (err) {
    console.error(`[${requestId}] Error loading ETL run ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el run de ETL. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
