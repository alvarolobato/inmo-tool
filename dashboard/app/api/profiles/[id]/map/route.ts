/**
 * GET /api/profiles/[id]/map — Materialized candidate set for a profile's
 * map view (task 2.7, #43), one item per deduplicated `property_id` with
 * `profile_listing_state.matched = true` (task 2.4, #18) and usable
 * coordinates. Unlike /api/profiles/[id]/candidates, not paginated — a map
 * wants all plottable pins at once (capped, see lib/map-candidates.ts).
 *
 * Error codes:
 *   400 — Invalid id
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { listMapCandidates } from "@/lib/map-candidates";
import { getProfileById } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parsePositiveInt(rawId);
  // Escape hatch mirroring the feed's "Mostrar descartadas" toggle (#417): by
  // default the map hides rejected pins; ?includeRejected=true keeps them.
  const includeRejected = request.nextUrl.searchParams.get("includeRejected") === "true";
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const profile = await getProfileById(id);
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError(
          "Perfil de búsqueda no encontrado o archivado.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const result = await listMapCandidates(id, includeRejected);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el mapa de candidatos:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el mapa de candidatos del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
