/**
 * Unit tests for the idealista search-URL builder (issue #267).
 */

import { describe, it, expect } from "vitest";
import { idealistaBuilder } from "@/lib/search-url/portals/idealista";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

const BASE: CanonicalSearchScope = {
  center: [40.4168, -3.7038],
  radiusKm: 10,
  propertyTypes: ["piso"],
};

function build(scope: Partial<CanonicalSearchScope>) {
  return idealistaBuilder.build({ ...BASE, ...scope });
}

describe("idealistaBuilder", () => {
  it("maps a single-type profile with a full price/size band", () => {
    const { portal, url, loosened } = build({
      priceMin: 100000,
      priceMax: 300000,
      sizeMin: 60,
      sizeMax: 120,
    });

    expect(portal).toBe("idealista");
    expect(loosened).toEqual([]);
    expect(url).toContain("https://www.idealista.com/areas/venta-viviendas/con-");
    expect(url).toContain("pisos");
    expect(url).toContain("precio-desde_100000");
    expect(url).toContain("precio-hasta_300000");
    expect(url).toContain("metros-cuadrados-mas-de_60");
    expect(url).toContain("metros-cuadrados-menos-de_120");
    expect(url).toContain("?shape=");
  });

  it("emits no con- segment when there are no filter tokens (all home subtypes, no price/size)", () => {
    const { url, loosened } = build({ propertyTypes: ["piso", "chalet", "atico"] });
    // All three home subtypes == the unfiltered section, so no subtype token
    // and no other filters → bare section + shape, no /con- segment.
    expect(url).not.toContain("/con-");
    expect(url).toContain("/areas/venta-viviendas/?shape=");
    expect(loosened).toEqual([]);
  });

  it("rounds fractional bounds", () => {
    const { url } = build({ priceMax: 299999.6, sizeMin: 59.4 });
    expect(url).toContain("precio-hasta_300000");
    expect(url).toContain("metros-cuadrados-mas-de_59");
  });

  it("loosens property_types when types span multiple idealista sections", () => {
    const { url, loosened } = build({ propertyTypes: ["piso", "garaje"] });
    // First canonical type is piso → venta-viviendas section.
    expect(url).toContain("/areas/venta-viviendas/");
    const flag = loosened.find((l) => l.constraint === "property_types");
    expect(flag).toBeDefined();
    expect(flag!.reason).toContain("garaje");
    // Geography is faithful via the polygon → never loosened.
    expect(loosened.some((l) => l.constraint === "geography")).toBe(false);
  });

  it("uses the section of the first canonical-order type", () => {
    // property_types order in the input must not matter — canonical order wins.
    const { url } = build({ propertyTypes: ["garaje", "piso"] });
    expect(url).toContain("/areas/venta-viviendas/");
  });

  it("selects the right section for a non-homes type", () => {
    expect(build({ propertyTypes: ["garaje"] }).url).toContain("/areas/venta-garajes/");
    expect(build({ propertyTypes: ["terreno"] }).url).toContain("/areas/venta-terrenos/");
    expect(build({ propertyTypes: ["local"] }).url).toContain("/areas/venta-locales/");
    expect(build({ propertyTypes: ["edificio"] }).url).toContain("/areas/venta-edificios/");
  });

  it("adds a subtype token only when it narrows the homes section", () => {
    // Two of three home subtypes → narrows → tokens present.
    const twoUrl = build({ propertyTypes: ["piso", "chalet"] }).url;
    expect(twoUrl).toContain("pisos");
    expect(twoUrl).toContain("chalets");
  });
});
