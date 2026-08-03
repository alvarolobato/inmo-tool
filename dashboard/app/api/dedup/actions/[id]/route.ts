/**
 * GET /api/dedup/actions/[id] — poll the result of an enqueued confirm/reject
 * request (see /api/dedup/suggestions/[id]/confirm|reject).
 *
 * `status` is 'pending' until the ETL container's poll loop
 * (etl/dedup/actions.py, ~3s interval) picks it up. The frontend polls this
 * endpoint on a short interval until status is 'done' or 'failed'.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDedupAction } from "@/lib/dedup";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const actionId = parsePositiveInt(rawId);

  if (actionId === null) {
    return NextResponse.json(
      formatApiError("Id de acción no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const action = await getDedupAction(actionId);
    if (action === null) {
      return NextResponse.json(
        formatApiError("No existe esa acción.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    return NextResponse.json(action);
  } catch (err) {
    console.error(`[${requestId}] Error al consultar la acción ${actionId}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo consultar el estado de la acción.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
