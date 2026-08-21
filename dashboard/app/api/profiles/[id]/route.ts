/**
 * GET    /api/profiles/[id] — Fetch a single search profile (active or archived).
 * PATCH  /api/profiles/[id] — Update name/scope/thesis_params. Blocked on
 *                              archived profiles (404) — there's no unarchive
 *                              path, so an archived row must stay frozen;
 *                              clone it to get an editable copy instead.
 * DELETE /api/profiles/[id] — Archive (soft delete — sets archived_at, never
 *                              hard-deletes; profile_listing_state/feedback_event
 *                              reference this row and must survive).
 *
 * Error codes:
 *   400 — Invalid id, body, or scope/thesis_params validation failure
 *   404 — Profile not found (GET/DELETE), or not found/archived (PATCH)
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  ScopeSchema,
  ThesisParamsSchema,
  archiveProfile,
  getProfileById,
  touchProfileViewedAt,
  updateProfile,
} from "@/lib/db/profiles";
import { unknownConnectorNames } from "@/lib/db/connectors";
import { refreshProfileForScope } from "@/lib/filtering/profile-refresh";
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
        formatApiError("Perfil de búsqueda no encontrado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    // Issue #191: best-effort "last viewed" marker for the "new since your
    // last visit" aggregate. Awaited (it's a single cheap UPDATE) but never
    // allowed to fail the response — a write failure here must degrade to a
    // stale "new" count next time, never a page error.
    try {
      await touchProfileViewedAt(id);
    } catch (err) {
      console.warn(`[${requestId}] No se pudo actualizar last_viewed_at para el perfil ${id}:`, err);
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
    if (body.scope !== undefined) {
      const scope = ScopeSchema.parse(body.scope);
      // Issue #660: same registry check as POST /api/profiles — see that
      // route's comment for why an unknown name 400s rather than silently
      // degrading to "matches nothing".
      if (Array.isArray(scope.connectors)) {
        const unknown = await unknownConnectorNames(scope.connectors);
        if (unknown.length > 0) {
          return NextResponse.json(
            formatApiError(
              `Conector${unknown.length > 1 ? "es" : ""} desconocido${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
              "VALIDATION",
              undefined,
              requestId,
            ),
            { status: 400 },
          );
        }
      }
      patch.scope = scope;
    }
    if (body.thesis_params !== undefined) patch.thesis_params = ThesisParamsSchema.parse(body.thesis_params);

    const result = await updateProfile(id, patch);
    if (!result) {
      // updateProfile returns null both when the id doesn't exist and when
      // the profile is archived (edits are blocked on archived profiles —
      // see the docstring on updateProfile). Same 404 either way, matching
      // DELETE's existing "not found or already archived" convention below.
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

    // Issue #245: only a scope change warrants a quick refresh. A rename (or a
    // thesis_params-only edit) leaves the candidate set and the crawl scope
    // untouched, so it enqueues nothing and re-materializes nothing —
    // `scopeChanged` (computed in updateProfile) is the gate. When it did
    // change, materialize against current data + enqueue an ad-hoc sweep
    // (best-effort inside the helper; never fails the save). `refresh` is null
    // on a non-scope edit so the client shows no "buscando datos…" indicator.
    const refresh = result.scopeChanged ? await refreshProfileForScope(id) : null;
    return NextResponse.json({ ...result.profile, refresh });
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
          "NOT_FOUND",
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
