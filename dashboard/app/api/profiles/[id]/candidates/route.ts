/**
 * GET /api/profiles/[id]/candidates — Materialized candidate feed for a
 * profile (task 2.5, #19), one item per deduplicated `property_id` with
 * `profile_listing_state.matched = true` (task 2.4, #18).
 *
 * Query params:
 *   cursor — property_id to page after (keyset pagination, see lib/candidates.ts)
 *   limit  — page size, default 30, max 100
 *   source — portal filter (#265): narrow to candidates with an active sale
 *            listing from this source. Combines with cursor/limit. Omitted =
 *            all sources. Options come from GET .../candidate-sources.
 *
 * Error codes:
 *   400 — Invalid id, cursor, limit, or source
 *   404 — Profile not found or archived
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { decodeCursor, listCandidates } from "@/lib/candidates";
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
  const rawSource = searchParams.get("source");

  // Source (portal) filter (#265). Bounded token — source values are
  // connector slugs (lowercase letters/digits/underscore, e.g.
  // `milanuncios_rental`), so anything outside that shape is a malformed
  // request, not a source that simply matched nothing. An empty string means
  // "no filter" (the client sends none, but tolerate it) and passes through
  // as null; the query narrows nothing.
  let source: string | null = null;
  if (rawSource !== null && rawSource !== "") {
    if (!/^[a-z0-9_]{1,40}$/.test(rawSource)) {
      return NextResponse.json(
        formatApiError("Fuente (portal) no válida.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    source = rawSource;
  }

  // Cursor is an opaque string (encodes a compound score+id keyset key, see
  // lib/candidates.ts) — validate it decodes, but don't parse it ourselves.
  let cursor: string | null = null;
  if (rawCursor !== null) {
    if (decodeCursor(rawCursor) === null) {
      return NextResponse.json(
        formatApiError("Cursor no válido.", "VALIDATION", undefined, requestId),
        { status: 400 },
      );
    }
    cursor = rawCursor;
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

    const page = await listCandidates(id, { cursor, limit, source });
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
