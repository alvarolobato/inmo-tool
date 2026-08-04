/**
 * Capture worklist API (issue #237).
 *
 * GET  /api/etl/worklist[?portal=aliseda]  — rows + per-portal status roll-ups.
 * POST /api/etl/worklist  { urls: string[] | string }  — add manually-pasted
 *      URLs (added_via='manual'); returns {added, duplicate, invalid}.
 *
 * Mounted under /api/etl so middleware.ts's `/api/etl/:path*` matcher already
 * admin-gates it, same as the connector-management surface (issue #100). No
 * new auth surface — the worklist reuses the same admin gate as every other
 * write-capable route.
 */

import { NextRequest, NextResponse } from "next/server";
import { addWorklistUrls, listWorklist } from "@/lib/db/worklist";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

const MAX_URLS_PER_REQUEST = 5000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const portal = request.nextUrl.searchParams.get("portal")?.trim() || undefined;
  try {
    const { rows, summaries } = await listWorklist(portal);
    return NextResponse.json({ rows, summaries });
  } catch (err) {
    console.error(`[${requestId}] Error al cargar la worklist de captura:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la lista de captura. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

interface AddBody {
  urls?: string[] | string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  let body: AddBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // Accept either an array or a newline/whitespace-separated blob (the page's
  // textarea posts the raw text), so the operator can paste one-URL-per-line.
  let urls: string[];
  if (Array.isArray(body.urls)) {
    urls = body.urls.filter((u): u is string => typeof u === "string");
  } else if (typeof body.urls === "string") {
    urls = body.urls.split(/\s+/);
  } else {
    return NextResponse.json(
      formatApiError("Falta el campo 'urls' (array o texto).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  urls = urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return NextResponse.json(
      formatApiError("No se ha proporcionado ninguna URL.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return NextResponse.json(
      formatApiError(
        `Demasiadas URLs en una sola petición (máx. ${MAX_URLS_PER_REQUEST}).`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const result = await addWorklistUrls(urls);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error(`[${requestId}] Error al añadir URLs a la worklist:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron añadir las URLs. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
