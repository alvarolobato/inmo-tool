/**
 * GET /api/profiles/[id]/candidate-sources — the distinct source portals
 * present among a profile's candidates (#265), i.e. the options the list
 * page's source filter offers.
 *
 * Deliberately separate from the paginated candidate feed: the available
 * sources are a property of the WHOLE matched set, not of any one page, so
 * folding them into `/candidates` would either recompute them on every
 * "Cargar más" or force the client to trust only the first page's copy. A
 * tiny dedicated read keeps the dropdown stable while the feed pages.
 *
 * Response: { sources: string[] } — alphabetical, possibly empty.
 *
 * Error codes:
 *   400 — Invalid id
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { listCandidateSources } from "@/lib/candidates";
import { getProfileById } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parsePositiveInt(rawId);
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

    const sources = await listCandidateSources(id);
    return NextResponse.json({ sources });
  } catch (err) {
    console.error(`[${requestId}] Error al listar fuentes de candidatos del perfil:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron listar las fuentes de los candidatos del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
