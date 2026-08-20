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
import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_SELECTION_FLOWS,
  assessmentEligibleClause,
  selectionFlowValues,
  missingCurrentVerdictClause,
} from "../eligibility";
import { OCCUPANCY_PROMPT_VERSION } from "../occupancy";
import { CONDITION_PROMPT_VERSION } from "../condition";
import { REDFLAGS_PROMPT_VERSION } from "../redflags";
import { LOCATION_PROMPT_VERSION } from "../location";
import { OPPORTUNITY_PROMPT_VERSION } from "../opportunity";

describe("ASSESSMENT_SELECTION_FLOWS", () => {
  it("is occupancy/condition/redflags/location/opportunity at their current prompt versions (extract excluded, F-9/#542)", () => {
    expect(ASSESSMENT_SELECTION_FLOWS).toEqual([
      { type: "occupancy", version: OCCUPANCY_PROMPT_VERSION },
      { type: "condition", version: CONDITION_PROMPT_VERSION },
      { type: "redflags", version: REDFLAGS_PROMPT_VERSION },
      { type: "location", version: LOCATION_PROMPT_VERSION },
      { type: "opportunity", version: OPPORTUNITY_PROMPT_VERSION },
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
    expect(valuesSql).toBe("($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)");
    expect(params).toEqual([
      "occupancy",
      OCCUPANCY_PROMPT_VERSION,
      "condition",
      CONDITION_PROMPT_VERSION,
      "redflags",
      REDFLAGS_PROMPT_VERSION,
      "location",
      LOCATION_PROMPT_VERSION,
      "opportunity",
      OPPORTUNITY_PROMPT_VERSION,
    ]);
  });

  it("respects a non-1 start index", () => {
    expect(selectionFlowValues(3).valuesSql).toBe(
      "($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)",
    );
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

  it("#542: never counts location/opportunity as missing for a terreno (D-095/#398 — no row is ever written for them)", () => {
    const { valuesSql } = selectionFlowValues(1);
    const sql = missingCurrentVerdictClause("p", valuesSql);
    expect(sql).toContain("f.atype NOT IN ('location', 'opportunity')");
    expect(sql).toContain("p.property_type IS DISTINCT FROM 'terreno'");
  });
});
