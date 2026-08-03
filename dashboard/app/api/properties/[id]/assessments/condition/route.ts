/**
 * Condition/renovation assessment for one deduplicated property (#26).
 *
 *   GET  — read the cached verdict, or 404 if none has been generated yet.
 *   POST — run (or re-run) the assessment and persist it.
 *
 * Keyed on the property, not a listing — mirrors
 * `/api/properties/[id]/assessments/occupancy` (#25): see
 * lib/ai-assessment/condition.ts for why (one physical flat, one verdict,
 * every merged advert as evidence).
 *
 * Note: issue #26's "Repo touchpoints" named this route
 * `/api/listings/[id]/assessments/condition`. That was written before #25
 * landed and established the real, property-keyed route shape this file
 * follows instead — a listing-keyed path would contradict the property-level
 * assessment this flow actually performs (issue #27's design-review thread
 * makes the same property-vs-listing call explicitly for redflags).
 *
 * Gated by the admin credential like every route under /api/* — POST spends
 * real LLM budget (lib/api-auth-policy.ts).
 *
 * #30: GET returns the LATEST verdict regardless of prompt version, plus
 * `stale: true` when it was generated under a version that is no longer
 * current — see `lib/ai-assessment/cache.ts`'s `CachedAssessment` doc and
 * occupancy's route (which documents the skew this fixes) for the full
 * rationale.
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
  assessPropertyCondition,
  getConditionAssessment,
  NoListingsError,
  CONDITION_PROMPT_VERSION,
} from "@/lib/ai-assessment/condition";
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
    const cached = await getConditionAssessment(propertyId);
    if (!cached) {
      return NextResponse.json(
        formatApiError(
          "Todavía no se ha evaluado el estado de conservación de esta propiedad.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json({
      property_id: propertyId,
      current_prompt_version: CONDITION_PROMPT_VERSION,
      prompt_version: cached.prompt_version,
      stale: cached.stale,
      result: cached.result,
      model: cached.model,
      generated_at: cached.generated_at,
    });
  } catch (err) {
    console.error(`[${requestId}] GET condition assessment failed:`, err);
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
    const result = await assessPropertyCondition(propertyId, { requestId });
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: CONDITION_PROMPT_VERSION,
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
    console.error(`[${requestId}] POST condition assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
