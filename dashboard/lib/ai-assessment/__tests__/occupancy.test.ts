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

describe("occupancy prompt — derived area-price signal (#184)", () => {
  it("renders the signal, labelled, when FlowVars.areaPriceSignal is set", () => {
    const { stable, volatile } = buildSystemPrompt("occupancy", {
      listings: [SILENT_ADVERT],
      areaPriceSignal:
        "El precio de este inmueble está aproximadamente un 20-30% por debajo de la mediana de precio/m² de inmuebles comparables en su zona (radio 1km, 10-19 comparables).",
    });
    const text = `${stable}\n${volatile ?? ""}`;

    expect(text).toContain("DATO DERIVADO: PRECIO VS. ZONA");
    expect(text).toContain("20-30% por debajo");
  });

  it("renders no PER-PROPERTY figure when areaPriceSignal is absent (#184 requirement 2 — no fabricated 'in line with market')", () => {
    // The general rules block (what to do IF a signal appears) is always in
    // `stable` — see the next test. What must NOT appear without a real
    // signal is the labelled per-request block that would carry an actual
    // number/band; its header is unique to that block.
    const { volatile } = buildSystemPrompt("occupancy", { listings: [SILENT_ADVERT] });
    expect(volatile ?? "").not.toContain("DATO DERIVADO: PRECIO VS. ZONA");
  });

  it("always includes the general rules for how to weigh the signal, whether or not one is present this request (stable, cache-friendly text)", () => {
    // The RULES text (what to do IF a signal appears) must be part of the
    // flow's stable prefix regardless of this particular request having a
    // signal — only the actual figure is per-request/volatile. Otherwise the
    // stable prefix would vary by request, defeating prompt caching.
    const withSignal = buildSystemPrompt("occupancy", {
      listings: [SILENT_ADVERT],
      areaPriceSignal: "20-30% por debajo",
    }).stable;
    const withoutSignal = buildSystemPrompt("occupancy", { listings: [SILENT_ADVERT] }).stable;

    expect(withSignal).toBe(withoutSignal);
    expect(withSignal).toContain("Contexto de precio de zona");
  });

  it(
    "the evidence/no-assertion rules for the derived signal come AFTER ASSESSMENT_RULES in the " +
      "assembled string (#184 requirement 4 — a rule stated before ASSESSMENT_RULES loses to a " +
      "contradicting rule inside it; mirrors the ejes-2/3 exception test above)",
    () => {
      const text = occupancyPromptText([SILENT_ADVERT]);

      const genericNoCiteRuleIdx = text.indexOf("no afirmes nada");
      const derivedSignalRuleIdx = text.indexOf("NO la cites como");

      expect(genericNoCiteRuleIdx).toBeGreaterThan(-1);
      expect(derivedSignalRuleIdx).toBeGreaterThan(-1);
      expect(derivedSignalRuleIdx).toBeGreaterThan(genericNoCiteRuleIdx);
    },
  );

  it("explicitly forbids citing the derived signal as `evidence`", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);
    expect(text).toContain("NO la cites como");
    expect(text.toLowerCase()).toContain("fabricar una cita");
  });

  it("explicitly forbids treating the derived signal as proof by itself, only as a scrutiny cue", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);
    expect(text).toMatch(/NO la uses,? por sí sola/);
    expect(text.toLowerCase()).toContain("explicaciones inocentes");
  });

  it("the eje-1 'price is not shown' sentence references the derived-signal exception rather than flatly contradicting it", () => {
    const text = occupancyPromptText([SILENT_ADVERT]);
    // Both statements must coexist without the model reading them as opposed:
    // raw price is still hidden, AND a derived comparison may separately appear.
    expect(text).toContain("El precio exacto del");
    expect(text).toContain("Excepción explícita a esto");
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
    // new outputs stay comparable after a prompt edit. Bumped to v2 for #184
    // (the derived area-price signal changed both the stable rules text and
    // the volatile payload shape) — see OCCUPANCY_PROMPT_VERSION's doc.
    expect(OCCUPANCY_PROMPT_VERSION).toBe("occupancy/v2");
  });
});

describe("occupancy prompt — hash-scoped fields are genuinely invisible (#30 review, must-fix 1)", () => {
  /**
   * The review's own probe: two snapshots differing ONLY in a field
   * `computeAssessmentContentHash` (cache.ts) excludes must now produce the
   * IDENTICAL prompt — not just the identical hash, which was already true
   * and is what made the old "none of those are shown to the model" doc
   * claim false without a test catching it.
   */
  const base: ListingSnapshot = {
    propertyId: 7,
    listingId: 101,
    source: "fotocasa",
    operation: "sale",
    description: "Piso de 90 m2 en Chamberí. Tres dormitorios, dos baños. Luminoso.",
    price: 250000,
    m2Built: 90,
    rooms: 3,
    bathrooms: 2,
    floor: "3",
    photoUrls: ["a.jpg", "b.jpg"],
  };

  it("a price-only change produces an IDENTICAL prompt, not just an identical hash", () => {
    const cheaper: ListingSnapshot = { ...base, price: 150000 };
    expect(occupancyPromptText([base])).toBe(occupancyPromptText([cheaper]));
  });

  it("a photo-count-only change produces an IDENTICAL prompt", () => {
    const morePhotos: ListingSnapshot = { ...base, photoUrls: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"] };
    expect(occupancyPromptText([base])).toBe(occupancyPromptText([morePhotos]));
  });

  it("a rooms/m2Built/floor-only change produces an IDENTICAL prompt", () => {
    const differentStructured: ListingSnapshot = {
      ...base,
      rooms: 5,
      m2Built: 140,
      floor: "ático",
    };
    expect(occupancyPromptText([base])).toBe(occupancyPromptText([differentStructured]));
  });

  it("never emits precio_eur, m2_construidos, habitaciones, banos, planta, or num_fotos", () => {
    const text = occupancyPromptText([base]);
    expect(text).not.toContain("precio_eur");
    expect(text).not.toContain("m2_construidos");
    expect(text).not.toContain("habitaciones:");
    expect(text).not.toContain("banos:");
    expect(text).not.toContain("planta:");
    expect(text).not.toContain("num_fotos");
    // The description itself (the actual hashed content) must still be there.
    expect(text).toContain("Chamberí");
  });

  it("no longer instructs the model to weigh price as an occupancy signal (it can't see price)", () => {
    const text = occupancyPromptText([base]);
    expect(text).not.toContain("precio muy por debajo de mercado");
  });
});
