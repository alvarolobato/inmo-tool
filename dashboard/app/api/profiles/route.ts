/**
 * GET  /api/profiles — List active (non-archived) search profiles.
 * POST /api/profiles — Create a new search profile.
 *
 * Error codes:
 *   400 — Invalid body or scope/thesis_params validation failure
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  ScopeSchema,
  ThesisParamsSchema,
  createProfile,
  listActiveProfiles,
} from "@/lib/db/profiles";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const profiles = await listActiveProfiles();
    return NextResponse.json(profiles);
  } catch (err) {
    console.error(`[${requestId}] Error al listar perfiles de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudieron cargar los perfiles de búsqueda. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

interface CreateBody {
  name?: string;
  scope?: unknown;
  thesis_params?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = generateRequestId();

  let body: CreateBody;
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

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json(
      formatApiError("El campo 'name' es obligatorio.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const scope = ScopeSchema.parse(body.scope);
    const thesisParams = ThesisParamsSchema.parse(body.thesis_params ?? {});
    const profile = await createProfile(body.name.trim(), scope, thesisParams);
    return NextResponse.json(profile, { status: 201 });
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
    console.error(`[${requestId}] Error al crear perfil de búsqueda:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo crear el perfil de búsqueda. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
