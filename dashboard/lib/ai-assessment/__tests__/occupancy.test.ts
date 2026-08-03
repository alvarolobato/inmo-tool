/**
 * Occupancy assessment — unit tests (#25, extended by #145).
 *
 * The central claim of #25 is that occupancy is a property-level fact, so the
 * model must see EVERY merged advert at once. These tests therefore focus on
 * two things a mock-heavy test would miss:
 *
 *  1. The evidence union genuinely reaches the prompt — a disclosure that
 *     appears in only one of three adverts must be visible to the model.
 *     Asserted against the real `buildSystemPrompt` output, not a spy on a
 *     function we hope carries it.
 *  2. Parsing degrades safely. These verdicts feed scoring and the deal
 *     pipeline, so a hallucinated or missing axis must never surface as a
 *     confident answer.
 *
 * The real end-to-end question ("does the model actually say `tenanted` when
 * one advert says «se vende con inquilino»?") is a model-behaviour question,
 * not a code question — it is covered by the mock provider in e2e, and by the
 * prompt-content assertions here. See occupancy.integration.test.ts for the
 * one-property-one-row guarantee against a real database.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import {
  parseOccupancyResult,
  deriveCaveats,
  summaryConfidence,
  OCCUPANCY_PROMPT_VERSION,
} from "../occupancy";

/**
 * Three adverts for ONE physical flat, as the dedup engine leaves them.
 * Only the Milanuncios one mentions the tenant; only the Fotocasa one
 * mentions the debt sale. Neither portal has the whole picture — which is
 * the entire reason the assessment reads all of them together.
 */
const SILENT_ADVERT: ListingSnapshot = {
  propertyId: 7,
  listingId: 101,
  source: "fotocasa",
  operation: "sale",
  description: "Piso de 90 m2 en Chamberí. Tres dormitorios, dos baños. Luminoso.",
};

const DISCLOSING_ADVERT: ListingSnapshot = {
  propertyId: 7,
  listingId: 102,
  source: "milanuncios",
  operation: "sale",
  description: "Piso en Chamberí, se vende con inquilino, rentabilidad garantizada.",
};

const THIRD_ADVERT: ListingSnapshot = {
  propertyId: 7,
  listingId: 103,
  source: "idealista",
  operation: "sale",
  description: "Vivienda en zona Chamberí. Consultar condiciones de la operación.",
};

function occupancyPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("occupancy", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

describe("occupancy prompt — evidence union", () => {
  it("carries EVERY advert's description, not just the first", () => {
    const text = occupancyPromptText([SILENT_ADVERT, DISCLOSING_ADVERT, THIRD_ADVERT]);

    // The disclosure exists in exactly one of the three adverts. If the
    // prompt only carried the newest/first listing, this is the assertion
    // that fails — and it is the whole point of the #25 re-key.
    expect(text).toContain("se vende con inquilino");
    // ...without dropping the other two.
    expect(text).toContain("Tres dormitorios");
    expect(text).toContain("Consultar condiciones de la operación");
  });

  it("labels each advert with its portal so a verdict can cite a source", () => {
    const text = occupancyPromptText([SILENT_ADVERT, DISCLOSING_ADVERT, THIRD_ADVERT]);

    expect(text).toContain("fotocasa");
    expect(text).toContain("milanuncios");
    expect(text).toContain("idealista");
    // Numbered so the model can refer to "ANUNCIO 2 DE 3" unambiguously.
    expect(text).toMatch(/ANUNCIO\s+1\s+DE\s+3/i);
    expect(text).toMatch(/ANUNCIO\s+3\s+DE\s+3/i);
  });

  it("tells the model the adverts are ONE property, not three candidates", () => {
    const text = occupancyPromptText([SILENT_ADVERT, DISCLOSING_ADVERT]);

    // Without this framing the model reasonably reads a multi-listing payload
    // as "compare these properties" and returns a comparison, not a verdict.
    expect(text.toLowerCase()).toContain("mismo inmueble");
  });

  it("instructs that a concrete mention outweighs silence", () => {
    const text = occupancyPromptText([SILENT_ADVERT, DISCLOSING_ADVERT]);

    // EC-4's rule. Without it the model can average three adverts into
    // `unknown` and lose the one disclosure that mattered.
    expect(text.toLowerCase()).toContain("silencio");
  });

  it("still works for a property with a single advert", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);
    expect(text).toContain("Tres dormitorios");
    expect(text).toMatch(/ANUNCIO\s+1\s+DE\s+1/i);
  });
});

describe("occupancy prompt — axis 2/3 silence override survives ASSESSMENT_RULES (#156 review, must-fix 3)", () => {
  // ASSESSMENT_RULES (shared by every flow) tells the model "unknown + baja
  // confidence" on insufficient info, and "if you can't cite anything, don't
  // assert anything" — both of which flatly contradict the occupancy-specific
  // instruction to answer compraventa/pleno_dominio from silence on ejes 2-3.
  // Assembled-prompt ordering matters here (a later instruction can shadow an
  // earlier one), so these assertions read the REAL buildSystemPrompt output,
  // not the template source.
  it("restates the ejes-2/3 override AFTER ASSESSMENT_RULES' generic unknown/no-citation rules", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);

    const genericNoCiteRuleIdx = text.indexOf("no afirmes nada");
    const overrideIdx = text.indexOf("Excepción a las reglas 2 y 3");

    expect(genericNoCiteRuleIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(-1);
    // The override must come LAST: it is what a model resolving a conflict by
    // recency will actually obey.
    expect(overrideIdx).toBeGreaterThan(genericNoCiteRuleIdx);
  });

  it("explicitly tells the model NOT to answer unknown on ejes 2-3 for lack of a citation", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);

    expect(text).toContain(
      "NO respondas `unknown` en los ejes 2 o 3 solo porque no hay",
    );
  });

  it("keeps the generic unknown-on-silence rule binding for eje 1 with no exception", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);

    expect(text).toContain("SIN excepción al");
    expect(text).toMatch(/eje 1 \(ocupación\)/);
  });
});

describe("parseOccupancyResult", () => {
  const full = JSON.stringify({
    occupancy: {
      status: "tenanted",
      confidence: 0.9,
      evidence: "se vende con inquilino",
      evidence_source: "milanuncios",
    },
    transaction: {
      kind: "compraventa",
      confidence: 0.8,
      evidence: "compraventa",
      evidence_source: "fotocasa",
    },
    ownership: {
      extent: "pleno_dominio",
      confidence: 0.7,
      evidence: "",
      evidence_source: null,
      share_pct: null,
    },
    reasoning: "Un anuncio declara inquilino, el otro calla.",
  });

  it("parses all three axes with their own evidence and source", () => {
    const r = parseOccupancyResult(full);

    expect(r.occupancy.value).toBe("tenanted");
    expect(r.occupancy.confidence).toBe(0.9);
    // EC-4: the verdict names the advert that justified it.
    expect(r.occupancy.evidence_source).toBe("milanuncios");
    expect(r.transaction.value).toBe("compraventa");
    expect(r.ownership.value).toBe("pleno_dominio");
  });

  it("derives caveats from the axes rather than trusting the model", () => {
    const r = parseOccupancyResult(full);
    expect(r.caveats).toEqual(["tenanted"]);
  });

  it("tolerates a ```json code fence", () => {
    const r = parseOccupancyResult("```json\n" + full + "\n```");
    expect(r.occupancy.value).toBe("tenanted");
  });

  it("degrades an unrecognised status to unknown with ZERO confidence", () => {
    // A prompt drift or hallucinated category must not look like a confident
    // verdict downstream — it feeds scoring.
    const r = parseOccupancyResult(
      JSON.stringify({
        occupancy: { status: "probablemente_vacío", confidence: 0.95 },
      }),
    );

    expect(r.occupancy.value).toBe("unknown");
    expect(r.occupancy.confidence).toBe(0);
  });

  it("degrades a MISSING axis to unknown rather than defaulting to all-clear", () => {
    // EC-2: silence is "we learned nothing", never "vacant / pleno dominio".
    const r = parseOccupancyResult(JSON.stringify({ reasoning: "no dice nada" }));

    expect(r.occupancy.value).toBe("unknown");
    expect(r.transaction.value).toBe("unknown");
    expect(r.ownership.value).toBe("unknown");
    expect(r.caveats).toEqual([]);
  });

  it("clamps a confidence the model reports outside 0..1", () => {
    const r = parseOccupancyResult(
      JSON.stringify({ occupancy: { status: "vacant", confidence: 4.2 } }),
    );
    expect(r.occupancy.confidence).toBe(1);
  });

  it("throws on non-JSON output instead of silently returning unknown", () => {
    // A totally broken response is an operational problem worth surfacing,
    // not a verdict worth storing.
    expect(() => parseOccupancyResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });
});

describe("deriveCaveats", () => {
  it("flags every non-standard condition at once", () => {
    // The listing that motivated three axes instead of one enum: a squatted
    // debt sale of a 50% share.
    expect(deriveCaveats("occupied_illegally", "venta_deuda", "proindiviso")).toEqual([
      "occupied_illegally",
      "venta_deuda",
      "proindiviso",
    ]);
  });

  it("never turns unknown into a caveat", () => {
    // Absence of evidence is not evidence of a problem — a badge implies we
    // actually found something.
    expect(deriveCaveats("unknown", "unknown", "unknown")).toEqual([]);
  });

  it("treats vacant + compraventa + pleno_dominio as clean", () => {
    expect(deriveCaveats("vacant", "compraventa", "pleno_dominio")).toEqual([]);
  });
});

describe("summaryConfidence", () => {
  const verdict = <T>(value: T, confidence: number) => ({
    value,
    confidence,
    evidence: "",
    evidence_source: null,
  });

  it("reports the strongest flagged axis, not an average", () => {
    // The stored `confidence` column drives sorting/badging: a 0.9-confidence
    // squat must not be diluted by two low-confidence clean axes.
    const r = parseOccupancyResult(
      JSON.stringify({
        occupancy: { status: "occupied_illegally", confidence: 0.9 },
        transaction: { kind: "compraventa", confidence: 0.2 },
        ownership: { extent: "pleno_dominio", confidence: 0.1 },
      }),
    );
    expect(summaryConfidence(r)).toBe(0.9);
  });

  it("falls back to the occupancy confidence when nothing is flagged", () => {
    expect(
      summaryConfidence({
        occupancy: verdict("vacant" as const, 0.65),
        transaction: verdict("compraventa" as const, 0.4),
        ownership: { ...verdict("pleno_dominio" as const, 0.3), share_pct: null },
        caveats: [],
        reasoning: "",
      }),
    ).toBe(0.65);
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    // ai_assessment's unique key includes prompt_version precisely so old and
    // new outputs stay comparable after a prompt edit.
    expect(OCCUPANCY_PROMPT_VERSION).toBe("occupancy/v1");
  });
});
