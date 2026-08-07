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
 * occupancy/condition/redflags/extract (#25/#26/#27/#28) ALL run at property
 * level — every live listing of ONE deduplicated property, read together —
 * because the fact each looks for (occupied, needs reform, embargo pending,
 * missing m²/rooms/floor/elevator) is a property of the physical flat, not of
 * any one advert, and "one portal omits what another discloses" applies
 * equally to all four. This updates an earlier version of this note, written
 * when #24 landed extract's plumbing ahead of #28's real prompt: it argued
 * extract should stay listing-level because "each portal's own structured-
 * data completeness varies" — true, but irrelevant, because the fields
 * extract fills (`m2_built`, `m2_useful`, `rooms`, `bathrooms`, `floor`,
 * `has_elevator`) are columns on `property`, not `listing` (see
 * `etl/schema/init.sql`). The dedup pipeline already reconciles per-listing
 * facts onto that one property row, so extraction has to read every live
 * listing's description together for the same reason occupancy does: an
 * `m2_built` disclosed only in one portal's text must not be missed because a
 * sibling listing (which happened to have shorter or vaguer text) is the one
 * that got read. See `lib/ai-assessment/extract.ts`.
 */

import { checkDailyBudget } from "./llm-usage";
import { AgenticRunnerError } from "./llm-tools/runner";
import { resetClient } from "./llm-client";
import type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
import { assembleRequest } from "./llm-context";
import type { FlowVars, ListingSnapshot, RedflagTrendingCandidate } from "./llm-context";

export { BudgetExceededError } from "./llm-usage";
export { CircuitBreakerOpenError } from "./llm-circuit-breaker";
export { AgenticRunnerError };
export type { LlmAgenticContext, AgenticProgressEvent } from "./llm-tools/types";
export { resetClient };

/** Shared options accepted by every assessment helper. */
export interface AssessmentOpts {
  requestId?: string | null;
  ctx?: LlmAgenticContext;
  /**
   * Derived (non-listing) zone-median price comparison — #184. Only
   * `assessOccupancy` and `extractRedFlags` read this; `assessCondition`/
   * `extractStructuredFields` accept the same `AssessmentOpts` shape but
   * never forward it into `assembleRequest`'s vars (see
   * `runPropertyAssessment`'s `extraVars` param), so passing it there is a
   * silent no-op rather than a type error — harmless, but callers should
   * only set it for the two flows that render it. See
   * `lib/ai-assessment/price-signal.ts` for why.
   */
  areaPriceSignal?: string;
  /**
   * #396 — redflags ONLY: the top-N trending `other`-flag `candidate_type`
   * slugs, computed ONCE per batch by the orchestrator and forwarded here so
   * `extractRedFlags` can thread them into the redflags prompt. Other flows
   * accept the same `AssessmentOpts` shape but never forward it (a silent
   * no-op), same as `areaPriceSignal`. See `lib/db/redflag-candidates.ts`.
   */
  trendingCandidates?: RedflagTrendingCandidate[];
}

/**
 * Run a single-shot assessment flow over EVERY live listing of one
 * deduplicated property at once (#25 occupancy's pattern, followed by #26
 * condition, #27 redflags, and #28 extract — see the module-level note).
 * Returns the model that produced the answer alongside the text, so the
 * caller can record which model a stored verdict came from (mirrors
 * `assessOccupancy`).
 *
 * `extraVars` (#184): merged into the vars object passed to
 * `assembleRequest`, on top of `{ listings }`. Exists so `extractRedFlags`
 * can forward `areaPriceSignal` without condition/extract's calls (which
 * omit it) changing shape at all.
 */
async function runPropertyAssessment(
  flow: "condition" | "redflags" | "location" | "opportunity" | "extract",
  listings: ListingSnapshot[],
  instruction: string,
  opts?: AssessmentOpts,
  extraVars?: Partial<FlowVars>,
): Promise<{ text: string; model: string }> {
  await checkDailyBudget();

  const result = await assembleRequest(
    flow,
    { listings, ...extraVars },
    null,
    instruction,
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
 * `opts.areaPriceSignal` (#184): a bucketed zone-median price comparison,
 * when the caller (`lib/ai-assessment/occupancy.ts`) has one — see
 * `lib/ai-assessment/price-signal.ts` for why occupancy is one of the two
 * flows that receives this and how it's bucketed for cache stability.
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
    { listings, areaPriceSignal: opts?.areaPriceSignal },
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
 * Deliberately does NOT receive `opts.areaPriceSignal` (#184): price-per-m²
 * correlating with condition is a real but weak, confounded signal (location,
 * floor, orientation and size all move price/m² at least as much as
 * renovation state does), and condition is read directly off what the ad
 * text says about the flat, not inferred from price — see
 * `lib/ai-assessment/price-signal.ts`'s module doc for the full reasoning.
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
 * #27 / #361 — Extract property problems worth a review before offering:
 * legal/financial risks (a lawyer's review) AND physical problems such as
 * unfinished/halted construction or structural damage (a technician's review).
 *
 * Takes EVERY live listing of one deduplicated property, same reasoning as
 * `assessCondition` above: a disclosure like "pendiente de embargo" made on
 * one portal must not be missed because a sibling advert omits it.
 *
 * `opts.areaPriceSignal` (#184): a bucketed zone-median price comparison,
 * when the caller (`lib/ai-assessment/redflags.ts`) has one. Redflags is the
 * clearest beneficiary of the two flows that receive it: "priced far below
 * the zone" is a canonical distress-sale tell (embargo, debt sale,
 * partial-title transfer) — see `lib/ai-assessment/price-signal.ts`.
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
    "Extrae señales de alerta del inmueble (problemas legales, financieros y físicos) según las instrucciones (redflags).",
    opts,
    {
      areaPriceSignal: opts?.areaPriceSignal,
      trendingCandidates: opts?.trendingCandidates,
    },
  );
}

/**
 * #388 (Fase 3 de #385) — Assess two location signals derived from the advert
 * text: beach proximity (graded: frontline/sea_view/near_beach/none) and
 * whether the property sits in a casco/centro histórico.
 *
 * Takes EVERY live listing of one deduplicated property, same reasoning as
 * `assessCondition`: a "primera línea de playa" disclosure made on one portal
 * must not be missed because a sibling advert omits it. LLM-only by owner
 * decision — no regex/keyword classifier anywhere (see
 * `lib/ai-assessment/location.ts` and D-095).
 *
 * Returns the raw JSON text plus the model that produced it.
 */
export function assessLocation(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  return runPropertyAssessment(
    "location",
    listings,
    "Evalúa las señales de ubicación del inmueble (proximidad a la playa y casco histórico) según las instrucciones (location).",
    opts,
  );
}

/**
 * #398 (Fase 5 de #385) — Assess two investor-opportunity signals derived from
 * the advert text: whether the property is VPO / vivienda protegida (`is_vpo`,
 * a hard filter downstream) and whether a licencia turística / VUT is already
 * granted (`tourist_license`, a soft ranking boost).
 *
 * Takes EVERY live listing of one deduplicated property, same reasoning as
 * `assessCondition`: a "VPO" disclosure made on one portal must not be missed
 * because a sibling advert omits it. LLM-only by owner decision — no
 * regex/keyword classifier anywhere (see `lib/ai-assessment/opportunity.ts` and
 * D-095's LLM-not-regex principle).
 *
 * Returns the raw JSON text plus the model that produced it.
 */
export function assessOpportunity(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  return runPropertyAssessment(
    "opportunity",
    listings,
    "Evalúa las señales de oportunidad del inmueble (VPO y licencia turística) según las instrucciones (opportunity).",
    opts,
  );
}

/**
 * #28 — Recover structured fields (m², rooms, bathrooms, floor, elevator)
 * from free-text description(s), so listings whose portal published no
 * structured data are not unfairly excluded by the hard filters.
 *
 * Takes EVERY live listing of one deduplicated property (see the module-level
 * note): the fields this recovers live on `property`, not `listing`, so a
 * disclosure in one portal's text must not be missed because a sibling
 * listing's (shorter, vaguer) text is what got read — same reasoning as
 * `assessCondition`/`extractRedFlags`.
 *
 * Deliberately does NOT receive `opts.areaPriceSignal` (#184): extract pulls
 * objective structured fields straight out of the ad text, and per its own
 * EC-2 ("no inventes, no redondees, no completes") must never let an
 * external signal nudge a field away from exactly what's written — see
 * `lib/ai-assessment/price-signal.ts`'s module doc.
 *
 * Returns the raw JSON text plus the model that produced it.
 */
export function extractStructuredFields(
  listings: ListingSnapshot[],
  opts?: AssessmentOpts,
): Promise<{ text: string; model: string }> {
  return runPropertyAssessment(
    "extract",
    listings,
    "Extrae los campos estructurados del inmueble según las instrucciones (extract).",
    opts,
  );
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
