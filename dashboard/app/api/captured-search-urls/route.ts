/**
 * /api/captured-search-urls — Capture + review raw search URLs from any capture
 * portal (issue #475, part of #471; generalized to all capture portals in #510).
 *
 * POST: the browser extension's "Capturar URL de búsqueda" action sends the raw
 *   results-page URL the owner is on (verbatim, including any `shape=` param that
 *   Idealista's "Dibuja tu zona" encodes the drawn polygon into) + the page
 *   title. We validate it is an http(s) URL on a supported capture portal
 *   (idealista / aliseda / altamira — rejecting anything else, 400), derive the
 *   portal server-side from the host (never client-claimed), and persist it. For
 *   idealista this unblocks #471 P1 (its polygon grammar); for aliseda/altamira
 *   it accrues the corpus each portal's URL grammar is built from (#510 → #514).
 *
 * GET: the admin review surface lists the captured URLs (newest first) so they
 *   can be copied/decoded.
 *
 * Same admin-key gate as every other write-capable route (the extension sends
 * `x-admin-key`; the admin UI relies on the `ps_admin` cookie via middleware).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { adminApiKeyValid, adminUnauthorized } from "@/lib/admin-api-auth";
import { portalForUrl } from "@/lib/worklist";
import {
  saveCapturedSearchUrl,
  listCapturedSearchUrls,
} from "@/lib/db/captured-search-url";

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
// A page title is short; cap it so a malformed/huge value can't bloat a row.
const MAX_TITLE_LEN = 500;

interface Body {
  url?: string;
  title?: unknown;
  capturedAt?: unknown; // accepted for parity with the extension payload; unused (server timestamps).
  notes?: unknown;
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
  // Derive the portal from the host (never client-claimed); reject any host that
  // isn't a supported capture portal (idealista / aliseda / altamira).
  const portal = portalForUrl(url);
  if (!portal) {
    return NextResponse.json(
      formatApiError(
        "'url' debe ser de un portal soportado (idealista, aliseda o altamira).",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_LEN) : null;
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_TITLE_LEN) : null;

  try {
    const saved = await saveCapturedSearchUrl(portal, url, title, notes);
    return NextResponse.json({
      success: true,
      id: saved.id,
      portal,
      captured_at: saved.captured_at,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar la URL de búsqueda capturada:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar la URL capturada. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  if (!adminApiKeyValid(request)) {
    return adminUnauthorized();
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 200;

  try {
    const rows = await listCapturedSearchUrls(Number.isFinite(limit) ? limit : 200);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    console.error(`[${requestId}] Error al listar las URLs de búsqueda capturadas:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las URLs capturadas.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
