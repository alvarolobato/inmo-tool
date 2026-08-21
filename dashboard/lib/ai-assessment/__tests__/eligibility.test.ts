/**
 * #330 — the SHARED assessment-eligibility predicate, unit-level.
 *
 * These prove the fragment shape the scheduler (`batch.ts`) and the cost panel
 * (`lib/db/llm-health.ts`) both embed, WITHOUT a database:
 *
 *   - the selection-flow list is occupancy/condition/redflags only (extract
 *     self-gates and is NOT a backlog gate), so both call sites count the same
 *     population;
 *   - `assessmentEligibleClause` carries the #327 rule in full — the
 *     matched-candidate-of-an-active-profile stage AND the non-disabled active
 *     source stage — which is exactly the stage the old panel query was
 *     MISSING (the #330 divergence);
 *   - `selectionFlowValues` numbers its placeholders from a caller-supplied
 *     base so batch.ts (`$1..$6` then `$7` limit) and llm-health.ts (`$1..$6`)
 *     bind the same params.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ASSESSMENT_SELECTION_FLOWS,
  assessmentEligibleClause,
  selectionFlowValues,
  missingCurrentVerdictClause,
  pendingClause,
  parkGuardParams,
} from "../eligibility";
import { resetConfigCache } from "@/lib/system-config/loader";
import { OCCUPANCY_PROMPT_VERSION } from "../occupancy";
import { CONDITION_PROMPT_VERSION } from "../condition";
import { REDFLAGS_PROMPT_VERSION } from "../redflags";

describe("ASSESSMENT_SELECTION_FLOWS", () => {
  it("is occupancy/condition/redflags at their current prompt versions (extract excluded)", () => {
    expect(ASSESSMENT_SELECTION_FLOWS).toEqual([
      { type: "occupancy", version: OCCUPANCY_PROMPT_VERSION },
      { type: "condition", version: CONDITION_PROMPT_VERSION },
      { type: "redflags", version: REDFLAGS_PROMPT_VERSION },
    ]);
    expect(ASSESSMENT_SELECTION_FLOWS.map((f) => f.type)).not.toContain("extract");
  });
});

describe("assessmentEligibleClause", () => {
  const sql = assessmentEligibleClause("p");

  it("gates on a matched candidate of an ACTIVE (non-archived) profile — the #327 stage the panel was missing", () => {
    expect(sql).toContain("profile_listing_state pls");
    expect(sql).toContain("JOIN search_profile sp");
    expect(sql).toContain("pls.matched = true");
    expect(sql).toContain("sp.archived_at IS NULL");
  });

  it("gates on a readable active listing from a NON-DISABLED source (D-055)", () => {
    expect(sql).toContain("l.status = 'active'");
    expect(sql).toContain("COALESCE(TRIM(l.description), '') <> ''");
    expect(sql).toContain("NOT IN (SELECT source FROM disabled_sources)");
  });

  it("substitutes the given property alias", () => {
    expect(assessmentEligibleClause("e")).toContain("pls.property_id = e.id");
    expect(assessmentEligibleClause("e")).toContain("l.property_id = e.id");
  });
});

describe("selectionFlowValues", () => {
  it("numbers placeholders from the base index and returns flat [type, version, ...] params", () => {
    const { valuesSql, params } = selectionFlowValues(1);
    expect(valuesSql).toBe("($1, $2), ($3, $4), ($5, $6)");
    expect(params).toEqual([
      "occupancy",
      OCCUPANCY_PROMPT_VERSION,
      "condition",
      CONDITION_PROMPT_VERSION,
      "redflags",
      REDFLAGS_PROMPT_VERSION,
    ]);
  });

  it("respects a non-1 start index", () => {
    expect(selectionFlowValues(3).valuesSql).toBe("($3, $4), ($5, $6), ($7, $8)");
  });
});

describe("missingCurrentVerdictClause", () => {
  it("checks for a missing current-prompt-version verdict, on the given alias", () => {
    const { valuesSql } = selectionFlowValues(1);
    const sql = missingCurrentVerdictClause("e", valuesSql);
    expect(sql).toContain(`(VALUES ${valuesSql}) AS f(atype, ver)`);
    expect(sql).toContain("a.property_id = e.id");
    expect(sql).toContain("a.assessment_type = f.atype");
    expect(sql).toContain("a.prompt_version = f.ver");
  });
});

describe("#666/D-149 review finding 1: parkGuardParams", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it("returns $N-numbered params for the schema default (3 failures, 14-day decay) when nothing is configured", () => {
    const guard = parkGuardParams(5);
    expect(guard.maxFailuresParam).toBe("$5");
    expect(guard.decayDaysParam).toBe("$6");
    // The SAME threshold cache.ts's own getOrCompute enforces at spend-time
    // (DEFAULT_MAX_ASSESSMENT_FAILURES = 3) and the SAME decay window
    // (PARK_DECAY_DAYS = 14) — never a second hand-kept copy.
    expect(guard.params).toEqual(["3", "14"]);
  });

  it("respects a configured dashboard.assessment_max_failures override", () => {
    vi.stubEnv("DASHBOARD_ASSESSMENT_MAX_FAILURES", "5");
    resetConfigCache();
    expect(parkGuardParams(1).params).toEqual(["5", "14"]);
  });

  it("returns null params (no guard) when parking is disabled (assessment_max_failures = 0)", () => {
    vi.stubEnv("DASHBOARD_ASSESSMENT_MAX_FAILURES", "0");
    resetConfigCache();
    expect(parkGuardParams(5)).toEqual({
      maxFailuresParam: null,
      decayDaysParam: null,
      params: [],
    });
  });
});

describe("#666/D-149 review finding 1: pendingClause", () => {
  const { valuesSql } = selectionFlowValues(1);

  it("is identical to missingCurrentVerdictClause when the park guard is null (parking disabled)", () => {
    expect(pendingClause("p", valuesSql, null, null)).toBe(
      missingCurrentVerdictClause("p", valuesSql),
    );
  });

  it("folds a per-flow park guard INSIDE the same EXISTS as the missing-verdict check — not a separate top-level AND", () => {
    const sql = pendingClause("p", valuesSql, "$7", "$8");
    // The whole predicate is still ONE EXISTS over the per-flow VALUES list.
    expect(sql.match(/EXISTS \(/g)?.length).toBeGreaterThanOrEqual(2); // outer + missing-verdict
    expect(sql).toContain("ai_assessment_failure af");
    expect(sql).toContain("af.property_id = p.id");
    // Scoped to the SAME flow (`f.atype`) the missing-verdict check is
    // scoped to — the fix for the review's "parked on extract blocks
    // occupancy too" gap: a park guard NOT correlated to `f.atype` would
    // exclude a property on account of a completely unrelated flow.
    expect(sql).toContain("af.assessment_type = f.atype");
    expect(sql).toContain("af.fail_count >= $7");
    expect(sql).toContain("af.last_failed_at > now() - ($8 || ' days')::interval");
  });

  it("substitutes a different alias throughout, including in the park guard", () => {
    const sql = pendingClause("e", valuesSql, "$7", "$8");
    expect(sql).toContain("a.property_id = e.id");
    expect(sql).toContain("af.property_id = e.id");
  });
});
