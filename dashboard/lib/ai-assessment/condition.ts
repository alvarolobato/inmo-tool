/**
 * #26 — renovation/condition assessment, per deduplicated property.
 *
 * Answers "does this need reform, and of what kind?" — decision-critical for
 * a flip-type thesis and cost-relevant for any thesis, and like occupancy
 * (#25) usually only available as unstructured description text.
 *
 * Follows #25's established shape rather than inventing a parallel one (see
 * `lib/ai-assessment/occupancy.ts` for the full rationale, and
 * `lib/ai-assessment/shared.ts` for the plumbing this file reuses):
 *
 *  1. **Per property, after dedup.** The same flat listed on three portals
 *     has one true condition, and one seller may mention "a reformar" while
 *     another's ad stays silent on it — reading every merged advert at once
 *     is strictly better evidence than reading any single one (the same
 *     argument #25 makes for occupancy, now applied here per the #156-review
 *     carryover: "the same 'one portal omits what another discloses'
 *     argument applies to condition and red flags").
 *
 *  2. **Silence has no safe default.** Unlike occupancy's transaction/
 *     ownership axes — where nobody sells a debt or a bare share without
 *     saying so, so silence itself is weak evidence of the ordinary case —
 *     there is no market convention that a seller who doesn't mention
 *     condition therefore has a renovated flat. Silence here means "we don't
 *     know", i.e. `unclear`, exactly like occupancy's eje-1 (`vacant` vs
 *     `tenanted`). No `silenceDefault` is passed to `parseVerdict`.
 *
 * Server-only: imports lib/db-write (the `pg` client) via shared.ts. Never
 * import from a client component.
 */

import { sql } from "@/lib/db-write";
import { assessCondition } from "@/lib/llm";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";
import {
  NoListingsError,
  loadPropertyListings,
  parseVerdict,
  stripCodeFence,
} from "./shared";
import { getOrCompute, getLatestAssessment, logCacheOutcome, type CachedAssessment } from "./cache";

export { NoListingsError, loadPropertyListings };

/**
 * Prompt version. Bump when the condition prompt changes in a way that could
 * change a verdict, so `ai_assessment`'s unique key treats the new output as
 * a distinct row rather than colliding with a verdict the old prompt
 * produced (same convention as `OCCUPANCY_PROMPT_VERSION`).
 */
export const CONDITION_PROMPT_VERSION = "condition/v1";

/**
 * Renovation-state vocabulary (issue #26 technical approach #1). Kept to
 * exactly these four — no `buen_estado`/`a_rehabilitar` granularity beyond
 * what the issue specifies, so the badge vocabulary in `lib/candidates.ts`
 * stays a closed set that matches what this flow can actually emit.
 */
export const CONDITION_CATEGORIES = [
  "reformado",
  "a_reformar",
  "obra_nueva",
  "unclear",
] as const;

export type ConditionCategory = (typeof CONDITION_CATEGORIES)[number];

/**
 * Single-axis result. Flattened (not wrapped in a nested `verdict` object
 * like occupancy's three axes) because there is only one axis here — nesting
 * would just be `result.verdict.value` for no benefit. Still carries the same
 * evidence-quoting fields occupancy's `Verdict<T>` does (#26 technical
 * approach #2: "same evidence-quoting requirement as task 4.2"), because a
 * property-level assessment over several adverts needs to say which advert a
 * quote came from.
 */
export interface ConditionResult {
  condition: ConditionCategory;
  confidence: number;
  /** Literal quote from one advert, or "" when nothing could be cited. */
  evidence: string;
  /** Which portal that quote came from, so the investor can go and check it. */
  evidence_source: string | null;
  /**
   * Specific concerns mentioned in text (e.g. "instalación eléctrica
   * antigua", "humedad", "necesita baño nuevo") — issue #26 explicitly wants
   * these flagged individually, not collapsed into the coarse category label.
   */
  issues: string[];
  reasoning: string;
}

/** Parse and validate the model's JSON into the condition result. */
export function parseConditionResult(raw: string): ConditionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(`Condition flow returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Condition flow returned a non-object JSON value.");
  }

  const o = parsed as Record<string, unknown>;

  // No silenceDefault: unlike occupancy's ejes 2/3, there is no market
  // convention that silence about condition means "reformado" — silence
  // degrades straight to `unclear` with zero confidence via `known === false`.
  const rawVerdict = parseVerdict(o, "condition", CONDITION_CATEGORIES, "unclear");

  // Code-side "no citation, no assertion" backstop (#168 review, also-fix).
  // Condition was the only one of the three #25/#26/#27 flows without one:
  // redflags drops an uncited flag outright (redflags.ts), and occupancy's
  // ejes 2/3 only assert from silence via a deliberate, confidence-capped
  // exception (parseVerdict's `silenceDefault`). Condition has no legitimate
  // silence-implied default at all, so ANY non-`unclear` value with no
  // evidence is not "we looked and it's fine" — it's exactly what
  // ASSESSMENT_RULES rule 3 forbids ("si no puedes citar nada, no afirmes
  // nada"). This matters more here than for redflags: condition drives a
  // visible card badge, which uncited red flags never do.
  const verdict =
    rawVerdict.value !== "unclear" && rawVerdict.evidence.trim() === ""
      ? { ...rawVerdict, value: "unclear" as const, confidence: 0 }
      : rawVerdict;

  const issues = Array.isArray(o.issues)
    ? o.issues.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  return {
    condition: verdict.value,
    confidence: verdict.confidence,
    evidence: verdict.evidence,
    evidence_source: verdict.evidence_source,
    issues,
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * Persist a verdict, replacing any prior one for the same prompt version.
 * `contentHash` (#30) defaults to NULL for direct callers that don't compute
 * one — see occupancy.ts's `saveOccupancyAssessment` doc for the same note.
 */
export async function saveConditionAssessment(
  propertyId: number,
  result: ConditionResult,
  model: string | null,
  contentHash: string | null = null,
): Promise<void> {
  await sql(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, content_hash, generated_at)
     VALUES ($1, 'condition', $2::jsonb, $3, $4, $5, $6, NOW())
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
      CONDITION_PROMPT_VERSION,
      contentHash,
    ],
  );
}

/**
 * Read the cached verdict for a property, if one exists.
 * #30: latest row regardless of prompt_version, with `stale` — see
 * occupancy.ts's `getOccupancyAssessment` doc for the full rationale.
 */
export async function getConditionAssessment(
  propertyId: number,
): Promise<CachedAssessment<ConditionResult> | null> {
  return getLatestAssessment<ConditionResult>(
    propertyId,
    "condition",
    CONDITION_PROMPT_VERSION,
  );
}

/**
 * Assess one property end-to-end: load its merged listings, ask the model
 * (unless an unchanged verdict is already cached — #30), validate, persist.
 *
 * Throws `NoListingsError` when the property has no live listings, OR when
 * every live listing has no description (see `loadPropertyListings`) — in
 * both cases there is nothing to read, and writing a verdict (even
 * `unclear`) would misrepresent "we never looked" as "we looked and could
 * not tell".
 */
export async function assessPropertyCondition(
  propertyId: number,
  opts?: { requestId?: string | null; ctx?: LlmAgenticContext },
): Promise<ConditionResult> {
  const listings = await loadPropertyListings(propertyId);
  if (listings.length === 0) throw new NoListingsError(propertyId);

  const { result, fromCache } = await getOrCompute<ConditionResult>(
    propertyId,
    "condition",
    CONDITION_PROMPT_VERSION,
    listings,
    async () => {
      const { text, model } = await assessCondition(listings, opts);
      return { result: parseConditionResult(text), model };
    },
    saveConditionAssessment,
  );
  logCacheOutcome("condition", propertyId, fromCache);
  return result;
}
