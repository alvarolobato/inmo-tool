import { describe, it, expect } from "vitest";
import { computeColdStartScore, MIN_TRAINING_EXAMPLES, MIN_TRAINING_EXAMPLES_MULTIPLIER } from "../pipeline";
import { FEATURE_NAMES, extractRaw } from "../features";
import type { Scope } from "@/lib/profiles-schema";

const SCOPE: Scope = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
  price_min: 150000,
  price_max: 250000,
  hard_exclusions: {},
};

function raw(min_price: number | null, m2_built: number | null) {
  return extractRaw(
    { property_id: 1, m2_built, rooms: null, floor: null, has_elevator: null, year_built: null, min_price, first_seen_at: null },
    SCOPE,
  );
}

describe("MIN_TRAINING_EXAMPLES (task 3.4, #23)", () => {
  it("scales with the active feature count, not a hardcoded number", () => {
    // Issue #23's own derivation: roughly 3-5x feature count. This test
    // guards against someone hardcoding "32" directly and silently
    // decoupling it from FEATURE_NAMES.length the next time a feature is
    // added or removed.
    expect(MIN_TRAINING_EXAMPLES).toBe(MIN_TRAINING_EXAMPLES_MULTIPLIER * FEATURE_NAMES.length);
    expect(MIN_TRAINING_EXAMPLES_MULTIPLIER).toBeGreaterThanOrEqual(3);
    expect(MIN_TRAINING_EXAMPLES_MULTIPLIER).toBeLessThanOrEqual(5);
  });

  it("is 32 at the current 8-feature model — documents the concrete number this repo actually runs with today", () => {
    expect(FEATURE_NAMES.length).toBe(8);
    expect(MIN_TRAINING_EXAMPLES).toBe(32);
  });
});

describe("computeColdStartScore (task 3.4, #23)", () => {
  it("scores exactly at the profile's target price-per-m² as neutral (0.5)", () => {
    // price_min=150000, price_max=250000 -> band midpoint 200000; no size
    // band set, so price_per_m2_relative degrades to plain price/priceMid.
    // A candidate priced exactly at the midpoint has v=1.
    const score = computeColdStartScore(raw(200000, null));
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("scores a cheaper-than-target candidate higher than 0.5 (price-per-m² ascending = cheaper first)", () => {
    const cheapScore = computeColdStartScore(raw(100000, null)); // v=0.5
    expect(cheapScore).toBeGreaterThan(0.5);
  });

  it("scores a pricier-than-target candidate lower than 0.5", () => {
    const priceyScore = computeColdStartScore(raw(400000, null)); // v=2.0
    expect(priceyScore).toBeLessThan(0.5);
  });

  it("orders multiple candidates by ascending price consistently (a real ranking, not just a sign check)", () => {
    const cheapest = computeColdStartScore(raw(50000, null));
    const mid = computeColdStartScore(raw(200000, null));
    const pricey = computeColdStartScore(raw(500000, null));
    expect(cheapest).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(pricey);
  });

  it("is neutral (0.5) when price is entirely unknown, not a guess in either direction", () => {
    const score = computeColdStartScore(raw(null, 70));
    expect(score).toBe(0.5);
  });

  it("stays within (0, 1) for an extreme price ratio, never hits exactly 0 or 1", () => {
    const veryExpensive = computeColdStartScore(raw(50_000_000, null));
    expect(veryExpensive).toBeGreaterThan(0);
    expect(veryExpensive).toBeLessThan(0.01);
  });
});
