/**
 * F-7 — pre-bump cost preview (docs/roadmap/llm-batching-plan.md Phase 0).
 *
 * A `*_PROMPT_VERSION` bump silently reopens the ENTIRE matched pool as
 * backlog for that flow (docs/roadmap/llm-cost-optimization.md F-7) — the
 * batching plan measures this at ~1,918 properties × N flows for the Phase 2
 * wave. This answers "how much would THIS bump cost?" BEFORE the bump lands,
 * so it stops being a surprise step-function in spend and becomes a number an
 * agent/operator reviews before merging (see the plan's §2 "bumps ship in
 * coordinated waves... only after the F-7 cost preview has been run").
 *
 * Reuses, rather than re-derives:
 *   - `assessmentEligibleClause` / `missingCurrentVerdictClause`
 *     (`./eligibility`, #330's shared fragment) — the SAME predicate the
 *     scheduler selects with and the coverage panel counts with, just probed
 *     against a HYPOTHETICAL (type, version) pair instead of the live
 *     `ASSESSMENT_SELECTION_FLOWS` constant.
 *   - `projectBacklogCostEur` (`@/lib/llm-health`) for the €arithmetic —
 *     no second cost formula.
 *
 * Server-only (imports `@/lib/db`). Read-only: every query is a SELECT.
 */

import { query } from "@/lib/db";
import { DISABLED_SOURCES_CTE, assessmentEligibleClause, missingCurrentVerdictClause } from "./eligibility";
import { projectBacklogCostEur } from "@/lib/llm-health";

export interface BumpPreviewRequest {
  /** `ai_assessment.assessment_type` (e.g. "occupancy", "condition", "redflags", "location", "opportunity"). */
  assessmentType: string;
  /**
   * The `prompt_version` the bump WOULD write. Ordinarily a version that has
   * never been assessed under yet — in that (the common) case `reopened`
   * simply equals `eligible`, since nothing has a verdict at a version that
   * doesn't exist yet. The query still runs the real predicate rather than
   * short-circuiting to `eligible`, so a preview re-run against a
   * partially-applied bump (some properties already reassessed) stays
   * accurate.
   */
  hypotheticalVersion: string;
}

export interface BumpPreviewResult extends BumpPreviewRequest {
  /** Properties eligible for assessment at all (assessmentEligibleClause) — independent of the hypothetical version. */
  eligible: number;
  /** Of those, how many would lack a verdict at the hypothetical version — the backlog the bump reopens for this flow. */
  reopened: number;
  /** 7d average € `llm_usage.estimated_cost_usd` per call logged against this flow's endpoint, or null when nothing was logged in the window. */
  avg_cost_eur_per_call: number | null;
  /** `reopened × avg_cost_eur_per_call`, or null when the average is unknown — never a fabricated €0 (mirrors `projectBacklogCostEur`'s own contract). */
  projected_cost_eur: number | null;
}

export interface BumpPreviewSummary {
  flows: BumpPreviewResult[];
  /**
   * Sum of every flow's `projected_cost_eur`. Null only when NONE of the
   * requested flows have a costable average (no llm_usage rows for any of
   * them in the last 7d) — a flow with an unknown cost is simply excluded
   * from the sum rather than forcing the whole total to null, so one
   * never-run flow doesn't hide the cost of the others.
   */
  total_projected_cost_eur: number | null;
}

/** Coerce a pg value (number | numeric-string | null) to a number, 0 on null/non-finite. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce a pg value to a nullable number — unlike `num`, null/non-finite stays null (no €0 fabrication). */
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function previewOneFlow(req: BumpPreviewRequest): Promise<BumpPreviewResult> {
  // `missingCurrentVerdictClause` expects a `(VALUES ...)` fragment; a single
  // hypothetical (type, version) pair is exactly a one-row VALUES list, bound
  // to $1/$2 — the same shape `selectionFlowValues` builds for the real
  // multi-flow case, just for one flow.
  const [countsRes, avgCostRes] = await Promise.all([
    query(
      `WITH ${DISABLED_SOURCES_CTE}
       SELECT
         COUNT(*) FILTER (WHERE ${assessmentEligibleClause("p")}) AS eligible,
         COUNT(*) FILTER (
           WHERE ${assessmentEligibleClause("p")}
             AND ${missingCurrentVerdictClause("p", "($1, $2)")}
         ) AS reopened
         FROM property p`,
      [req.assessmentType, req.hypotheticalVersion],
    ),
    query(
      `SELECT AVG(estimated_cost_usd)::text AS avg_cost
         FROM llm_usage
        WHERE endpoint = $1
          AND created_at >= NOW() - INTERVAL '7 days'`,
      [req.assessmentType],
    ),
  ]);

  const eligible = num(countsRes.rows[0]?.[0]);
  const reopened = num(countsRes.rows[0]?.[1]);
  const avgCostEurPerCall = nullableNum(avgCostRes.rows[0]?.[0]);

  return {
    ...req,
    eligible,
    reopened,
    avg_cost_eur_per_call: avgCostEurPerCall,
    projected_cost_eur: projectBacklogCostEur(reopened, avgCostEurPerCall),
  };
}

/**
 * Preview the cost of bumping one or more `*_PROMPT_VERSION`s BEFORE merging
 * the bump. Independent per-flow reads run in parallel — cheap enough to run
 * ad hoc (this is not a polled panel, see `dashboard/scripts/preview-bump-cost.ts`).
 */
export async function previewBumpCost(requests: BumpPreviewRequest[]): Promise<BumpPreviewSummary> {
  const flows = await Promise.all(requests.map(previewOneFlow));
  const known = flows.filter((f) => f.projected_cost_eur !== null);
  const total_projected_cost_eur =
    known.length > 0 ? known.reduce((s, f) => s + (f.projected_cost_eur ?? 0), 0) : null;
  return { flows, total_projected_cost_eur };
}
