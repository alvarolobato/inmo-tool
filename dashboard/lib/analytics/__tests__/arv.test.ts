import { describe, it, expect } from "vitest";
import { estimateArv, ARV_HIGH_CONFIDENCE_MIN_SAMPLE } from "../arv";

describe("estimateArv", () => {
  it("computes ARV as area median €/m² × m²", () => {
    const r = estimateArv(3500, 80, 20);
    expect(r.arv_eur).toBe(280000); // 3500 * 80
    expect(r.arv_per_m2).toBe(3500);
    expect(r.m2).toBe(80);
  });

  it("tiers confidence by sample size", () => {
    const high = estimateArv(3000, 100, ARV_HIGH_CONFIDENCE_MIN_SAMPLE);
    expect(high.confidence).toBe("high");

    const low = estimateArv(3000, 100, ARV_HIGH_CONFIDENCE_MIN_SAMPLE - 1);
    expect(low.confidence).toBe("low");
    // Same ARV number, different confidence tag (issue #45 approach #5).
    expect(low.arv_eur).toBe(high.arv_eur);
  });

  it("respects a custom high-confidence threshold", () => {
    const r = estimateArv(3000, 100, 6, { highConfidenceMinSample: 5 });
    expect(r.confidence).toBe("high");
  });

  it("returns no ARV when the area median is unavailable", () => {
    const r = estimateArv(null, 80, 3);
    expect(r.arv_eur).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.sample_size).toBe(3);
    expect(r.basis).toMatch(/comparables/i);
  });

  it("returns no ARV when m² is missing or non-positive", () => {
    for (const m2 of [null, 0, -5]) {
      const r = estimateArv(3000, m2, 20);
      expect(r.arv_eur).toBeNull();
      expect(r.confidence).toBeNull();
      expect(r.arv_per_m2).toBe(3000);
      expect(r.basis).toMatch(/superficie/i);
    }
  });

  it("rejects a non-positive median", () => {
    const r = estimateArv(0, 80, 20);
    expect(r.arv_eur).toBeNull();
  });

  it("always states the un-filtered-comps approximation in the basis", () => {
    const r = estimateArv(3500, 80, 20);
    expect(r.basis).toMatch(/no est[aá]n filtrados|conservador/i);
  });
});
