/**
 * Unit tests for the dashboard side of issue #80's extraction-quality signal:
 * parsing the stored `raw_extra.extraction_quality` JSON, aggregating across a
 * property's listings, and the grade→display mapping. The ETL owns the
 * *scoring* (etl/extraction_quality.py, tested there); this file pins that the
 * dashboard reads it faithfully and degrades gracefully on absent/malformed
 * data.
 */
import { describe, it, expect } from "vitest";
import {
  parseExtractionQuality,
  bestExtractionQuality,
  gradeDisplay,
  type ExtractionQuality,
} from "@/lib/extraction-quality";

function q(grade: ExtractionQuality["grade"], score: number): ExtractionQuality {
  return { grade, score, populated_fields: 5, total_fields: 9, weights_version: 1 };
}

describe("parseExtractionQuality", () => {
  it("parses a well-formed descriptor from raw_extra", () => {
    const parsed = parseExtractionQuality({
      grade: "B",
      score: 0.72,
      populated_fields: 6,
      total_fields: 9,
      weights_version: 1,
    });
    expect(parsed).toEqual({
      grade: "B",
      score: 0.72,
      populated_fields: 6,
      total_fields: 9,
      weights_version: 1,
    });
  });

  it("returns null for absent/malformed values (predates the feature)", () => {
    expect(parseExtractionQuality(null)).toBeNull();
    expect(parseExtractionQuality(undefined)).toBeNull();
    expect(parseExtractionQuality({})).toBeNull();
    expect(parseExtractionQuality({ grade: "Z", score: 1 })).toBeNull();
    expect(parseExtractionQuality({ grade: "A" })).toBeNull(); // no score
    expect(parseExtractionQuality("A")).toBeNull();
  });
});

describe("bestExtractionQuality", () => {
  it("returns the highest-score quality across listings", () => {
    const best = bestExtractionQuality([q("F", 0.2), q("A", 0.95), q("C", 0.5)]);
    expect(best?.grade).toBe("A");
  });

  it("ignores nulls and undefineds and returns null when none present", () => {
    expect(bestExtractionQuality([null, null])).toBeNull();
    expect(bestExtractionQuality([])).toBeNull();
    expect(bestExtractionQuality([null, q("C", 0.5)])?.grade).toBe("C");
    // A listing object that omits the field is undefined at runtime — must
    // be skipped, not treated as a quality (guards the PropertyHeader path).
    expect(bestExtractionQuality([undefined, undefined])).toBeNull();
    expect(bestExtractionQuality([undefined, q("B", 0.7)])?.grade).toBe("B");
  });

  it("a rich sibling rescues a property whose other listing was thin", () => {
    // The whole point of 'best', not 'worst': one good source means the
    // COALESCE-merged header fields are trustworthy.
    const best = bestExtractionQuality([q("F", 0.15), q("A", 0.9)]);
    expect(best?.grade).toBe("A");
  });
});

describe("gradeDisplay", () => {
  it("escalates tone for low grades and stays quiet for high ones", () => {
    expect(gradeDisplay("A").tone).toBe("ok");
    expect(gradeDisplay("B").tone).toBe("ok");
    expect(gradeDisplay("C").tone).toBe("warn");
    expect(gradeDisplay("F").tone).toBe("danger");
  });

  it("gives every grade a non-empty Spanish label", () => {
    for (const g of ["A", "B", "C", "F"] as const) {
      expect(gradeDisplay(g).label.length).toBeGreaterThan(0);
    }
  });
});
