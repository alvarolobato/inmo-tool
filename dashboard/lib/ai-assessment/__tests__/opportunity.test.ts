/**
 * Opportunity assessment — unit tests (#398, Fase 5 de #385).
 *
 * Parsing-degrades-safely tests for `parseOpportunityResult`, plus the
 * `terreno` exclusion predicate. Prompt-CONTENT assertions moved to
 * `triage.test.ts` (#542): `opportunity` is answered from the merged `triage`
 * prompt now, not a standalone `buildSystemPrompt("opportunity", …)` call —
 * that flow name no longer exists. The parser itself
 * (`parseOpportunityResult`/`parseOpportunityObject`) is UNCHANGED by the
 * merge, so every test below still exercises the real, unmodified degrade
 * logic.
 *
 * The owner's constraint — detection is LLM-based, NEVER regex — is a property
 * of WHERE the value comes from (the prompt/model), which `triage.test.ts`
 * exercises by asserting the prompt demands a literal cited quote per boolean;
 * the parser tests below prove the CODE-SIDE half: an uncited claim degrades
 * to false regardless of what the prompt asked for. There is no ILIKE/keyword
 * classifier to test because there is none in the runtime path.
 */
import { describe, it, expect } from "vitest";
import {
  parseOpportunityResult,
  opportunityApplies,
  OPPORTUNITY_PROMPT_VERSION,
} from "../opportunity";

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
  it("is the v2 axis version (#542, triage merge) so #308 re-assesses on future bumps", () => {
    expect(OPPORTUNITY_PROMPT_VERSION).toBe("opportunity/v2");
  });
});
