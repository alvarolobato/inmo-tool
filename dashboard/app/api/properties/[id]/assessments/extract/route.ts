/**
 * Unstructured-to-structured field extraction for one deduplicated property (#28).
 *
 *   GET  — read the cached extraction, or 404 if none has been generated yet.
 *   POST — run (or re-run) the extraction and persist it. May return
 *          `skipped: true` without ever calling the LLM, when the property
 *          already has every field this flow can fill (EC-3, cost control) —
 *          see lib/ai-assessment/extract.ts's `assessPropertyExtract` doc.
 *
 * Keyed on the property, not a listing — same shape as
 * `/api/properties/[id]/assessments/{occupancy,condition,redflags}`: see
 * lib/ai-assessment/extract.ts's module doc for why this flow moved to
 * property-level despite issue #28's own listing-level wording.
 *
 * Gated by the admin credential like every route under /api/* — POST spends
 * real LLM budget (lib/api-auth-policy.ts).
 *
 * #30: GET returns the LATEST extraction regardless of prompt version, plus
 * `stale: true` when it was generated under a version that is no longer
 * current — see `lib/ai-assessment/cache.ts`'s `CachedAssessment` doc and
 * occupancy's route (which documents the skew this fixes) for the full
 * rationale.
 *
 * Error codes:
 *   400 — Invalid property id
 *   404 — Property not found, no live listings, or (GET) no cached extraction
 *   409 — Assessment parked after repeated failures on unchanged listing text
 *         (D-104); repeat with ?force=1 to override
 *   429 — Daily LLM budget exhausted
 *   503 — LLM circuit breaker open
 *   500 — Unexpected error
 */

import { NextRequest, NextResponse } from "next/server";
import {
  assessPropertyExtract,
  getExtractAssessment,
  NoListingsError,
  EXTRACT_PROMPT_VERSION,
} from "@/lib/ai-assessment/extract";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { formatApiError, generateRequestId, sanitizeErrorMessage } from "@/lib/errors";
import {
  assessmentParkedResponse,
  llmDisabledResponse,
  llmQuotaResponse,
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
    const cached = await getExtractAssessment(propertyId);
    if (!cached) {
      return NextResponse.json(
        formatApiError(
          "Todavía no se han extraído campos estructurados de esta propiedad.",
          "NOT_FOUND",
          undefined,
          requestId,
        ),
        { status: 404 },
      );
    }
    return NextResponse.json({
      property_id: propertyId,
      current_prompt_version: EXTRACT_PROMPT_VERSION,
      prompt_version: cached.prompt_version,
      stale: cached.stale,
      result: cached.result,
      model: cached.model,
      generated_at: cached.generated_at,
    });
  } catch (err) {
    console.error(`[${requestId}] GET extract assessment failed:`, err);
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
    await clearAssessmentFailures(propertyId, "extract", EXTRACT_PROMPT_VERSION);
  }

  try {
    const outcome = await assessPropertyExtract(propertyId, { requestId });
    if (outcome.skipped) {
      // Not an error: the property already has every field this flow can
      // fill, so no LLM call was made (EC-3, cost control) — 200, not 404,
      // because "nothing to do" is a normal, expected outcome here.
      return NextResponse.json({
        property_id: propertyId,
        prompt_version: EXTRACT_PROMPT_VERSION,
        skipped: true,
        reason: outcome.reason,
      });
    }
    return NextResponse.json({
      property_id: propertyId,
      prompt_version: EXTRACT_PROMPT_VERSION,
      skipped: false,
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
    // Subscription quota cap reached (D-107) — 503, resumes on window reset.
    const overQuota = llmQuotaResponse(err, requestId);
    if (overQuota) return overQuota;
    console.error(`[${requestId}] POST extract assessment failed:`, err);
    return NextResponse.json(
      formatApiError(sanitizeErrorMessage(err), "UNKNOWN", undefined, requestId),
      { status: 500 },
    );
  }
}
