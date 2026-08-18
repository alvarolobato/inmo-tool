// @vitest-environment node
/**
 * F-7 pre-bump cost preview — mocked-DB unit tests (docs/roadmap/llm-batching-plan.md
 * Phase 0, PR 0b). Complements bump-preview.integration.test.ts (real Postgres,
 * proves the shared-eligibility-fragment composition) by pinning the pure
 * assembly logic — the sum-of-known-flows contract and the SQL/params shape —
 * without needing a DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mockQuery }));

import { previewBumpCost } from "../bump-preview";

/** Helper: a rowMode-array QueryResult. */
function result(rows: unknown[][]): { columns: string[]; rows: unknown[][] } {
  return { columns: [], rows };
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("previewBumpCost", () => {
  it("issues the counts query and the avg-cost query per flow, with the (type, version) bound as params", async () => {
    mockQuery
      .mockResolvedValueOnce(result([[10, 4]])) // counts: eligible=10, reopened=4
      .mockResolvedValueOnce(result([["0.05"]])); // avg cost

    const summary = await previewBumpCost([
      { assessmentType: "occupancy", hypotheticalVersion: "occupancy/v3" },
    ]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [countsSql, countsParams] = mockQuery.mock.calls[0];
    // Embeds the SAME shared fragments the scheduler/coverage panel use —
    // not a re-derived copy (#330's whole point).
    expect(countsSql).toContain("profile_listing_state pls");
    expect(countsSql).toContain("FROM property p");
    expect(countsSql).toContain("(VALUES ($1, $2)) AS f(atype, ver)");
    expect(countsParams).toEqual(["occupancy", "occupancy/v3"]);

    const [avgSql, avgParams] = mockQuery.mock.calls[1];
    expect(avgSql).toContain("FROM llm_usage");
    expect(avgSql).toContain("endpoint = $1");
    expect(avgParams).toEqual(["occupancy"]);

    expect(summary.flows).toEqual([
      {
        assessmentType: "occupancy",
        hypotheticalVersion: "occupancy/v3",
        eligible: 10,
        reopened: 4,
        avg_cost_eur_per_call: 0.05,
        projected_cost_eur: 4 * 0.05,
      },
    ]);
    expect(summary.total_projected_cost_eur).toBeCloseTo(0.2, 6);
  });

  it("sums only the flows with a known average cost, excluding (not zeroing) unknown ones", async () => {
    mockQuery
      // flow A: known cost
      .mockResolvedValueOnce(result([[100, 50]]))
      .mockResolvedValueOnce(result([["0.10"]]))
      // flow B: no recent llm_usage rows -> avg cost null
      .mockResolvedValueOnce(result([[20, 20]]))
      .mockResolvedValueOnce(result([[null]]));

    const summary = await previewBumpCost([
      { assessmentType: "condition", hypotheticalVersion: "condition/v3" },
      { assessmentType: "location", hypotheticalVersion: "location/v2" },
    ]);

    const a = summary.flows.find((f) => f.assessmentType === "condition")!;
    const b = summary.flows.find((f) => f.assessmentType === "location")!;
    expect(a.projected_cost_eur).toBeCloseTo(50 * 0.1, 6);
    expect(b.avg_cost_eur_per_call).toBeNull();
    expect(b.projected_cost_eur).toBeNull();
    // Total counts only flow A — flow B's unknown cost is excluded, not
    // treated as €0 (which would silently under-report the total).
    expect(summary.total_projected_cost_eur).toBeCloseTo(50 * 0.1, 6);
  });

  it("total is null only when EVERY requested flow has an unknown cost", async () => {
    mockQuery
      .mockResolvedValueOnce(result([[5, 5]]))
      .mockResolvedValueOnce(result([[null]]));

    const summary = await previewBumpCost([
      { assessmentType: "extract", hypotheticalVersion: "extract/v2" },
    ]);

    expect(summary.flows[0].projected_cost_eur).toBeNull();
    expect(summary.total_projected_cost_eur).toBeNull();
  });

  it("returns an empty summary for an empty request list, without querying", async () => {
    const summary = await previewBumpCost([]);
    expect(summary.flows).toEqual([]);
    expect(summary.total_projected_cost_eur).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
