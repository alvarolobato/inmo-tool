/**
 * GET /api/conversations/:id/context/:turnId — load a turn's context log.
 *
 * The heavy "context log" (the exact payload sent to the LLM for this turn) lives
 * in a file on the data volume, not in Postgres. The DB holds only the pointer
 * (conversation_turns.context_file). This endpoint resolves that pointer — scoped
 * to the conversation — and streams the file contents back, so the UI can lazy-load
 * "Contexto original" only when the user expands it.
 *
 * Returns the raw context JSON, or 404 when the turn has no context file.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/conversations";
import { getTurnContextFile } from "@/lib/turn-events";
import { readTurnContext } from "@/lib/conversation-context-store";
import { formatApiError, generateRequestId } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string; turnId: string }> | { id: string; turnId: string };
};

const ID_PATTERN = /^[a-f0-9]{12}$/;
const TURN_PATTERN = /^[0-9a-fA-F-]{8,}$/;

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id, turnId } = await context.params;

  if (!ID_PATTERN.test(id) || !TURN_PATTERN.test(turnId)) {
    return NextResponse.json(
      formatApiError("Identificador no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const conv = await getConversation(id);
    if (!conv) {
      return NextResponse.json(
        formatApiError("Conversación no encontrada.", "NOT_FOUND", undefined, requestId),
        { status: 404 },
      );
    }

    const file = await getTurnContextFile(id, turnId);
    if (!file) {
      return NextResponse.json(
        formatApiError(
          "No hay contexto guardado para este turno.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    const ctx = await readTurnContext(file);
    if (ctx === null) {
      return NextResponse.json(
        formatApiError(
          "El archivo de contexto no está disponible.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }

    return NextResponse.json(ctx);
  } catch (err) {
    console.error(`[${requestId}] GET /api/conversations/${id}/context/${turnId} error:`, err);
    return NextResponse.json(
      formatApiError("Error al cargar el contexto.", "DB_ERROR", undefined, requestId),
      { status: 500 },
    );
  }
}
