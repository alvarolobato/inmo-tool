/**
 * PATCH /api/etl/worklist/[id] — set a worklist row's status (issue #237).
 *
 * The operator surface for "skip" (dismiss a URL) and "reset to pending"
 * (re-queue a failed capture). Admin-gated via the `/api/etl/:path*` matcher,
 * same as the list/add route.
 */

import { NextRequest, NextResponse } from "next/server";
import { setWorklistStatus } from "@/lib/db/worklist";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import { WORKLIST_STATUSES, type WorklistStatus } from "@/lib/worklist";

interface PatchBody {
  status?: string;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id } = await params;
  const worklistId = Number(id);
  if (!Number.isInteger(worklistId) || worklistId <= 0) {
    return NextResponse.json(
      formatApiError("Id de worklist inválido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("Cuerpo de la petición inválido (se esperaba JSON).", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }
  if (!body.status || !WORKLIST_STATUSES.includes(body.status as WorklistStatus)) {
    return NextResponse.json(
      formatApiError(
        `'status' debe ser uno de: ${WORKLIST_STATUSES.join(", ")}.`,
        "VALIDATION",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  try {
    const updated = await setWorklistStatus(worklistId, body.status as WorklistStatus);
    if (!updated) {
      return NextResponse.json(
        formatApiError("Fila de worklist no encontrada.", "VALIDATION", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[${requestId}] Error al actualizar la fila de worklist:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar la fila. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
