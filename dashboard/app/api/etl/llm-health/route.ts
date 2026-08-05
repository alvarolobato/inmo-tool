/**
 * LLM cost / usage API (issue #324).
 *
 * GET /api/etl/llm-health — one aggregated read of the LLM cost-control signals
 * for the "LLM / IA" section of the "Salud de datos" page: call volume by flow
 * and provider (today + 7d), tokens + estimated € cost, assessment
 * coverage/backlog with a projection to clear it at the current batch rate, the
 * scheduler throttle / kill-switch state, and recent error counts. Read-only,
 * display-only — no alerting, no writes.
 *
 * Mounted under /api/etl so middleware.ts admin-gates it exactly like the
 * data-health and worklist routes (every /api/ path is gated by default; see
 * lib/api-auth-policy.ts). No new auth surface.
 *
 * Error codes:
 *   500 - Database error
 */

import { NextResponse } from "next/server";
import { getLlmHealth } from "@/lib/db/llm-health";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";

// Queries Postgres per request; never prerender at build (no DB then).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();
  try {
    const data = await getLlmHealth();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[${requestId}] Error al cargar el uso de LLM:`, err);
    return NextResponse.json(
      formatApiError(
        "No se pudo cargar el uso de LLM. Inténtalo de nuevo.",
        "DB_QUERY",
        sanitizeErrorMessage(err),
        requestId,
      ),
      { status: 500 },
    );
  }
}
