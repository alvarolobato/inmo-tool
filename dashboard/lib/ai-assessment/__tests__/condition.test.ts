/**
 * Condition assessment — unit tests (#26).
 *
 * Mirrors occupancy.test.ts's structure (#25): prompt-content assertions
 * against the REAL `buildSystemPrompt` output (not a spy on a function we
 * hope carries the evidence), plus parsing-degrades-safely tests for
 * `parseConditionResult`. The real end-to-end "does the model actually say
 * `a_reformar` when the text says so" question is covered by the mock
 * provider in e2e and by these prompt-content assertions.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import { parseConditionResult, CONDITION_PROMPT_VERSION } from "../condition";

const SILENT_ADVERT: ListingSnapshot = {
  propertyId: 9,
  listingId: 201,
  source: "fotocasa",
  operation: "sale",
  description: "Piso de 90 m2 en Chamberí. Tres dormitorios, dos baños. Luminoso.",
};

const REFORM_NEEDED_ADVERT: ListingSnapshot = {
  propertyId: 9,
  listingId: 202,
  source: "milanuncios",
  operation: "sale",
  description:
    "Piso a reformar, necesita actualización de instalaciones y baño. Buena ubicación.",
};

function conditionPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("condition", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

describe("condition prompt — evidence union across merged listings", () => {
  it("carries EVERY advert's description, not just the first", () => {
    const text = conditionPromptText([SILENT_ADVERT, REFORM_NEEDED_ADVERT]);
    expect(text).toContain("necesita actualización de instalaciones y baño");
    expect(text).toContain("Tres dormitorios");
  });

  it("labels each advert with its portal so a verdict can cite a source", () => {
    const text = conditionPromptText([SILENT_ADVERT, REFORM_NEEDED_ADVERT]);
    expect(text).toContain("fotocasa");
    expect(text).toContain("milanuncios");
  });

  it("still works for a property with a single advert", () => {
    const text = conditionPromptText([SILENT_ADVERT]);
    expect(text).toContain("Tres dormitorios");
    expect(text).toMatch(/ANUNCIO\s+1\s+DE\s+1/i);
  });

  it("states that silence is NOT evidence of `reformado` (no safe default, unlike occupancy's ejes 2/3)", () => {
    const text = conditionPromptText([SILENT_ADVERT]);
    expect(text.toLowerCase()).toContain("el silencio no es prueba");
  });
});

describe("parseConditionResult", () => {
  it("EC-1: 'a reformar, necesita actualización de instalaciones y baño' produces a_reformar with issues", () => {
    const raw = JSON.stringify({
      condition: "a_reformar",
      confidence: 0.85,
      issues: ["instalación eléctrica antigua", "baño a renovar"],
      evidence: "a reformar, necesita actualización de instalaciones y baño",
      evidence_source: "milanuncios",
      reasoning: "El anuncio pide explícitamente reforma de instalaciones y baño.",
    });

    const r = parseConditionResult(raw);
    expect(r.condition).toBe("a_reformar");
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/instalaci/i),
        expect.stringMatching(/baño/i),
      ]),
    );
    expect(r.evidence).toContain("a reformar");
  });

  it("EC-2: 'totalmente reformado en 2024, calidades de lujo' produces reformado with an empty/near-empty issues list", () => {
    const raw = JSON.stringify({
      condition: "reformado",
      confidence: 0.9,
      issues: [],
      evidence: "totalmente reformado en 2024, calidades de lujo",
      evidence_source: "fotocasa",
      reasoning: "Reforma reciente declarada explícitamente.",
    });

    const r = parseConditionResult(raw);
    expect(r.condition).toBe("reformado");
    expect(r.issues).toEqual([]);
  });

  it("tolerates a ```json code fence", () => {
    const raw = "```json\n" + JSON.stringify({ condition: "obra_nueva", confidence: 0.7 }) + "\n```";
    expect(parseConditionResult(raw).condition).toBe("obra_nueva");
  });

  it("degrades an unrecognised condition value to unclear with ZERO confidence", () => {
    const r = parseConditionResult(
      JSON.stringify({ condition: "probablemente_bien", confidence: 0.95 }),
    );
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("degrades a MISSING condition to unclear rather than defaulting to reformado", () => {
    // Design constraint carried over from #156's occupancy review: silence
    // must never manufacture a positive verdict at high confidence, and
    // condition (unlike occupancy's ejes 2/3) has no legitimate silence
    // default at all.
    const r = parseConditionResult(JSON.stringify({ reasoning: "no dice nada" }));
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("clamps a confidence the model reports outside 0..1", () => {
    const r = parseConditionResult(
      JSON.stringify({ condition: "reformado", confidence: 3.7 }),
    );
    expect(r.confidence).toBe(1);
  });

  it("drops non-string entries from issues defensively rather than throwing", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        confidence: 0.6,
        issues: ["humedad", 42, null, "  ", "instalación antigua"],
      }),
    );
    expect(r.issues).toEqual(["humedad", "instalación antigua"]);
  });

  it("throws on non-JSON output instead of silently returning unclear", () => {
    expect(() => parseConditionResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    expect(CONDITION_PROMPT_VERSION).toBe("condition/v1");
  });
});
