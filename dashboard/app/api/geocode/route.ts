/**
 * GET /api/geocode?q=<query> — address/place search for the search profile
 * location picker (issue #95), proxying Nominatim (see lib/geocode.ts for
 * why this is server-side rather than a direct browser call).
 *
 * Error codes:
 *   400 — Missing/too-short query
 *   429 — Per-IP request bucket exceeded (see lib/geocode.ts's checkRateLimit)
 *   502 — Nominatim unreachable or returned an error
 */

import { NextRequest, NextResponse } from "next/server";
import { searchPlaces, GeocodeError, checkRateLimit } from "@/lib/geocode";
import { formatApiError, generateRequestId } from "@/lib/errors";

function clientIp(request: NextRequest): string {
  // No reliable request.ip in all Next.js/deployment configurations for a
  // single-process personal tool behind at most a simple reverse proxy —
  // this is a best-effort abuse guard, not a security boundary, so a
  // reasonable fallback key is fine when no forwarding header is present.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  if (!checkRateLimit(clientIp(request))) {
    return NextResponse.json(
      formatApiError(
        "Demasiadas búsquedas de ubicación en poco tiempo. Espera unos segundos.",
        "RATE_LIMITED",
        undefined,
        requestId,
      ),
      { status: 429 },
    );
  }

  const q = request.nextUrl.searchParams.get("q") ?? "";

  if (q.trim().length < 3) {
    return NextResponse.json(
      formatApiError(
        "Escribe al menos 3 caracteres para buscar una ubicación.",
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const results = await searchPlaces(q);
    return NextResponse.json({ items: results });
  } catch (err) {
    const message = err instanceof GeocodeError ? err.message : "No se pudo buscar la ubicación.";
    console.error(`[${requestId}] Error de geocodificación:`, err);
    return NextResponse.json(
      formatApiError(message, "GEOCODE_ERROR", undefined, requestId),
      { status: 502 },
    );
  }
}
