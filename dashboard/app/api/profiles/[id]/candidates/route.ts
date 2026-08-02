/**
 * GET /api/profiles/[id]/candidates — Materialized candidate feed for a
 * profile (task 2.5, #19), one item per deduplicated `property_id` with
 * `profile_listing_state.matched = true` (task 2.4, #18).
 *
 * Query params:
 *   cursor — property_id to page after (keyset pagination, see lib/candidates.ts)
 *   limit  — page size, default 30, max 100
 *
 * Error codes:
 *   400 — Invalid id, cursor, or limit
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { listCandidates } from "@/lib/candidates";
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
  if (id === null) {
    return NextResponse.json(
      formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const { searchParams } = new URL(request.url);
  const rawCursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");

  let cursor: number | null = null;
  if (rawCursor !== null) {
    cursor = parsePositiveInt(rawCursor);
    if (cursor === null) {
      return NextResponse.json(
        formatApiError("Cursor no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
  }

  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = parsePositiveInt(rawLimit);
    if (parsed === null) {
      return NextResponse.json(
        formatApiError("Límite de página no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    limit = parsed;
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

    const page = await listCandidates(id, { cursor, limit });
    return NextResponse.json(page);
  } catch (err) {
    console.error(`[${requestId}] Error al listar candidatos del perfil:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron listar los candidatos del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
