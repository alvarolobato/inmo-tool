/**
 * #398 (Fase 5 de #385) — `opportunity` assessment axis, per deduplicated
 * property.
 *
 * Carries two investor-opportunity signals that mining the descriptions found
 * are BOTH under-exposed by the portals and only reliably derivable from the
 * free text:
 *
 *  - **`is_vpo`** — Vivienda de Protección Oficial / vivienda protegida (resale
 *    price cap and/or a buyer restriction). The text captured it 3.6× more than
 *    the portal `vpo` checkbox (33 text mentions vs. 9 flagged listings, #385),
 *    which is why we read it from the text, not from a connector flag. It is a
 *    HARD filter downstream (`candidates.ts`): an investor needs to exclude it
 *    or seek it out explicitly, because it changes what you are legally allowed
 *    to buy and at what resale price.
 *  - **`tourist_license`** — a licencia turística / VUT ALREADY granted. It is a
 *    SOFT ranking boost only, NEVER a filter: its ABSENCE does not mean "cannot
 *    be obtained" (most properties simply don't mention it), so filtering on it
 *    would manufacture false negatives — it only prioritises a property that
 *    already carries the licence.
 *
 * ## LLM-only detection, NEVER runtime regex (owner decision, 2026-08-06)
 *
 * The owner explicitly does NOT trust keyword/regex matching for text-derived
 * signals. The product path that assigns `is_vpo` / `tourist_license` to a
 * property is this LLM assessment — a prompt (`buildOpportunityPrompt` in
 * `lib/llm-context/system-prompt.ts`) that reads the advert text and answers
 * with a literal cited quote per signal at `temperature: 0`, mirroring
 * `location.ts` exactly. There is NO ILIKE/regex classifier anywhere in this
 * file or its prompt. (Mining prevalence with SQL/ILIKE in dev was fine — it
 * only sized the signal; it is not how a property gets a verdict.) The same
 * LLM-not-regex principle recorded for the location axis in
 * `docs/decisions/D-095-location-axis.md` applies verbatim here.
 *
 * ## Evidence-or-false backstop
 *
 * Each boolean requires its OWN literal `evidence` quote or degrades to `false`
 * — the same anti-false-positive guard `location`'s `heritage_zone` and
 * `redflags.parseFlag` enforce in code rather than trusting to the prompt.
 *
 * Server-only: imports lib/db-write (the `pg` client) via shared.ts. Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import { NoListingsError, loadPropertyListings, clamp01, stripCodeFence } from "./shared";
import { getLatestAssessment, logCacheOutcome, AssessmentParkedError, type CachedAssessment } from "./cache";
// #542 — opportunity is now assessed as one axis of the merged `triage` flow.
// See condition.ts's matching import for why this circular import (triage.ts
// imports back from this file) is safe: only read inside a function body here
// (never at this module's top level).
import { assessPropertyTriage } from "./triage";

export { NoListingsError, loadPropertyListings };

/**
 * Prompt version. Bump when the opportunity prompt changes in a way that could
 * change a verdict, so `ai_assessment`'s unique key treats the new output as a
 * distinct row and #308's batch scheduler re-assesses (same convention as
 * `LOCATION_PROMPT_VERSION`). `v1` is the initial axis (#398).
 *
 * `v2` (#542): answered from the merged `triage` prompt now, not a standalone
 * `opportunity` prompt — same vocabulary/evidence rules, different
 * surrounding text. See `CONDITION_PROMPT_VERSION`'s `v3` note for the full
 * rationale.
 */
export const OPPORTUNITY_PROMPT_VERSION = "opportunity/v2";

// The opportunity signal names + badge labels live in the leaf module
// `opportunity-vocabulary.ts` (no `pg`/LLM imports) so the redflags prompt
// builder can render them without the system-prompt → opportunity → llm →
// llm-context cycle (#407). Re-exported here so existing importers
// (`lib/candidates.ts`) keep using `@/lib/ai-assessment/opportunity` unchanged.
export {
  OPPORTUNITY_SIGNALS,
  IS_VPO_LABEL,
  TOURIST_LICENSE_LABEL,
  type OpportunitySignal,
} from "./opportunity-vocabulary";

/**
 * Single-property opportunity result. Flattened (no nested `verdict` object),
 * with two independent booleans each carrying its OWN literal evidence quote +
 * source so the investor can check either claim independently.
 */
export interface OpportunityResult {
  /** True only when the text says the property is VPO / vivienda protegida. */
  is_vpo: boolean;
  /** Literal quote backing `is_vpo`, or "" when nothing could be cited. */
  vpo_evidence: string;
  /** Portal that quote came from, or null. */
  vpo_evidence_source: string | null;
  /** True only when the text says a licencia turística / VUT is already granted. */
  tourist_license: boolean;
  /** Literal quote backing `tourist_license`, or "" when nothing could be cited. */
  tourist_license_evidence: string;
  /** Portal that quote came from, or null. */
  tourist_license_evidence_source: string | null;
  confidence: number;
  reasoning: string;
}

/**
 * Whether the `opportunity` axis applies to a property of this type (#398,
 * owner decision — same rule as the `location` axis). A `terreno` (bare plot)
 * has no VPO-classification / tourist-licence reading in the same product
 * sense, so it is excluded from this axis entirely — `assessPropertyOpportunity`
 * skips it before any LLM call. A null/unknown type is NOT excluded: better to
 * assess than to silently drop a mis-typed flat.
 */
export function opportunityApplies(propertyType: string | null | undefined): boolean {
  return (propertyType ?? "").trim().toLowerCase() !== "terreno";
}

/**
 * Parse and validate the model's JSON into the opportunity result.
 *
 * Applies the same evidence-or-fallback backstop `location`'s `heritage_zone`
 * uses: a boolean claimed `true` with no literal citation is degraded to
 * `false` (with its evidence dropped). This is the code-side "si no puedes citar
 * nada, no afirmes nada" guard, not something trusted to the prompt.
 */
export function parseOpportunityResult(raw: string): OpportunityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Opportunity flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Opportunity flow returned a non-object JSON value.");
  }
  return parseOpportunityObject(parsed as Record<string, unknown>);
}

/**
 * The object-taking core of `parseOpportunityResult` (#542, triage) — see
 * condition.ts's `parseConditionObject` doc for why this split exists.
 * `parseOpportunityResult` above is now a thin `JSON.parse` + fence-strip
 * wrapper; every validation and degrade rule below is UNCHANGED from before
 * the merge.
 */
export function parseOpportunityObject(o: Record<string, unknown>): OpportunityResult {
  // Evidence-or-false guard, once per boolean (mirrors location's heritage_zone
  // handling): a claim with no literal quote is not a finding, it is exactly
  // what the assessment rules forbid — degrade it to false and drop its quote.
  const vpo = evidenceGuardedBool(o.is_vpo, o.vpo_evidence, o.vpo_evidence_source);
  const tourist = evidenceGuardedBool(
    o.tourist_license,
    o.tourist_license_evidence,
    o.tourist_license_evidence_source,
  );

  return {
    is_vpo: vpo.value,
    vpo_evidence: vpo.evidence,
    vpo_evidence_source: vpo.evidence_source,
    tourist_license: tourist.value,
    tourist_license_evidence: tourist.evidence,
    tourist_license_evidence_source: tourist.evidence_source,
    confidence: clamp01(typeof o.confidence === "number" ? o.confidence : 0),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/** A boolean claim that only survives as `true` when a literal quote backs it. */
function evidenceGuardedBool(
  rawValue: unknown,
  rawEvidence: unknown,
  rawSource: unknown,
): { value: boolean; evidence: string; evidence_source: string | null } {
  const claimed = rawValue === true;
  const evidence = typeof rawEvidence === "string" ? rawEvidence : "";
  const source =
    typeof rawSource === "string" && rawSource.trim() !== "" ? rawSource : null;
  const value = claimed && evidence.trim() !== "";
  return {
    value,
    evidence: value ? evidence : "",
    evidence_source: value ? source : null,
  };
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 * `contentHash` defaults to NULL for direct callers — see location.ts.
 */
export async function saveOpportunityAssessment(
  propertyId: number,
  result: OpportunityResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'opportunity', $2::jsonb, $3, $4, $5, $6, NOW())
     ON CONFLICT ON CONSTRAINT ai_assessment_property_key
     DO UPDATE SET result = EXCLUDED.result,
                   confidence = EXCLUDED.confidence,
                   model = EXCLUDED.model,
                   content_hash = EXCLUDED.content_hash,
                   generated_at = EXCLUDED.generated_at`,
    [
      propertyId,
      JSON.stringify(result),
      result.confidence,
      model,
      OPPORTUNITY_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/** Read the cached verdict for a property, if one exists. */
export async function getOpportunityAssessment(
  propertyId: number,
): Promise<CachedAssessment<OpportunityResult> | null> {
  return getLatestAssessment<OpportunityResult>(
    propertyId,
    "opportunity",
    OPPORTUNITY_PROMPT_VERSION,
  );
}

/** Discriminated outcome of `assessPropertyOpportunity` — see its doc. */
export type OpportunityOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; result: OpportunityResult };

/**
 * Assess one property end-to-end (#542): delegates to the merged `triage`
 * flow (`lib/ai-assessment/triage.ts`) and returns just the `opportunity`
 * slice — every existing caller keeps this exact signature/return type. The
 * terreno exclusion (#398, owner decision — the axis doesn't apply to a bare
 * plot) is now decided inside `assessPropertyTriage` (same
 * `opportunityApplies`/`locationApplies` rule), surfaced here as the
 * `not_applicable` outcome.
 *
 * Throws `NoListingsError` when the property has no live listings, OR when every
 * live listing has no description (see `loadPropertyListings`) — same 404 signal
 * the other flows use. Throws `AssessmentParkedError` when specifically the
 * `opportunity` axis is parked (D-104).
 */
export async function assessPropertyOpportunity(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<OpportunityOutcome> {
  const triage = await assessPropertyTriage(propertyId, opts);
  const axis = triage.opportunity;
  switch (axis.status) {
    case "ok":
      logCacheOutcome("opportunity", propertyId, axis.fromCache);
      return { skipped: false, result: axis.result };
    case "not_applicable":
      // Terreno exclusion (#398, owner decision) — a plot has no VPO/tourist-
      // licence reading in the same sense.
      return { skipped: true, reason: "El eje 'opportunity' no aplica a un terreno/solar." };
    case "parked":
      throw new AssessmentParkedError(propertyId, "opportunity", axis.failCount, axis.lastError);
    case "error":
      throw axis.error;
  }
}
