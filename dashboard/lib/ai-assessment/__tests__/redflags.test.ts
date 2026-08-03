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
import { parseRedFlagsResult, REDFLAGS_PROMPT_VERSION, REDFLAG_TYPES } from "../redflags";

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

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    expect(REDFLAGS_PROMPT_VERSION).toBe("redflags/v1");
  });
});
