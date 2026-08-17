/**
 * Legal/financial red-flag extraction for one deduplicated property (#27).
 *
 *   GET  — read the cached verdict, or 404 if none has been generated yet.
 *   POST — run (or re-run) the extraction and persist it.
 *
 * Keyed on the property, not a listing — mirrors
 * `/api/properties/[id]/assessments/occupancy` (#25) and
 * `/api/properties/[id]/assessments/condition` (#26): see
 * lib/ai-assessment/redflags.ts for why. See that file's module doc also for
 * why issue #27's `type` vocabulary deliberately keeps `herencia_yacente`
 * distinct from, but overlapping with, #25's `ownership.proindiviso` — they
 * answer different questions and neither is redundant.
 *
 * Note: issue #27's "Repo touchpoints" named this route
 * `/api/listings/[id]/assessments/redflags`; this file uses the property-
 * keyed path #25 established instead, same deviation as #26's route (see its
 * doc comment).
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
 * IMPORTANT: this is NOT legal advice. `flags[]` surfaces mentions worth an
 * independent check, never a confirmed legal fact — see the flow's prompt in
 * lib/llm-context/system-prompt.ts.
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
  assessPropertyRedFlags,
  getRedFlagsAssessment,
  NoListingsError,
  REDFLAGS_PROMPT_VERSION,
} from "@/lib/ai-assessment/redflags";
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
    const cached = await getRedFlagsAssessment(propertyId);
    if (!cached) {
      return NextResponse.json(
        formatApiError(
          "Todavía no se han buscado señales de alerta en esta propiedad.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json({
      property_id: propertyId,
      current_prompt_version: REDFLAGS_PROMPT_VERSION,
      prompt_version: cached.prompt_version,
      stale: cached.stale,
      result: cached.result,
      model: cached.model,
      generated_at: cached.generated_at,
    });
  } catch (err) {
    console.error(`[${requestId}] GET redflags assessment failed:`, err);
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
    await clearAssessmentFailures(propertyId, "redflags", REDFLAGS_PROMPT_VERSION);
  }

  try {
    const result = await assessPropertyRedFlags(propertyId, { requestId });
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: REDFLAGS_PROMPT_VERSION,
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
    console.error(`[${requestId}] POST redflags assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
