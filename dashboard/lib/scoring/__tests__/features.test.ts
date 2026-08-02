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

  it("parses real label variants found in this project's own connector fixtures (PR #91 review)", () => {
    // "Bajos" (etl/tests/fixtures/fotocasa_sample_detail_fallback.html) and
    // "Planta baja" — the plural and the feminine-agreement forms of "bajo"
    // — previously fell through to null.
    expect(parseFloorNumeric("Bajos")).toBe(0);
    expect(parseFloorNumeric("bajos")).toBe(0);
    expect(parseFloorNumeric("Planta baja")).toBe(0);
    expect(parseFloorNumeric("Planta Baja")).toBe(0);
    // "Ático" (etl/tests/fixtures/fotocasa_sample_search.html) previously
    // fell through to null, discarding a real, high-value floor signal.
    expect(parseFloorNumeric("Ático")).toBe(50);
    expect(parseFloorNumeric("atico")).toBe(50);
    // Mezzanine — between ground and first floor.
    expect(parseFloorNumeric("Entreplanta")).toBe(0.5);
    // Hyphenated/spaced "semi-sótano" previously fell through to the plain
    // "sótano" branch (-1) instead of -0.5, since the un-hyphenated pattern
    // never matched.
    expect(parseFloorNumeric("Semi-sótano")).toBe(-0.5);
    expect(parseFloorNumeric("Semi sótano")).toBe(-0.5);
    expect(parseFloorNumeric("semi-sotano")).toBe(-0.5);
  });

  it("returns null (missing, not zero) for unparseable or absent values", () => {
    expect(parseFloorNumeric(null)).toBeNull();
    expect(parseFloorNumeric("")).toBeNull();
    expect(parseFloorNumeric("N/A")).toBeNull();
  });
});
