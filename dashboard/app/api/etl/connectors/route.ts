/**
 * GET /api/etl/connectors — every registered connector with its effective
 * configuration, the scope it will actually use on the next run, and its
 * last run outcome (issue #100).
 *
 * Mounted under /api/etl deliberately: middleware.ts's matcher already
 * covers `/api/etl/:path*`, so this operator surface inherits the same
 * admin gating as the rest of the ETL tooling with no middleware change —
 * the least-coupled place to put it, and connector management is ingestion
 * tooling anyway.
 *
 * Error codes:
 *   401 — Missing/invalid admin credentials (enforced by middleware)
 *   500 — Unexpected error
 */

import { NextResponse } from "next/server";
import { listConnectors } from "@/lib/db/connectors";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const connectors = await listConnectors();
    return NextResponse.json({ connectors });
  } catch (err) {
    console.error(`[${requestId}] Error al listar conectores:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar los conectores. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
