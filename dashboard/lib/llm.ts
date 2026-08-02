/**
 * Domain LLM entry points — thin wrappers around assembleRequest().
 *
 * Every public function delegates to `assembleRequest(flow, vars, ...)` in
 * `dashboard/lib/llm-context/`. No prompt assembly or LLM calls happen here
 * directly; all of that is owned by llm-context/assemble.ts (the single seam
 * enforced by CI via check-llm-context.sh).
 *
 * This file retains:
 *  - Public API contracts (function signatures, return types)
 *  - the `checkDailyBudget()` gate (deliberately outside assembleRequest, so
 *    the budget is charged per user-facing operation, not per internal call)
 *  - re-exports consumed by routes and turn-background
 *
 * #24 replaced the dashboard-generation API (generateDashboard, modifyDashboard,
 * analyzeDashboard, suggestDashboards, analyzeGaps, generateSuggestions) with
 * the real-estate assessment flows below. Each assessment returns the model's
 * raw text; parsing and persisting the JSON belongs to the flow's own task
 * (#25–#30), which knows the shape it asked for.
 */

import { checkDailyBudget } from "./llm-usage";
import { AgenticRunnerError } from "./llm-tools/runner";
import { resetClient } from "./llm-client";
import type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
import { assembleRequest } from "./llm-context";
import type { FlowVars, ListingSnapshot } from "./llm-context";

export { BudgetExceededError } from "./llm-usage";
export { CircuitBreakerOpenError } from "./llm-circuit-breaker";
export { AgenticRunnerError };
export type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
export { resetClient };

/** Shared options accepted by every assessment helper. */
export interface AssessmentOpts {
  requestId?: string | null;
  ctx?: LlmAgenticContext;
}

/**
 * Run a single-shot assessment flow over one listing.
 *
 * Shared by occupancy / condition / redflags / extract: they differ only in
 * their prompt (owned by buildSystemPrompt) and in how the caller parses the
 * result, not in how the request is executed. Temperature is pinned low —
 * these are extraction tasks, not creative ones.
 */
async function runListingAssessment(
  flow: "occupancy" | "condition" | "redflags" | "extract",
  listing: ListingSnapshot,
  opts?: AssessmentOpts,
): Promise<string> {
  await checkDailyBudget();

  const vars: FlowVars = { listing };
  const result = await assembleRequest(
    flow,
    vars,
    null,
    `Evalúa el anuncio según las instrucciones (${flow}).`,
    {
      ctx: opts?.ctx,
      requestId: opts?.requestId ?? null,
      endpoint: flow,
      temperature: 0,
      maxOutputTokens: 2048,
    },
  );

  if (!result.text) {
    throw new Error(`LLM returned an empty response for flow "${flow}"`);
  }
  return result.text;
}

/**
 * #25 — Assess whether a property is vacant, tenanted, or illegally occupied.
 * Returns the model's raw JSON text; #25 owns parsing and caching it.
 */
export function assessOccupancy(
  listing: ListingSnapshot,
  opts?: AssessmentOpts,
): Promise<string> {
  return runListingAssessment("occupancy", listing, opts);
}

/**
 * #26 — Assess the property's renovation state.
 * Returns the model's raw JSON text.
 */
export function assessCondition(
  listing: ListingSnapshot,
  opts?: AssessmentOpts,
): Promise<string> {
  return runListingAssessment("condition", listing, opts);
}

/**
 * #27 — Extract legal/financial red flags worth a lawyer's review.
 * Returns the model's raw JSON text. An empty `flags` array is a normal result.
 */
export function extractRedFlags(
  listing: ListingSnapshot,
  opts?: AssessmentOpts,
): Promise<string> {
  return runListingAssessment("redflags", listing, opts);
}

/**
 * #28 — Recover structured fields from a free-text description, so listings
 * whose portal published no structured data are not unfairly excluded by the
 * hard filters.
 * Returns the model's raw JSON text.
 */
export function extractStructuredFields(
  listing: ListingSnapshot,
  opts?: AssessmentOpts,
): Promise<string> {
  return runListingAssessment("extract", listing, opts);
}

/**
 * #38 — Compare 2+ candidates against the profile's investment thesis.
 * Returns the model's raw JSON text.
 */
export async function compareCandidates(
  candidates: ListingSnapshot[],
  profileThesis?: string,
  opts?: AssessmentOpts,
): Promise<string> {
  await checkDailyBudget();

  if (candidates.length < 2) {
    throw new Error("compareCandidates requires at least two candidates");
  }

  const vars: FlowVars = { candidates, profileThesis };
  const result = await assembleRequest(
    "compare",
    vars,
    null,
    "Compara los candidatos según las instrucciones.",
    {
      ctx: opts?.ctx,
      requestId: opts?.requestId ?? null,
      endpoint: "compare",
      temperature: 0,
      maxOutputTokens: 4096,
    },
  );

  if (!result.text) {
    throw new Error('LLM returned an empty response for flow "compare"');
  }
  return result.text;
}
