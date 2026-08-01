/**
 * GET    /api/conversations/:id — fetch single conversation
 * PATCH  /api/conversations/:id — partial update (title, archived)
 * DELETE /api/conversations/:id — 405 Method Not Allowed (no hard deletion)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getConversation,
  getConversationWithMessages,
  updateConversationTitle,
  setConversationArchived,
  markConversationRead,
} from "@/lib/conversations";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

// Lowercase 12-char hex (6 random bytes). Matches generateConversationId().
const ID_PATTERN = /^[a-f0-9]{12}$/;

function rejectInvalidId(id: string, requestId: string): NextResponse | null {
  if (ID_PATTERN.test(id)) return null;
  return NextResponse.json(
    formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
    { status: 400 },
  );
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id } = await context.params;
  const invalid = rejectInvalidId(id, requestId);
  if (invalid) return invalid;

  try {
    const conversation = await getConversationWithMessages(id);
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
    return NextResponse.json(conversation);
  } catch (err) {
    console.error(`[${requestId}] GET /api/conversations/${id} error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar la conversación.",
        "DB_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id } = await context.params;
  const invalid = rejectInvalidId(id, requestId);
  if (invalid) return invalid;

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

  if ("title" in b && typeof b.title !== "string") {
    return NextResponse.json(
      formatApiError("El campo 'title' debe ser una cadena de texto.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }
  if ("archived" in b && typeof b.archived !== "boolean") {
    return NextResponse.json(
      formatApiError("El campo 'archived' debe ser un booleano.", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }
  if ("last_read_at" in b && b.last_read_at !== "now") {
    return NextResponse.json(
      formatApiError("El campo 'last_read_at' solo acepta el valor \"now\".", "INVALID_BODY", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const existing = await getConversation(id);
    if (!existing) {
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

    if (typeof b.title === "string") {
      if (b.title.trim() === "") {
        return NextResponse.json(
          formatApiError("El campo 'title' no puede estar vacío.", "INVALID_BODY", undefined, requestId),
          { status: 400 },
        );
      }
      await updateConversationTitle(id, b.title);
    }

    if (typeof b.archived === "boolean") {
      await setConversationArchived(id, b.archived);
    }

    if (b.last_read_at === "now") {
      await markConversationRead(id);
    }

    const updated = await getConversation(id);
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
    console.error(`[${requestId}] PATCH /api/conversations/${id} error:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo actualizar la conversación.",
        "DB_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}

// ── DELETE — intentionally disallowed ─────────────────────────────────────────

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    formatApiError(
      "Las conversaciones no pueden eliminarse. Usa archive para archivarlas.",
      "METHOD_NOT_ALLOWED",
    ),
    { status: 405, headers: { Allow: "GET, PATCH" } },
  );
}
