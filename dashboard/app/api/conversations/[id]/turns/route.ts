/**
 * POST /api/conversations/:id/turns — start a new turn (user → assistant exchange).
 *
 * Body: { content: string }
 *
 * Returns 202 immediately with { turnId } after creating the turn row.
 * The LLM call runs in the background via runTurnBackground().
 *
 * Use GET /api/conversations/:id/stream (Phase 2) to receive live events.
 * Use GET /api/conversations/:id/turns/:turnId to poll turn status.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/conversations";
import { createTurnIfIdle } from "@/lib/turn-events";
import { runTurnBackground } from "@/lib/turn-background";
import { formatApiError, generateRequestId } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

const MAX_CONTENT_CHARS = 10_000;
const ID_PATTERN = /^[a-f0-9]{12}$/;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id } = await context.params;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      formatApiError("El cuerpo de la solicitud no es JSON válido.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      formatApiError("El cuerpo debe ser un objeto JSON.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const rawContent = b.content;

  if (typeof rawContent !== "string" || rawContent.trim() === "") {
    return NextResponse.json(
      formatApiError(
        "El campo 'content' es obligatorio y no puede estar vacío.",
        "MISSING_CONTENT",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  if (rawContent.length > MAX_CONTENT_CHARS) {
    return NextResponse.json(
      formatApiError(
        `El campo 'content' no puede superar los ${MAX_CONTENT_CHARS} caracteres.`,
        "CONTENT_TOO_LONG",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  let conversation;
  try {
    conversation = await getConversation(id);
  } catch (err) {
    console.error(`[${requestId}] POST /api/conversations/${id}/turns lookup error:`, err);
    return NextResponse.json(
      formatApiError("Error al acceder a la conversación.", "DB_ERROR", undefined, requestId),
      { status: 500 },
    );
  }
  if (!conversation) {
    return NextResponse.json(
      formatApiError(
        "Conversación no encontrada.",
        "NOT_FOUND",
        `No existe ninguna conversación con ID ${id}.`,
        requestId,
      ),
      { status: 404 },
    );
  }

  if (conversation.archived_at !== null) {
    return NextResponse.json(
      formatApiError(
        "La conversación está archivada y no acepta nuevos turnos.",
        "CONVERSATION_ARCHIVED",
        undefined,
        requestId,
      ),
      { status: 409 },
    );
  }

  // Atomically reject-or-create the turn (issue #823). Concurrent turns
  // interleave the message history nondeterministically; createTurnIfIdle does
  // the active-turn check AND the insert under one per-conversation advisory
  // lock so there is no TOCTOU window. Crashed turns stop counting after a
  // staleness cutoff so a dead container never bricks the conversation.
  let turnId: string;
  try {
    const result = await createTurnIfIdle(id, rawContent);
    if (!result.ok) {
      return NextResponse.json(
        formatApiError(
          "Hay una respuesta en curso en esta conversación. Espera a que termine.",
          "TURN_IN_PROGRESS",
          undefined,
          requestId,
        ),
        { status: 409 },
      );
    }
    turnId = result.turnId;
  } catch (err) {
    console.error(`[${requestId}] POST /api/conversations/${id}/turns DB error:`, err);
    return NextResponse.json(
      formatApiError("Error al crear el turno.", "DB_ERROR", undefined, requestId),
      { status: 500 },
    );
  }

  // Fire-and-forget background job. Next.js 15 `after()` / `waitUntil()` would
  // be preferable for lifecycle tracking (see issue #682 risk note), but is not
  // available in all deployment targets. The promise is intentionally not awaited
  // so the 202 response returns immediately.
  void runTurnBackground(turnId, conversation, rawContent);

  return NextResponse.json({ turnId }, { status: 202 });
}
