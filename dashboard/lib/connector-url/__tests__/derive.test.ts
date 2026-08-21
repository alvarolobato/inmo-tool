// @vitest-environment node
/**
 * On-demand derived preview URL (issue #513) — {@link deriveGrammarPreview}.
 *
 * Proves the generic build works from a grammar + a profile scope (so the
 * "Validar filtros" row is never URL-less before the first ETL sweep), and that
 * the round-trip / rejection / no-geography gates all correctly return null
 * (falling back to the honest "pending" note) rather than surfacing a bad URL.
 */

import { describe, it, expect } from "vitest";
import { deriveGrammarPreview } from "../derive";
import type { SearchUrlGrammar } from "../parse";
import type { Scope } from "@/lib/profiles-schema";

// Estepona (Málaga) — inside KNOWN_PROVINCES, so provinceForPoint → "malaga".
const MALAGA_SCOPE: Scope = {
  geography: { type: "radius", center: [36.4268, -5.1468], radius_km: 10 },
  property_types: ["piso"],
};

// A point far outside every operating province (Lisbon) → no province slug.
const UNKNOWN_SCOPE: Scope = {
  geography: { type: "radius", center: [38.7223, -9.1393], radius_km: 10 },
  property_types: ["piso"],
};

/** A pisos-style grammar: a single profile-sourced geography slug. */
const SIMPLE_GRAMMAR: SearchUrlGrammar = {
  buildTemplate: "https://www.pisos.com/venta/pisos-{geography}/",
  parsePattern: "^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$",
  params: { geography: { label: "Geografía", source: "profile" } },
  rejectReasons: [],
};

/** A grammar with an extra non-profile placeholder left empty → won't round-trip. */
const EXTRA_SLOT_GRAMMAR: SearchUrlGrammar = {
  buildTemplate: "https://x.example/{geography}/{zone}/l",
  parsePattern: "^https?://x\\.example/(?<geography>[^/]+)/(?<zone>[^/]+)/l$",
  params: {
    geography: { label: "Geo", source: "profile" },
    zone: { label: "Zona", source: "derived" },
  },
  rejectReasons: [],
};

/** A grammar whose built URL matches a robots-reject fragment. */
const REJECTED_GRAMMAR: SearchUrlGrammar = {
  buildTemplate: "https://x.example/{geography}?q=1",
  parsePattern: "^https?://x\\.example/(?<geography>[^/?]+)\\?q=1$",
  params: { geography: { label: "Geo", source: "profile" } },
  rejectReasons: [{ pattern: "^https?://x\\.example/[^?]*\\?", reason: "robots-query-params" }],
};

/** No profile-sourced param at all → nothing meaningful to derive. */
const NO_PROFILE_PARAM_GRAMMAR: SearchUrlGrammar = {
  buildTemplate: "https://x.example/all",
  parsePattern: "^https?://x\\.example/all$",
  params: {},
  rejectReasons: [],
};

describe("deriveGrammarPreview", () => {
  it("builds a derived URL from the profile's resolved province slug", () => {
    const result = deriveGrammarPreview(SIMPLE_GRAMMAR, MALAGA_SCOPE);
    expect(result).not.toBeNull();
    expect(result!.geoSlug).toBe("malaga");
    expect(result!.url).toBe("https://www.pisos.com/venta/pisos-malaga/");
  });

  it("returns null when the profile geography resolves to no known province", () => {
    expect(deriveGrammarPreview(SIMPLE_GRAMMAR, UNKNOWN_SCOPE)).toBeNull();
  });

  it("returns null when an empty non-profile placeholder makes the URL not round-trip", () => {
    // zone is left empty → the built URL can't be inferred back → no derivation.
    expect(deriveGrammarPreview(EXTRA_SLOT_GRAMMAR, MALAGA_SCOPE)).toBeNull();
  });

  it("returns null when the built URL is a robots-forbidden shape", () => {
    expect(deriveGrammarPreview(REJECTED_GRAMMAR, MALAGA_SCOPE)).toBeNull();
  });

  it("returns null when the grammar has no profile-sourced param to fill", () => {
    expect(deriveGrammarPreview(NO_PROFILE_PARAM_GRAMMAR, MALAGA_SCOPE)).toBeNull();
  });

  // Issue #659/D-147: an "everywhere" geography has no center to resolve a
  // province slug from — must fall back to the honest "pending" null, never
  // crash on `.center`.
  it("returns null (not a crash) for an everywhere geography", () => {
    const everywhereScope: Scope = { geography: { type: "everywhere" }, property_types: "all" };
    expect(deriveGrammarPreview(SIMPLE_GRAMMAR, everywhereScope)).toBeNull();
  });
});
