import { describe, it, expect } from "vitest";
import { summarizeNovedades } from "@/lib/novedades";
import type { ProfileOverviewEntry, ProfileOverviewMetrics } from "@/lib/profile-overview-types";
import type { SearchProfileRow } from "@/lib/profiles-schema";

function profile(id: number): SearchProfileRow {
  return {
    id,
    name: `Perfil ${id}`,
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
  };
}

function metrics(newCount: number): ProfileOverviewMetrics {
  return {
    matched_count: Math.max(newCount, 1),
    new_count: newCount,
    accepted_count: 0,
    rejected_count: 0,
    starred_count: 0,
    min_price: null,
    median_price: null,
    max_price: null,
    cold_start_count: 0,
    trained_count: 0,
    training_example_count: null,
    model_trained: false,
    gross_yield_median_pct: null,
    flagged_count: 0,
    thumbnails: [],
  };
}

function ok(id: number, newCount: number): ProfileOverviewEntry {
  return { ok: true, profile: profile(id), metrics: metrics(newCount) };
}

function broken(id: number): ProfileOverviewEntry {
  return { ok: false, id, name: `roto ${id}`, issues: ["scope inválido"] };
}

describe("summarizeNovedades (issue #195)", () => {
  it("sums new_count across profiles and counts profiles with any new candidate", () => {
    const summary = summarizeNovedades([ok(1, 3), ok(2, 0), ok(3, 9)]);
    expect(summary.totalNew).toBe(12);
    expect(summary.profilesWithNew).toBe(2);
  });

  it("orders newProfileIds most-new-first (busiest profile drives the jump-to)", () => {
    const summary = summarizeNovedades([ok(1, 3), ok(3, 9), ok(2, 3)]);
    // 3 new-count comes first, then the two 3s ordered by id asc for determinism.
    expect(summary.newProfileIds).toEqual([3, 1, 2]);
  });

  it("ignores malformed-scope (ok:false) profiles — they have no matched-candidate concept", () => {
    const summary = summarizeNovedades([broken(1), ok(2, 4)]);
    expect(summary.totalNew).toBe(4);
    expect(summary.profilesWithNew).toBe(1);
    expect(summary.newProfileIds).toEqual([2]);
  });

  it("returns an all-zero summary when nothing is new", () => {
    expect(summarizeNovedades([ok(1, 0), ok(2, 0)])).toEqual({
      totalNew: 0,
      profilesWithNew: 0,
      newProfileIds: [],
    });
  });

  it("treats null/undefined (degraded fallback) as all-zero", () => {
    expect(summarizeNovedades(null)).toEqual({ totalNew: 0, profilesWithNew: 0, newProfileIds: [] });
    expect(summarizeNovedades(undefined)).toEqual({ totalNew: 0, profilesWithNew: 0, newProfileIds: [] });
    expect(summarizeNovedades([])).toEqual({ totalNew: 0, profilesWithNew: 0, newProfileIds: [] });
  });
});
