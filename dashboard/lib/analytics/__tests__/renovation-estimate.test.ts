import { describe, it, expect } from "vitest";
import {
  estimateRenovationCost,
  DEFAULT_REFURB_COST_BANDS,
  type RefurbCostBands,
} from "../renovation-estimate";

const BANDS: RefurbCostBands = {
  leve_eur_per_m2: 400,
  integral_eur_per_m2: 900,
  unknown_eur_per_m2: 650,
};

describe("estimateRenovationCost", () => {
  // Issue #45 EC-1's named test: a reformado property shows a near-zero
  // estimate, an a_reformar one a materially higher one, using the tier rates.
  it("tiers renovation cost by condition assessment", () => {
    const reformado = estimateRenovationCost("reformado", null, 80, BANDS);
    expect(reformado.tier).toBe("none");
    expect(reformado.total_eur).toBe(0);

    const obraNueva = estimateRenovationCost("obra_nueva", null, 80, BANDS);
    expect(obraNueva.tier).toBe("none");
    expect(obraNueva.total_eur).toBe(0);

    const leve = estimateRenovationCost("a_reformar", "leve", 80, BANDS);
    expect(leve.tier).toBe("leve");
    expect(leve.eur_per_m2).toBe(400);
    expect(leve.total_eur).toBe(32000); // 400 * 80

    const integral = estimateRenovationCost("a_reformar", "integral", 80, BANDS);
    expect(integral.tier).toBe("integral");
    expect(integral.eur_per_m2).toBe(900);
    expect(integral.total_eur).toBe(72000); // 900 * 80

    // Materially higher: integral >> leve >> reformado(0).
    expect(integral.total_eur!).toBeGreaterThan(leve.total_eur!);
    expect(leve.total_eur!).toBeGreaterThan(reformado.total_eur!);
  });

  it("uses the conservative mid band for a_reformar with ungraded severity", () => {
    const unknown = estimateRenovationCost("a_reformar", "unknown", 100, BANDS);
    expect(unknown.tier).toBe("unknown");
    expect(unknown.eur_per_m2).toBe(650);
    expect(unknown.total_eur).toBe(65000);

    // null severity (no sub-axis at all) degrades the same way.
    const nullSeverity = estimateRenovationCost("a_reformar", null, 100, BANDS);
    expect(nullSeverity.tier).toBe("unknown");
    expect(nullSeverity.eur_per_m2).toBe(650);

    // Mid band sits between leve and integral.
    expect(unknown.eur_per_m2!).toBeGreaterThan(BANDS.leve_eur_per_m2);
    expect(unknown.eur_per_m2!).toBeLessThan(BANDS.integral_eur_per_m2);
  });

  it("returns no_estimate when there is no reliable condition signal", () => {
    for (const condition of [null, "unclear"] as const) {
      const r = estimateRenovationCost(condition, null, 80, BANDS);
      expect(r.tier).toBe("no_estimate");
      expect(r.eur_per_m2).toBeNull();
      expect(r.total_eur).toBeNull();
      expect(r.basis).toMatch(/no se estima/i);
    }
  });

  it("gives a rate but no total when m² is missing or non-positive", () => {
    for (const m2 of [null, 0, -10]) {
      const r = estimateRenovationCost("a_reformar", "leve", m2, BANDS);
      expect(r.eur_per_m2).toBe(400);
      expect(r.m2).toBeNull();
      expect(r.total_eur).toBeNull();
    }
  });

  it("reformado is 0 total even without m²", () => {
    const r = estimateRenovationCost("reformado", null, null, BANDS);
    expect(r.total_eur).toBe(0);
  });

  it("defaults to DEFAULT_REFURB_COST_BANDS when no bands passed", () => {
    const r = estimateRenovationCost("a_reformar", "leve", 50);
    expect(r.eur_per_m2).toBe(DEFAULT_REFURB_COST_BANDS.leve_eur_per_m2);
    expect(r.total_eur).toBe(DEFAULT_REFURB_COST_BANDS.leve_eur_per_m2 * 50);
  });
});
