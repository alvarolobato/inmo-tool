/**
 * Location assessment — unit tests (#388, Fase 3 de #385).
 *
 * Mirrors condition.test.ts's structure: prompt-content assertions against the
 * REAL `buildSystemPrompt` output (not a spy), plus parsing-degrades-safely
 * tests for `parseLocationResult`, plus the `terreno` exclusion predicate.
 *
 * The owner's constraint — detection is LLM-based, NEVER regex — is a property
 * of WHERE the value comes from (the prompt/model), which these tests exercise
 * by asserting the prompt demands a literal cited quote per graded verdict and
 * that the parser degrades an uncited claim to the safe default. There is no
 * ILIKE/keyword classifier to test because there is none in the runtime path.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import {
  parseLocationResult,
  locationApplies,
  LOCATION_PROMPT_VERSION,
} from "../location";

const FRONTLINE_ADVERT: ListingSnapshot = {
  propertyId: 7,
  listingId: 301,
  source: "fotocasa",
  operation: "sale",
  propertyType: "piso",
  description:
    "Piso en primera línea de playa, a pie de arena, con acceso directo al paseo marítimo.",
};

const SEA_VIEW_ADVERT: ListingSnapshot = {
  propertyId: 7,
  listingId: 302,
  source: "milanuncios",
  operation: "sale",
  propertyType: "piso",
  description: "Ático con espectaculares vistas al mar, aunque no es primera línea.",
};

const SILENT_ADVERT: ListingSnapshot = {
  propertyId: 8,
  listingId: 303,
  source: "idealista",
  operation: "sale",
  propertyType: "piso",
  description: "Piso de 90 m2 en el interior, tres dormitorios, dos baños. Luminoso.",
};

function locationPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("location", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

describe("location prompt — graded vocabulary and evidence discipline", () => {
  it("states the closed, graded beach vocabulary inline", () => {
    const text = locationPromptText([FRONTLINE_ADVERT]);
    for (const v of ["frontline", "sea_view", "near_beach", "none"]) {
      expect(text).toContain(v);
    }
    expect(text).toContain("heritage_zone");
  });

  it("draws the primera-línea vs. vistas-al-mar vs. cerca distinction explicitly", () => {
    const text = locationPromptText([FRONTLINE_ADVERT]).toLowerCase();
    expect(text).toContain("primera línea");
    expect(text).toContain("vistas al mar");
    expect(text).toContain("paseo marítimo");
    // The prompt must warn against conflating the grades.
    expect(text).toContain('"vistas al mar" no es');
  });

  it("demands a literal evidence quote per signal or the safe default", () => {
    const text = locationPromptText([FRONTLINE_ADVERT]);
    expect(text).toContain("beach_evidence");
    expect(text).toContain("heritage_evidence");
    expect(text.toLowerCase()).toContain("cita literal");
  });

  it("carries EVERY advert's description so a verdict can cite any of them", () => {
    const text = locationPromptText([SEA_VIEW_ADVERT, FRONTLINE_ADVERT]);
    expect(text).toContain("primera línea de playa");
    expect(text).toContain("vistas al mar");
    expect(text).toContain("fotocasa");
    expect(text).toContain("milanuncios");
  });

  it("restates the none/false correction AFTER ASSESSMENT_RULES' generic unknown rule (recency wins)", () => {
    const text = locationPromptText([SILENT_ADVERT]);
    const genericUnknownRuleIdx = text.indexOf('`"unknown"` y una `confidence` baja');
    const correctionIdx = text.indexOf("Nota sobre la regla 2 anterior");
    expect(genericUnknownRuleIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(genericUnknownRuleIdx);
  });
});

describe("parseLocationResult — graded beach values", () => {
  it("parses `frontline` with its evidence and source", () => {
    const r = parseLocationResult(
      JSON.stringify({
        beach_proximity: "frontline",
        beach_evidence: "primera línea de playa, a pie de arena",
        beach_evidence_source: "fotocasa",
        heritage_zone: false,
        confidence: 0.9,
        reasoning: "El anuncio afirma primera línea explícitamente.",
      }),
    );
    expect(r.beach_proximity).toBe("frontline");
    expect(r.beach_evidence).toContain("primera línea");
    expect(r.beach_evidence_source).toBe("fotocasa");
    expect(r.confidence).toBe(0.9);
  });

  it("parses `sea_view`", () => {
    const r = parseLocationResult(
      JSON.stringify({
        beach_proximity: "sea_view",
        beach_evidence: "espectaculares vistas al mar",
        confidence: 0.8,
      }),
    );
    expect(r.beach_proximity).toBe("sea_view");
  });

  it("parses `near_beach`", () => {
    const r = parseLocationResult(
      JSON.stringify({
        beach_proximity: "near_beach",
        beach_evidence: "playa a 300 m, junto al paseo marítimo",
        confidence: 0.7,
      }),
    );
    expect(r.beach_proximity).toBe("near_beach");
  });

  it("parses `none` with no evidence as the unremarkable default", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "none", heritage_zone: false, confidence: 0.6 }),
    );
    expect(r.beach_proximity).toBe("none");
    expect(r.beach_evidence).toBe("");
  });

  it("tolerates a ```json code fence", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ beach_proximity: "frontline", beach_evidence: "primera línea" }) +
      "\n```";
    expect(parseLocationResult(raw).beach_proximity).toBe("frontline");
  });
});

describe("parseLocationResult — heritage_zone", () => {
  it("parses heritage_zone true with its own evidence", () => {
    const r = parseLocationResult(
      JSON.stringify({
        beach_proximity: "none",
        heritage_zone: true,
        heritage_evidence: "en pleno casco histórico de la ciudad",
        heritage_evidence_source: "idealista",
        confidence: 0.85,
      }),
    );
    expect(r.heritage_zone).toBe(true);
    expect(r.heritage_evidence).toContain("casco histórico");
    expect(r.heritage_evidence_source).toBe("idealista");
  });

  it("parses heritage_zone false", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "none", heritage_zone: false }),
    );
    expect(r.heritage_zone).toBe(false);
    expect(r.heritage_evidence).toBe("");
    expect(r.heritage_evidence_source).toBeNull();
  });
});

describe("parseLocationResult — evidence-or-fallback backstop (no manufactured signal)", () => {
  it("degrades a non-`none` beach verdict with NO evidence to `none` at zero confidence", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "frontline", beach_evidence: "", confidence: 0.95 }),
    );
    expect(r.beach_proximity).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("degrades a heritage_zone:true with NO evidence to false", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "none", heritage_zone: true, heritage_evidence: "   " }),
    );
    expect(r.heritage_zone).toBe(false);
    expect(r.heritage_evidence).toBe("");
  });

  it("degrades an unrecognised beach value to `none` at zero confidence", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "muy_cerca_del_mar", beach_evidence: "algo", confidence: 0.9 }),
    );
    expect(r.beach_proximity).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("degrades a MISSING beach_proximity to `none` rather than inventing a grade", () => {
    const r = parseLocationResult(JSON.stringify({ reasoning: "no dice nada de la playa" }));
    expect(r.beach_proximity).toBe("none");
    expect(r.heritage_zone).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it("clamps a confidence reported outside 0..1", () => {
    const r = parseLocationResult(
      JSON.stringify({ beach_proximity: "frontline", beach_evidence: "primera línea", confidence: 4.2 }),
    );
    expect(r.confidence).toBe(1);
  });

  it("throws on non-JSON output instead of silently returning `none`", () => {
    expect(() => parseLocationResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });
});

describe("locationApplies — terreno exclusion (owner decision)", () => {
  it("excludes a terreno/solar from the axis", () => {
    expect(locationApplies("terreno")).toBe(false);
    expect(locationApplies("Terreno")).toBe(false);
    expect(locationApplies("  TERRENO ")).toBe(false);
  });

  it("applies to every other (or unknown) property type", () => {
    expect(locationApplies("piso")).toBe(true);
    expect(locationApplies("chalet")).toBe(true);
    expect(locationApplies(null)).toBe(true);
    expect(locationApplies(undefined)).toBe(true);
  });
});

describe("LOCATION_PROMPT_VERSION", () => {
  it("is the v1 axis version so #308 re-assesses on future bumps", () => {
    expect(LOCATION_PROMPT_VERSION).toBe("location/v1");
  });
});
