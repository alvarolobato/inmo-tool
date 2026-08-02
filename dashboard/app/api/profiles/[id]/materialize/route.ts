/**
 * POST /api/profiles/[id]/materialize — Re-run the hard-filter engine
 * (task 2.4, #18) for one profile against the current `property` pool.
 *
 * Called explicitly from the client after a profile is created/edited (see
 * ProfileForm.tsx) rather than wired automatically into POST/PATCH
 * /api/profiles — see lib/filtering/materialize.ts's docstring for why.
 *
 * Error codes:
 *   400 — Invalid id
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { materializeProfile } from "@/lib/filtering/materialize";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const result = await materializeProfile(id);
    if (!result) {
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
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[${requestId}] Error al recalcular candidatos del perfil:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron recalcular los candidatos del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
