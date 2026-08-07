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
 *
 * `v2` (#313): the prompt/output gained the `renovation_severity` sub-axis on
 * `a_reformar`. Bumping the version is the correct trigger for #308's batch
 * scheduler (`lib/ai-assessment/batch.ts` selects properties lacking a row at
 * the *current* prompt_version) to re-assess every property so pre-severity
 * `a_reformar` verdicts get a severity, rather than being read back stale as
 * if they had always carried the field (D-056).
 */
export const CONDITION_PROMPT_VERSION = "condition/v2";

// The renovation-state vocabulary lives in the leaf module
// `condition-vocabulary.ts` (no `pg`/LLM imports) so the redflags prompt builder
// can render it without the system-prompt → condition → llm → llm-context cycle
// (#407). Re-exported here so existing importers keep using
// `@/lib/ai-assessment/condition` unchanged.
export { CONDITION_CATEGORIES, type ConditionCategory } from "./condition-vocabulary";
import { CONDITION_CATEGORIES, type ConditionCategory } from "./condition-vocabulary";

/**
 * Renovation severity — the sub-axis on `a_reformar` (#313, D-056).
 *
 * The base `condition` enum deliberately stays a flat 4-value set (#26): its
 * two endpoints — `reformado` (no capex) and `obra_nueva` (new-build) — are
 * already unambiguous, and `unclear` is the no-signal case. What #45
 * (renovation cost & ARV tiering) needs, and what the flat enum could not
 * give it, is a light-vs-heavy split *within* `a_reformar`: "repintar y
 * cambiar cocina" and "reforma estructural completa" are the same category
 * today but map to very different cost bands.
 *
 * Modelled as a separate, additive field rather than by splitting the
 * `condition` enum, so every existing consumer of `condition` (the card badge
 * vocabulary in `lib/candidates.ts`, the hard filters in #310, the mock
 * fixtures) keeps reading exactly the same closed 4-value set it always did.
 *
 *  - `leve`     — cosmetic / light reform: paint, kitchen/bath refresh,
 *                 fixtures, flooring. No structural or whole-systems work.
 *  - `integral` — heavy / structural reform: "reforma integral", structural
 *                 mentions, multiple systems (electrical + plumbing + …) to
 *                 replace, gutting back to shell.
 *  - `unknown`  — the property IS `a_reformar` but the text doesn't say
 *                 enough to grade the depth of work. Same evidence discipline
 *                 as the base verdict: a severity is asserted only from cited
 *                 cues, never guessed, so "needs work, unclear how much" is a
 *                 first-class value rather than a coin-flip.
 *
 * `null` on the result means the axis does not apply — `condition` is not
 * `a_reformar` (a `reformado`/`obra_nueva`/`unclear` property has no
 * renovation to grade). #45 keys its cost bands off `leve`/`integral` and
 * treats `unknown`/`null` as "no graded estimate available".
 */
export const RENOVATION_SEVERITIES = ["leve", "integral", "unknown"] as const;

export type RenovationSeverity = (typeof RENOVATION_SEVERITIES)[number];

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
  /**
   * Depth of work when `condition === "a_reformar"` (#313, D-056), else
   * `null` (the axis does not apply to `reformado`/`obra_nueva`/`unclear`).
   * See `RENOVATION_SEVERITIES` for the value semantics. #45 maps this to
   * refurb cost bands.
   */
  renovation_severity: RenovationSeverity | null;
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
    renovation_severity: parseRenovationSeverity(o, verdict.value),
    confidence: verdict.confidence,
    evidence: verdict.evidence,
    evidence_source: verdict.evidence_source,
    issues,
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/**
 * Grade the depth of an `a_reformar` verdict (#313, D-056).
 *
 * Bound to the *final* condition (after the `unclear`-on-no-evidence backstop
 * above), not to whatever the model put in the JSON: severity only means
 * anything for `a_reformar`, so any other verdict — including one the backstop
 * just downgraded to `unclear` — yields `null`. When the verdict IS
 * `a_reformar`, an unrecognised or missing severity degrades to `"unknown"`
 * ("needs work, can't grade the depth") rather than being invented, mirroring
 * how `parseVerdict` degrades an unknown category rather than guessing.
 */
function parseRenovationSeverity(
  o: Record<string, unknown>,
  condition: ConditionCategory,
): RenovationSeverity | null {
  if (condition !== "a_reformar") return null;
  const raw = typeof o.renovation_severity === "string" ? o.renovation_severity : "";
  return raw === "leve" || raw === "integral" ? raw : "unknown";
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
