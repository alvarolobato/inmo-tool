import { describe, expect, it } from "vitest";
import { parseFloorNumeric } from "../features";

describe("parseFloorNumeric", () => {
  it("parses plain numeric floors", () => {
    expect(parseFloorNumeric("3")).toBe(3);
    expect(parseFloorNumeric("3º")).toBe(3);
    expect(parseFloorNumeric("3º ext")).toBe(3);
  });

  it("recognizes ground-floor and semi-basement Spanish labels, accent-insensitive", () => {
    expect(parseFloorNumeric("Bajo")).toBe(0);
    expect(parseFloorNumeric("bajo")).toBe(0);
    expect(parseFloorNumeric("Entresuelo")).toBe(0);
    expect(parseFloorNumeric("Semisótano")).toBe(-0.5);
    expect(parseFloorNumeric("Sótano")).toBe(-1);
    expect(parseFloorNumeric("Sotano")).toBe(-1);
  });

  it("returns null (missing, not zero) for unparseable or absent values", () => {
    expect(parseFloorNumeric(null)).toBeNull();
    expect(parseFloorNumeric("")).toBeNull();
    expect(parseFloorNumeric("N/A")).toBeNull();
  });
});
