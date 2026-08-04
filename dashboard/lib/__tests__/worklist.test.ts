/**
 * Unit tests for the capture-worklist pure helpers (issue #237).
 *
 * The MATCH_KEY_CASES table below is the byte-for-byte mirror of
 * etl/tests/test_capture_worklist.py's MATCH_KEY_CASES — the TypeScript
 * `worklistMatchKey` (seed-time canonicalisation) and the Python
 * `worklist_match_key` (capture-time correlation) MUST produce identical
 * output or a captured listing silently fails to correlate to its worklist
 * row. Keeping the two tables identical is the guard.
 */

import { describe, it, expect } from "vitest";
import { worklistMatchKey, portalForUrl } from "@/lib/worklist";

// Mirror of etl/tests/test_capture_worklist.py MATCH_KEY_CASES.
const MATCH_KEY_CASES: [string, string][] = [
  ["https://www.alisedainmobiliaria.com/inmueble/ANT1", "alisedainmobiliaria.com/inmueble/ANT1"],
  ["http://alisedainmobiliaria.com/inmueble/ANT1/", "alisedainmobiliaria.com/inmueble/ANT1"],
  [
    "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm_source=x#gallery",
    "alisedainmobiliaria.com/inmueble/ANT1",
  ],
  ["https://WWW.Idealista.com/inmueble/106387165/", "idealista.com/inmueble/106387165"],
  ["  https://alisedainmobiliaria.com/inmueble/ANT2  ", "alisedainmobiliaria.com/inmueble/ANT2"],
  ["not a url", ""],
];

describe("worklistMatchKey", () => {
  it.each(MATCH_KEY_CASES)("canonicalises %s", (url, expected) => {
    expect(worklistMatchKey(url)).toBe(expected);
  });

  it("preserves path case (asset ids can be case-sensitive)", () => {
    expect(worklistMatchKey("https://alisedainmobiliaria.com/inmueble/AbC123")).toBe(
      "alisedainmobiliaria.com/inmueble/AbC123",
    );
  });
});

describe("portalForUrl", () => {
  it("maps a known capture host to its portal", () => {
    expect(portalForUrl("https://www.alisedainmobiliaria.com/inmueble/ANT1")).toBe("aliseda");
    expect(portalForUrl("https://www.idealista.com/inmueble/1/")).toBe("idealista");
  });

  it("matches subdomains of a capture host", () => {
    expect(portalForUrl("https://foo.alisedainmobiliaria.com/inmueble/ANT1")).toBe("aliseda");
  });

  it("returns null for an unrecognised host", () => {
    expect(portalForUrl("https://www.fotocasa.es/vivienda/1")).toBeNull();
    expect(portalForUrl("not a url")).toBeNull();
  });
});
