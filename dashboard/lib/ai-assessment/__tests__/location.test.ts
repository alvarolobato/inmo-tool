/**
 * Location assessment — unit tests (#388, Fase 3 de #385).
 *
 * Parsing-degrades-safely tests for `parseLocationResult`, plus the `terreno`
 * exclusion predicate. Prompt-CONTENT assertions (the graded vocabulary, the
 * evidence-quote requirement, "restates the correction after ASSESSMENT_RULES")
 * moved to `triage.test.ts` (#542): `location` is answered from the merged
 * `triage` prompt now (`buildTriagePrompt`), not a standalone `buildSystemPrompt
 * ("location", …)` call — that flow name no longer exists. The parser itself
 * (`parseLocationResult`/`parseLocationObject`) is UNCHANGED by the merge, so
 * every test below still exercises the real, unmodified degrade logic.
 *
 * The owner's constraint — detection is LLM-based, NEVER regex — is a property
 * of WHERE the value comes from (the prompt/model), which `triage.test.ts`
 * exercises by asserting the prompt demands a literal cited quote per graded
 * verdict; the parser tests below prove the CODE-SIDE half: an uncited claim
 * degrades to the safe default regardless of what the prompt asked for. There
 * is no ILIKE/keyword classifier to test because there is none in the runtime
 * path.
 */
import { describe, it, expect } from "vitest";
import {
  parseLocationResult,
  locationApplies,
  LOCATION_PROMPT_VERSION,
} from "../location";

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
  it("is the v2 axis version (#542, triage merge) so #308 re-assesses on future bumps", () => {
    expect(LOCATION_PROMPT_VERSION).toBe("location/v2");
  });
});
