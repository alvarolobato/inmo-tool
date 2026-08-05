/**
 * POST /api/extension/filter-catalog — URL-building discovery ingest (issue
 * #336, D-063).
 *
 * The browser extension, running a "#inmo-discover" pass on a portal's search
 * page, enumerates the form's filter OPTIONS (property type, rooms, condition,
 * price buckets, zones — as the portal labels them) and the URL FRAGMENT each
 * produces, then POSTs the catalog here. We validate the shape, derive the
 * connector from the request HOST (never trust a client-claimed connector — the
 * same discipline as search-url-example), persist it to `portal_filter_catalog`
 * (latest-wins), and echo counts back. The connector's URL builder later reads
 * the latest catalog (lib/search-url/discovered-mapping.ts) and prefers the
 * discovered mapping over its hard-coded seed.
 *
 * Scope/robots: this ingests FORM METADATA (option labels + URL shapes), never
 * listing results — the same read-only, owner-authenticated boundary the
 * capture pipeline honours. Same admin-key gate as the other write routes.
 *
 * Response 200: { success, stored, connector?, source?, axes_count?, options_count?, reason? }
 */

import { NextRequest, NextResponse } from "next/server";
import { portalForUrl } from "@/lib/worklist";
import { validateCatalogPayload } from "@/lib/search-url/discovered-mapping";
import { saveFilterCatalog } from "@/lib/db/portal-filter-catalog";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

// Persists per request; never prerender.
export const dynamic = "force-dynamic";

interface Body {
  /** The search page the discovery pass ran on — the connector is derived from its host. */
  pageUrl?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let body: (Body & Record<string, unknown>) | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // Derive the connector from the page host — never trust `connector` in the
  // body (same host-suffix matching the capture pipeline / search-url-example
  // uses). A `pageUrl` is required so the catalog can't be mis-attributed.
  const pageUrl = body?.pageUrl;
  if (!pageUrl || typeof pageUrl !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'pageUrl'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  const connector = portalForUrl(pageUrl);
  if (!connector) {
    // Not a portal we know — nothing to catalog, but not an error (mirrors
    // search-url-example's unknown_portal handling).
    return NextResponse.json({ success: true, stored: false, reason: "unknown_connector" });
  }

  const validated = validateCatalogPayload(body);
  if (!validated.ok) {
    return NextResponse.json(
      formatApiError(
        `Catálogo de filtros inválido (${validated.reason}).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const { axesCount, optionsCount } = await saveFilterCatalog({
      connector,
      source: validated.source,
      axes: validated.axes,
      capturedAt: validated.capturedAt,
    });
    return NextResponse.json({
      success: true,
      stored: true,
      connector,
      source: validated.source,
      axes_count: axesCount,
      options_count: optionsCount,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar el catálogo de filtros:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar el catálogo de filtros. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
