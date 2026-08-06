/**
 * GET /api/etl/discovery/:connector — the latest URL-building discovery catalog
 * for a connector, for the /etl/discovery admin page (issue #336, D-063).
 *
 * Mounted under /api/etl so it inherits the admin gating middleware.ts already
 * applies to `/api/etl/:path*` (same rationale as /api/etl/connectors). Returns
 * the newest `portal_filter_catalog` row plus a small per-axis summary so the
 * page can show counts + captured_at without shipping the full JSONB twice.
 *
 * Error codes:
 *   401 — Missing/invalid admin credentials (enforced by middleware)
 *   404 — No catalog discovered yet for this connector
 *   500 — Unexpected error
 */

import { NextResponse } from "next/server";
import { findLatestCatalog, countCatalogOptions } from "@/lib/db/portal-filter-catalog";
import { codeMappingForPortal } from "@/lib/search-url";
import { computePortalDrift } from "@/lib/search-url/drift";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ connector: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { connector } = await params;

  try {
    const row = await findLatestCatalog(connector);
    if (!row) {
      return NextResponse.json(
        formatApiError(
          `No hay catálogo descubierto todavía para «${connector}».`,
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const axisSummary = Object.fromEntries(
      Object.entries(row.axes).map(([axis, opts]) => [axis, opts?.length ?? 0]),
    );

    // Deterministic drift (issue #371, D-089): diff the captured catalog against
    // the connector's hard-coded code mapping so the page can FLAG where the code
    // needs updating. Pure/no-LLM; null when the connector has no builder to diff.
    const codeMapping = codeMappingForPortal(connector);
    const drift = codeMapping
      ? computePortalDrift(connector, row.axes, codeMapping)
      : null;

    return NextResponse.json({
      connector: row.connector,
      source: row.source,
      captured_at: row.captured_at,
      axes: row.axes,
      axis_summary: axisSummary,
      options_count: countCatalogOptions(row.axes),
      drift,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el catálogo de «${connector}»:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el catálogo de filtros. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
