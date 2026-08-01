/**
 * GET /api/review — List past weekly reviews (summary only).
 *
 * Returns: Array of week summaries (latest revision per week).
 *
 * Error codes:
 *   503 — Database connection error
 *   500 — Unexpected error
 */

import { NextResponse } from "next/server";
import {
  formatApiError,
  generateRequestId,
  sanitizeErrorMessage,
} from "@/lib/errors";
import { getReviewWeekSummaries } from "@/lib/review-db";

/** pg error codes that indicate a connection failure */
const PG_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01", // admin_shutdown
]);

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as Record<string, unknown>).code as string | undefined;
  return code !== undefined && PG_CONNECTION_CODES.has(code);
}

export async function GET(): Promise<NextResponse> {
  const requestId = generateRequestId();

  try {
    const reviews = await getReviewWeekSummaries();
    return NextResponse.json(reviews);
  } catch (err) {
    if (isConnectionError(err)) {
      console.error(`[${requestId}] DB connection error:`, err);
      return NextResponse.json(
        formatApiError(
          "No se pudo conectar a la base de datos.",
          "DB_CONNECTION",
          sanitizeErrorMessage(err),
          requestId
        ),
        { status: 503 }
      );
    }

    console.error(`[${requestId}] Error listing reviews:`, err);
    return NextResponse.json(
      formatApiError(
        "Error al obtener las revisiones.",
        "UNKNOWN",
        sanitizeErrorMessage(err),
        requestId
      ),
      { status: 500 }
    );
  }
}
