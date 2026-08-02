/**
 * GET    /api/profiles/[id] — Fetch a single search profile (active or archived).
 * PATCH  /api/profiles/[id] — Update name/scope/thesis_params.
 * DELETE /api/profiles/[id] — Archive (soft delete — sets archived_at, never
 *                              hard-deletes; profile_listing_state/feedback_event
 *                              reference this row and must survive).
 *
 * Error codes:
 *   400 — Invalid id, body, or scope/thesis_params validation failure
 *   404 — Profile not found
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  ScopeSchema,
  ThesisParamsSchema,
  archiveProfile,
  getProfileById,
  updateProfile,
} from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
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
    const profile = await getProfileById(id);
    if (!profile) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(profile);
  } catch (err) {
    console.error(`[${requestId}] Error al obtener perfil de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el perfil de búsqueda.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

interface PatchBody {
  name?: unknown;
  scope?: unknown;
  thesis_params?: unknown;
}

export async function PATCH(
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

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      formatApiError("El cuerpo JSON debe ser un objeto.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    return NextResponse.json(
      formatApiError("'name' debe ser una cadena no vacía.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const patch: { name?: string; scope?: import("@/lib/db/profiles").Scope; thesis_params?: import("@/lib/db/profiles").ThesisParams } = {};
    if (body.name !== undefined) patch.name = (body.name as string).trim();
    if (body.scope !== undefined) patch.scope = ScopeSchema.parse(body.scope);
    if (body.thesis_params !== undefined) patch.thesis_params = ThesisParamsSchema.parse(body.thesis_params);

    const updated = await updateProfile(id, patch);
    if (!updated) {
      return NextResponse.json(
        formatApiError("Perfil de búsqueda no encontrado.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        formatApiError(
          "El alcance (scope) del perfil no es válido.",
          "VALIDATION",
          JSON.stringify(err.issues),
          requestId,
        ),
        { status: 400 },
      );
    }
    console.error(`[${requestId}] Error al actualizar perfil de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar el perfil de búsqueda.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

export async function DELETE(
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
    const archived = await archiveProfile(id);
    if (!archived) {
      return NextResponse.json(
        formatApiError(
          "Perfil de búsqueda no encontrado o ya archivado.",
          "VALIDATION",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json(archived);
  } catch (err) {
    console.error(`[${requestId}] Error al archivar perfil de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo archivar el perfil de búsqueda.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
