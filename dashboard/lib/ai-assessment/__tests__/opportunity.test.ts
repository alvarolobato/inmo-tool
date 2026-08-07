/**
 * Opportunity assessment — unit tests (#398, Fase 5 de #385).
 *
 * Mirrors location.test.ts's structure: prompt-content assertions against the
 * REAL `buildSystemPrompt` output (not a spy), plus parsing-degrades-safely
 * tests for `parseOpportunityResult`, plus the `terreno` exclusion predicate.
 *
 * The owner's constraint — detection is LLM-based, NEVER regex — is a property
 * of WHERE the value comes from (the prompt/model), which these tests exercise
 * by asserting the prompt demands a literal cited quote per boolean and that the
 * parser degrades an uncited claim to false. There is no ILIKE/keyword
 * classifier to test because there is none in the runtime path.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import {
  parseOpportunityResult,
  opportunityApplies,
  OPPORTUNITY_PROMPT_VERSION,
} from "../opportunity";

const VPO_ADVERT: ListingSnapshot = {
  propertyId: 11,
  listingId: 401,
  source: "fotocasa",
  operation: "sale",
  propertyType: "piso",
  description:
    "Vivienda de protección oficial (VPO) con precio máximo de venta tasado, tres dormitorios.",
};

const TOURIST_ADVERT: ListingSnapshot = {
  propertyId: 11,
  listingId: 402,
  source: "idealista",
  operation: "sale",
  propertyType: "piso",
  description: "Apartamento con licencia turística concedida, número de registro VUT vigente.",
};

const SILENT_ADVERT: ListingSnapshot = {
  propertyId: 12,
  listingId: 403,
  source: "milanuncios",
  operation: "sale",
  propertyType: "piso",
  description: "Piso de 90 m2, tres dormitorios, dos baños. Luminoso y céntrico.",
};

function opportunityPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("opportunity", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

describe("opportunity prompt — closed vocabulary and evidence discipline", () => {
  it("states both booleans and their closed vocabulary inline", () => {
    const text = opportunityPromptText([VPO_ADVERT]);
    expect(text).toContain("is_vpo");
    expect(text).toContain("tourist_license");
    expect(text.toLowerCase()).toContain("protección oficial");
    expect(text.toLowerCase()).toContain("vivienda protegida");
    expect(text.toLowerCase()).toContain("licencia turística");
    expect(text.toLowerCase()).toContain("vut");
  });

  it("demands the tourist licence be ALREADY granted, not a mere potential", () => {
    const text = opportunityPromptText([TOURIST_ADVERT]).toLowerCase();
    expect(text).toContain("ya tiene concedida");
    // The prompt must warn against treating "posibilidad de licencia" as true.
    expect(text).toContain("posibilidad de licencia turística");
  });

  it("demands a literal evidence quote per signal or the safe default", () => {
    const text = opportunityPromptText([VPO_ADVERT]);
    expect(text).toContain("vpo_evidence");
    expect(text).toContain("tourist_license_evidence");
    expect(text.toLowerCase()).toContain("cita literal");
  });

  it("carries EVERY advert's description so a verdict can cite any of them", () => {
    const text = opportunityPromptText([VPO_ADVERT, TOURIST_ADVERT]);
    expect(text).toContain("protección oficial");
    expect(text).toContain("licencia turística concedida");
    expect(text).toContain("fotocasa");
    expect(text).toContain("idealista");
  });

  it("restates the false correction AFTER ASSESSMENT_RULES' generic unknown rule (recency wins)", () => {
    const text = opportunityPromptText([SILENT_ADVERT]);
    const genericUnknownRuleIdx = text.indexOf('`"unknown"` y una `confidence` baja');
    const correctionIdx = text.indexOf("Nota sobre la regla 2 anterior");
    expect(genericUnknownRuleIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(genericUnknownRuleIdx);
  });
});

describe("parseOpportunityResult — is_vpo", () => {
  it("parses is_vpo true with its evidence and source", () => {
    const r = parseOpportunityResult(
      JSON.stringify({
        is_vpo: true,
        vpo_evidence: "vivienda de protección oficial (VPO)",
        vpo_evidence_source: "fotocasa",
        tourist_license: false,
        confidence: 0.9,
        reasoning: "El anuncio afirma VPO explícitamente.",
      }),
    );
    expect(r.is_vpo).toBe(true);
    expect(r.vpo_evidence).toContain("protección oficial");
    expect(r.vpo_evidence_source).toBe("fotocasa");
    expect(r.confidence).toBe(0.9);
  });

  it("parses is_vpo false with no evidence as the unremarkable default", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ is_vpo: false, tourist_license: false, confidence: 0.6 }),
    );
    expect(r.is_vpo).toBe(false);
    expect(r.vpo_evidence).toBe("");
    expect(r.vpo_evidence_source).toBeNull();
  });

  it("tolerates a ```json code fence", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ is_vpo: true, vpo_evidence: "VPO", tourist_license: false }) +
      "\n```";
    expect(parseOpportunityResult(raw).is_vpo).toBe(true);
  });
});

describe("parseOpportunityResult — tourist_license", () => {
  it("parses tourist_license true with its own evidence", () => {
    const r = parseOpportunityResult(
      JSON.stringify({
        is_vpo: false,
        tourist_license: true,
        tourist_license_evidence: "licencia turística concedida, número de registro VUT",
        tourist_license_evidence_source: "idealista",
        confidence: 0.85,
      }),
    );
    expect(r.tourist_license).toBe(true);
    expect(r.tourist_license_evidence).toContain("licencia turística");
    expect(r.tourist_license_evidence_source).toBe("idealista");
  });

  it("parses tourist_license false", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ is_vpo: false, tourist_license: false }),
    );
    expect(r.tourist_license).toBe(false);
    expect(r.tourist_license_evidence).toBe("");
    expect(r.tourist_license_evidence_source).toBeNull();
  });
});

describe("parseOpportunityResult — evidence-or-false backstop (no manufactured signal)", () => {
  it("degrades is_vpo:true with NO evidence to false", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ is_vpo: true, vpo_evidence: "", confidence: 0.95 }),
    );
    expect(r.is_vpo).toBe(false);
    expect(r.vpo_evidence).toBe("");
  });

  it("degrades tourist_license:true with only-whitespace evidence to false", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ tourist_license: true, tourist_license_evidence: "   " }),
    );
    expect(r.tourist_license).toBe(false);
    expect(r.tourist_license_evidence).toBe("");
  });

  it("degrades a MISSING is_vpo/tourist_license to false rather than inventing them", () => {
    const r = parseOpportunityResult(JSON.stringify({ reasoning: "no dice nada relevante" }));
    expect(r.is_vpo).toBe(false);
    expect(r.tourist_license).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it("treats a non-boolean (string 'true') claim as not a finding", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ is_vpo: "true", vpo_evidence: "algo", tourist_license: "true" }),
    );
    expect(r.is_vpo).toBe(false);
    expect(r.tourist_license).toBe(false);
  });

  it("clamps a confidence reported outside 0..1", () => {
    const r = parseOpportunityResult(
      JSON.stringify({ is_vpo: true, vpo_evidence: "VPO", confidence: 4.2 }),
    );
    expect(r.confidence).toBe(1);
  });

  it("throws on non-JSON output instead of silently returning false", () => {
    expect(() => parseOpportunityResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });
});

describe("opportunityApplies — terreno exclusion (owner decision)", () => {
  it("excludes a terreno/solar from the axis", () => {
    expect(opportunityApplies("terreno")).toBe(false);
    expect(opportunityApplies("Terreno")).toBe(false);
    expect(opportunityApplies("  TERRENO ")).toBe(false);
  });

  it("applies to every other (or unknown) property type", () => {
    expect(opportunityApplies("piso")).toBe(true);
    expect(opportunityApplies("chalet")).toBe(true);
    expect(opportunityApplies(null)).toBe(true);
    expect(opportunityApplies(undefined)).toBe(true);
  });
});

describe("OPPORTUNITY_PROMPT_VERSION", () => {
  it("is the v1 axis version so #308 re-assesses on future bumps", () => {
    expect(OPPORTUNITY_PROMPT_VERSION).toBe("opportunity/v1");
  });
});
