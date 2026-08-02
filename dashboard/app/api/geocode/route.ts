/**
 * GET /api/geocode?q=<query> — address/place search for the search profile
 * location picker (issue #95), proxying Nominatim (see lib/geocode.ts for
 * why this is server-side rather than a direct browser call).
 *
 * Error codes:
 *   400 — Missing/too-short query
 *   502 — Nominatim unreachable or returned an error
 */

import { NextRequest, NextResponse } from "next/server";
import { searchPlaces, GeocodeError } from "@/lib/geocode";
import { formatApiError, generateRequestId } from "@/lib/errors";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();
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
