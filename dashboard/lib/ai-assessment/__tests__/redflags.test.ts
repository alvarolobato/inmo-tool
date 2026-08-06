/**
 * Red-flag extraction — unit tests (#27).
 *
 * The highest-cost failure mode here is a false positive (issue #27, EC-3),
 * so beyond the standard "parsing degrades safely" coverage, this file
 * specifically tests the code-side backstop against manufactured flags:
 * `parseRedFlagsResult` drops any flag without a literal evidence citation,
 * regardless of what the prompt asked for — the model not following
 * instructions must not be the only thing standing between silence and a
 * fabricated legal risk.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import type { ListingSnapshot } from "@/lib/llm-context";
import {
  parseRedFlagsResult,
  normalizeCandidateType,
  REDFLAGS_PROMPT_VERSION,
  REDFLAG_TYPES,
} from "../redflags";

const SILENT_ADVERT: ListingSnapshot = {
  propertyId: 11,
  listingId: 301,
  source: "fotocasa",
  operation: "sale",
  description: "Piso de 90 m2 en Chamberí. Tres dormitorios, dos baños. Luminoso.",
};

const INHERITANCE_ADVERT: ListingSnapshot = {
  propertyId: 11,
  listingId: 302,
  source: "milanuncios",
  operation: "sale",
  description: "Se vende por herencia yacente, pendiente de partición. Urge venta.",
};

function redflagsPromptText(listings: ListingSnapshot[]): string {
  const { stable, volatile } = buildSystemPrompt("redflags", { listings });
  return `${stable}\n${volatile ?? ""}`;
}

describe("redflags prompt — evidence union across merged listings", () => {
  it("carries EVERY advert's description, not just the first", () => {
    const text = redflagsPromptText([SILENT_ADVERT, INHERITANCE_ADVERT]);
    expect(text).toContain("herencia yacente, pendiente de partición");
    expect(text).toContain("Tres dormitorios");
  });

  it("instructs the model NOT to speculate from silence", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text.toLowerCase()).toContain("no especules");
  });

  it("frames output as 'worth checking', never a legal verdict", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toMatch(/no est[aá]s dando asesoramiento legal/i);
  });

  it("names the closed type vocabulary including herencia_yacente, distinct from occupancy's proindiviso", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toContain("herencia_yacente");
    expect(text).toContain("construccion_ilegal");
    // The overlap with #25 is explained, not silently ignored.
    expect(text).toContain("proindiviso");
  });

  it("#361: names the physical-problem types and defines unfinished_construction distinctly from a_reformar/obra_nueva", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toContain("unfinished_construction");
    expect(text).toContain("structural_damage");
    // The definition must distinguish a half-built shell from the two
    // condition axes it must NOT be confused with (#361 acceptance).
    expect(text).toContain("parcialmente ejecutada");
    expect(text).toContain("a_reformar");
    expect(text).toContain("obra_nueva");
  });

  it("#389: names subasta_judicial as its own type (procedimiento de apremio), distinct from embargo", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toContain("subasta_judicial");
    expect(text).toContain("procedimiento de apremio");
  });

  it("#394: asks the model for a candidate_type slug + definition when it uses `other`, and puts both in the output schema", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    // The `other` guidance requests a snake_case candidate slug + a one-line
    // definition alongside the existing free-text description.
    expect(text).toContain("candidate_type");
    expect(text).toContain("definition");
    expect(text).toContain("snake_case");
    // ...and it must stay scoped to `other` — named types don't carry a slug.
    expect(text.toLowerCase()).toContain("solo para");
  });
});

describe("parseRedFlagsResult", () => {
  it("EC-1: 'se vende por herencia yacente, pendiente de partición' produces a herencia_yacente flag with matching evidence", () => {
    const raw = JSON.stringify({
      flags: [
        {
          type: "herencia_yacente",
          description: "Verificar si la herencia está formalmente aceptada y partida.",
          evidence: "se vende por herencia yacente, pendiente de partición",
          evidence_source: "milanuncios",
        },
      ],
      confidence: 0.85,
      reasoning: "El anuncio declara explícitamente una herencia sin resolver.",
    });

    const r = parseRedFlagsResult(raw);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("herencia_yacente");
    expect(r.flags[0].evidence).toContain("herencia yacente");
    expect(r.flags[0].evidence_source).toBe("milanuncios");
  });

  it("#361: an 'en construcción / parcialmente ejecutada' advert produces an unfinished_construction flag with a description and matching evidence", () => {
    const raw = JSON.stringify({
      flags: [
        {
          type: "unfinished_construction",
          description: "Comprobar cuánto falta por terminar la obra y si tiene licencia en vigor.",
          evidence:
            "inmueble en construcción, parcialmente ejecutada, con algunos tabiques ya levantados",
          evidence_source: "idealista",
        },
      ],
      confidence: 0.8,
      reasoning: "El anuncio declara que la obra está a medio ejecutar.",
    });

    const r = parseRedFlagsResult(raw);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("unfinished_construction");
    expect(REDFLAG_TYPES).toContain(r.flags[0].type);
    expect(r.flags[0].description).not.toBe("");
    expect(r.flags[0].evidence).toContain("parcialmente ejecutada");
  });

  it("#361: an unfinished_construction flag with NO evidence is dropped, same manufactured-flag guard as legal flags", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "unfinished_construction",
            description: "Parece a medio construir.",
            evidence: "",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toEqual([]);
  });

  it("#389: a 'se vende en subasta judicial' advert produces a subasta_judicial flag with matching evidence", () => {
    const raw = JSON.stringify({
      flags: [
        {
          type: "subasta_judicial",
          description: "Comprobar el estado del procedimiento de apremio y las condiciones de la subasta.",
          evidence: "inmueble en subasta judicial, procedimiento de apremio",
          evidence_source: "idealista",
        },
      ],
      confidence: 0.8,
      reasoning: "El anuncio declara que el inmueble se vende en subasta judicial.",
    });

    const r = parseRedFlagsResult(raw);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("subasta_judicial");
    expect(REDFLAG_TYPES).toContain(r.flags[0].type);
    expect(r.flags[0].evidence).toContain("subasta judicial");
  });

  it("#389: a subasta_judicial flag with NO evidence is dropped, same manufactured-flag guard as every other type", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "subasta_judicial",
            description: "Podría estar en subasta.",
            evidence: "",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toEqual([]);
  });

  it("EC-2: a clean description yields an empty flags array, not a fabricated flag", () => {
    const raw = JSON.stringify({
      flags: [],
      confidence: 0.8,
      reasoning: "El anuncio no menciona ningún riesgo legal o financiero.",
    });
    const r = parseRedFlagsResult(raw);
    expect(r.flags).toEqual([]);
  });

  it("tolerates a ```json code fence", () => {
    const raw = "```json\n" + JSON.stringify({ flags: [], confidence: 0.5 }) + "\n```";
    expect(parseRedFlagsResult(raw).flags).toEqual([]);
  });

  it("drops a flag with no evidence citation, even if the model included one (code-side backstop against silence-based speculation)", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          { type: "embargo", description: "Podría haber un embargo.", evidence: "" },
          {
            type: "litigio",
            description: "Procedimiento judicial mencionado.",
            evidence: "existe un procedimiento judicial en curso",
          },
        ],
        confidence: 0.6,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("litigio");
  });

  it("coerces an unrecognised type to `other` rather than dropping a cited flag", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "algo_no_previsto",
            description: "Riesgo no catalogado.",
            evidence: "cláusula rara en el contrato",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("other");
    expect(REDFLAG_TYPES).toContain(r.flags[0].type);
  });

  it("throws when 'flags' is missing rather than degrading to a confident empty list (#168 review, must-fix 1)", () => {
    // A missing `flags` used to silently become `[]` while carrying the
    // model's stated confidence through unchanged — persisting
    // `{flags: [], confidence: 0.9}`, shape-identical to a genuine clean
    // read. That is worse than throwing: a re-run costs an LLM call, a
    // false "legally clean" verdict costs an investor a bad decision.
    expect(() =>
      parseRedFlagsResult(JSON.stringify({ reasoning: "no dice nada" })),
    ).toThrow(/flags/i);
  });

  it("throws when 'flags' is present but not an array, even if confidence looks high", () => {
    // Verified live against a real model: a policy refusal or prompt drift
    // can put a string (e.g. "ninguna") where the array belongs, alongside
    // an otherwise well-formed confidence — exactly the shape that used to
    // sail through as a confident clean read.
    expect(() =>
      parseRedFlagsResult(JSON.stringify({ flags: "ninguna", confidence: 0.9 })),
    ).toThrow(/flags/i);
  });

  it("ignores non-object entries in flags defensively", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({ flags: ["not-an-object", null, 42], confidence: 0.4 }),
    );
    expect(r.flags).toEqual([]);
  });

  it("clamps an overall confidence outside 0..1", () => {
    const r = parseRedFlagsResult(JSON.stringify({ flags: [], confidence: -1 }));
    expect(r.confidence).toBe(0);
  });

  it("throws on non-JSON output instead of silently returning an empty result", () => {
    expect(() => parseRedFlagsResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });
});

describe("#394 candidate_type on `other` flags", () => {
  it("normalizeCandidateType folds accents, lowercases, and collapses spaces/punctuation to snake_case", () => {
    expect(normalizeCandidateType("Servidumbre de Paso")).toBe("servidumbre_de_paso");
    expect(normalizeCandidateType("Inundación / riesgo")).toBe("inundacion_riesgo");
    expect(normalizeCandidateType("  Ruido   excesivo  ")).toBe("ruido_excesivo");
    expect(normalizeCandidateType("ZONA-Ruidosa")).toBe("zona_ruidosa");
    // Already-normalized slug passes through unchanged.
    expect(normalizeCandidateType("okupas_vecinos")).toBe("okupas_vecinos");
  });

  it("normalizeCandidateType degrades a malformed/empty slug to undefined", () => {
    expect(normalizeCandidateType("")).toBeUndefined();
    expect(normalizeCandidateType("   ")).toBeUndefined();
    expect(normalizeCandidateType("///")).toBeUndefined();
    expect(normalizeCandidateType(undefined)).toBeUndefined();
    expect(normalizeCandidateType(42)).toBeUndefined();
  });

  it("parseFlag normalizes the candidate_type slug on an evidenced `other` flag", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "other",
            description: "Existe una servidumbre de paso sobre la finca.",
            candidate_type: "Servidumbre de Paso",
            definition: "Un tercero tiene derecho de paso por la propiedad.",
            evidence: "la finca soporta una servidumbre de paso a favor del colindante",
            evidence_source: "idealista",
          },
        ],
        confidence: 0.6,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("other");
    expect(r.flags[0].candidate_type).toBe("servidumbre_de_paso");
  });

  it("drops an `other` flag with NO evidence even when it carries a candidate_type (evidence guard unchanged)", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "other",
            description: "Podría haber una servidumbre.",
            candidate_type: "servidumbre_de_paso",
            evidence: "",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toEqual([]);
  });

  it("a named type never carries a candidate_type, even if the model sent one", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "litigio",
            description: "Procedimiento judicial en curso.",
            candidate_type: "algo_inventado",
            evidence: "existe un procedimiento judicial en curso sobre el inmueble",
          },
        ],
        confidence: 0.7,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("litigio");
    expect(r.flags[0].candidate_type).toBeUndefined();
  });

  it("an `other` flag with a malformed/empty slug stays a valid plain `other` (candidate_type undefined)", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "other",
            description: "Riesgo no catalogado citado en el anuncio.",
            candidate_type: "   ",
            evidence: "cláusula rara en el contrato de arras",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("other");
    expect(r.flags[0].candidate_type).toBeUndefined();
  });

  it("an unrecognised type coerced to `other` picks up no candidate_type unless one was sent", () => {
    const r = parseRedFlagsResult(
      JSON.stringify({
        flags: [
          {
            type: "algo_no_previsto",
            description: "Riesgo no catalogado.",
            evidence: "cláusula rara en el contrato",
          },
        ],
        confidence: 0.5,
      }),
    );
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].type).toBe("other");
    expect(r.flags[0].candidate_type).toBeUndefined();
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    // Bumped to v5 for #394: `other` flags now carry a `candidate_type` slug +
    // one-line definition, so the prompt asks for a new field and #308's batch
    // re-assesses existing rows rather than serving a v4 cache row as current.
    // See REDFLAGS_PROMPT_VERSION's doc.
    expect(REDFLAGS_PROMPT_VERSION).toBe("redflags/v5");
  });
});

describe("redflags prompt — hash-scoped fields are invisible (#30 review, must-fix 1)", () => {
  it("never emits precio_eur, m2_construidos, habitaciones, banos, planta, or num_fotos — price is a canonical red-flag signal that must not silently survive a stale cache hit", () => {
    const withStructuredFields: ListingSnapshot = {
      ...SILENT_ADVERT,
      price: 90000,
      m2Built: 90,
      rooms: 3,
      bathrooms: 2,
      floor: "3",
      photoUrls: ["a.jpg"],
    };
    const text = redflagsPromptText([withStructuredFields]);
    expect(text).not.toContain("precio_eur");
    expect(text).not.toContain("m2_construidos");
    expect(text).not.toContain("habitaciones:");
    expect(text).not.toContain("banos:");
    expect(text).not.toContain("planta:");
    expect(text).not.toContain("num_fotos");
  });
});

describe("redflags prompt — derived area-price signal (#184)", () => {
  it("renders the signal, labelled, when FlowVars.areaPriceSignal is set — this is how #184 gives redflags back its below-market-price cue without reopening EC-3", () => {
    const { stable, volatile } = buildSystemPrompt("redflags", {
      listings: [SILENT_ADVERT],
      areaPriceSignal:
        "El precio de este inmueble está aproximadamente un 20-30% por debajo de la mediana de precio/m² de inmuebles comparables en su zona (radio 1km, 10-19 comparables).",
    });
    const text = `${stable}\n${volatile ?? ""}`;

    expect(text).toContain("DATO DERIVADO: PRECIO VS. ZONA");
    expect(text).toContain("20-30% por debajo");
  });

  it("renders no per-property figure when areaPriceSignal is absent (#184 requirement 2)", () => {
    const { volatile } = buildSystemPrompt("redflags", { listings: [SILENT_ADVERT] });
    expect(volatile ?? "").not.toContain("DATO DERIVADO: PRECIO VS. ZONA");
  });

  it("always includes the general rules for how to weigh the signal, whether or not one is present this request (stable, cache-friendly text)", () => {
    const withSignal = buildSystemPrompt("redflags", {
      listings: [SILENT_ADVERT],
      areaPriceSignal: "20-30% por debajo",
    }).stable;
    const withoutSignal = buildSystemPrompt("redflags", { listings: [SILENT_ADVERT] }).stable;

    expect(withSignal).toBe(withoutSignal);
    expect(withSignal).toContain("Contexto de precio de zona");
  });

  it(
    "the evidence/no-assertion rules for the derived signal come AFTER ASSESSMENT_RULES in the " +
      "assembled string (#184 requirement 4)",
    () => {
      const text = redflagsPromptText([SILENT_ADVERT]);

      const genericNoCiteRuleIdx = text.indexOf("no afirmes nada");
      const derivedSignalRuleIdx = text.indexOf("NO la cites como");

      expect(genericNoCiteRuleIdx).toBeGreaterThan(-1);
      expect(derivedSignalRuleIdx).toBeGreaterThan(-1);
      expect(derivedSignalRuleIdx).toBeGreaterThan(genericNoCiteRuleIdx);
    },
  );

  it("explicitly forbids citing the derived signal as `evidence` — parseFlag drops uncited flags, but the prompt must not tempt the model to fake one", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toContain("NO la cites como");
    expect(text.toLowerCase()).toContain("fabricar una cita");
  });

  it("explicitly forbids treating the derived signal as proof by itself (#184 requirement 5 — below-market is a prompt for scrutiny, not a finding)", () => {
    const text = redflagsPromptText([SILENT_ADVERT]);
    expect(text).toMatch(/NO la uses,? por sí sola/);
    expect(text.toLowerCase()).toContain("explicaciones inocentes");
  });
});
