/**
 * Unit tests for the lat/lng → municipio mapping (issue #277).
 */

import { describe, it, expect } from "vitest";
import { municipioForPoint, MAX_MATCH_KM } from "@/lib/search-url/municipios";

describe("municipioForPoint", () => {
  it("resolves Estepona (owner's confirmed example) to estepona/malaga", () => {
    const m = municipioForPoint([36.4268, -5.1468]);
    expect(m).not.toBeNull();
    expect(m!.municipio).toBe("estepona");
    expect(m!.provincia).toBe("malaga");
  });

  it("resolves the nearest town for a point a few km off-centre", () => {
    // ~3 km from Marbella centre.
    const m = municipioForPoint([36.53, -4.9]);
    expect(m!.municipio).toBe("marbella");
  });

  it("resolves Sevilla capital to sevilla/sevilla", () => {
    const m = municipioForPoint([37.3891, -5.9845]);
    expect(m!.municipio).toBe("sevilla");
    expect(m!.provincia).toBe("sevilla");
  });

  it(`returns null when the point is more than ${MAX_MATCH_KM} km from every known town`, () => {
    // Ronda (inland málaga) — in-province but far from every coastal town.
    expect(municipioForPoint([36.7429, -5.1668])).toBeNull();
    // Madrid — nowhere near.
    expect(municipioForPoint([40.4168, -3.7038])).toBeNull();
  });
});
