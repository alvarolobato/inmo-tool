/**
 * Unit tests for the lat/lng → (comunidad, provincia) mapping (issue #277).
 */

import { describe, it, expect } from "vitest";
import { provinceForPoint, KNOWN_PROVINCES } from "@/lib/search-url/provinces";

describe("provinceForPoint", () => {
  it("resolves Estepona (owner's confirmed example) to andalucia/malaga", () => {
    const p = provinceForPoint([36.4268, -5.1468]);
    expect(p).not.toBeNull();
    expect(p!.comunidad).toBe("andalucia");
    expect(p!.provincia).toBe("malaga");
  });

  it("resolves Sevilla capital to andalucia/sevilla", () => {
    const p = provinceForPoint([37.3891, -5.9845]);
    expect(p).not.toBeNull();
    expect(p!.provincia).toBe("sevilla");
  });

  it("returns null for a point outside every known province (Madrid)", () => {
    expect(provinceForPoint([40.4168, -3.7038])).toBeNull();
  });

  it("exposes bounding-box rows ordered most-specific first (malaga before sevilla)", () => {
    expect(KNOWN_PROVINCES.map((p) => p.provincia)).toEqual(["malaga", "sevilla"]);
  });
});
