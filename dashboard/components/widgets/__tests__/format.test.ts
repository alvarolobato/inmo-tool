import { describe, it, expect } from "vitest";
import { formatValue } from "../format";

describe("formatValue", () => {
  it("formats currency with prefix in European style", () => {
    expect(formatValue(1234.56, "currency", "\u20ac")).toBe("\u20ac1.234,56");
  });

  it("formats currency without prefix", () => {
    expect(formatValue(1234.56, "currency")).toBe("1.234,56");
  });

  it("formats large currency values", () => {
    expect(formatValue(125340.5, "currency", "\u20ac")).toBe("\u20ac125.340,50");
  });

  it("formats integer numbers with dot separator", () => {
    expect(formatValue(4521, "number")).toBe("4.521");
  });

  it("formats small numbers without separator", () => {
    expect(formatValue(42, "number")).toBe("42");
  });

  it("formats percent with one decimal", () => {
    expect(formatValue(34.8, "percent")).toBe("34,8%");
  });

  it("returns dash for NaN input", () => {
    expect(formatValue("not-a-number", "currency")).toBe("\u2014");
  });

  it("returns dash for null", () => {
    expect(formatValue(null, "currency")).toBe("\u2014");
  });

  it("returns dash for undefined", () => {
    expect(formatValue(undefined, "number")).toBe("\u2014");
  });

  it("returns dash for empty string", () => {
    expect(formatValue("", "percent")).toBe("\u2014");
  });

  it("handles string numeric values", () => {
    expect(formatValue("1234", "number")).toBe("1.234");
  });

  it("handles zero", () => {
    expect(formatValue(0, "currency", "\u20ac")).toBe("\u20ac0,00");
  });

  it("handles negative values", () => {
    const result = formatValue(-500.5, "currency", "\u20ac");
    expect(result).toContain("500,50");
  });

  // Regression: format: "number" rounds to integer (1.69 -> "2"). The
  // "decimal" format preserves fractional precision for ratio KPIs such as
  // Unidades por Ticket. See PR #424 review.
  it("formats decimal with two fractional digits (ratios)", () => {
    expect(formatValue(1.69, "decimal")).toBe("1,69");
  });

  it("formats decimal large numbers with grouping", () => {
    expect(formatValue(1234.5, "decimal")).toBe("1.234,50");
  });

  it("formats decimal integer values with trailing zeros", () => {
    expect(formatValue(2, "decimal")).toBe("2,00");
  });

  it("number format still rounds to integer (regression guard)", () => {
    expect(formatValue(1.69, "number")).toBe("2");
  });
});
