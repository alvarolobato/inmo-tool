/**
 * #542 (docs/roadmap/llm-batching-plan.md, Phase 2 PR 2a) — the merged
 * `triage` flow: unit tests.
 *
 * Two halves:
 *
 *   1. Prompt-CONTENT assertions against the REAL `buildSystemPrompt("triage",
 *      …)` output — the vocabulary/evidence-discipline tests that used to live
 *      in condition.test.ts/location.test.ts/opportunity.test.ts against their
 *      own standalone prompts, now against the merged one. Nothing about the
 *      vocabulary or evidence rules changed — only that they're asked in one
 *      call instead of three.
 *   2. Parser tests for `parseTriageResponse`/`parseTriageArray` — the NEW
 *      surface the merge introduces: echoed-id validation, duplicate ids,
 *      unknown ids, missing ids, per-axis degradation isolation, the
 *      evidence-substring guard, and the terreno slice.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot, TriagePropertyInput } from "@/lib/llm-context";
import {
  parseTriageResponse,
  parseTriageArray,
  type TriageParseRequest,
} from "../triage";

function triagePromptText(properties: TriagePropertyInput[]): string {
  const { stable, volatile } = buildSystemPrompt("triage", { triageProperties: properties });
  return `${stable}\n${volatile ?? ""}`;
}

const REFORM_LISTING: ListingSnapshot = {
  propertyId: 9,
  listingId: 202,
  source: "milanuncios",
  operation: "sale",
  description:
    "Piso a reformar, necesita actualización de instalaciones y baño. Buena ubicación.",
};

const SILENT_LISTING: ListingSnapshot = {
  propertyId: 9,
  listingId: 201,
  source: "fotocasa",
  operation: "sale",
  description: "Piso de 90 m2 en Chamberí. Tres dormitorios, dos baños. Luminoso.",
};

const BEACH_LISTING: ListingSnapshot = {
  propertyId: 7,
  listingId: 301,
  source: "fotocasa",
  operation: "sale",
  propertyType: "piso",
  description:
    "Piso en primera línea de playa, a pie de arena, con acceso directo al paseo marítimo.",
};

const VPO_LISTING: ListingSnapshot = {
  propertyId: 11,
  listingId: 401,
  source: "fotocasa",
  operation: "sale",
  propertyType: "piso",
  description:
    "Vivienda de protección oficial (VPO) con precio máximo de venta tasado, tres dormitorios.",
};

// ── Prompt content ────────────────────────────────────────────────────────────

describe("buildTriagePrompt — merged stable block", () => {
  it("carries the merged task heading and all three axes' vocabularies", () => {
    const text = triagePromptText([
      { propertyId: 9, listings: [REFORM_LISTING], axes: ["condition", "location", "opportunity"] },
    ]);
    expect(text).toContain("Tarea: triage combinado");
    // condition
    expect(text).toContain("a_reformar");
    expect(text).toContain("renovation_severity");
    // location
    for (const v of ["frontline", "sea_view", "near_beach", "none"]) expect(text).toContain(v);
    expect(text).toContain("heritage_zone");
    // opportunity
    expect(text).toContain("is_vpo");
    expect(text).toContain("tourist_license");
  });

  it("carries ONE DOMAIN_PREAMBLE and ONE ASSESSMENT_RULES block, not three", () => {
    const text = triagePromptText([
      { propertyId: 9, listings: [REFORM_LISTING], axes: ["condition"] },
    ]);
    const preambleCount = text.split("Eres un asistente experto en inversión inmobiliaria").length - 1;
    const rulesCount = text.split("Reglas de evaluación (obligatorias):").length - 1;
    expect(preambleCount).toBe(1);
    expect(rulesCount).toBe(1);
  });

  it("restates each axis's silence-value correction AFTER ASSESSMENT_RULES (recency wins)", () => {
    const text = triagePromptText([
      { propertyId: 9, listings: [REFORM_LISTING], axes: ["condition", "location", "opportunity"] },
    ]);
    const rulesIdx = text.indexOf('`"unknown"` y una `confidence` baja');
    const correctionIdx = text.indexOf("Nota sobre la regla 2 anterior");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeGreaterThan(rulesIdx);
    expect(text).toContain("`condition`: usa `unclear`");
    expect(text).toContain("`location`: usa `none`");
    expect(text).toContain("`opportunity`: usa `false`");
  });

  it("output format is a JSON ARRAY keyed by echoed property_id", () => {
    const text = triagePromptText([
      { propertyId: 9, listings: [REFORM_LISTING], axes: ["condition"] },
    ]);
    expect(text).toMatch(/un ARRAY JSON/);
    expect(text).toContain('"property_id": <int, EXACTAMENTE el id_propiedad recibido>');
  });
});

describe("triageVolatile — per-property blocks (N-capable)", () => {
  it("renders one ### INMUEBLE block per property, each with its own id and axes", () => {
    const text = triagePromptText([
      { propertyId: 7, listings: [BEACH_LISTING], axes: ["condition", "location", "opportunity"] },
      { propertyId: 11, listings: [VPO_LISTING], axes: ["condition"] },
    ]);
    expect(text).toContain("### INMUEBLE property_id=7");
    expect(text).toContain("### INMUEBLE property_id=11");
    expect(text).toContain("Ejes solicitados: condition, location, opportunity");
    expect(text).toContain("Ejes solicitados: condition");
  });

  it("carries EVERY advert's description for a property with several listings", () => {
    const text = triagePromptText([
      { propertyId: 9, listings: [SILENT_LISTING, REFORM_LISTING], axes: ["condition"] },
    ]);
    expect(text).toContain("necesita actualización de instalaciones y baño");
    expect(text).toContain("Tres dormitorios");
    expect(text).toContain("fotocasa");
    expect(text).toContain("milanuncios");
  });

  it("returns no volatile block when no properties are given", () => {
    const { volatile } = buildSystemPrompt("triage", {});
    expect(volatile).toBeUndefined();
  });
});

// ── parseTriageResponse — echoed-id validation / dedup ────────────────────────

describe("parseTriageResponse", () => {
  it("keeps a valid entry whose property_id matches a requested id", () => {
    const raw = JSON.stringify([{ property_id: 9, condition: { condition: "reformado" } }]);
    const byId = parseTriageResponse(raw, [9]);
    expect(byId.get(9)).toEqual({ property_id: 9, condition: { condition: "reformado" } });
  });

  it("echoed-id validation: drops an entry whose property_id is not a finite integer", () => {
    const raw = JSON.stringify([
      { property_id: "9", condition: {} }, // string, not a number
      { property_id: 9.5, condition: {} }, // not an integer
      { condition: {} }, // missing entirely
    ]);
    const byId = parseTriageResponse(raw, [9]);
    expect(byId.size).toBe(0);
  });

  it("drops an entry for an UNREQUESTED (unknown) property_id", () => {
    const raw = JSON.stringify([
      { property_id: 9, condition: { condition: "reformado" } },
      { property_id: 999, condition: { condition: "a_reformar" } },
    ]);
    const byId = parseTriageResponse(raw, [9]);
    expect(byId.size).toBe(1);
    expect(byId.has(999)).toBe(false);
  });

  it("DUPLICATE ids: the FIRST entry for a given id wins, later ones are dropped", () => {
    const raw = JSON.stringify([
      { property_id: 9, condition: { condition: "reformado" } },
      { property_id: 9, condition: { condition: "a_reformar" } },
    ]);
    const byId = parseTriageResponse(raw, [9]);
    expect(byId.size).toBe(1);
    expect((byId.get(9) as { condition: { condition: string } }).condition.condition).toBe("reformado");
  });

  it("MISSING ids: a requested id absent from the response has no key at all", () => {
    const raw = JSON.stringify([{ property_id: 9, condition: {} }]);
    const byId = parseTriageResponse(raw, [9, 42]);
    expect(byId.has(9)).toBe(true);
    expect(byId.has(42)).toBe(false);
  });

  it("throws on non-JSON output", () => {
    expect(() => parseTriageResponse("lo siento, no puedo", [9])).toThrow(/non-JSON/);
  });

  it("throws on a valid JSON value that is not an array", () => {
    expect(() => parseTriageResponse(JSON.stringify({ property_id: 9 }), [9])).toThrow(/non-array/);
  });

  it("drops a non-object entry inside the array without throwing for the rest", () => {
    const raw = JSON.stringify(["oops", { property_id: 9, condition: {} }]);
    const byId = parseTriageResponse(raw, [9]);
    expect(byId.size).toBe(1);
  });
});

// ── parseTriageArray — per-axis isolation, evidence-substring guard, terreno ──

describe("parseTriageArray — per-axis degradation isolation", () => {
  it("a malformed `location` slice does NOT poison a valid `condition` verdict from the same entry", () => {
    const raw = JSON.stringify([
      {
        property_id: 9,
        condition: {
          condition: "a_reformar",
          confidence: 0.85,
          evidence: "necesita actualización de instalaciones y baño",
          evidence_source: "milanuncios",
        },
        // Malformed: a string instead of an object.
        location: "not an object",
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 9, axes: ["condition", "location"], listings: [SILENT_LISTING, REFORM_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(9);
    expect(parsed?.condition?.condition).toBe("a_reformar");
    expect(parsed?.location).toBeUndefined();
  });

  it("a missing `opportunity` key leaves `condition`/`location` intact", () => {
    const raw = JSON.stringify([
      {
        property_id: 7,
        condition: {
          condition: "reformado",
          confidence: 0.8,
          // A real substring of BEACH_LISTING's own text — not semantically
          // about condition, but this test is only exercising the
          // "missing key" isolation, not evidence content; a fabricated
          // quote here would be blanked by the evidence-substring guard
          // and confound the assertion (see the guard's own describe block).
          evidence: "Piso en primera línea de playa",
        },
        location: {
          beach_proximity: "frontline",
          beach_evidence: "primera línea de playa, a pie de arena",
          confidence: 0.9,
        },
        // opportunity omitted entirely
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 7, axes: ["condition", "location", "opportunity"], listings: [BEACH_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(7);
    expect(parsed?.condition?.condition).toBe("reformado");
    expect(parsed?.location?.beach_proximity).toBe("frontline");
    expect(parsed?.opportunity).toBeUndefined();
  });
});

describe("parseTriageArray — evidence-substring guard", () => {
  it("degrades an axis whose evidence quote does NOT appear in the property's own listing text", () => {
    const raw = JSON.stringify([
      {
        property_id: 9,
        condition: {
          condition: "a_reformar",
          confidence: 0.9,
          // Fabricated — never appears in SILENT_LISTING/REFORM_LISTING's text.
          evidence: "cocina completamente destruida por un incendio",
          evidence_source: "fotocasa",
        },
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 9, axes: ["condition"], listings: [SILENT_LISTING, REFORM_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(9);
    // Same degrade path an uncited claim already takes (D-056): unclear, zero confidence.
    expect(parsed?.condition?.condition).toBe("unclear");
    expect(parsed?.condition?.confidence).toBe(0);
    expect(parsed?.condition?.evidence).toBe("");
  });

  it("accepts an evidence quote that DOES appear verbatim in the listing text", () => {
    const raw = JSON.stringify([
      {
        property_id: 9,
        condition: {
          condition: "a_reformar",
          confidence: 0.85,
          evidence: "necesita actualización de instalaciones y baño",
          evidence_source: "milanuncios",
        },
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 9, axes: ["condition"], listings: [SILENT_LISTING, REFORM_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(9);
    expect(parsed?.condition?.condition).toBe("a_reformar");
    expect(parsed?.condition?.confidence).toBe(0.85);
  });

  it("checks EACH evidence field independently — one axis can have a good AND a fabricated quote", () => {
    const raw = JSON.stringify([
      {
        property_id: 7,
        location: {
          beach_proximity: "frontline",
          beach_evidence: "primera línea de playa, a pie de arena", // real
          beach_evidence_source: "fotocasa",
          heritage_zone: true,
          heritage_evidence: "en pleno casco histórico medieval", // fabricated
          confidence: 0.9,
        },
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 7, axes: ["location"], listings: [BEACH_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(7);
    expect(parsed?.location?.beach_proximity).toBe("frontline"); // real quote survives
    expect(parsed?.location?.heritage_zone).toBe(false); // fabricated quote degrades
    expect(parsed?.location?.heritage_evidence).toBe("");
  });

  it("cross-axis evidence bleed: a condition quote copied into location's evidence field still fails the guard against location's own corpus check", () => {
    // The guard checks against the PROPERTY's corpus, not per-axis provenance,
    // so a quote that really is in the ad text but was meant for a different
    // axis still passes the substring check — evidence attribution beyond
    // "is this text really in the ad" is the model's job, not this guard's.
    // This test pins that scope explicitly rather than leaving it implicit.
    const raw = JSON.stringify([
      {
        property_id: 9,
        location: {
          beach_proximity: "frontline",
          // Real text from the property's OWN corpus, but not actually about
          // the beach — the guard cannot and does not judge relevance, only
          // literal presence.
          beach_evidence: "necesita actualización de instalaciones y baño",
          confidence: 0.9,
        },
      },
    ]);
    const requests: TriageParseRequest[] = [
      { propertyId: 9, axes: ["location"], listings: [SILENT_LISTING, REFORM_LISTING] },
    ];
    const parsed = parseTriageArray(raw, requests).get(9);
    // Passes the substring guard (the text IS in the corpus) — a real, if
    // unusual, limitation: the guard blocks HALLUCINATED quotes, not
    // mis-attributed real ones.
    expect(parsed?.location?.beach_proximity).toBe("frontline");
  });
});

describe("parseTriageArray — terreno slice", () => {
  it("a terreno request (axes=['condition']) returns ONLY condition, even if the model erroneously includes a location slice", () => {
    const raw = JSON.stringify([
      {
        property_id: 20,
        condition: { condition: "unclear", confidence: 0 },
        // The model should never send this for a terreno per the prompt's
        // per-property axis instruction, but the parser must not trust it
        // even if it does — defense in depth beyond the prompt.
        location: { beach_proximity: "frontline", beach_evidence: "primera línea", confidence: 0.9 },
      },
    ]);
    const requests: TriageParseRequest[] = [
      {
        propertyId: 20,
        axes: ["condition"], // terreno — location/opportunity never requested
        listings: [{ propertyId: 20, listingId: 900, propertyType: "terreno", description: "Solar urbano." }],
      },
    ];
    const parsed = parseTriageArray(raw, requests).get(20);
    expect(parsed?.condition).toBeDefined();
    expect(parsed?.location).toBeUndefined();
    expect(parsed?.opportunity).toBeUndefined();
  });

  it("a missing property entirely yields no map entry (not an empty object)", () => {
    const raw = JSON.stringify([]);
    const requests: TriageParseRequest[] = [
      { propertyId: 20, axes: ["condition"], listings: [] },
    ];
    const parsed = parseTriageArray(raw, requests);
    expect(parsed.has(20)).toBe(false);
  });
});
