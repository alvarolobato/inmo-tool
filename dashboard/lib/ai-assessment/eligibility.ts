/**
 * Shared "is this property eligible for AI assessment?" SQL predicate (#330).
 *
 * Two call sites need the SAME notion of eligibility, and they had drifted:
 *
 *   - The SCHEDULER (`batch.ts::selectPropertiesNeedingAssessment`, #326/#327)
 *     narrowed selection to *profile-matched candidates of an active profile*
 *     with a readable listing from a *non-disabled source* — so the LLM is
 *     never spent on a property the investor will never see.
 *   - The COST PANEL (`lib/db/llm-health.ts`, #329) computed the assessment
 *     backlog/coverage with an OLDER, looser rule (any active listing with a
 *     non-empty description), so its "eligible / backlog / coverage" numbers
 *     disagreed with what the scheduler actually assesses (#330).
 *
 * The fix: ONE predicate, built here, used verbatim by both. Keeping the SQL
 * identical *by construction* (a shared fragment, not two hand-kept copies) is
 * the whole point — the panel can no longer drift from reality.
 *
 * The predicate is expressed as SQL-string helpers rather than a runnable query
 * because the two callers embed it differently (one as a `WHERE` on `property p`
 * with an `ORDER BY`/`LIMIT`, the other inside an `eligible`/`pending` CTE pair)
 * — but every fragment they compose is defined here.
 *
 * Requires `DISABLED_SOURCES_CTE` to be in scope (re-exported here so a caller
 * imports both from one module).
 */

import { DISABLED_SOURCES_CTE, activeSourceClause } from "@/lib/db/source-active";
import { OCCUPANCY_PROMPT_VERSION } from "./occupancy";
import { CONDITION_PROMPT_VERSION } from "./condition";
import { REDFLAGS_PROMPT_VERSION } from "./redflags";
import { maxAssessmentFailures, PARK_DECAY_DAYS } from "./cache";

export { DISABLED_SOURCES_CTE };

/**
 * The flows whose ABSENCE makes a property "pending" (part of the backlog).
 *
 * Deliberately occupancy/condition/redflags only — `extract` is excluded
 * because it self-gates (`needsExtraction`): a fully-structured property never
 * gets an `extract` row, so keying selection on a missing `extract` row would
 * re-select the same properties forever. This mirrors `SELECTION_FLOWS` in
 * `batch.ts` (which derives the same three by filtering `extract` out of the
 * run list) and the panel's own copy in `llm-health.ts`; defining it once here
 * keeps the scheduler's selection and the panel's backlog counting the SAME
 * population.
 */
export const ASSESSMENT_SELECTION_FLOWS: ReadonlyArray<{
  type: string;
  version: string;
}> = [
  { type: "occupancy", version: OCCUPANCY_PROMPT_VERSION },
  { type: "condition", version: CONDITION_PROMPT_VERSION },
  { type: "redflags", version: REDFLAGS_PROMPT_VERSION },
];

/**
 * SQL predicate: is property `<alias>` ELIGIBLE for AI assessment? (#327 rule.)
 *
 *   - Stage 1: a matched candidate of at least one ACTIVE (non-archived)
 *     profile — a `profile_listing_state` row with `matched = true` whose
 *     `search_profile` is not archived.
 *   - Stage 2a: has at least one ACTIVE listing carrying a non-empty
 *     description from a non-disabled source (D-055).
 *
 * Requires `DISABLED_SOURCES_CTE` in scope (for `activeSourceClause`).
 */
export function assessmentEligibleClause(alias: string): string {
  return `EXISTS (
        -- Stage 1: matched candidate of at least one ACTIVE profile.
        SELECT 1
          FROM profile_listing_state pls
          JOIN search_profile sp ON sp.id = pls.profile_id
         WHERE pls.property_id = ${alias}.id
           AND pls.matched = true
           AND sp.archived_at IS NULL
      )
      AND EXISTS (
        -- Stage 2a: something readable exists, from an ACTIVE source.
        SELECT 1 FROM listing l
         WHERE l.property_id = ${alias}.id
           AND l.status = 'active'
           AND COALESCE(TRIM(l.description), '') <> ''
           AND ${activeSourceClause("l")}
      )`;
}

/**
 * Build the `(VALUES ...)` fragment + bound params for the selection flows,
 * starting at parameter index `startIndex` (1-based, matching `pg`). Returns
 * the placeholders string and the flat `[type, version, ...]` params so both
 * callers number and bind them identically.
 */
export function selectionFlowValues(startIndex = 1): {
  valuesSql: string;
  params: string[];
} {
  const valuesSql = ASSESSMENT_SELECTION_FLOWS.map(
    (_f, i) => `($${startIndex + i * 2}, $${startIndex + i * 2 + 1})`,
  ).join(", ");
  const params = ASSESSMENT_SELECTION_FLOWS.flatMap((f) => [f.type, f.version]);
  return { valuesSql, params };
}

/**
 * SQL predicate: does property `<alias>` still LACK a current-prompt-version
 * verdict for at least one selection flow? (The "pending"/backlog condition,
 * on top of eligibility.) `valuesSql` is the fragment from
 * {@link selectionFlowValues}.
 */
export function missingCurrentVerdictClause(alias: string, valuesSql: string): string {
  return `EXISTS (
        SELECT 1
          FROM (VALUES ${valuesSql}) AS f(atype, ver)
         WHERE NOT EXISTS (
                 SELECT 1 FROM ai_assessment a
                  WHERE a.property_id = ${alias}.id
                    AND a.assessment_type = f.atype
                    AND a.prompt_version = f.ver
               )
      )`;
}

/**
 * Bound params for the parked-flow guard {@link pendingClause} takes — read
 * once by the caller so it can be included in the SAME params array as
 * {@link selectionFlowValues}'s.
 *
 * Returns `maxFailuresParam`/`decayDaysParam` as `null` (and no params) when
 * `dashboard.assessment_max_failures` is 0 — parking itself is disabled
 * (`cache.ts`'s own "retry forever" mode), so `pendingClause` should apply
 * NO park guard at all rather than one that can never match.
 *
 * `startIndex` is the next free `$N` — same numbering convention as
 * {@link selectionFlowValues}.
 */
export function parkGuardParams(startIndex: number): {
  maxFailuresParam: string | null;
  decayDaysParam: string | null;
  params: string[];
} {
  const maxFailures = maxAssessmentFailures();
  if (maxFailures <= 0) return { maxFailuresParam: null, decayDaysParam: null, params: [] };
  return {
    maxFailuresParam: `$${startIndex}`,
    decayDaysParam: `$${startIndex + 1}`,
    params: [String(maxFailures), String(PARK_DECAY_DAYS)],
  };
}

/**
 * SQL predicate: does property `<alias>` have at least one selection flow
 * that is BOTH missing a current-prompt-version verdict AND NOT actively
 * parked (#666/D-149 review finding 1)?
 *
 * A strict refinement of `missingCurrentVerdictClause`, not a bolt-on AND —
 * the park guard has to live INSIDE the per-flow `EXISTS`, correlated on
 * `f.atype`, not as an independent top-level clause. An earlier version of
 * this predicate excluded a property if it had ANY parked failure row for
 * ANY assessment type at all — which meant a property parked only on
 * `extract` (self-gating, not even a selection flow) would ALSO stop being
 * selected for perfectly healthy occupancy/condition/redflags work. Scoping
 * the guard to `af.assessment_type = f.atype` fixes that: a park on one flow
 * blocks re-selecting THAT flow, never an unrelated one.
 *
 * Before this predicate existed at all, `selectPropertiesNeedingAssessment`
 * had no notion of D-104's failure ledger — a property that hit
 * `assessment_max_failures` strikes on flow F stays selected FOREVER purely
 * because of F (it never gets an `ai_assessment` row for F, so the old
 * `missingCurrentVerdictClause` alone kept matching it), and selection
 * orders `created_at ASC` with a LIMIT, so a parked head-of-queue page
 * permanently blocks every property behind it from ever being selected — a
 * latent bug that #666's faster drain cadence turned from "a few wasted
 * selections an hour" into "hundreds," which is quota, not cost.
 *
 * APPROXIMATE, not hash-exact: `ai_assessment_failure` keys a park on
 * `content_hash` too, which this predicate can't recompute in SQL (that
 * would mean re-implementing `computeAssessmentContentHash` server-side).
 * So a property whose listing text changed AFTER a flow parked — which
 * SHOULD unpark that flow immediately on the new hash — stays excluded from
 * automatic re-selection for that flow until `PARK_DECAY_DAYS` elapses or a
 * manual `?force=1`, rather than being picked up on the very next tick.
 * Accepted deliberately: closing "the whole backlog can stall behind one
 * poison property forever" is worth a bounded, rare delay on "a changed
 * property's flow gets re-tried a few days later than it ideally would."
 *
 * `valuesSql` is {@link selectionFlowValues}'s fragment; `maxFailuresParam`/
 * `decayDaysParam` are {@link parkGuardParams}'s — pass `null` for both
 * (parking disabled) to fall back to exactly `missingCurrentVerdictClause`'s
 * behaviour, no guard at all.
 */
export function pendingClause(
  alias: string,
  valuesSql: string,
  maxFailuresParam: string | null,
  decayDaysParam: string | null,
): string {
  const parkGuard =
    maxFailuresParam !== null && decayDaysParam !== null
      ? `
           AND NOT EXISTS (
                 SELECT 1 FROM ai_assessment_failure af
                  WHERE af.property_id = ${alias}.id
                    AND af.assessment_type = f.atype
                    AND af.fail_count >= ${maxFailuresParam}
                    AND af.last_failed_at > now() - (${decayDaysParam} || ' days')::interval
               )`
      : "";
  return `EXISTS (
        SELECT 1
          FROM (VALUES ${valuesSql}) AS f(atype, ver)
         WHERE NOT EXISTS (
                 SELECT 1 FROM ai_assessment a
                  WHERE a.property_id = ${alias}.id
                    AND a.assessment_type = f.atype
                    AND a.prompt_version = f.ver
               )${parkGuard}
      )`;
}
