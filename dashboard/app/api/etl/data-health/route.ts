/**
 * Data-health / observability API (issue #272).
 *
 * GET /api/etl/data-health — one aggregated read of every capture/ETL health
 * signal for the "Salud de datos" page: per-connector last-run health,
 * per-portal capture health (pending/stuck, success rate, extraction
 * completeness, avg photos), per-source stored-listing quality, and stale
 * profiles. Read-only, display-only — no alerting, no writes.
 *
 * Mounted under /api/etl so middleware.ts admin-gates it exactly like the
 * worklist and connector-management routes (every /api/ path is gated by
 * default; see lib/api-auth-policy.ts). No new auth surface.
 *
 * Error codes:
 *   500 - Database error
 */

import { NextResponse } from "next/server";
import { getDataHealth } from "@/lib/db/data-health";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const data = await getDataHealth();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[${requestId}] Error al cargar la salud de datos:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la salud de datos. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
