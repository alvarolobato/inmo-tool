/**
 * GET /api/profiles/[id]/diagnostics — zero-candidate diagnostic (issue
 * #194). Lazy, on-demand only — never called as part of the Perfiles list's
 * aggregate load (issue #192); the frontend calls this only for a row it
 * already knows is at zero matched candidates.
 *
 * Error codes:
 *   400 — Invalid id
 *   404 — Profile not found, archived, or has a malformed scope (issue
 *         #113's `{ok: false, ...}` case — the diagnostic funnel needs a
 *         parsed scope to run at all; a malformed-scope profile is already
 *         rendered as its own visibly-broken row upstream and never reaches
 *         "why is this zero", which only applies once a scope is valid).
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getProfileById } from "@/lib/db/profiles";
import { diagnoseZeroCandidates } from "@/lib/profile-diagnostics";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json(formatApiError("Id de perfil no válido.", "VALIDATION", undefined, requestId), {
      status: 400,
    });
  }

  try {
    let profile;
    try {
      profile = await getProfileById(id);
    } catch (err) {
      // getProfileById parses `scope`/`thesis_params` with ScopeSchema.parse
      // (throws on failure) rather than safeParse — a malformed-scope
      // profile (issue #113) is already rendered as its own visibly-broken
      // row upstream and never has a "why is this zero" question to answer,
      // so this route treats that as 404, not a 500.
      if (err instanceof ZodError) {
        return NextResponse.json(
          formatApiError(
            "El perfil tiene una configuración inválida; no se puede diagnosticar.",
            "NOT_FOUND",
            undefined,
            requestId,
          ),
          { status: 404 },
        );
      }
      throw err;
    }
    if (!profile || profile.archived_at !== null) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado o archivado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    const diagnosis = await diagnoseZeroCandidates(profile);
    return NextResponse.json(diagnosis);
  } catch (err) {
    console.error(`[${requestId}] Error al diagnosticar el perfil ${id}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo generar el diagnóstico del perfil.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
