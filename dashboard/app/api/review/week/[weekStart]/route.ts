/**
 * GET /api/review/week/[weekStart] — List all revisions for an ISO week (YYYY-MM-DD Monday).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { getRevisionsForWeek } from "@/lib/review-db";

const PG_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01",
]);

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as Record<string, unknown>).code as string | undefined;
  return code !== undefined && PG_CONNECTION_CODES.has(code);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ weekStart: string }> },
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { weekStart } = await context.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json(
      formatApiError("weekStart debe ser YYYY-MM-DD.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const rows = await getRevisionsForWeek(weekStart);
    return NextResponse.json(rows);
  } catch (err) {
    if (isConnectionError(err)) {
      return NextResponse.json(
        formatApiError(
          "No se pudo conectar a la base de datos.",
          "DB_CONNECTION",
          sanitizeErrorMessage(err),
          requestId,
        ),
        { status: 503 },
      );
    }
    console.error(`[${requestId}] list revisions:`, err);
    return NextResponse.json(
      formatApiError("Error al listar revisiones.", "UNKNOWN", sanitizeErrorMessage(err), requestId),
      { status: 500 },
    );
  }
}
