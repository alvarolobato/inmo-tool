/**
 * Location assessment (beach proximity + heritage zone) for one deduplicated
 * property (#388, Fase 3 de #385). On-demand per-property route (#400) so the
 * owner can (re)assess a single property's beach/location tags instead of
 * waiting for the batch scheduler.
 *
 *   GET  — read the cached verdict, or 404 if none has been generated yet.
 *   POST — run (or re-run) the assessment and persist it.
 *
 * Keyed on the property, not a listing — mirrors
 * `/api/properties/[id]/assessments/{occupancy,condition,redflags}`: one
 * physical flat, one verdict, every merged advert as evidence. See
 * lib/ai-assessment/location.ts for the axis semantics (graded
 * `beach_proximity` enum + `heritage_zone` boolean, each with its own literal
 * evidence quote).
 *
 * Gated by the admin credential like every route under /api/* (enforced by
 * middleware.ts via lib/api-auth-policy.ts — POST spends real LLM budget).
 *
 * #30: GET returns the LATEST verdict regardless of prompt version, plus
 * `stale: true` when it was generated under a version that is no longer
 * current — see `lib/ai-assessment/cache.ts`'s `CachedAssessment` doc.
 *
 * Terreno exclusion (#388, owner decision): the `location` axis doesn't apply
 * to a bare plot. `assessPropertyLocation` reports this as a `skipped` outcome
 * rather than a verdict, which POST surfaces as a 200 `{ skipped: true, reason }`
 * body (no LLM spend, nothing persisted).
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
  assessPropertyLocation,
  getLocationAssessment,
  NoListingsError,
  LOCATION_PROMPT_VERSION,
} from "@/lib/ai-assessment/location";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import {
  assessmentParkedResponse,
  llmDisabledResponse,
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
    const cached = await getLocationAssessment(propertyId);
    if (!cached) {
      return NextResponse.json(
        formatApiError(
          "Todavía no se ha evaluado la ubicación (playa/casco histórico) de esta propiedad.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json({
      property_id: propertyId,
      current_prompt_version: LOCATION_PROMPT_VERSION,
      prompt_version: cached.prompt_version,
      stale: cached.stale,
      result: cached.result,
      model: cached.model,
      generated_at: cached.generated_at,
    });
  } catch (err) {
    console.error(`[${requestId}] GET location assessment failed:`, err);
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
    await clearAssessmentFailures(propertyId, "location", LOCATION_PROMPT_VERSION);
  }

  try {
    const outcome = await assessPropertyLocation(propertyId, { requestId });
    if (outcome.skipped) {
      return NextResponse.json({
        property_id: propertyId,
        prompt_version: LOCATION_PROMPT_VERSION,
        skipped: true,
        reason: outcome.reason,
      });
    }
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: LOCATION_PROMPT_VERSION,
      result: outcome.result,
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
    // Master kill switch is off — 503, again not a 500.
    const off = llmDisabledResponse(err, requestId);
    if (off) return off;
    console.error(`[${requestId}] POST location assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
