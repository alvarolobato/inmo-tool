import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import { diagnoseZeroCandidates, findNearestProperty } from "../profile-diagnostics";
import { resetPool } from "@/lib/db-write";
import type { SearchProfileRow } from "@/lib/profiles-schema";

function profile(overrides: Partial<SearchProfileRow> = {}): SearchProfileRow {
  return {
    id: 1,
    name: "Test",
    scope: {
      geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    last_materialized_at: "2026-08-01T00:00:00.000Z",
    last_viewed_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  mockQuery.mockReset();
  mockEnd.mockClear();
  await resetPool();
});

describe("findNearestProperty", () => {
  it("returns the bounded (200km box) result when it finds one", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, distance_km: "3.5" }] });
    const result = await findNearestProperty([40.4, -3.7]);
    expect(result).toEqual({ propertyId: 42, distanceKm: 3.5 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to the unbounded full-table scan when the bounded box is empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // bounded box: nothing
      .mockResolvedValueOnce({ rows: [{ id: 7, distance_km: "412.9" }] }); // unbounded fallback
    const result = await findNearestProperty([40.4, -3.7]);
    expect(result).toEqual({ propertyId: 7, distanceKm: 412.9 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns null when literally nothing exists anywhere (both queries empty)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await findNearestProperty([40.4, -3.7]);
    expect(result).toBeNull();
  });
});

describe("diagnoseZeroCandidates", () => {
  it("returns {kind: 'not_zero', matchedCount} without running the funnel when matched_count > 0 (defends against a stale caller)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 4 }] }); // matched count check
    const diagnosis = await diagnoseZeroCandidates(profile());
    expect(diagnosis).toEqual({ kind: "not_zero", matchedCount: 4 });
    // Only the one guard query ran — no funnel stage query.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns never_materialized before running any funnel query", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // matched count check
    const diagnosis = await diagnoseZeroCandidates(profile({ last_materialized_at: null }));
    expect(diagnosis).toEqual({ kind: "never_materialized" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Issue #659/D-147: an "everywhere" scope has no center — this must not
  // crash trying to dereference `.center` for findNearestProperty/
  // getAreaCoverage, and must not fabricate a radius or a coverage claim.
  describe("everywhere geography — no center to diagnose against (issue #659)", () => {
    const everywhereProfile = profile({
      scope: { geography: { type: "everywhere" }, property_types: "all", hard_exclusions: {} },
    });

    it("returns geography_empty with null radiusKm/nearest/areaCoverage, never crashes on a missing center", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // matched count
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // geography-stage count (sale EXISTS only)
        .mockResolvedValueOnce({ rows: [{ max: "2026-08-10T00:00:00.000Z" }] }); // connector last run

      const diagnosis = await diagnoseZeroCandidates(everywhereProfile);

      expect(diagnosis).toEqual({
        kind: "geography_empty",
        radiusKm: null,
        nearest: null,
        connectorLastRunFinishedAt: "2026-08-10T00:00:00.000Z",
        areaCoverage: null,
      });
    });

    it("never calls findNearestProperty/getAreaCoverage (only 3 queries total: matched, geography count, connector recency)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ max: null }] });

      await diagnoseZeroCandidates(everywhereProfile);

      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });

  it("exclusion_empty names BOTH exclusions when neither alone zeroes the count but the combination does (interaction effect)", async () => {
    const p = profile({
      scope: {
        geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: { requires_elevator: true, excludes_ground_floor: true },
      },
    });
    let call = 0;
    mockQuery.mockImplementation((sqlText: string) => {
      call += 1;
      if (sqlText.includes("profile_listing_state")) return Promise.resolve({ rows: [{ count: 0 }] }); // matched=0
      if (call === 2) return Promise.resolve({ rows: [{ count: 5 }] }); // geography
      if (call === 3) return Promise.resolve({ rows: [{ count: 5 }] }); // type
      if (call === 4) return Promise.resolve({ rows: [{ count: 5 }] }); // price_size
      if (call === 5) return Promise.resolve({ rows: [{ count: 0 }] }); // exclusions (combined) = 0
      // Isolated per-exclusion counts: neither alone is 0 (interaction only).
      return Promise.resolve({ rows: [{ count: 2 }] });
    });
    const diagnosis = await diagnoseZeroCandidates(p);
    expect(diagnosis.kind).toBe("exclusion_empty");
    if (diagnosis.kind === "exclusion_empty") {
      expect(diagnosis.excludedBy.sort()).toEqual(["el filtro de ascensor", "el filtro de planta baja"].sort());
    }
  });
});
