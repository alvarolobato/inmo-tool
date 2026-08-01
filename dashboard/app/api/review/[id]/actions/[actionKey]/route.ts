/**
 * PATCH /api/review/[id]/actions/[actionKey] — Update follow-up fields for an action.
 *
 * Body: { status?: "pendiente"|"en_curso"|"hecha"|"descartada", owner_name?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { patchReviewAction } from "@/lib/review-actions-db";

const PG_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01",
]);

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as Record<string, unknown>).code as string | undefined;
  return code !== undefined && PG_CONNECTION_CODES.has(code);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; actionKey: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: idParam, actionKey } = await context.params;

  if (!/^\d+$/.test(idParam)) {
    return NextResponse.json(
      formatApiError("id inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  const id = parseInt(idParam, 10);
  if (id <= 0) {
    return NextResponse.json(
      formatApiError("id inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: { status?: string; owner_name?: string };
  try {
    body = (await request.json()) as { status?: string; owner_name?: string };
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo JSON no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const allowed = new Set(["pendiente", "en_curso", "hecha", "descartada"]);
  if (body.status !== undefined && !allowed.has(body.status)) {
    return NextResponse.json(
      formatApiError("status inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (body.owner_name !== undefined && typeof body.owner_name !== "string") {
    return NextResponse.json(
      formatApiError("owner_name debe ser texto.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  const ownerNameTrimmed =
    typeof body.owner_name === "string" ? body.owner_name.trim().slice(0, 120) : undefined;

  try {
    const row = await patchReviewAction(id, actionKey, {
      status: body.status as "pendiente" | "en_curso" | "hecha" | "descartada" | undefined,
      owner_name: ownerNameTrimmed,
    });
    if (!row) {
      return NextResponse.json(
        formatApiError("Acción no encontrada.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(row);
  } catch (err) {
    if (isConnectionError(err)) {
      return NextResponse.json(
        formatApiError(
          "No se pudo conectar a la base de datos.",
          "DB_CONNECTION",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 503 },
      );
    }
    console.error(`[${requestId}] patch action:`, err);
    return NextResponse.json(
      formatApiError("Error al actualizar la acción.", "UNKNOWN", sanitizeErrorMessage(err), requestId),
      { status: 500 },
    );
  }
}
