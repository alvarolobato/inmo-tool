import { describe, it, expect } from "vitest";
import {
  formatCompactEs,
  formatIntegerEs,
  formatTokensWithCompact,
  formatUsdEs,
} from "@/lib/usage-number-format";

describe("usage-number-format", () => {
  it("formatIntegerEs uses Spanish grouping", () => {
    expect(formatIntegerEs(1234567)).toMatch(/1.*234.*567/);
    expect(formatIntegerEs(0)).toBe("0");
  });

  it("formatCompactEs returns a short string for large values", () => {
    const s = formatCompactEs(1_500_000);
    expect(s.length).toBeLessThan(12);
    expect(s).toMatch(/\d/);
  });

  it("formatTokensWithCompact returns primary and compact", () => {
    const { primary, compact } = formatTokensWithCompact(10_000);
    expect(primary).toBeTruthy();
    expect(compact).toBeTruthy();
  });

  it("formatUsdEs formats dollar amounts", () => {
    expect(formatUsdEs("0.018")).toContain("0");
    expect(formatUsdEs(12.345678)).toContain("12");
  });

  it("handles non-finite as em dash", () => {
    expect(formatIntegerEs(Number.NaN)).toBe("—");
    expect(formatCompactEs(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsdEs("not-a-number")).toBe("—");
  });
});
