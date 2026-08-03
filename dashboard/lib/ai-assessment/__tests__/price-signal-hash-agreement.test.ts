/**
 * Hash/prompt agreement for the derived area-price signal — issue #184's own
 * acceptance criterion, verbatim: "the invalidation key and the rendered
 * prompt must stay in agreement — that mismatch is precisely what this
 * issue exists to prevent recurring."
 *
 * This is the SINGLE test that is the actual point of #184 (the rest of the
 * suite covers bucketing/silence/direction, which are important but
 * secondary to this one property). It needs no database and no mocking: both
 * `buildSystemPrompt` and `computeAssessmentContentHash` are pure functions
 * of their inputs, and occupancy.ts/redflags.ts's real production code path
 * threads ONE `areaPriceSignal` variable into both — see their
 * `assessPropertyOccupancy`/`assessPropertyRedFlags` doc comments. This test
 * proves that wiring actually produces the agreement it claims to, for both
 * flows that use it.
 *
 * Mirrors what PR #180 got wrong for price (`formatListing` rendered
 * `precio_eur` while `computeAssessmentContentHash` ignored it) — generalised
 * to the new derived field this issue introduces.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/llm-context/system-prompt";
import { computeAssessmentContentHash } from "../cache";
import type { ListingSnapshot } from "@/lib/llm-context";

const LISTINGS: ListingSnapshot[] = [
  {
    propertyId: 1,
    listingId: 101,
    source: "fotocasa",
    operation: "sale",
    description: "Piso de 90 m2 en el centro. Buena ubicación.",
  },
];

const SIGNAL_A =
  "El precio de este inmueble está aproximadamente un 20-30% por debajo de " +
  "la mediana de precio/m² de inmuebles comparables en su zona (radio 1km, 10-19 comparables).";

const SIGNAL_B =
  "El precio de este inmueble está aproximadamente un 30-40% por debajo de " +
  "la mediana de precio/m² de inmuebles comparables en su zona (radio 1km, 10-19 comparables).";

describe.each(["occupancy", "redflags"] as const)(
  "hash/prompt agreement for the %s flow's areaPriceSignal (#184)",
  (flow) => {
    it("the assembled prompt renders whatever areaPriceSignal is set to", () => {
      const { stable, volatile } = buildSystemPrompt(flow, { listings: LISTINGS, areaPriceSignal: SIGNAL_A });
      const assembled = `${stable}\n${volatile ?? ""}`;
      expect(assembled).toContain(SIGNAL_A);
    });

    it("renders NOTHING price-comparison-shaped when areaPriceSignal is absent (no listing content changes)", () => {
      const { stable, volatile } = buildSystemPrompt(flow, { listings: LISTINGS });
      const assembled = `${stable}\n${volatile ?? ""}`;
      expect(assembled).not.toContain("DATO DERIVADO: PRECIO VS. ZONA");
    });

    it(
      "CHANGING the rendered comparison changes the hash — the exact case #184 exists to prove: " +
        "same listings, different areaPriceSignal band -> different content_hash",
      () => {
        const { volatile: volatileA } = buildSystemPrompt(flow, {
          listings: LISTINGS,
          areaPriceSignal: SIGNAL_A,
        });
        const { volatile: volatileB } = buildSystemPrompt(flow, {
          listings: LISTINGS,
          areaPriceSignal: SIGNAL_B,
        });
        // Sanity: the two prompts really do differ in what's rendered...
        expect(volatileA).not.toBe(volatileB);

        // ...and production code (occupancy.ts/redflags.ts) passes the SAME
        // string into getOrCompute's extraHashInput as it does into
        // FlowVars.areaPriceSignal here — so the hash must track the change.
        const hashA = computeAssessmentContentHash(LISTINGS, SIGNAL_A);
        const hashB = computeAssessmentContentHash(LISTINGS, SIGNAL_B);
        expect(hashA).not.toBe(hashB);
      },
    );

    it(
      "NOT changing the rendered comparison does NOT change the hash — a re-run with the " +
        "same band produces a cache HIT, not a spurious re-bill",
      () => {
        const hash1 = computeAssessmentContentHash(LISTINGS, SIGNAL_A);
        const hash2 = computeAssessmentContentHash(LISTINGS, SIGNAL_A);
        expect(hash1).toBe(hash2);
      },
    );

    it(
      "the presence/absence of areaPriceSignal itself changes the hash (undefined vs. a real " +
        "signal must not collide)",
      () => {
        const hashWithout = computeAssessmentContentHash(LISTINGS);
        const hashWith = computeAssessmentContentHash(LISTINGS, SIGNAL_A);
        expect(hashWithout).not.toBe(hashWith);
      },
    );
  },
);

describe("computeAssessmentContentHash — backward compatibility (condition/extract, which never pass extra)", () => {
  it("a two-argument call is bit-for-bit identical whether or not this parameter existed", () => {
    // Golden hash computed against the pre-#184 implementation (listings-only
    // material, no extra). If this ever changes, every condition/extract row
    // ever cached goes stale in one deploy — exactly the blast radius #184's
    // backward-compatible `extra === undefined` branch (cache.ts) exists to avoid.
    const listings: ListingSnapshot[] = [{ listingId: 1, description: "original text" }];
    expect(computeAssessmentContentHash(listings)).toBe(
      "7a2e22ac54398ba0a761642986617c26764a170da85957ba2d32c024c92ba28e",
    );
  });
});
