/**
 * Unit tests for investment-metrics.ts's raw_extra parsing guard (Opus
 * review must-fix #2). Pure-function tests only — getInvestmentMetrics
 * itself needs a real Postgres pool and is exercised by
 * app/api/profiles/[id]/properties/[propertyId]/investment/__tests__/route.test.ts
 * instead; importing this module at the top level is safe without a DB
 * because lib/db-write's Pool is only constructed lazily inside getPool().
 */
import { describe, it, expect } from "vitest";
import {
  parseFiniteCarryingCost,
  isPlausibleMonthlyCommunityFee,
  MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR,
} from "../investment-metrics";

describe("parseFiniteCarryingCost", () => {
  it("parses a clean integer/decimal string", () => {
    expect(parseFiniteCarryingCost("500")).toBe(500);
    expect(parseFiniteCarryingCost("80.5")).toBe(80.5);
  });

  it("returns null for a null input (field not published)", () => {
    expect(parseFiniteCarryingCost(null)).toBeNull();
  });

  // Opus review must-fix #2, verified: Number('1.234,56') -> NaN under the
  // bare `Number()` this module used before the fix. A Spanish-formatted
  // number (thousands dot, decimal comma) is exactly the shape a portal
  // could plausibly publish in raw_extra — must resolve to `null`
  // (unknown), never NaN (which poisoned every downstream computation:
  // hasActualCarrying became true, net_yield_pct became NaN, JSON
  // round-tripped NaN as null, and the UI rendered a fabricated "0,0 %").
  it("returns null (never NaN) for a Spanish-formatted number string that Number() can't parse", () => {
    const raw = "1.234,56";
    expect(Number.isNaN(Number(raw))).toBe(true); // sanity: confirms the bug this guards against
    expect(parseFiniteCarryingCost(raw)).toBeNull();
  });

  // Opus review must-fix #2, verified: Number('') -> 0 under bare Number(),
  // which silently makes carrying costs (and therefore net rent) equal to
  // gross rent — a different failure direction from NaN, same root cause
  // (an untrusted raw_extra string treated as if it were always numeric).
  it("returns null (never a fabricated 0) for an empty string", () => {
    expect(Number("")).toBe(0); // sanity: confirms the bug this guards against
    expect(parseFiniteCarryingCost("")).toBeNull();
  });

  it("returns null for non-numeric garbage", () => {
    expect(parseFiniteCarryingCost("N/A")).toBeNull();
    expect(parseFiniteCarryingCost("null")).toBeNull();
    expect(parseFiniteCarryingCost("  ")).toBeNull();
  });

  it("returns null for Infinity-producing input (still not a finite number)", () => {
    expect(parseFiniteCarryingCost("Infinity")).toBeNull();
  });
});

describe("isPlausibleMonthlyCommunityFee", () => {
  // Opus review "Also fix": gastos_comunidad_eur is assumed MONTHLY with no
  // validation. If a source ever published an ANNUAL figure under this key
  // (a portal-side labeling mistake), yield.ts's *12 conversion would
  // produce a carrying cost ~12x too high with nothing about the number
  // alone looking wrong (a plausible ANNUAL fee is itself a plausible-
  // looking MONTHLY figure). This is a coarse ceiling, not a precise
  // validator — it only catches implausibly large monthly figures, not
  // every mislabeled value, and is documented as such.
  it("accepts a typical Spanish monthly community fee", () => {
    expect(isPlausibleMonthlyCommunityFee(80)).toBe(true);
    expect(isPlausibleMonthlyCommunityFee(300)).toBe(true);
  });

  it("rejects a value at/above the documented ceiling", () => {
    expect(isPlausibleMonthlyCommunityFee(MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR + 1)).toBe(false);
    expect(isPlausibleMonthlyCommunityFee(MAX_PLAUSIBLE_MONTHLY_COMMUNITY_FEE_EUR)).toBe(true);
  });

  it("catches a large annual community fee mislabeled as monthly (the exact 12x error this guard exists for)", () => {
    // A genuinely high (but not impossible) ANNUAL community fee for a
    // larger property — mislabeled as monthly, this is well past the
    // documented ceiling, so the guard rejects it rather than letting
    // yield.ts multiply it by 12 again on top.
    const annualFeeMislabeledAsMonthly = 2400; // e.g. a real 200 EUR/month fee entered as an annual-looking figure
    expect(isPlausibleMonthlyCommunityFee(annualFeeMislabeledAsMonthly)).toBe(false);
  });
});
