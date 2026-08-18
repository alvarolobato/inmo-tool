import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt";
import { LLM_FLOWS } from "../types";
import type { FlowVars, ListingSnapshot } from "../types";

/**
 * F-13/D-108 byte-stability guard.
 *
 * `dashboard/lib/llm-client.ts`'s CLI branch sends `buildSystemPrompt(flow,
 * vars).stable` verbatim on `--system-prompt`. The Anthropic prompt cache
 * this buys (Phase 0c of docs/roadmap/llm-batching-plan.md) only reuses that
 * value across calls when it is BYTE-IDENTICAL for a given flow — a single
 * per-call character (a property id, a price, a profile name, today's date)
 * leaking into `stable` silently reverts to the pre-F-13 zero-reuse result,
 * with no other observable symptom (same output text, same behaviour).
 *
 * This is the actual PRODUCER test the review of #544 asked for: it calls
 * `buildSystemPrompt(flow, varsA)` / `buildSystemPrompt(flow, varsB)` with
 * two genuinely different var sets per flow (different property ids,
 * descriptions, cities, prices, candidates, profile names — never the same
 * object) and asserts `stable` is identical AND free of every marker unique
 * to either input. A test that instead compares a value to itself, or reuses
 * one `vars` object for both calls, would not catch this class of bug.
 */

function listing(overrides: Partial<ListingSnapshot>): ListingSnapshot {
  return {
    propertyId: 1,
    listingId: 1,
    source: "fotocasa",
    operation: "sale",
    propertyType: "piso",
    title: "Piso en venta",
    description: "Descripción genérica.",
    price: 150_000,
    m2Built: 80,
    rooms: 3,
    bathrooms: 1,
    floor: "2",
    address: "Calle Falsa 1",
    city: "Madrid",
    province: "Madrid",
    ...overrides,
  };
}

/** Every marker planted in the "A" var set — must never appear in `stable`. */
const MARKERS_A = [
  "MARKER-PROPERTY-90001",
  "MARKER_DESC_ALPHA_a_reformar_ocupado",
  "MARKER_CITY_Alfaville",
  "MARKER_PROFILE_Alfa",
  "MARKER_THESIS_alquiler_alfa",
];
/** Every marker planted in the "B" var set — must never appear in `stable`. */
const MARKERS_B = [
  "MARKER-PROPERTY-90002",
  "MARKER_DESC_BETA_reformado_vacio",
  "MARKER_CITY_Betaburgo",
  "MARKER_PROFILE_Beta",
  "MARKER_THESIS_flip_beta",
];

/**
 * Two deliberately different var sets per flow. Fields a flow doesn't read
 * are harmless noise (e.g. `candidates` on `occupancy`) — the point is that
 * whatever a flow DOES read for its per-call payload differs between A and B.
 *
 * `redflags` is the one flow whose `stable` legitimately depends on `vars`
 * (`trendingCandidates`/`dismissedCandidates`, rendered into `stable` — see
 * `buildRedflagsPrompt`) — but that data is computed ONCE per assessment
 * batch tick (`lib/ai-assessment/batch.ts`) and reused across every property
 * scored in that run, so it is batch-constant, not per-property-call-constant.
 * A and B below share the exact same `trendingCandidates`/`dismissedCandidates`
 * reference, matching that real invocation pattern, while every genuinely
 * per-property field (listing content) still differs — see the companion
 * "redflags: NOT stable across a different batch" test below for the
 * documented edge of that exemption.
 */
const SHARED_REDFLAG_CANDIDATES = {
  trendingCandidates: [{ candidateType: "ruido_excesivo", count: 3 }],
  dismissedCandidates: [{ slug: "servidumbre_paso", reason: "no aplica" }],
};

function varsFor(flow: string, which: "A" | "B"): FlowVars {
  const common =
    which === "A"
      ? {
          listing: listing({
            propertyId: 90001,
            listingId: 90001,
            description: "MARKER_DESC_ALPHA_a_reformar_ocupado, se entrega vacío.",
            city: "MARKER_CITY_Alfaville",
            price: 111_111,
          }),
        }
      : {
          listing: listing({
            propertyId: 90002,
            listingId: 90002,
            description: "MARKER_DESC_BETA_reformado_vacio, buen estado.",
            city: "MARKER_CITY_Betaburgo",
            price: 222_222,
          }),
        };

  switch (flow) {
    case "occupancy":
    case "condition":
    case "location":
    case "opportunity":
    case "extract":
      return {
        ...common,
        areaPriceSignal:
          which === "A"
            ? "20-30% por debajo de la mediana (MARKER-PROPERTY-90001)"
            : "5-10% por debajo de la mediana (MARKER-PROPERTY-90002)",
      };
    case "redflags":
      return { ...common, ...SHARED_REDFLAG_CANDIDATES };
    case "compare":
      return {
        candidates: [
          listing(
            which === "A"
              ? { propertyId: 90001, description: "MARKER_DESC_ALPHA_a_reformar_ocupado" }
              : { propertyId: 90002, description: "MARKER_DESC_BETA_reformado_vacio" },
          ),
        ],
        profileThesis:
          which === "A" ? "MARKER_THESIS_alquiler_alfa" : "MARKER_THESIS_flip_beta",
      };
    case "chat":
      return which === "A"
        ? { profileName: "MARKER_PROFILE_Alfa", profileId: 11 }
        : { profileName: "MARKER_PROFILE_Beta", profileId: 22 };
    default:
      return {};
  }
}

describe("buildSystemPrompt: stable is byte-identical across different calls (F-13/D-108)", () => {
  for (const flow of LLM_FLOWS) {
    it(`${flow}: stable is byte-identical for two different property/call payloads`, () => {
      const varsA = varsFor(flow, "A");
      const varsB = varsFor(flow, "B");

      const promptA = buildSystemPrompt(flow, varsA);
      const promptB = buildSystemPrompt(flow, varsB);

      expect(promptA.stable).toBe(promptB.stable);

      for (const marker of [...MARKERS_A, ...MARKERS_B]) {
        expect(promptA.stable).not.toContain(marker);
      }
    });
  }

  it("redflags: NOT stable across a different batch's trending/dismissed candidates", () => {
    // Documents the actual scope of the redflags exemption above: constant
    // WITHIN a batch tick (same trending/dismissed reference), but not a
    // flow-wide constant independent of that data. If this ever starts
    // passing, `buildRedflagsPrompt` stopped rendering the candidate lists
    // into `stable` (F-2) and the SHARED_REDFLAG_CANDIDATES rationale above
    // should be revisited/simplified.
    const varsA: FlowVars = {
      listing: listing({}),
      trendingCandidates: [{ candidateType: "ruido_excesivo", count: 3 }],
      dismissedCandidates: [],
    };
    const varsB: FlowVars = {
      listing: listing({}),
      trendingCandidates: [{ candidateType: "obra_sin_licencia", count: 9 }],
      dismissedCandidates: [{ slug: "servidumbre_paso", reason: "no aplica" }],
    };

    const promptA = buildSystemPrompt("redflags", varsA);
    const promptB = buildSystemPrompt("redflags", varsB);

    expect(promptA.stable).not.toBe(promptB.stable);
  });
});
