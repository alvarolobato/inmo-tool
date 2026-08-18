/**
 * Condition assessment — unit tests (#26).
 *
 * Parsing-degrades-safely tests for `parseConditionResult`. Prompt-CONTENT
 * assertions (evidence union across merged listings, the `unclear`-not-
 * `unknown` correction surviving ASSESSMENT_RULES, the `renovation_severity`
 * sub-axis wording, the hash-scoped-fields invisibility) moved to
 * `triage.test.ts` (#542): `condition` is answered from the merged `triage`
 * prompt now (`buildTriagePrompt`), not a standalone `buildSystemPrompt
 * ("condition", …)` call — that flow name no longer exists. The parser itself
 * (`parseConditionResult`/`parseConditionObject`) is UNCHANGED by the merge,
 * so every test below still exercises the real, unmodified degrade logic.
 */
import { describe, it, expect } from "vitest";
import { parseConditionResult, CONDITION_PROMPT_VERSION } from "../condition";

describe("parseConditionResult", () => {
  it("EC-1: 'a reformar, necesita actualización de instalaciones y baño' produces a_reformar with issues", () => {
    const raw = JSON.stringify({
      condition: "a_reformar",
      confidence: 0.85,
      issues: ["instalación eléctrica antigua", "baño a renovar"],
      evidence: "a reformar, necesita actualización de instalaciones y baño",
      evidence_source: "milanuncios",
      reasoning: "El anuncio pide explícitamente reforma de instalaciones y baño.",
    });

    const r = parseConditionResult(raw);
    expect(r.condition).toBe("a_reformar");
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/instalaci/i),
        expect.stringMatching(/baño/i),
      ]),
    );
    expect(r.evidence).toContain("a reformar");
  });

  it("EC-2: 'totalmente reformado en 2024, calidades de lujo' produces reformado with an empty/near-empty issues list", () => {
    const raw = JSON.stringify({
      condition: "reformado",
      confidence: 0.9,
      issues: [],
      evidence: "totalmente reformado en 2024, calidades de lujo",
      evidence_source: "fotocasa",
      reasoning: "Reforma reciente declarada explícitamente.",
    });

    const r = parseConditionResult(raw);
    expect(r.condition).toBe("reformado");
    expect(r.issues).toEqual([]);
  });

  it("tolerates a ```json code fence", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        condition: "obra_nueva",
        confidence: 0.7,
        evidence: "promoción de obra nueva a estrenar",
      }) +
      "\n```";
    expect(parseConditionResult(raw).condition).toBe("obra_nueva");
  });

  it("degrades an unrecognised condition value to unclear with ZERO confidence", () => {
    const r = parseConditionResult(
      JSON.stringify({ condition: "probablemente_bien", confidence: 0.95 }),
    );
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("degrades a MISSING condition to unclear rather than defaulting to reformado", () => {
    // Design constraint carried over from #156's occupancy review: silence
    // must never manufacture a positive verdict at high confidence, and
    // condition (unlike occupancy's ejes 2/3) has no legitimate silence
    // default at all.
    const r = parseConditionResult(JSON.stringify({ reasoning: "no dice nada" }));
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("clamps a confidence the model reports outside 0..1", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "reformado",
        confidence: 3.7,
        evidence: "reformado integral en 2022",
      }),
    );
    expect(r.confidence).toBe(1);
  });

  it("drops non-string entries from issues defensively rather than throwing", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        confidence: 0.6,
        issues: ["humedad", 42, null, "  ", "instalación antigua"],
      }),
    );
    expect(r.issues).toEqual(["humedad", "instalación antigua"]);
  });

  it("throws on non-JSON output instead of silently returning unclear", () => {
    expect(() => parseConditionResult("lo siento, no puedo")).toThrow(/non-JSON/);
  });

  it("degrades a non-`unclear` verdict with no evidence citation to `unclear` at zero confidence (#168 review, also-fix)", () => {
    // Condition was the only one of the three flows (#25/#26/#27) with no
    // code-side "no citation, no assertion" backstop. Redflags drops an
    // uncited flag (redflags.ts); occupancy's ejes 2/3 only assert from
    // silence via a deliberate, capped exception. Condition had nothing:
    // `{"condition":"a_reformar","confidence":0.95,"evidence":""}` used to
    // write through unchanged — and condition drives a visible card badge,
    // which uncited red flags never do.
    const r = parseConditionResult(
      JSON.stringify({ condition: "a_reformar", confidence: 0.95, evidence: "" }),
    );
    expect(r.condition).toBe("unclear");
    expect(r.confidence).toBe(0);
  });

  it("still accepts a non-`unclear` verdict when evidence IS cited", () => {
    // Guards against an overzealous fix that forces everything to `unclear`.
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        confidence: 0.8,
        evidence: "necesita reforma integral",
      }),
    );
    expect(r.condition).toBe("a_reformar");
    expect(r.confidence).toBe(0.8);
  });
});

describe("prompt version", () => {
  it("is pinned, so a prompt change forces a new row rather than overwriting", () => {
    // #313 bumped v1 -> v2 when the renovation_severity sub-axis landed;
    // #542 bumped v2 -> v3 when condition moved to the merged `triage` prompt.
    // #308's batch scheduler re-assesses every bump. The bump IS the
    // re-assessment trigger.
    expect(CONDITION_PROMPT_VERSION).toBe("condition/v3");
  });
});

describe("parseConditionResult — renovation_severity (#313, EC-1)", () => {
  it("structural-renovation language yields `a_reformar` + `integral`", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        renovation_severity: "integral",
        confidence: 0.8,
        evidence: "para reformar integralmente, necesita reforma estructural completa",
        evidence_source: "fotocasa",
      }),
    );
    expect(r.condition).toBe("a_reformar");
    expect(r.renovation_severity).toBe("integral");
  });

  it("cosmetic-only language yields `a_reformar` + `leve`", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        renovation_severity: "leve",
        confidence: 0.7,
        evidence: "necesita repintar y cambiar la cocina, un lavado de cara",
        evidence_source: "milanuncios",
      }),
    );
    expect(r.condition).toBe("a_reformar");
    expect(r.renovation_severity).toBe("leve");
  });

  it("`a_reformar` with no gradeable severity degrades to `unknown`, not a guess", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        confidence: 0.6,
        evidence: "a reformar",
        evidence_source: "idealista",
      }),
    );
    expect(r.condition).toBe("a_reformar");
    expect(r.renovation_severity).toBe("unknown");
  });

  it("an unrecognised severity value on `a_reformar` degrades to `unknown`", () => {
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        renovation_severity: "media",
        confidence: 0.6,
        evidence: "a reformar",
      }),
    );
    expect(r.renovation_severity).toBe("unknown");
  });

  it("a no-renovation-signal advert keeps `unclear` and a `null` severity (axis N/A)", () => {
    const r = parseConditionResult(JSON.stringify({ reasoning: "no dice nada" }));
    expect(r.condition).toBe("unclear");
    expect(r.renovation_severity).toBeNull();
  });

  it("forces severity to `null` for `reformado`/`obra_nueva` even if the model volunteers one", () => {
    // Severity only means anything for a_reformar; a model that fills it on a
    // non-a_reformar verdict must not leak that into the stored result.
    const reformado = parseConditionResult(
      JSON.stringify({
        condition: "reformado",
        renovation_severity: "integral",
        confidence: 0.9,
        evidence: "reformado en 2023",
      }),
    );
    expect(reformado.renovation_severity).toBeNull();

    const obraNueva = parseConditionResult(
      JSON.stringify({
        condition: "obra_nueva",
        renovation_severity: "leve",
        confidence: 0.8,
        evidence: "promoción de obra nueva a estrenar",
      }),
    );
    expect(obraNueva.renovation_severity).toBeNull();
  });

  it("forces severity to `null` when an uncited `a_reformar` is downgraded to `unclear`", () => {
    // The evidence backstop turns {a_reformar, evidence:""} into unclear; the
    // severity must follow the FINAL verdict, not the raw one.
    const r = parseConditionResult(
      JSON.stringify({
        condition: "a_reformar",
        renovation_severity: "integral",
        confidence: 0.95,
        evidence: "",
      }),
    );
    expect(r.condition).toBe("unclear");
    expect(r.renovation_severity).toBeNull();
  });
});
