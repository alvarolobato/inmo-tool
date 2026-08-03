/**
 * Unit tests for the occupancy assessment's output contract (#25, #145).
 *
 * These cover the parsing/derivation layer, which is where a bad model
 * response turns into a bad investment signal. The LLM itself is exercised
 * separately — here the input is the JSON text a model would return.
 */

import { describe, it, expect } from "vitest";

import {
  parseOccupancyResult,
  deriveCaveats,
  summaryConfidence,
} from "../occupancy";

/** A well-formed three-axis response, overridable per test. */
function modelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    occupancy: {
      status: "unknown",
      confidence: 0.2,
      evidence: "",
      evidence_source: null,
    },
    transaction: {
      kind: "compraventa",
      confidence: 0.65,
      evidence: "",
      evidence_source: null,
    },
    ownership: {
      extent: "pleno_dominio",
      share_pct: null,
      confidence: 0.65,
      evidence: "",
      evidence_source: null,
    },
    reasoning: "Sin señales relevantes.",
    ...overrides,
  });
}

describe("parseOccupancyResult — occupancy axis (#25)", () => {
  it("detects explicit tenant-occupied phrasing", () => {
    const result = parseOccupancyResult(
      modelJson({
        occupancy: {
          status: "tenanted",
          confidence: 0.92,
          evidence: "se vende con inquilino, contrato hasta 2027",
          evidence_source: "fotocasa",
        },
      }),
    );

    expect(result.occupancy.value).toBe("tenanted");
    expect(result.occupancy.confidence).toBeGreaterThan(0.7);
    expect(result.occupancy.evidence).toContain("inquilino");
    expect(result.occupancy.evidence_source).toBe("fotocasa");
    expect(result.caveats).toContain("tenanted");
  });

  it("no signal yields unclear, not a guess", () => {
    const result = parseOccupancyResult(modelJson());

    expect(result.occupancy.value).toBe("unknown");
    // An unknown occupancy is not a problem found, so it must not be badged.
    expect(result.caveats).toEqual([]);
  });

  it("degrades a hallucinated status to unknown with zero confidence", () => {
    const result = parseOccupancyResult(
      modelJson({
        occupancy: { status: "probably_empty", confidence: 0.99, evidence: "x" },
      }),
    );

    expect(result.occupancy.value).toBe("unknown");
    expect(result.occupancy.confidence).toBe(0);
  });
});

describe("parseOccupancyResult — #145 axes", () => {
  it("detects a debt sale (cesión de crédito)", () => {
    const result = parseOccupancyResult(
      modelJson({
        transaction: {
          kind: "venta_deuda",
          confidence: 0.88,
          evidence: "cesión de crédito hipotecario, no se transmite el inmueble",
          evidence_source: "servihabitat",
        },
      }),
    );

    expect(result.transaction.value).toBe("venta_deuda");
    expect(result.transaction.evidence_source).toBe("servihabitat");
    expect(result.caveats).toContain("venta_deuda");
  });

  it("detects nuda propiedad as a partial sale", () => {
    const result = parseOccupancyResult(
      modelJson({
        ownership: {
          extent: "nuda_propiedad",
          share_pct: null,
          confidence: 0.9,
          evidence: "se vende la nuda propiedad, usufructo vitalicio reservado",
          evidence_source: "idealista",
        },
      }),
    );

    expect(result.ownership.value).toBe("nuda_propiedad");
    expect(result.caveats).toContain("nuda_propiedad");
  });

  it("captures the share percentage of a proindiviso", () => {
    const result = parseOccupancyResult(
      modelJson({
        ownership: {
          extent: "proindiviso",
          share_pct: 50,
          confidence: 0.85,
          evidence: "se vende el 50% indiviso de la vivienda",
          evidence_source: "milanuncios",
        },
      }),
    );

    expect(result.ownership.value).toBe("proindiviso");
    expect(result.ownership.share_pct).toBe(50);
  });

  it.each([
    ["out of range high", 150],
    ["zero", 0],
    // A model writing the fraction form of a percentage (0.5 meaning "50%",
    // not "0.5%") — no real proindiviso sale trades a sub-1% stake, so this
    // must drop to null rather than being stored as a ~100x-too-small share
    // (#156 review, nice-to-have).
    ["a fraction the model wrote as 0.5", 0.5],
    ["a string", "50%"],
  ])("drops an implausible share_pct (%s) to null", (_label, value) => {
    const result = parseOccupancyResult(
      modelJson({
        ownership: { extent: "proindiviso", share_pct: value, confidence: 0.8 },
      }),
    );

    expect(result.ownership.share_pct).toBeNull();
  });

  it("a missing axis degrades to unknown rather than a clean default", () => {
    // The dangerous failure mode: silence read as "no debt sale, full title".
    const result = parseOccupancyResult(
      JSON.stringify({ occupancy: { status: "vacant", confidence: 0.8 } }),
    );

    expect(result.transaction.value).toBe("unknown");
    expect(result.transaction.confidence).toBe(0);
    expect(result.ownership.value).toBe("unknown");
    expect(result.caveats).toEqual([]);
  });
});

describe("parseOccupancyResult — confidence cap on evidence-free positive verdicts (#156 review, must-fix 1)", () => {
  // The prompt's own silence rule only licenses "~0.6-0.7" for a
  // compraventa/pleno_dominio verdict reached because nothing contradicts
  // it. Without code-side enforcement, a model returning e.g. 0.95 for that
  // same uncited default is written straight through and can clear a
  // `WHERE confidence > 0.7` filter as if it were evidence-backed.

  it("clamps transaction.confidence to <=0.7 when compraventa comes from silence", () => {
    const result = parseOccupancyResult(
      modelJson({
        transaction: {
          kind: "compraventa",
          confidence: 0.95,
          evidence: "",
          evidence_source: null,
        },
      }),
    );

    expect(result.transaction.value).toBe("compraventa");
    expect(result.transaction.confidence).toBeLessThanOrEqual(0.7);
  });

  it("clamps ownership.confidence to <=0.7 when pleno_dominio comes from silence", () => {
    const result = parseOccupancyResult(
      modelJson({
        ownership: {
          extent: "pleno_dominio",
          share_pct: null,
          confidence: 0.99,
          evidence: "",
          evidence_source: null,
        },
      }),
    );

    expect(result.ownership.value).toBe("pleno_dominio");
    expect(result.ownership.confidence).toBeLessThanOrEqual(0.7);
  });

  it("does NOT clamp when the same default value is actually backed by a citation", () => {
    const result = parseOccupancyResult(
      modelJson({
        transaction: {
          kind: "compraventa",
          confidence: 0.95,
          evidence: "compraventa ordinaria, escritura pública ante notario",
          evidence_source: "fotocasa",
        },
      }),
    );

    // A real citation is a real finding — the cap only exists to stop a
    // silence-based guess from *looking* this sure.
    expect(result.transaction.confidence).toBe(0.95);
  });

  it("does NOT clamp a non-default (flagged) value even with empty evidence", () => {
    // Rule 3 already tells the model not to assert an uncited finding; the
    // cap is scoped to the silence-default value specifically, not to every
    // evidence-free verdict, so it must not mask an ungrounded venta_deuda
    // behind a false sense of safety.
    const result = parseOccupancyResult(
      modelJson({
        transaction: {
          kind: "venta_deuda",
          confidence: 0.9,
          evidence: "",
          evidence_source: null,
        },
      }),
    );

    expect(result.transaction.confidence).toBe(0.9);
  });
});

describe("combinations are representable (#145)", () => {
  it("represents a squatted debt sale of a 50% share", () => {
    const result = parseOccupancyResult(
      modelJson({
        occupancy: {
          status: "occupied_illegally",
          confidence: 0.8,
          evidence: "ocupado ilegalmente, posesión no garantizada",
          evidence_source: "solvia",
        },
        transaction: {
          kind: "venta_deuda",
          confidence: 0.75,
          evidence: "venta de deuda / cesión de remate",
          evidence_source: "solvia",
        },
        ownership: {
          extent: "proindiviso",
          share_pct: 50,
          confidence: 0.7,
          evidence: "participación indivisa del 50%",
          evidence_source: "solvia",
        },
      }),
    );

    // All three co-exist — the shape this issue exists to make possible.
    expect(result.occupancy.value).toBe("occupied_illegally");
    expect(result.transaction.value).toBe("venta_deuda");
    expect(result.ownership.value).toBe("proindiviso");
    expect(result.ownership.share_pct).toBe(50);
    expect(result.caveats).toEqual([
      "occupied_illegally",
      "venta_deuda",
      "proindiviso",
    ]);
    // Each axis keeps its own citation, not one shared quote.
    expect(result.occupancy.evidence).not.toBe(result.transaction.evidence);
  });
});

describe("deriveCaveats", () => {
  it("is empty for a clean, fully-confirmed sale", () => {
    expect(deriveCaveats("vacant", "compraventa", "pleno_dominio")).toEqual([]);
  });

  it("never badges an unknown as a problem", () => {
    expect(deriveCaveats("unknown", "unknown", "unknown")).toEqual([]);
  });
});

describe("summaryConfidence", () => {
  it("reports the confidence of the finding that matters, not an average", () => {
    const result = parseOccupancyResult(
      modelJson({
        // Unsure about occupancy, but very sure it is a debt sale.
        occupancy: { status: "unknown", confidence: 0.1 },
        transaction: { kind: "venta_deuda", confidence: 0.9 },
      }),
    );

    expect(summaryConfidence(result)).toBe(0.9);
  });

  it("falls back to the occupancy confidence when nothing is flagged", () => {
    const result = parseOccupancyResult(
      modelJson({ occupancy: { status: "vacant", confidence: 0.77 } }),
    );

    expect(summaryConfidence(result)).toBe(0.77);
  });
});
