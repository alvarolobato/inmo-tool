/**
 * POST /api/profiles/[id]/clone — Clone a profile's scope/thesis_params into
 * a new profile. Feedback history does NOT carry over (issue #17): a clone
 * is a fresh thesis variant, not a data export.
 *
 * Error codes:
 *   400 — Invalid id
 *   404 — Source profile not found
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { cloneProfile } from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface CloneBody {
  name?: unknown;
}

export async function POST(
  request: NextRequest,
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

  let newName: string | undefined;
  try {
    const body: CloneBody = await request.json();
    if (typeof body?.name === "string" && body.name.trim().length > 0) {
      newName = body.name.trim();
    }
  } catch {
    // No body / invalid JSON — fine, clone uses the default "(copia)" name.
  }

  try {
    const clone = await cloneProfile(id, newName);
    if (!clone) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(clone, { status: 201 });
  } catch (err) {
    console.error(`[${requestId}] Error al clonar perfil de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo clonar el perfil de búsqueda.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
