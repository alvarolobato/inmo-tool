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

describe("condition prompt — `unclear` override survives ASSESSMENT_RULES (#168 review, must-fix 2)", () => {
  // ASSESSMENT_RULES (shared by every flow) tells the model to answer
  // insufficient info with `"unknown"` — a value outside CONDITION_CATEGORIES.
  // A model resolving the conflict by recency (the last instruction it reads
  // wins) would emit `unknown`, which `parseVerdict` then degrades to
  // `unclear` at FORCED zero confidence (via `known === false`) regardless of
  // what confidence the model actually reported — turning a deliberate
  // low-confidence "I don't know" into something indistinguishable from
  // garbage. Occupancy's ejes-2/3 exception already established the fix:
  // restate the flow-specific rule AFTER ASSESSMENT_RULES so it's the last
  // thing the model reads (occupancy.test.ts, "survives ASSESSMENT_RULES").
  it("restates the `unclear`-not-`unknown` correction AFTER ASSESSMENT_RULES' generic unknown rule", () => {
    const text = conditionPromptText([SILENT_ADVERT]);

    const genericUnknownRuleIdx = text.indexOf('`"unknown"` y una `confidence` baja');
    const correctionIdx = text.indexOf("Nota sobre la regla 2 anterior");

    expect(genericUnknownRuleIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(-1);
    // The correction must come LAST: it is what a model resolving a conflict
    // by recency will actually obey.
    expect(correctionIdx).toBeGreaterThan(genericUnknownRuleIdx);
  });

  it("explicitly tells the model `unknown` is not a valid `condition` value", () => {
    const text = conditionPromptText([SILENT_ADVERT]);
    expect(text).toContain("`unknown` no es un valor válido de");
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
    const raw =
      "```json\n" +
      JSON.stringify({
        condition: "obra_nueva",
        confidence: 0.7,
        evidence: "promoción de obra nueva a estrenar",
      }) +
      "\n```";
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
      JSON.stringify({
        condition: "reformado",
        confidence: 3.7,
        evidence: "reformado integral en 2022",
      }),
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

  it("degrades a non-`unclear` verdict with no evidence citation to `unclear` at zero confidence (#168 review, also-fix)", () => {
    // Condition was the only one of the three flows (#25/#26/#27) with no
    // code-side "no citation, no assertion" backstop. Redflags drops an
    // uncited flag (redflags.ts); occupancy's ejes 2/3 only assert from
    // silence via a deliberate, capped exception. Condition had nothing:
    // `{"condition":"a_reformar","confidence":0.95,"evidence":""}` used to
    // write through unchanged — and condition drives a visible card badge,
    // which uncited red flags never do.
    const r = parseConditionResult(
      JSON.stringify({ condition: "a_reformar", confidence: 0.95, evidence: "" }),
    );
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("still accepts a non-`unclear` verdict when evidence IS cited", () => {
    // Guards against an overzealous fix that forces everything to `unclear`.
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        confidence: 0.8,
        evidence: "necesita reforma integral",
      }),
    );
    expect(r.condition).toBe("a_reformar");
    expect(r.confidence).toBe(0.8);
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    expect(CONDITION_PROMPT_VERSION).toBe("condition/v1");
  });
});

describe("condition prompt — hash-scoped fields are invisible (#30 review, must-fix 1)", () => {
  it("never emits precio_eur, m2_construidos, habitaciones, banos, planta, or num_fotos", () => {
    const withStructuredFields: ListingSnapshot = {
      ...SILENT_ADVERT,
      price: 250000,
      m2Built: 90,
      rooms: 3,
      bathrooms: 2,
      floor: "3",
      photoUrls: ["a.jpg"],
    };
    const text = conditionPromptText([withStructuredFields]);
    expect(text).not.toContain("precio_eur");
    expect(text).not.toContain("m2_construidos");
    expect(text).not.toContain("habitaciones:");
    expect(text).not.toContain("banos:");
    expect(text).not.toContain("planta:");
    expect(text).not.toContain("num_fotos");
  });
});
