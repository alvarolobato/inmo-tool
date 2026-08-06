/**
 * POST /api/extension/search-url-example — Capture-to-infer: learn a portal's
 * real search-URL grammar from the owner's own navigated URL (issue #293).
 *
 * The browser extension fires this (fire-and-forget) when the owner clicks
 * "Capturar todas" on a search-results page — it already has that page's URL in
 * hand (browser-extension/background.js `startBatch`). We parse the URL into
 * `{filters, categoryKey, template}` and store it as an auto-trusted example
 * (owner decision, 2026-08-05: the owner navigated it, so it's correct — no
 * review step). The resolver later prefers these confirmed templates over the
 * hand-written builders (lib/search-url/resolve.ts).
 *
 * URL-only, no HTML: the URL grammar lives entirely in the URL string; mining
 * the listing's detail links (which needs the DOM) is a separate, already-built
 * path (#262, POST /api/extension/capture). Same admin-key gate as every other
 * write-capable extension route.
 *
 * Response 200: { success, stored, inserted?, categoryKey?, reason? }
 */

import { NextRequest, NextResponse } from "next/server";
import { portalForUrl } from "@/lib/worklist";
import { saveSearchUrlExample } from "@/lib/db/search-url-example";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

interface Body {
  url?: string;
  // Issue #376: the real harvested result count `enumerateResultsPages()`
  // computed for this search URL (was discarded). Optional — the batch-start
  // save omits it (no count yet); the end-of-enumeration save carries it.
  resultCount?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return NextResponse.json(
      formatApiError("Falta el campo 'url'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json(
      formatApiError("'url' no es una URL válida.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsedUrl.protocol)) {
    return NextResponse.json(
      formatApiError("'url' debe usar http o https.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // Derive the portal from the URL host (never trust a client-claimed portal):
  // this is the same host-suffix matching the capture pipeline uses.
  const portal = portalForUrl(url);
  if (!portal) {
    // Not a capture portal we know — nothing to learn, but not an error.
    return NextResponse.json({ success: true, stored: false, reason: "unknown_portal" });
  }

  const resultCount =
    typeof body.resultCount === "number" && Number.isFinite(body.resultCount)
      ? body.resultCount
      : null;

  try {
    const result = await saveSearchUrlExample(portal, url, resultCount);
    if (!result.stored) {
      return NextResponse.json({ success: true, stored: false, reason: result.reason });
    }
    return NextResponse.json({
      success: true,
      stored: true,
      inserted: result.inserted,
      categoryKey: result.categoryKey,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar el ejemplo de URL de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar el ejemplo de búsqueda. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
