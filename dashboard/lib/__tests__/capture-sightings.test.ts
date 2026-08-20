/**
 * Unit tests for lib/capture-sightings.ts (issue #639 review, C1/C3/C4).
 *
 * Mirrors etl/tests/test_capture.py::TestSightingIdExtraction case-for-case —
 * the Python and TypeScript id-extraction logic MUST agree, since both
 * ultimately write the same `listing.last_seen_at` column and the review's
 * finding was specifically that only the Python path existed while the REAL
 * production path (this module, wired into lib/db/worklist.ts
 * addWorklistUrls) recorded nothing at all.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeDetailPath,
  sightingIdFromUrl,
  sightingIdsByPortal,
} from "@/lib/capture-sightings";

describe("normalizeDetailPath", () => {
  it("strips query string and fragment, keeps trailing slash", () => {
    expect(normalizeDetailPath("https://www.idealista.com/inmueble/11111/?x=1")).toBe(
      "/inmueble/11111/",
    );
    expect(normalizeDetailPath("https://www.idealista.com/inmueble/11111/#foto")).toBe(
      "/inmueble/11111/",
    );
  });

  it("appends a trailing slash when missing", () => {
    expect(normalizeDetailPath("https://www.idealista.com/inmueble/22222")).toBe(
      "/inmueble/22222/",
    );
  });

  it("returns empty string for an unparseable URL", () => {
    expect(normalizeDetailPath("not a url")).toBe("");
  });
});

describe("sightingIdFromUrl", () => {
  it("idealista: trailing slash, missing slash, query, and fragment all resolve", () => {
    expect(sightingIdFromUrl("idealista", "https://www.idealista.com/inmueble/11111/")).toBe(
      "11111",
    );
    expect(sightingIdFromUrl("idealista", "https://www.idealista.com/inmueble/22222")).toBe(
      "22222",
    );
    expect(
      sightingIdFromUrl(
        "idealista",
        "https://www.idealista.com/inmueble/33333/?searchQueryId=x",
      ),
    ).toBe("33333");
    expect(sightingIdFromUrl("idealista", "https://www.idealista.com/inmueble/44444#foto")).toBe(
      "44444",
    );
  });

  it("aliseda: alphanumeric id with query and fragment", () => {
    expect(
      sightingIdFromUrl("aliseda", "https://www.alisedainmobiliaria.com/inmueble/ANT1"),
    ).toBe("ANT1");
    expect(
      sightingIdFromUrl(
        "aliseda",
        "https://www.alisedainmobiliaria.com/inmueble/ANT2?utm_source=x",
      ),
    ).toBe("ANT2");
    expect(
      sightingIdFromUrl("aliseda", "https://www.alisedainmobiliaria.com/inmueble/ANT3#gallery"),
    ).toBe("ANT3");
  });

  it("altamira: query/fragment resolve, but a sub-4-digit id still doesn't (its own regex floor)", () => {
    const base =
      "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001";
    expect(sightingIdFromUrl("altamira", `${base}/375859/1?utm_source=x`)).toBe("375859");
    expect(sightingIdFromUrl("altamira", `${base}/375860#ficha`)).toBe("375860");
    expect(sightingIdFromUrl("altamira", `${base}/123/`)).toBeNull();
  });

  it("hipoges: query and fragment resolve", () => {
    expect(sightingIdFromUrl("hipoges", "https://realestate.hipoges.com/es/detail/99001")).toBe(
      "99001",
    );
    expect(
      sightingIdFromUrl("hipoges", "https://realestate.hipoges.com/es/detail/99002?ref=x"),
    ).toBe("99002");
    expect(
      sightingIdFromUrl("hipoges", "https://realestate.hipoges.com/es/detail/99003#top"),
    ).toBe("99003");
  });

  it("hipoges: the portal's own 'gone' route never yields a sighting id (C3)", () => {
    expect(
      sightingIdFromUrl(
        "hipoges",
        "https://realestate.hipoges.com/es/detail/99001/unavailable",
      ),
    ).toBeNull();
    expect(
      sightingIdFromUrl(
        "hipoges",
        "https://realestate.hipoges.com/es/detail/99002/contact-received",
      ),
    ).toBeNull();
    // A live detail id in the same shape is unaffected.
    expect(sightingIdFromUrl("hipoges", "https://realestate.hipoges.com/es/detail/99003")).toBe(
      "99003",
    );
  });

  it("unknown portal yields null", () => {
    expect(sightingIdFromUrl("cimenta2", "https://example.com/whatever")).toBeNull();
  });
});

describe("sightingIdsByPortal", () => {
  it("groups by portal, de-duped, dropping unresolvable pairs", () => {
    const result = sightingIdsByPortal([
      { portal: "idealista", url: "https://www.idealista.com/inmueble/11111/" },
      // Duplicate id via a different URL form for the same listing.
      { portal: "idealista", url: "https://www.idealista.com/inmueble/11111?x=1" },
      { portal: "idealista", url: "https://www.idealista.com/inmueble/22222/" },
      { portal: "aliseda", url: "https://www.alisedainmobiliaria.com/inmueble/ANT1" },
      // Unresolvable (hipoges 'gone' route) — dropped, not thrown.
      {
        portal: "hipoges",
        url: "https://realestate.hipoges.com/es/detail/1/unavailable",
      },
    ]);
    expect([...result.get("idealista")!].sort()).toEqual(["11111", "22222"]);
    expect(result.get("aliseda")).toEqual(["ANT1"]);
    expect(result.has("hipoges")).toBe(false);
  });

  it("returns an empty map for an empty input", () => {
    expect(sightingIdsByPortal([]).size).toBe(0);
  });
});
