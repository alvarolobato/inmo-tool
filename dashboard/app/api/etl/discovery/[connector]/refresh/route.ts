/**
 * POST /api/etl/discovery/:connector/refresh — run the SERVER-SIDE static-asset
 * filter extractor for a connector and persist the result (issue #377, D-093).
 *
 * Aliseda's filter→URL mapping lives in static, robots-allowed assets (the
 * category sitemap + the Angular app bundle's slug map), which are GET-able
 * server-side even though Aliseda's SPA defeats a browser DOM scrape. This route
 * fetches + parses them into a `CatalogAxes`, writes a `portal_filter_catalog`
 * row (source `static-asset`), and returns the freshly computed drift.
 *
 * Since #511 the extract+save+diff logic lives in the shared `runDriftCheck`
 * helper (lib/search-url/drift-check.ts) so this route, the weekly scheduler, and
 * the "Comprobar ahora" button on Salud de datos all run the exact same check.
 * URL building stays 100% code-driven (D-090) — this only detects.
 *
 * Only `aliseda` has a static extractor today; other connectors → 400. Mounted
 * under /api/etl so it inherits the admin gating middleware.ts applies.
 *
 * Error codes:
 *   400 — connector has no static extractor
 *   401 — missing/invalid admin credentials (enforced by middleware)
 *   502 — the portal's static assets could not be fetched/parsed
 *   500 — unexpected error
 */

import { NextResponse } from "next/server";
import { runDriftCheck, STATIC_EXTRACTORS } from "@/lib/search-url/drift-check";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

// Fetches the live portal per request; never prerender.
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ connector: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { connector } = await params;

  if (!STATIC_EXTRACTORS[connector]) {
    return NextResponse.json(
      formatApiError(
        `El conector «${connector}» no tiene un extractor de activos estáticos.`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const result = await runDriftCheck(connector);
    return NextResponse.json({
      connector: result.connector,
      source: result.source,
      captured_at: result.capturedAt,
      bundle_url: result.bundleUrl,
      options_count: result.optionsCount,
      drift: result.drift,
    });
  } catch (err) {
    // A fetch/parse failure (WAF block, moved asset, bundle regex miss) — surface
    // it as an upstream error rather than a 500 so the operator knows to retry.
    console.error(`[${requestId}] Fallo al extraer activos estáticos de «${connector}»:`, err);
    return NextResponse.json(
      formatApiError(
        `No se pudieron leer los activos estáticos de «${connector}». Reintenta o revisa el portal.`,
        "UNKNOWN",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 502 },
    );
  }
}
