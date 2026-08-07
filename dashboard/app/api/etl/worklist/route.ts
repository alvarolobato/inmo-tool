/**
 * Capture worklist API (issue #237).
 *
 * GET  /api/etl/worklist[?portal=aliseda]  — rows + per-portal status roll-ups.
 * POST /api/etl/worklist  { urls: string[] | string, via?: 'manual'|'derived' }
 *      — add URLs. `via` defaults to 'manual' (the page's paste box);
 *      'derived' is what the browser extension sends when it harvested the URLs
 *      off a listing page for batch capture (issue #262). Returns
 *      {added, duplicate, invalid}.
 *
 * Mounted under /api/etl so middleware.ts's `/api/etl/:path*` matcher already
 * admin-gates it, same as the connector-management surface (issue #100). No
 * new auth surface — the worklist reuses the same admin gate as every other
 * write-capable route.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  addWorklistUrls,
  listWorklist,
  listPendingWorklist,
  type WorklistAddedVia,
} from "@/lib/db/worklist";
import { getPortalDuePriority } from "@/lib/db/worklist-priority";
import { selectNextPendingUrls } from "@/lib/worklist";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

const MAX_URLS_PER_REQUEST = 5000;
// Hard cap on the auto-driver's next-batch size, independent of the extension's
// own clamp (issue #424) — N is bounded on both sides.
const MAX_PENDING_LIMIT = 500;
const DEFAULT_PENDING_LIMIT = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
  const portal = request.nextUrl.searchParams.get("portal")?.trim() || undefined;

  // Auto-capture continuous driver (issue #424): the extension asks for the next
  // ≤N pending URLs, prioritised due-first then oldest, to drain in one batch.
  if (request.nextUrl.searchParams.get("pending") != null) {
    const rawLimit = Number(request.nextUrl.searchParams.get("limit"));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_PENDING_LIMIT)
        : DEFAULT_PENDING_LIMIT;
    try {
      const items = await listPendingWorklist(portal);
      // Best-effort due-ranking (never throws): a failure falls back to oldest-first.
      const duePriority = await getPortalDuePriority();
      const urls = selectNextPendingUrls(items, duePriority, limit);
      return NextResponse.json({ urls, totalPending: items.length });
    } catch (err) {
      console.error(`[${requestId}] Error al seleccionar pendientes de la worklist:`, err);
      return NextResponse.json(
        formatApiError(
          "No se pudieron seleccionar las URLs pendientes. Inténtalo de nuevo.",
          "DB_QUERY",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 500 },
      );
    }
  }

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
  via?: string;
}

const VALID_ADDED_VIA: readonly WorklistAddedVia[] = ["manual", "derived"];

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

  const via: WorklistAddedVia =
    typeof body.via === "string" && VALID_ADDED_VIA.includes(body.via as WorklistAddedVia)
      ? (body.via as WorklistAddedVia)
      : "manual";

  try {
    const result = await addWorklistUrls(urls, via);
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
