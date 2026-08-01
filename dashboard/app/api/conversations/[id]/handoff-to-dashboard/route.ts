/**
 * POST /api/conversations/:id/handoff-to-dashboard
 *
 * Migrates a free-chat conversation to dashboard context. Updates mode,
 * context_kind, context_ref, and context_url on the conversations row.
 * Does NOT touch initial_context or conversation_messages.
 *
 * Body:    { dashboard_id: string }
 * Returns: { ok: true, conversation: ConversationRow, redirect_url: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db-write";
import { getConversation, migrateConversationToDashboard } from "@/lib/conversations";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> };

const CONV_ID_PATTERN = /^[a-f0-9]{12}$/;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;

  if (!CONV_ID_PATTERN.test(rawId)) {
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
      formatApiError(
        "El cuerpo de la solicitud no es JSON válido.",
        "INVALID_BODY",
        undefined,
        requestId,
      ),
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

  if (
    !("dashboard_id" in b) ||
    typeof b.dashboard_id !== "string" ||
    b.dashboard_id.trim() === ""
  ) {
    return NextResponse.json(
      formatApiError(
        "El campo 'dashboard_id' es obligatorio y debe ser una cadena de texto.",
        "INVALID_BODY",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }

  const dashboardId = b.dashboard_id.trim();
  const dashboardIdNum = Number(dashboardId);
  if (!Number.isInteger(dashboardIdNum) || dashboardIdNum <= 0) {
    return NextResponse.json(
      formatApiError(
        "El campo 'dashboard_id' debe ser un identificador de dashboard válido (entero positivo).",
        "INVALID_BODY",
        undefined,
        requestId,
      ),
      { status: 400 },
    );
  }
  // Normalize to canonical integer string so "042" and "42.0" both store as "42".
  const canonicalDashboardId = String(dashboardIdNum);

  try {
    const conversation = await getConversation(rawId);
    if (!conversation) {
      return NextResponse.json(
        formatApiError(
          "Conversación no encontrada.",
          "NOT_FOUND",
          `No existe ninguna conversación con ID ${rawId}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    if (conversation.archived_at !== null) {
      return NextResponse.json(
        formatApiError(
          "La conversación está archivada y no puede modificarse.",
          "CONVERSATION_ARCHIVED",
          undefined,
          requestId,
        ),
        { status: 409 },
      );
    }

    const dashboards = await sql<{ id: number }>(
      `SELECT id FROM dashboards WHERE id = $1`,
      [dashboardIdNum],
    );
    if (dashboards.length === 0) {
      return NextResponse.json(
        formatApiError(
          "Dashboard no encontrado.",
          "NOT_FOUND",
          `No existe ningún dashboard con ID ${canonicalDashboardId}.`,
          requestId,
        ),
        { status: 404 },
      );
    }

    const updated = await migrateConversationToDashboard(rawId, canonicalDashboardId);
    const redirect_url = `/dashboard/${canonicalDashboardId}`;

    return NextResponse.json({ ok: true, conversation: updated, redirect_url });
  } catch (err) {
    // TOCTOU: conversation archived between the pre-flight check above and the UPDATE
    if (err instanceof Error && /not found or is archived/i.test(err.message)) {
      return NextResponse.json(
        formatApiError(
          "La conversación está archivada y no puede modificarse.",
          "CONVERSATION_ARCHIVED",
          undefined,
          requestId,
        ),
        { status: 409 },
      );
    }
    console.error(
      `[${requestId}] POST /api/conversations/${rawId}/handoff-to-dashboard error:`,
      err,
    );
    return NextResponse.json(
      formatApiError(
        "No se pudo realizar el handoff de la conversación.",
        "DB_ERROR",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
