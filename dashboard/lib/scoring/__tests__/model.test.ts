import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, type RawFeatureVector } from "../features";
import { computeNormalization, normalizeVector, trainLogisticRegression } from "../model";

function rawVector(overrides: Partial<RawFeatureVector>): RawFeatureVector {
  const base: RawFeatureVector = {
    price_per_m2_relative: null,
    m2_built: null,
    rooms: null,
    floor_numeric: null,
    has_elevator: null,
    year_built: null,
    days_on_market: null,
    price_drop_pct: null,
  };
  return { ...base, ...overrides };
}

const PRICE_REL_INDEX = FEATURE_NAMES.indexOf("price_per_m2_relative");
const M2_INDEX = FEATURE_NAMES.indexOf("m2_built");
const ROOMS_INDEX = FEATURE_NAMES.indexOf("rooms");

describe("trainLogisticRegression", () => {
  it("EC-1: model learns clear synthetic pattern without coefficient blowup", () => {
    // 10 synthetic candidates: accepts are cheap-relative-to-band (0.7-0.9),
    // rejects are pricey-relative-to-band (1.1-1.3). m2_built/rooms vary
    // randomly, uncorrelated with the label — noise the model should NOT
    // latch onto as strongly as the real signal.
    const raw: RawFeatureVector[] = [
      rawVector({ price_per_m2_relative: 0.7, m2_built: 60, rooms: 3 }),
      rawVector({ price_per_m2_relative: 0.75, m2_built: 90, rooms: 2 }),
      rawVector({ price_per_m2_relative: 0.8, m2_built: 45, rooms: 4 }),
      rawVector({ price_per_m2_relative: 0.85, m2_built: 120, rooms: 1 }),
      rawVector({ price_per_m2_relative: 0.9, m2_built: 70, rooms: 3 }),
      rawVector({ price_per_m2_relative: 1.1, m2_built: 65, rooms: 2 }),
      rawVector({ price_per_m2_relative: 1.15, m2_built: 100, rooms: 4 }),
      rawVector({ price_per_m2_relative: 1.2, m2_built: 50, rooms: 1 }),
      rawVector({ price_per_m2_relative: 1.25, m2_built: 110, rooms: 3 }),
      rawVector({ price_per_m2_relative: 1.3, m2_built: 55, rooms: 2 }),
    ];
    // accept=1 for the first 5 (cheap), reject=0 for the last 5 (pricey).
    const y = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];

    const normalization = computeNormalization(raw);
    const X = raw.map((v) => normalizeVector(v, normalization));
    const { weights } = trainLogisticRegression(X, y);

    // Higher relative price -> lower accept probability: negative coefficient.
    expect(weights[PRICE_REL_INDEX]).toBeLessThan(0);

    // The real signal should dominate the uncorrelated noise features.
    expect(Math.abs(weights[PRICE_REL_INDEX])).toBeGreaterThan(Math.abs(weights[M2_INDEX]));
    expect(Math.abs(weights[PRICE_REL_INDEX])).toBeGreaterThan(Math.abs(weights[ROOMS_INDEX]));

    // Regularization keeps every coefficient in a sane range even though
    // this synthetic set is perfectly separable on one feature — an
    // unregularized fit would drive weights toward +/-infinity here.
    for (const w of weights) {
      expect(Math.abs(w)).toBeLessThan(10);
    }
  });

  it("EC-2: profiles train independently — contradictory feedback produces different, non-leaking coefficients", () => {
    // Profile A "prefers small": accepts are small (m2_built low), rejects are large.
    const rawA: RawFeatureVector[] = [
      rawVector({ m2_built: 40, rooms: 2 }),
      rawVector({ m2_built: 45, rooms: 1 }),
      rawVector({ m2_built: 50, rooms: 3 }),
      rawVector({ m2_built: 140, rooms: 2 }),
      rawVector({ m2_built: 150, rooms: 4 }),
      rawVector({ m2_built: 160, rooms: 1 }),
    ];
    const yA = [1, 1, 1, 0, 0, 0];

    // Profile B "prefers large": the exact opposite pattern on the same feature.
    const rawB: RawFeatureVector[] = [
      rawVector({ m2_built: 40, rooms: 2 }),
      rawVector({ m2_built: 45, rooms: 1 }),
      rawVector({ m2_built: 50, rooms: 3 }),
      rawVector({ m2_built: 140, rooms: 2 }),
      rawVector({ m2_built: 150, rooms: 4 }),
      rawVector({ m2_built: 160, rooms: 1 }),
    ];
    const yB = [0, 0, 0, 1, 1, 1];

    const normA = computeNormalization(rawA);
    const modelA = trainLogisticRegression(
      rawA.map((v) => normalizeVector(v, normA)),
      yA,
    );

    const normB = computeNormalization(rawB);
    const modelB = trainLogisticRegression(
      rawB.map((v) => normalizeVector(v, normB)),
      yB,
    );

    // Same feature, contradictory training data -> opposite-signed coefficients.
    // No shared state between the two calls could leak one profile's fit into
    // the other's (trainLogisticRegression is a pure function of its inputs).
    expect(Math.sign(modelA.weights[M2_INDEX])).not.toBe(Math.sign(modelB.weights[M2_INDEX]));
    expect(modelA.weights[M2_INDEX]).not.toBeCloseTo(modelB.weights[M2_INDEX], 1);
  });
});

describe("computeNormalization / normalizeVector", () => {
  it("imputes missing values to the pool mean, which normalizes to exactly 0", () => {
    const raw: RawFeatureVector[] = [
      rawVector({ m2_built: 50 }),
      rawVector({ m2_built: 100 }),
      rawVector({ m2_built: null }), // missing
    ];
    const stats = computeNormalization(raw);
    // mean of [50, 100] = 75
    expect(stats.mean[M2_INDEX]).toBeCloseTo(75, 5);

    const normalized = normalizeVector(rawVector({ m2_built: null }), stats);
    expect(normalized[M2_INDEX]).toBe(0);
  });

  it("does not divide by zero when a feature has no variance", () => {
    const raw: RawFeatureVector[] = [rawVector({ rooms: 3 }), rawVector({ rooms: 3 })];
    const stats = computeNormalization(raw);
    expect(stats.std[ROOMS_INDEX]).toBe(1);
    const normalized = normalizeVector(rawVector({ rooms: 3 }), stats);
    expect(Number.isFinite(normalized[ROOMS_INDEX])).toBe(true);
  });
});
