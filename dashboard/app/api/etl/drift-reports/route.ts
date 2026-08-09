/**
 * GET /api/etl/drift-reports — the latest portal filter-drift status per
 * configured portal, for the "Deriva de portales" section on Salud de datos
 * (issue #511).
 *
 * Read-only: returns the newest captured catalog per portal diffed against the
 * code mapping (see lib/search-url/drift-check.ts). The weekly scheduler keeps
 * these fresh; the section also offers a manual "Comprobar ahora" that POSTs the
 * existing /api/etl/discovery/:connector/refresh route.
 *
 * Mounted under /api/etl so middleware.ts admin-gates it like the rest of the
 * ETL tooling. Never errors for the empty case — a portal with no catalog yet
 * reports `hasCatalog:false`.
 *
 * Error codes:
 *   500 — Database error
 */

import { NextResponse } from "next/server";
import { getLatestPortalDrifts } from "@/lib/search-url/drift-check";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const reports = await getLatestPortalDrifts();
    return NextResponse.json({ reports }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar la deriva de portales:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la deriva de portales. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
