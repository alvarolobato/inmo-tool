/**
 * Unstructured-to-structured extraction — unit tests (#28).
 *
 * Mirrors condition.test.ts's/occupancy.test.ts's structure: prompt-content
 * assertions against the REAL `buildSystemPrompt` output, plus parsing/gating
 * tests. The three EC test names below are exactly what issue #28 names as
 * `*Verified by*` for its three acceptance criteria.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import {
  parseExtractResult,
  needsExtraction,
  summaryConfidence,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_FIELDS,
  type PropertyStructuredFields,
} from "../extract";

const FULL_FACTS_ADVERT: ListingSnapshot = {
  propertyId: 21,
  listingId: 401,
  source: "milanuncios",
  operation: "sale",
  description: "Piso de 85m2, 3 habitaciones, 2 baños, con ascensor. Particular.",
};

const VAGUE_ADVERT: ListingSnapshot = {
  propertyId: 22,
  listingId: 402,
  source: "fotocasa",
  operation: "sale",
  description: "Piso luminoso muy bien situado, no dejes pasar la oportunidad.",
};

function extractPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("extract", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

function completeFields(): PropertyStructuredFields {
  return {
    m2_built: 90,
    m2_useful: 80,
    rooms: 3,
    bathrooms: 2,
    floor: "2",
    has_elevator: true,
  };
}

describe("extract prompt — property-level evidence union (#28 moved off listing-level)", () => {
  it("carries EVERY advert's description, not just the first", () => {
    const text = extractPromptText([FULL_FACTS_ADVERT, VAGUE_ADVERT]);
    expect(text).toContain("85m2, 3 habitaciones, 2 baños");
    expect(text).toContain("no dejes pasar la oportunidad");
  });

  it("still works for a property with a single advert", () => {
    const text = extractPromptText([FULL_FACTS_ADVERT]);
    expect(text).toContain("85m2, 3 habitaciones");
  });

  it("tells the model to leave a field null rather than fabricate one (EC-2)", () => {
    const text = extractPromptText([VAGUE_ADVERT]).toLowerCase();
    expect(text).toContain("no inventes");
  });

  it("asks for per-field confidence, not one scalar", () => {
    const text = extractPromptText([FULL_FACTS_ADVERT]);
    expect(text).toContain("confidence_per_field");
  });
});

describe("extract prompt — `null`-not-`unknown` correction survives ASSESSMENT_RULES ordering (hard-won rule #6)", () => {
  it("restates the null-not-unknown correction AFTER ASSESSMENT_RULES' generic unknown rule", () => {
    const text = extractPromptText([FULL_FACTS_ADVERT]);

    const genericUnknownRuleIdx = text.indexOf('`"unknown"` y una `confidence` baja');
    const correctionIdx = text.indexOf("Nota sobre la regla 2 anterior");

    expect(genericUnknownRuleIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(-1);
    // The correction must come LAST: a model resolving the conflict by
    // recency obeys whichever instruction it reads later.
    expect(correctionIdx).toBeGreaterThan(genericUnknownRuleIdx);
  });

  it("explicitly forbids writing the string 'unknown' into a numeric/boolean field", () => {
    const text = extractPromptText([FULL_FACTS_ADVERT]);
    expect(text).toContain('NUNCA con la cadena');
  });
});

describe("parseExtractResult", () => {
  it('EC-1: "piso de 85m², 3 habitaciones, 2 baños, con ascensor" produces the explicit facts at high confidence', () => {
    const raw = JSON.stringify({
      m2_built: 85,
      m2_useful: null,
      rooms: 3,
      bathrooms: 2,
      floor: null,
      has_elevator: true,
      confidence_per_field: { m2_built: 0.95, rooms: 0.95, bathrooms: 0.9, has_elevator: 0.9 },
      reasoning: "El anuncio da metros, habitaciones, baños y ascensor explícitamente.",
    });

    const r = parseExtractResult(raw);
    expect(r.m2_built).toBe(85);
    expect(r.rooms).toBe(3);
    expect(r.bathrooms).toBe(2);
    expect(r.has_elevator).toBe(true);
    expect(r.confidence_per_field.m2_built).toBeGreaterThan(0.9);
    expect(r.confidence_per_field.rooms).toBeGreaterThan(0.9);
    expect(r.confidence_per_field.bathrooms).toBeGreaterThan(0.8);
    expect(r.confidence_per_field.has_elevator).toBeGreaterThan(0.8);
  });

  it("no fabrication when description lacks the fact", () => {
    const raw = JSON.stringify({
      m2_built: null,
      m2_useful: null,
      rooms: null,
      bathrooms: null,
      floor: null,
      has_elevator: null,
      confidence_per_field: {},
      reasoning: "El anuncio no da datos estructurados concretos.",
    });

    const r = parseExtractResult(raw);
    expect(r.m2_built).toBeNull();
    expect(r.rooms).toBeNull();
    expect(r.bathrooms).toBeNull();
    expect(r.floor).toBeNull();
    expect(r.has_elevator).toBeNull();
    expect(r.confidence_per_field).toEqual({});
  });

  it("tolerates a ```json code fence", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ m2_built: 100, rooms: 4, confidence_per_field: { m2_built: 0.8 } }) +
      "\n```";
    const r = parseExtractResult(raw);
    expect(r.m2_built).toBe(100);
    expect(r.rooms).toBe(4);
  });

  it("coerces a numeric floor to its string form rather than rejecting it", () => {
    const r = parseExtractResult(JSON.stringify({ floor: 3 }));
    expect(r.floor).toBe("3");
  });

  it("throws when a numeric field is a non-numeric string (strict validation, technical approach #3)", () => {
    expect(() => parseExtractResult(JSON.stringify({ rooms: "3 habitaciones" }))).toThrow(
      /non-numeric 'rooms'/,
    );
  });

  it("throws when m2_built is not a finite number", () => {
    expect(() => parseExtractResult(JSON.stringify({ m2_built: "grande" }))).toThrow(
      /non-numeric 'm2_built'/,
    );
  });

  it("throws when has_elevator is a string instead of a boolean", () => {
    expect(() => parseExtractResult(JSON.stringify({ has_elevator: "true" }))).toThrow(
      /non-boolean 'has_elevator'/,
    );
  });

  it("throws on non-JSON output instead of silently returning nulls", () => {
    expect(() => parseExtractResult("lo siento, no puedo ayudar con eso")).toThrow(/non-JSON/);
  });

  it("drops an out-of-range confidence_per_field entry rather than throwing (metadata, not a compared value)", () => {
    const r = parseExtractResult(
      JSON.stringify({ rooms: 3, confidence_per_field: { rooms: 5, bathrooms: "alta" } }),
    );
    expect(r.confidence_per_field.rooms).toBe(1); // clamped
    expect(r.confidence_per_field.bathrooms).toBeUndefined();
  });

  it("ignores a confidence_per_field key outside the closed EXTRACT_FIELDS vocabulary", () => {
    const r = parseExtractResult(
      JSON.stringify({ rooms: 3, confidence_per_field: { rooms: 0.8, year_built: 0.9 } }),
    );
    expect(Object.keys(r.confidence_per_field)).toEqual(["rooms"]);
  });
});

describe("needsExtraction — EC-3 cost-control gating", () => {
  it("skips extraction when structured data already complete", () => {
    expect(needsExtraction(completeFields())).toBe(false);
  });

  it("runs extraction when at least one relevant field is null", () => {
    expect(needsExtraction({ ...completeFields(), floor: null })).toBe(true);
  });

  it("runs extraction when every field is null (nothing structured at all)", () => {
    expect(
      needsExtraction({
        m2_built: null,
        m2_useful: null,
        rooms: null,
        bathrooms: null,
        floor: null,
        has_elevator: null,
      }),
    ).toBe(true);
  });

  it("EXTRACT_FIELDS names exactly the six property columns this flow can fill", () => {
    expect(EXTRACT_FIELDS).toEqual([
      "m2_built",
      "m2_useful",
      "rooms",
      "bathrooms",
      "floor",
      "has_elevator",
    ]);
  });
});

describe("summaryConfidence", () => {
  it("averages the reported per-field confidences", () => {
    const r = parseExtractResult(
      JSON.stringify({ rooms: 3, bathrooms: 2, confidence_per_field: { rooms: 0.8, bathrooms: 0.6 } }),
    );
    expect(summaryConfidence(r)).toBeCloseTo(0.7, 5);
  });

  it("is zero, not NaN, when nothing was extracted", () => {
    const r = parseExtractResult(JSON.stringify({ confidence_per_field: {} }));
    expect(summaryConfidence(r)).toBe(0);
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    expect(EXTRACT_PROMPT_VERSION).toBe("extract/v1");
  });
});
