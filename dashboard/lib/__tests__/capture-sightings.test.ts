/**
 * Unit tests for lib/capture-sightings.ts (issue #639 review, C1/C3/C4).
 *
 * Reads the SAME shared fixture etl/tests/test_capture.py::
 * TestSightingIdExtraction reads (`etl/tests/fixtures/sighting_ids.json`),
 * rather than each language hard-coding its own copy of the cases (a second
 * Opus review's own follow-up finding — this project has already been
 * bitten twice in one week by parallel definitions of one rule drifting,
 * and this particular rule feeds #643/#645's expiry signal). A URL shape
 * one language's regex accepts and the other rejects now fails a test
 * instead of aging into a wrong expiry months later.
 *
 * The Python and TypeScript id-extraction logic MUST agree, since both
 * ultimately write the same `listing.last_seen_at` column, and the first
 * review's finding was specifically that only the Python path existed while
 * the REAL production path (this module, wired into lib/db/worklist.ts
 * addWorklistUrls) recorded nothing at all.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeDetailPath,
  sightingIdFromUrl,
  sightingIdsByPortal,
} from "@/lib/capture-sightings";
import sightingIdCases from "../../../etl/tests/fixtures/sighting_ids.json";

interface SightingIdCase {
  case: string;
  portal: string;
  url: string;
  expected: string | null;
}

const CASES = sightingIdCases as SightingIdCase[];

describe("sightingIdFromUrl (shared fixture)", () => {
  it("the fixture is non-empty and covers every capture portal", () => {
    // Guard against the fixture itself silently losing coverage (e.g. a
    // bad merge truncating the file).
    const portals = new Set(CASES.map((c) => c.portal));
    for (const portal of ["idealista", "aliseda", "altamira", "hipoges"]) {
      expect(portals.has(portal)).toBe(true);
    }
    expect(CASES.length).toBeGreaterThanOrEqual(4);
  });

  it.each(CASES.map((c): [string, SightingIdCase] => [c.case, c]))(
    "%s",
    (_name, { portal, url, expected }) => {
      expect(sightingIdFromUrl(portal, url)).toBe(expected);
    },
  );
});

describe("normalizeDetailPath", () => {
  // Not part of the shared id-extraction fixture (it's a lower-level helper
  // `sightingIdFromUrl` composes with, not the rule itself) — kept as its
  // own small, language-specific test.
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

describe("sightingIdsByPortal", () => {
  // The batch/grouping form is the one thing the single-URL fixture can't
  // cover — de-dupe across two different URL forms for the same id,
  // group-by-portal, drop unresolvable pairs without throwing.
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
