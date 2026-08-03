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
 *
 * occupancy/condition/redflags (#25/#26/#27) all run at property level — every
 * live listing of ONE deduplicated property, read together — because the fact
 * each looks for (occupied, needs reform, embargo pending) is a property of
 * the physical flat, not of any one advert, and "one portal omits what
 * another discloses" applies equally to all three. extract (#28) stays at
 * listing level: it recovers *per-advert* structured fields (each portal's
 * own structured-data completeness varies), not a shared physical fact.
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
 * Run a single-shot assessment flow over one listing (#28 extract only — see
 * the module-level note on why condition/redflags moved off this path).
 * Temperature is pinned low — this is an extraction task, not a creative one.
 */
async function runListingAssessment(
  flow: "extract",
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
 * Run a single-shot assessment flow over EVERY live listing of one
 * deduplicated property at once (#25 occupancy's pattern, followed by #26
 * condition and #27 redflags — see the module-level note). Returns the model
 * that produced the answer alongside the text, so the caller can record which
 * model a stored verdict came from (mirrors `assessOccupancy`).
 */
async function runPropertyAssessment(
  flow: "condition" | "redflags",
  listings: ListingSnapshot[],
  instruction: string,
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  await checkDailyBudget();

  const result = await assembleRequest(flow, { listings }, null, instruction, {
    ctx: opts?.ctx,
    requestId: opts?.requestId ?? null,
    endpoint: flow,
    temperature: 0,
    maxOutputTokens: 2048,
  });

  if (!result.text) {
    throw new Error(`LLM returned an empty response for flow "${flow}"`);
  }
  return { text: result.text, model: result.model };
}

/**
 * #25 — Assess whether a property is vacant, tenanted, or illegally occupied.
 *
 * Takes EVERY live listing of one deduplicated property, not a single listing:
 * the same flat on three portals is one physical thing with one true occupancy
 * status, and reading all three descriptions together is strictly better
 * evidence than reading one (a portal that says nothing gets rescued by a
 * sibling that says "se vende con inquilino"). See lib/ai-assessment/occupancy.ts.
 *
 * Returns the raw JSON text plus the model that produced it, so the caller can
 * record which model a stored verdict came from.
 */
export async function assessOccupancy(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  await checkDailyBudget();

  const result = await assembleRequest(
    "occupancy",
    { listings },
    null,
    "Evalúa los tres ejes del inmueble según las instrucciones (occupancy): " +
      "ocupación, qué se transmite (compraventa o venta de deuda) y cuánto " +
      "derecho se transmite (pleno dominio, nuda propiedad, proindiviso…).",
    {
      ctx: opts?.ctx,
      requestId: opts?.requestId ?? null,
      endpoint: "occupancy",
      temperature: 0,
      maxOutputTokens: 2048,
    },
  );

  if (!result.text) {
    throw new Error('LLM returned an empty response for flow "occupancy"');
  }
  return { text: result.text, model: result.model };
}

/**
 * #26 — Assess the property's renovation state.
 *
 * Takes EVERY live listing of one deduplicated property (see the module-level
 * note): the same flat's condition doesn't change per portal, and one advert
 * mentioning "a reformar" while another stays silent is resolved the same way
 * occupancy resolves a silent portal — by reading them together.
 *
 * Returns the raw JSON text plus the model that produced it.
 */
export function assessCondition(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  return runPropertyAssessment(
    "condition",
    listings,
    "Evalúa el estado de conservación del inmueble según las instrucciones (condition).",
    opts,
  );
}

/**
 * #27 — Extract legal/financial red flags worth a lawyer's review.
 *
 * Takes EVERY live listing of one deduplicated property, same reasoning as
 * `assessCondition` above: a disclosure like "pendiente de embargo" made on
 * one portal must not be missed because a sibling advert omits it.
 *
 * Returns the raw JSON text plus the model that produced it. An empty
 * `flags` array is a normal result.
 */
export function extractRedFlags(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  return runPropertyAssessment(
    "redflags",
    listings,
    "Extrae señales de alerta legales y financieras del inmueble según las instrucciones (redflags).",
    opts,
  );
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
