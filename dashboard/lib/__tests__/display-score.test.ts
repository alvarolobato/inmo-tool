import { describe, it, expect } from "vitest";
import {
  MAX_TOTAL_BOOST,
  DISPLAY_SCORE_CEIL,
  NO_SCORE_SENTINEL,
  belowMarketBoost,
  distressBoost,
  beachBoost,
  touristBoost,
  domBoost,
  priceDropBoost,
  timingBoost,
  TIMING_JOINT_CAP,
  DOM_BOOST_WEIGHT,
  PRICE_DROP_BOOST_WEIGHT,
  toDisplayScore,
  bandForScore,
  confidenceTier,
  investorScoreBreakdown,
  distributeRounding,
  type InvestorScoreInputs,
} from "../display-score";

describe("display-score ceiling and invariant (#452)", () => {
  it("MAX_TOTAL_BOOST is 0.64 and the display ceiling is Fable's 1.64", () => {
    // below 0.25 + distress 0.15 + beach 0.09 + tourist 0.04 + timing 0.11.
    expect(MAX_TOTAL_BOOST).toBeCloseTo(0.64, 10);
    expect(DISPLAY_SCORE_CEIL).toBeCloseTo(1.64, 10);
  });

  it("the never-scored sentinel stays strictly below any real score even at max boost", () => {
    // A never-scored candidate at the maximum total boost is still < 0, while a
    // real sigmoid score is in (0,1) → strictly greater. Augment, never replace.
    const worstNeverScored = NO_SCORE_SENTINEL + MAX_TOTAL_BOOST;
    expect(worstNeverScored).toBeLessThan(0);
    expect(worstNeverScored).toBeCloseTo(-0.36, 10);
    // The tiniest real score with no boost still beats it.
    expect(0.0001).toBeGreaterThan(worstNeverScored);
  });
});

describe("boost math mirrors the SQL", () => {
  it("below-market: clamps to [0, cap] × weight, above-market and null → 0", () => {
    expect(belowMarketBoost(0.5)).toBeCloseTo(0.25, 10); // cap
    expect(belowMarketBoost(1.0)).toBeCloseTo(0.25, 10); // clamped to cap
    expect(belowMarketBoost(0.2)).toBeCloseTo(0.1, 10);
    expect(belowMarketBoost(-0.3)).toBe(0); // above market
    expect(belowMarketBoost(null)).toBe(0);
  });

  it("distress: 0–3 axes × 0.05, capped", () => {
    expect(distressBoost(0)).toBe(0);
    expect(distressBoost(3)).toBeCloseTo(0.15, 10);
    expect(distressBoost(9)).toBeCloseTo(0.15, 10); // capped
  });

  it("beach: graded units × weight; none/unknown → 0", () => {
    expect(beachBoost("frontline")).toBeCloseTo(0.09, 10);
    expect(beachBoost("near_beach")).toBeCloseTo(0.03, 10);
    expect(beachBoost("none")).toBe(0);
    expect(beachBoost(null)).toBe(0);
  });

  it("tourist: single boolean", () => {
    expect(touristBoost(true)).toBeCloseTo(0.04, 10);
    expect(touristBoost(false)).toBe(0);
  });

  it("DOM boost: linear ramp to 180 days, then flat; null/0 → 0 (degrade)", () => {
    expect(domBoost(null)).toBe(0);
    expect(domBoost(0)).toBe(0);
    expect(domBoost(90)).toBeCloseTo(DOM_BOOST_WEIGHT / 2, 10);
    expect(domBoost(180)).toBeCloseTo(DOM_BOOST_WEIGHT, 10);
    expect(domBoost(360)).toBeCloseTo(DOM_BOOST_WEIGHT, 10); // saturated
  });

  it("price-drop boost: linear ramp to 0.2, then flat; null/rise → 0 (degrade)", () => {
    expect(priceDropBoost(null)).toBe(0);
    expect(priceDropBoost(-0.1)).toBe(0); // a rise
    expect(priceDropBoost(0.1)).toBeCloseTo(PRICE_DROP_BOOST_WEIGHT / 2, 10);
    expect(priceDropBoost(0.2)).toBeCloseTo(PRICE_DROP_BOOST_WEIGHT, 10);
    expect(priceDropBoost(0.5)).toBeCloseTo(PRICE_DROP_BOOST_WEIGHT, 10); // saturated
  });

  it("timing joint cap: DOM + drop never exceed 0.11, and degrade to 0", () => {
    expect(timingBoost(null, null)).toBe(0); // both absent → 0
    expect(timingBoost(360, 0.5)).toBeCloseTo(TIMING_JOINT_CAP, 10); // both maxed → capped
    expect(timingBoost(360, 0.5)).toBeLessThanOrEqual(TIMING_JOINT_CAP);
    expect(timingBoost(90, null)).toBeCloseTo(DOM_BOOST_WEIGHT / 2, 10);
  });
});

describe("toDisplayScore + bands", () => {
  it("null / negative sentinel → Sin puntuar, never a number", () => {
    for (const eff of [null, NO_SCORE_SENTINEL, -0.36, -0.5]) {
      const d = toDisplayScore(eff);
      expect(d.unscored).toBe(true);
      expect(d.value).toBeNull();
      expect(d.band.label).toBe("Sin puntuar");
      expect(d.band.grade).toBeNull();
    }
  });

  it("maps a real effective_score with clamp(round(eff/1.64×100), 0, 100)", () => {
    // 0.9 base + boosts=0 → round(0.9/1.64×100)=55.
    expect(toDisplayScore(0.9).value).toBe(55);
    // A tiny positive score rounds to 0 (clamp lower bound), still scored.
    const tiny = toDisplayScore(0.001);
    expect(tiny.unscored).toBe(false);
    expect(tiny.value).toBe(0);
    // The theoretical max maps to 100 (clamp upper bound).
    expect(toDisplayScore(DISPLAY_SCORE_CEIL).value).toBe(100);
    expect(toDisplayScore(DISPLAY_SCORE_CEIL * 2).value).toBe(100);
  });

  it("assigns bands A/B/C/D by threshold", () => {
    expect(bandForScore(80).grade).toBe("A"); // ≥70 Oportunidad
    expect(bandForScore(70).grade).toBe("A");
    expect(bandForScore(69).grade).toBe("B"); // ≥50 Buena
    expect(bandForScore(50).grade).toBe("B");
    expect(bandForScore(49).grade).toBe("C"); // ≥30 Media
    expect(bandForScore(30).grade).toBe("C");
    expect(bandForScore(29).grade).toBe("D"); // Flojo
    expect(bandForScore(0).grade).toBe("D");
  });
});

describe("confidenceTier", () => {
  it("baja without a base score, regardless of signals", () => {
    expect(confidenceTier(false, 5)).toBe("baja");
  });
  it("scales with signal coverage when a base score exists", () => {
    expect(confidenceTier(true, 0)).toBe("baja");
    expect(confidenceTier(true, 1)).toBe("media");
    expect(confidenceTier(true, 2)).toBe("media");
    expect(confidenceTier(true, 3)).toBe("alta");
    expect(confidenceTier(true, 6)).toBe("alta");
  });
});

describe("distributeRounding", () => {
  it("returns integers that sum exactly to the target (largest remainder)", () => {
    const out = distributeRounding([10.4, 20.4, 24.4], 55);
    expect(out.reduce((a, b) => a + b, 0)).toBe(55);
    // Two units of remainder go to the two largest fractions (all .4 here → any
    // two), but the sum is the invariant that matters.
  });
  it("handles a zero target and empty-ish inputs", () => {
    expect(distributeRounding([0, 0, 0], 0)).toEqual([0, 0, 0]);
  });
  it("never emits a negative point even if floors overshoot", () => {
    const out = distributeRounding([0.6, 0.6], 1);
    expect(out.every((n) => n >= 0)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("investorScoreBreakdown", () => {
  const base: InvestorScoreInputs = {
    base_score: 0.8,
    effective_score: 0.8,
    below_market_pct: null,
    distress_level: 0,
    beach_proximity: null,
    tourist_license: false,
    days_on_market: null,
    price_drop_pct: null,
  };

  it("term points sum EXACTLY to the displayed score", () => {
    const inputs: InvestorScoreInputs = {
      ...base,
      below_market_pct: 0.3,
      distress_level: 2,
      days_on_market: 120,
      price_drop_pct: 0.1,
      // effective_score is authoritative: base + all boosts.
      effective_score:
        0.8 +
        belowMarketBoost(0.3) +
        distressBoost(2) +
        timingBoost(120, 0.1),
    };
    const b = investorScoreBreakdown(inputs);
    const sum = b.terms.reduce((a, t) => a + t.points, 0);
    expect(sum).toBe(b.display.value);
  });

  it("marks absent signals as hasData:false (the 'sin datos' rows)", () => {
    const b = investorScoreBreakdown(base);
    const byKey = Object.fromEntries(b.terms.map((t) => [t.key, t]));
    expect(byKey.base.hasData).toBe(true);
    expect(byKey.below_market.hasData).toBe(false);
    expect(byKey.distress.hasData).toBe(false);
    expect(byKey.days_on_market.hasData).toBe(false);
    expect(byKey.price_drop.hasData).toBe(false);
  });

  it("a never-scored property produces an unscored breakdown with all-zero points", () => {
    const b = investorScoreBreakdown({
      ...base,
      base_score: null,
      effective_score: NO_SCORE_SENTINEL + 0.03,
    });
    expect(b.display.unscored).toBe(true);
    expect(b.terms.every((t) => t.points === 0)).toBe(true);
    expect(b.confidence).toBe("baja");
  });
});
