/**
 * Shared HTTP mapping for assessment-flow errors that every
 * `POST /api/properties/[id]/assessments/*` route must handle identically.
 *
 * Written for `AssessmentParkedError` (D-104): without this, a parked flow
 * escaped the six routes' catch chains and fell through to the generic
 * `500 UNKNOWN` — so clicking "Evaluar" on a parked property produced an
 * opaque server error forever (the park only releases when the listing text
 * or the prompt version changes) plus an error-level log line per click. A
 * cost guard that presents as a 500 is a bug report waiting to happen.
 *
 * 409 Conflict, not 429/503: the request cannot be satisfied in the resource's
 * current state, and — unlike a budget stop or an open breaker — retrying the
 * identical request later will not help. `force` is the documented way out.
 */

import { NextResponse } from "next/server";
import { formatApiError } from "@/lib/errors";
import { AssessmentParkedError } from "./cache";
import { LlmDisabledError } from "@/lib/llm-enabled";

/**
 * Map `AssessmentParkedError` to a 409 that tells the operator what happened,
 * why, and how to override. Returns `null` for any other error so callers can
 * continue their existing catch chain unchanged.
 */
export function assessmentParkedResponse(
  err: unknown,
  requestId: string,
): NextResponse | null {
  if (!(err instanceof AssessmentParkedError)) return null;
  const detail = err.lastError ? ` Último error: ${err.lastError}` : "";
  return NextResponse.json(
    formatApiError(
      `Evaluación pausada tras ${err.failCount} intentos fallidos sobre el mismo contenido ` +
        `del anuncio. Se reintentará automáticamente cuando cambie el anuncio o la versión ` +
        `del prompt; para forzarlo ahora, repita la llamada con ?force=1.${detail}`,
      "ASSESSMENT_PARKED",
      undefined,
      requestId,
    ),
    { status: 409 },
  );
}

/**
 * Map `LlmDisabledError` to a 503 that names the switch, so "the AI is off"
 * reads as a deliberate configuration state rather than a broken server.
 * Returns `null` for any other error.
 */
export function llmDisabledResponse(err: unknown, requestId: string): NextResponse | null {
  if (!(err instanceof LlmDisabledError)) return null;
  return NextResponse.json(
    formatApiError(err.message, "LLM_DISABLED", undefined, requestId),
    { status: 503 },
  );
}

/**
 * True when the caller asked to override a park (`?force=1`).
 *
 * The unpark path is deliberately the SAME endpoint rather than a new admin
 * surface: the operator who hits the 409 is already holding the URL that
 * produced it, and D-104's park is per (property, flow), which is exactly what
 * this route identifies.
 */
export function wantsForceRetry(url: string): boolean {
  try {
    const v = new URL(url).searchParams.get("force");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}
