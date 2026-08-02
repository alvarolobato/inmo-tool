import { describe, it, expect } from "vitest";
import { computeContributions, explainScore, COLD_START_EXPLANATION } from "../explain";
import { FEATURE_NAMES, type RawFeatureVector } from "../features";
import type { TrainedModel } from "../model";

function emptyRaw(): RawFeatureVector {
  return Object.fromEntries(FEATURE_NAMES.map((n) => [n, null])) as RawFeatureVector;
}

/** Identity normalization (mean 0, std 1) so normalized values equal raw values — makes expected contributions trivial to compute by hand. */
function identityModel(weights: number[], bias = 0): Pick<TrainedModel, "weights" | "bias" | "normalization"> {
  return { weights, bias, normalization: { mean: FEATURE_NAMES.map(() => 0), std: FEATURE_NAMES.map(() => 1) } };
}

describe("computeContributions", () => {
  it("excludes features with a null raw value (imputed to the pool mean, contribution exactly 0)", () => {
    const raw = { ...emptyRaw(), rooms: 3 };
    const model = identityModel(FEATURE_NAMES.map((n) => (n === "rooms" ? 2 : 5)));
    const contributions = computeContributions(raw, model);
    // Only `rooms` has a non-null raw value; every other feature is excluded
    // even though their weights are non-zero, because their raw is null.
    expect(contributions).toEqual([{ name: "rooms", contribution: 6, rawValue: 3 }]);
  });

  it("excludes a present feature whose contribution is negligible (near-zero weight)", () => {
    const raw = { ...emptyRaw(), rooms: 5 };
    const model = identityModel(FEATURE_NAMES.map(() => 0));
    expect(computeContributions(raw, model)).toEqual([]);
  });

  it("sorts by absolute magnitude descending, regardless of sign", () => {
    const raw = { ...emptyRaw(), rooms: 1, m2_built: 1, has_elevator: 1 };
    const weights = FEATURE_NAMES.map((n) => (n === "rooms" ? -10 : n === "m2_built" ? 2 : n === "has_elevator" ? 5 : 0));
    const model = identityModel(weights);
    const names = computeContributions(raw, model).map((c) => c.name);
    expect(names).toEqual(["rooms", "has_elevator", "m2_built"]);
  });
});

describe("explainScore", () => {
  it("EC-1: names concrete features with directionally-correct language matching each contribution's sign", () => {
    const raw = { ...emptyRaw(), price_per_m2_relative: 0.9, floor_numeric: 3 };
    // price_per_m2_relative weight +1 -> contribution +0.9 (helps).
    // floor_numeric weight -1 -> contribution -3 (hurts, and the larger magnitude).
    const weights = FEATURE_NAMES.map((n) => (n === "price_per_m2_relative" ? 1 : n === "floor_numeric" ? -1 : 0));
    const model = identityModel(weights, 0);

    const explanation = explainScore(raw, model);

    // Overall total = 0.9 - 3 + bias(0) = -2.1 -> negative -> "Ranking bajo".
    expect(explanation).toMatch(/^Ranking bajo:/);
    // Strongest (most negative) contributor named with hurting-language.
    expect(explanation).toContain("planta 3ª");
    expect(explanation).toContain("normalmente la rechazas");
    // Second contributor named with helping-language.
    expect(explanation).toContain("por debajo de lo habitual en este perfil");
    expect(explanation).toContain("10%"); // pct(1 - 0.9)

    // EC-3 (automatable slice of it): no raw internal identifiers leak.
    for (const name of FEATURE_NAMES) expect(explanation).not.toContain(name);
    expect(explanation).not.toMatch(/zscore|normalized|coefficient/i);
  });

  it("orders 'Ranking alto' vs 'Ranking bajo' by the real total (all contributions + bias), not just the strongest single feature", () => {
    // Single strongest feature is negative, but two smaller positives plus a
    // positive bias outweigh it in total.
    const raw = { ...emptyRaw(), rooms: 1, m2_built: 1, has_elevator: 1 };
    const weights = FEATURE_NAMES.map((n) => (n === "rooms" ? -3 : n === "m2_built" ? 2 : n === "has_elevator" ? 2 : 0));
    const model = identityModel(weights, 4); // total = -3 + 2 + 2 + 4 = 5 > 0
    expect(explainScore(raw, model)).toMatch(/^Ranking alto:/);
  });

  it("EC-2: a null model (cold start, no trained model yet) returns the honest cold-start message, not a fabricated feature-based sentence", () => {
    const raw = { ...emptyRaw(), rooms: 4, m2_built: 90 };
    expect(explainScore(raw, null)).toBe(COLD_START_EXPLANATION);
    expect(COLD_START_EXPLANATION.toLowerCase()).toContain("personalizar");
  });

  it("falls back to a plain 'nothing to report' message when every feature is null or negligible", () => {
    const model = identityModel(FEATURE_NAMES.map(() => 0));
    expect(explainScore(emptyRaw(), model)).toMatch(/sin motivos concretos/i);
  });

  it("never crashes on days_on_market/price_drop_pct even though they're always null today (task 5.4 not built)", () => {
    const raw = { ...emptyRaw(), days_on_market: null, price_drop_pct: null, rooms: 2 };
    const model = identityModel(FEATURE_NAMES.map((n) => (n === "rooms" ? 1 : 3)));
    // rooms is the only non-null feature, so it's the only one that can appear.
    expect(() => explainScore(raw, model)).not.toThrow();
    expect(explainScore(raw, model)).not.toMatch(/día|bajada|subida/i);
  });
});
