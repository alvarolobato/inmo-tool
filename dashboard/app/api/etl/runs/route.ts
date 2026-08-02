/**
 * GET /api/etl/runs?page=1&per_page=20
 *
 * Returns a paginated list of connector orchestrator runs, newest first.
 *
 * Reads `connector_runs` — issue #104 repointed this off the source
 * project's `etl_sync_runs`, which nothing has written to since Phase 1.1
 * deleted the per-table sync modules. `total_discovered`/`total_fetched`
 * are aggregated from `connector_run_results` rather than read from a
 * column: unlike the old model, a run row stores no row-count total.
 *
 * Response shape:
 *   { runs: ConnectorRun[], total: number, page: number, per_page: number }
 *
 * Error codes:
 *   400 -- Invalid pagination parameters
 *   500 -- Database error
 */

import { NextRequest, NextResponse } from "next/server";
import { toIsoOrNull } from "@/lib/format";
import { query } from "@/lib/db";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

import type { ConnectorRun } from "../types";

export type { ConnectorRun };

export interface EtlRunsResponse {
  runs: ConnectorRun[];
  total: number;
  page: number;
  per_page: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  const { searchParams } = request.nextUrl;

  // Parse pagination params
  const rawPage = searchParams.get("page") ?? String(DEFAULT_PAGE);
  const rawPerPage = searchParams.get("per_page") ?? String(DEFAULT_PER_PAGE);

  // Strict integer validation: reject partial inputs like "1abc" or "5.5"
  if (!/^\d+$/.test(rawPage)) {
    return NextResponse.json(
      formatApiError(
        "El parámetro page debe ser un entero positivo.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  const page = parseInt(rawPage, 10);
  if (page < 1) {
    return NextResponse.json(
      formatApiError(
        "El parámetro page debe ser un entero positivo.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  if (!/^\d+$/.test(rawPerPage)) {
    return NextResponse.json(
      formatApiError(
        "El parámetro per_page debe ser un entero entre 1 y " + MAX_PER_PAGE + ".",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  const perPage = parseInt(rawPerPage, 10);
  if (perPage < 1 || perPage > MAX_PER_PAGE) {
    return NextResponse.json(
      formatApiError(
        "El parámetro per_page debe ser un entero entre 1 y " + MAX_PER_PAGE + ".",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const offset = (page - 1) * perPage;

  try {
    // Get total count
    const countResult = await query("SELECT COUNT(*) FROM connector_runs");
    const total = Number(countResult.rows[0][0]);

    // Get paginated rows. The LEFT JOIN LATERAL folds the funnel totals into
    // the same round-trip; LEFT (not INNER) so a run with no result rows yet
    // — one still 'running', or one where every connector was skipped before
    // recording anything — still appears in the list rather than vanishing.
    const runsResult = await query(
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
       ORDER BY r.started_at DESC
       LIMIT $1 OFFSET $2`,
      [perPage, offset],
    );

    const runs: ConnectorRun[] = runsResult.rows.map((row) => ({
      id: Number(row[0]),
      started_at: toIsoOrNull(row[1]) ?? "",
      finished_at: toIsoOrNull(row[2]),
      duration_ms: row[3] != null ? Number(row[3]) : null,
      status: String(row[4]),
      total_connectors: row[5] != null ? Number(row[5]) : null,
      connectors_ok: row[6] != null ? Number(row[6]) : null,
      connectors_failed: row[7] != null ? Number(row[7]) : null,
      connectors_skipped: row[8] != null ? Number(row[8]) : null,
      trigger: String(row[9]),
      total_discovered: row[10] != null ? Number(row[10]) : null,
      total_fetched: row[11] != null ? Number(row[11]) : null,
    }));

    const response: EtlRunsResponse = { runs, total, page, per_page: perPage };
    return NextResponse.json(response);
  } catch (err) {
    console.error(`[${requestId}] Error listing connector runs:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las ejecuciones de conectores. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
