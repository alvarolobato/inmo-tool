/**
 * Shared handler body for POST /api/dedup/suggestions/[id]/confirm and
 * .../reject — same request/response contract, differing only in which
 * `DedupActionKind` they enqueue. Factored out rather than duplicated so the
 * validation (id shape, suggestion exists, suggestion is still `pending`)
 * can't drift between the two routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { enqueueDedupAction, getSuggestionStatus, type DedupActionKind } from "@/lib/dedup";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function handleDedupActionRequest(
  context: { params: Promise<{ id: string }> | { id: string } },
  action: DedupActionKind,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const suggestionId = parsePositiveInt(rawId);

  if (suggestionId === null) {
    return NextResponse.json(
      formatApiError("Id de sugerencia no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const status = await getSuggestionStatus(suggestionId);
    if (status === null) {
      return NextResponse.json(
        formatApiError("No existe esa sugerencia de duplicado.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }
    if (status !== "pending") {
      return NextResponse.json(
        formatApiError(
          `Esta sugerencia ya no está pendiente (estado actual: ${status}).`,
          "CONFLICT",
          undefined,
          requestId,
        ),
        { status: 409 },
      );
    }

    const actionId = await enqueueDedupAction(suggestionId, action);
    return NextResponse.json({ action_id: actionId, status: "pending" });
  } catch (err) {
    console.error(`[${requestId}] Error al encolar ${action} para sugerencia ${suggestionId}:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo encolar la solicitud. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
