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
 * #30: GET now returns the LATEST verdict regardless of prompt version
 * (mirroring `lib/candidates.ts`'s card query), plus `stale: true` when that
 * row's `prompt_version` isn't `current_prompt_version` — see
 * `lib/ai-assessment/cache.ts`'s `CachedAssessment` doc for the skew this
 * fixes (a v1 badge rendering next to a 404 after a prompt bump). POST always
 * runs against the current prompt/schema, cache-hit or not.
 *
 * Error codes:
 *   400 — Invalid property id
 *   404 — Property not found, no live listings, or (GET) no cached verdict
 *   409 — Assessment parked after repeated failures on unchanged listing text
 *         (D-104); repeat with ?force=1 to override
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
import {
  assessmentParkedResponse,
  wantsForceRetry,
} from "@/lib/ai-assessment/route-errors";
import { clearAssessmentFailures } from "@/lib/ai-assessment/cache";

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
      current_prompt_version: OCCUPANCY_PROMPT_VERSION,
      prompt_version: cached.prompt_version,
      stale: cached.stale,
      result: cached.result,
      model: cached.model,
      generated_at: cached.generated_at,
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
  request: NextRequest,
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

  // `?force=1` is the documented way out of a D-104 park: clear the
  // ledger for this flow first, then run normally. Deliberately the SAME
  // endpoint that returned the 409 — the operator already has this URL.
  if (wantsForceRetry(request.url)) {
    await clearAssessmentFailures(propertyId, "occupancy", OCCUPANCY_PROMPT_VERSION);
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
    // D-104: a parked flow is a deliberate cost guard, not a server
    // fault — 409 with the reason, never an opaque 500.
    const parked = assessmentParkedResponse(err, requestId);
    if (parked) return parked;
    console.error(`[${requestId}] POST occupancy assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
