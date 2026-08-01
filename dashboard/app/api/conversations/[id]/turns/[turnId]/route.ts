/**
 * GET /api/conversations/:id/turns/:turnId — fetch a turn with its events.
 *
 * Returns { turn: TurnRow, events: TurnEventRow[] }.
 * 404 if the turn doesn't exist or belongs to a different conversation.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTurnWithEvents } from "@/lib/turn-events";
import { formatApiError, generateRequestId } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string; turnId: string }> | { id: string; turnId: string } };

const ID_PATTERN = /^[a-f0-9]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id, turnId } = await context.params;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  if (!UUID_PATTERN.test(turnId)) {
    return NextResponse.json(
      formatApiError("ID de turno no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof getTurnWithEvents>>;
  try {
    result = await getTurnWithEvents(turnId);
  } catch (err) {
    console.error(`[${requestId}] GET /api/conversations/${id}/turns/${turnId} DB error:`, err);
    return NextResponse.json(
      formatApiError("Error de base de datos.", "DB_ERROR", undefined, requestId),
      { status: 500 },
    );
  }

  if (!result || result.turn.conversation_id !== id) {
    return NextResponse.json(
      formatApiError(
        "Turno no encontrado.",
        "NOT_FOUND",
        `No existe ningún turno con ID ${turnId} para la conversación ${id}.`,
        requestId,
      ),
      { status: 404 },
    );
  }

  return NextResponse.json({ turn: result.turn, events: result.events });
}
