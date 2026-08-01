/**
 * POST   /api/conversations/:id/archive — archive the conversation
 * DELETE /api/conversations/:id/archive — unarchive the conversation
 */

import { NextRequest, NextResponse } from "next/server";
import { archiveConversation, unarchiveConversation } from "@/lib/conversations";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> };

function validateId(raw: string): string | null {
  return /^[a-f0-9]{12}$/.test(raw) ? raw : null;
}

// ── POST /archive — archive ───────────────────────────────────────────────────

export async function POST(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = validateId(rawId);
  if (!id) {
    return NextResponse.json(
      formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const updated = await archiveConversation(id);
    if (!updated) {
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
    return NextResponse.json(updated);
  } catch (err) {
    console.error(`[${requestId}] POST /api/conversations/${rawId}/archive error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo archivar la conversación.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ── DELETE /archive — unarchive ───────────────────────────────────────────────

export async function DELETE(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const id = validateId(rawId);
  if (!id) {
    return NextResponse.json(
      formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const updated = await unarchiveConversation(id);
    if (!updated) {
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
    return NextResponse.json(updated);
  } catch (err) {
    console.error(`[${requestId}] DELETE /api/conversations/${rawId}/archive error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo desarchivar la conversación.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
