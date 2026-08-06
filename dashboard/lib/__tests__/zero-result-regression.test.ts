/**
 * Unit tests for the zero-results regression detector (issue #376) — the pure
 * N-consecutive-zeros logic, no DB. Covers the four owner-specified cases:
 *   - nonzero → 0 for N consecutive runs FLAGS (the ático case).
 *   - a scope that was ALWAYS 0 (sparse area) NEVER flags.
 *   - a single transient 0 does NOT flag.
 *   - a later nonzero (recovery) CLEARS the flag.
 */

import { describe, it, expect } from "vitest";
import {
  detectZeroResultRegression,
  DEFAULT_ZERO_RESULT_REGRESSION_RUNS,
  type ScopeObservation,
} from "@/lib/zero-result-regression";

/** Build an oldest→newest observation series from a list of counts. */
function series(counts: number[]): ScopeObservation[] {
  return counts.map((count, i) => ({
    count,
    observedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  }));
}

describe("detectZeroResultRegression", () => {
  it("flags a scope that returned results then went 0 for N consecutive runs", () => {
    // 12, 10, 8 (nonzero baseline) then 0, 0, 0 (N=3) — the ático failure.
    const v = detectZeroResultRegression(series([12, 10, 8, 0, 0, 0]), 3);
    expect(v.flagged).toBe(true);
    expect(v.consecutiveZeros).toBe(3);
    expect(v.hadPriorNonZero).toBe(true);
    expect(v.lastNonZeroCount).toBe(8);
    expect(v.driftStartedAt).toBe(series([12, 10, 8, 0, 0, 0])[3].observedAt);
  });

  it("does NOT flag a scope that has always been 0 (sparse/never-covered area)", () => {
    const v = detectZeroResultRegression(series([0, 0, 0, 0, 0]), 3);
    expect(v.flagged).toBe(false);
    expect(v.hadPriorNonZero).toBe(false);
    expect(v.lastNonZeroCount).toBeNull();
  });

  it("does NOT flag a single transient 0", () => {
    const v = detectZeroResultRegression(series([5, 7, 6, 0]), 3);
    expect(v.flagged).toBe(false);
    expect(v.consecutiveZeros).toBe(1);
  });

  it("does NOT flag when trailing zeros are below N", () => {
    const v = detectZeroResultRegression(series([5, 0, 0]), 3);
    expect(v.flagged).toBe(false);
    expect(v.consecutiveZeros).toBe(2);
  });

  it("flags exactly at the N-th consecutive zero (boundary)", () => {
    const v = detectZeroResultRegression(series([9, 0, 0, 0]), 3);
    expect(v.flagged).toBe(true);
    expect(v.consecutiveZeros).toBe(3);
  });

  it("clears the flag after a recovery (later nonzero)", () => {
    // Was drifted (0,0,0) but the newest run returned results again.
    const v = detectZeroResultRegression(series([8, 0, 0, 0, 4]), 3);
    expect(v.flagged).toBe(false);
    expect(v.consecutiveZeros).toBe(0);
    expect(v.driftStartedAt).toBeNull();
  });

  it("keeps flagging while the drought continues past N", () => {
    const v = detectZeroResultRegression(series([8, 0, 0, 0, 0, 0]), 3);
    expect(v.flagged).toBe(true);
    expect(v.consecutiveZeros).toBe(5);
    // driftStartedAt is the FIRST zero of the trailing run, not the latest.
    expect(v.driftStartedAt).toBe(series([8, 0, 0, 0, 0, 0])[1].observedAt);
  });

  it("returns a clean non-flag verdict for an empty series", () => {
    const v = detectZeroResultRegression([], 3);
    expect(v.flagged).toBe(false);
    expect(v.lastObservedAt).toBeNull();
  });

  it("clamps a non-positive N to the default", () => {
    // N=0 would otherwise flag any always-zero series; clamped to the default 3.
    const v = detectZeroResultRegression(series([0, 0, 0]), 0);
    expect(v.flagged).toBe(false);
    expect(DEFAULT_ZERO_RESULT_REGRESSION_RUNS).toBe(3);
  });

  it("respects a larger configured N", () => {
    const s = series([5, 0, 0, 0]);
    expect(detectZeroResultRegression(s, 3).flagged).toBe(true);
    expect(detectZeroResultRegression(s, 4).flagged).toBe(false);
  });
});
