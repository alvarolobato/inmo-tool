/**
 * Occupancy assessment for one deduplicated property (#25).
 *
 *   GET  — read the cached verdict, or 404 if none has been generated yet.
 *   POST — run (or re-run) the assessment and persist it.
 *
 * Keyed on the property, not a listing: see lib/ai-assessment/occupancy.ts for
 * why (one physical flat, one verdict, all merged adverts as evidence).
 *
 * Gated by the admin credential like every route under /api/* — POST spends
 * real LLM budget, so it is emphatically not public (lib/api-auth-policy.ts).
 *
 * Error codes:
 *   400 — Invalid property id
 *   404 — Property not found, no live listings, or (GET) no cached verdict
 *   429 — Daily LLM budget exhausted
 *   503 — LLM circuit breaker open
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import {
  assessPropertyOccupancy,
  getOccupancyAssessment,
  NoListingsError,
  OCCUPANCY_PROMPT_VERSION,
} from "@/lib/ai-assessment/occupancy";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const propertyId = parsePositiveInt(rawId);

  if (propertyId === null) {
    return NextResponse.json(
      formatApiError("Id de propiedad no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const cached = await getOccupancyAssessment(propertyId);
    if (!cached) {
      return NextResponse.json(
        formatApiError(
          "Todavía no se ha evaluado la ocupación de esta propiedad.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: OCCUPANCY_PROMPT_VERSION,
      ...cached,
    });
  } catch (err) {
    console.error(`[${requestId}] GET occupancy assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}

export async function POST(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { id: rawId } = await context.params;
  const propertyId = parsePositiveInt(rawId);

  if (propertyId === null) {
    return NextResponse.json(
      formatApiError("Id de propiedad no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  try {
    const result = await assessPropertyOccupancy(propertyId, { requestId });
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: OCCUPANCY_PROMPT_VERSION,
      result,
    });
  } catch (err) {
    if (err instanceof NoListingsError) {
      return NextResponse.json(
        formatApiError(
          "La propiedad no tiene anuncios activos que evaluar.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        formatApiError(sanitizeErrorMessage(err), "LLM_BUDGET_EXCEEDED", undefined, requestId),
        { status: 429 },
      );
    }
    if (err instanceof CircuitBreakerOpenError) {
      return NextResponse.json(
        formatApiError(sanitizeErrorMessage(err), "LLM_CIRCUIT_OPEN", undefined, requestId),
        { status: 503 },
      );
    }
    console.error(`[${requestId}] POST occupancy assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
