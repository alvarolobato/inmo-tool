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
import { LOCATION_PROMPT_VERSION } from "./location";
import { OPPORTUNITY_PROMPT_VERSION } from "./opportunity";

export { DISABLED_SOURCES_CTE };

/**
 * The flows whose ABSENCE makes a property "pending" (part of the backlog).
 *
 * occupancy/condition/redflags/location/opportunity — `extract` is excluded
 * because it self-gates (`needsExtraction`): a fully-structured property never
 * gets an `extract` row, so keying selection on a missing `extract` row would
 * re-select the same properties forever. This mirrors `SELECTION_FLOWS` in
 * `batch.ts` and the panel's own copy in `llm-health.ts`; defining it once
 * here keeps the scheduler's selection and the panel's backlog counting the
 * SAME population.
 *
 * `location`/`opportunity` (F-9, #542) rode in with the `triage` merge: before
 * it, a mid-pass budget/circuit/quota stop landing after `condition` could
 * leave those two permanently unwritten for every property on the page (see
 * `batch.ts`'s old flow-major-order comment) — now they run in the SAME call
 * as `condition`, a selection flow, so that gap closes by construction. A
 * `terreno` never gets a `location`/`opportunity` row BY DESIGN (D-095/#398)
 * — `missingCurrentVerdictClause` below carries the matching exclusion so a
 * terreno is never counted as perpetually "pending" for those two axes.
 */
export const ASSESSMENT_SELECTION_FLOWS: ReadonlyArray<{
  type: string;
  version: string;
}> = [
  { type: "occupancy", version: OCCUPANCY_PROMPT_VERSION },
  { type: "condition", version: CONDITION_PROMPT_VERSION },
  { type: "redflags", version: REDFLAGS_PROMPT_VERSION },
  { type: "location", version: LOCATION_PROMPT_VERSION },
  { type: "opportunity", version: OPPORTUNITY_PROMPT_VERSION },
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
 *
 * `location`/`opportunity` NEVER get an `ai_assessment` row for a `terreno`
 * property — that is BY DESIGN (D-095/#398: the axis doesn't apply to a bare
 * plot), not a gap to fill. Without the guard below, a terreno would satisfy
 * this predicate FOREVER for those two flows and — since selection orders
 * `p.created_at ASC` (`batch.ts::selectPropertiesNeedingAssessment`) — the
 * oldest such properties would permanently occupy the head of the backlog
 * queue, starving every other property. So a `(location|opportunity, *)` pair
 * is treated as already-satisfied (never "missing") for a terreno `alias`;
 * every other pair is unaffected by this guard (`f.atype NOT IN (...)` is
 * true for them, short-circuiting the whole `OR` to true regardless of
 * `property_type`).
 */
export function missingCurrentVerdictClause(alias: string, valuesSql: string): string {
  return `EXISTS (
        SELECT 1
          FROM (VALUES ${valuesSql}) AS f(atype, ver)
         WHERE (f.atype NOT IN ('location', 'opportunity') OR ${alias}.property_type IS DISTINCT FROM 'terreno')
           AND NOT EXISTS (
                 SELECT 1 FROM ai_assessment a
                  WHERE a.property_id = ${alias}.id
                    AND a.assessment_type = f.atype
                    AND a.prompt_version = f.ver
               )
      )`;
}
