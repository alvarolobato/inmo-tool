/**
 * /api/observed-search-urls — Passively-observed Idealista search URLs
 * (issue #488, part of #471).
 *
 * POST: the browser extension's passive observer forwards a search/results URL
 *   the owner is browsing (verbatim, `shape=` and all). We validate it is an
 *   OBSERVABLE idealista.com http(s) URL (rejecting anything else, 400), derive
 *   the portal + de-dup key server-side from the URL (never client-claimed), and
 *   UPSERT it — a repeat sighting bumps its seen count rather than duplicating.
 *
 * GET: the admin review surface lists the observed URLs (newest sighting first)
 *   so their filtering/drawn-zone grammar can be analysed for #471.
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
import {
  isObservableIdealistaUrl,
  normalizeObservedUrl,
} from "@/lib/observed-search-url";
import {
  saveObservedSearchUrl,
  listObservedSearchUrls,
} from "@/lib/db/observed-search-url";

// A page title is short; cap it so a malformed/huge value can't bloat a row.
const MAX_TITLE_LEN = 500;

interface Body {
  url?: string;
  title?: unknown;
  observedAt?: unknown; // accepted for parity with the extension payload; unused (server timestamps).
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

  // The URL must be an OBSERVABLE idealista.com search/results page. This single
  // check covers scheme, host and page-role — the same predicate the extension
  // used before forwarding (we never trust the client's word for it).
  if (!isObservableIdealistaUrl(url)) {
    return NextResponse.json(
      formatApiError(
        "'url' debe ser una página de búsqueda/resultados de idealista.com.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const normKey = normalizeObservedUrl(url);
  if (!normKey) {
    return NextResponse.json(
      formatApiError("No se pudo normalizar la 'url'.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_LEN) || null : null;

  try {
    const saved = await saveObservedSearchUrl("idealista", url, normKey, title);
    return NextResponse.json({
      success: true,
      id: saved.id,
      portal: "idealista",
      seen_count: saved.seen_count,
      last_seen: saved.last_seen,
    });
  } catch (err) {
    console.error(`[${requestId}] Error al guardar la URL de búsqueda observada:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo guardar la URL observada. Inténtalo de nuevo.",
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
    const rows = await listObservedSearchUrls(Number.isFinite(limit) ? limit : 200);
    return NextResponse.json({ success: true, rows });
  } catch (err) {
    console.error(`[${requestId}] Error al listar las URLs de búsqueda observadas:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar las URLs observadas.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
