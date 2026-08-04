/**
 * Unit tests for the aliseda search-URL builder (issue #267).
 */

import { describe, it, expect } from "vitest";
import { alisedaBuilder } from "@/lib/search-url/portals/aliseda";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

const BASE: CanonicalSearchScope = {
  center: [40.4168, -3.7038],
  radiusKm: 10,
  propertyTypes: ["piso"],
};

function build(scope: Partial<CanonicalSearchScope>) {
  return alisedaBuilder.build({ ...BASE, ...scope });
}

describe("alisedaBuilder", () => {
  it("maps a single-category profile with a price/size band", () => {
    const { portal, url, loosened } = build({
      priceMin: 50000,
      priceMax: 200000,
      sizeMin: 50,
      sizeMax: 100,
    });

    expect(portal).toBe("aliseda");
    expect(url).toContain("https://www.alisedainmobiliaria.com/venta?");
    expect(url).toContain("tipo=vivienda");
    expect(url).toContain("precioMin=50000");
    expect(url).toContain("precioMax=200000");
    expect(url).toContain("superficieMin=50");
    expect(url).toContain("superficieMax=100");
  });

  it("ALWAYS loosens geography (aliseda has no radius search)", () => {
    const { loosened } = build({});
    const geo = loosened.find((l) => l.constraint === "geography");
    expect(geo).toBeDefined();
    expect(geo!.reason).toContain("radio");
  });

  it("sets a single tipo when all types share one category", () => {
    const { url, loosened } = build({ propertyTypes: ["piso", "chalet", "atico"] });
    expect(url).toContain("tipo=vivienda");
    // Only geography loosened, not property_types.
    expect(loosened.map((l) => l.constraint)).toEqual(["geography"]);
  });

  it("drops tipo and loosens property_types when categories span several", () => {
    const { url, loosened } = build({ propertyTypes: ["piso", "garaje"] });
    expect(url).not.toContain("tipo=");
    const flag = loosened.find((l) => l.constraint === "property_types");
    expect(flag).toBeDefined();
    expect(flag!.reason).toContain("vivienda");
    expect(flag!.reason).toContain("garaje");
  });

  it("maps each type to its aliseda category", () => {
    expect(build({ propertyTypes: ["garaje"] }).url).toContain("tipo=garaje");
    expect(build({ propertyTypes: ["terreno"] }).url).toContain("tipo=suelo");
    expect(build({ propertyTypes: ["local"] }).url).toContain("tipo=local");
    expect(build({ propertyTypes: ["nave"] }).url).toContain("tipo=nave");
    expect(build({ propertyTypes: ["edificio"] }).url).toContain("tipo=edificio");
  });

  it("omits the query string entirely when there are no expressible filters", () => {
    // A single category still yields a tipo; force the multi-category branch
    // with no price/size so the query would be empty but for… nothing.
    const { url } = build({ propertyTypes: ["piso", "garaje"] });
    // No tipo (multi-category) and no price/size → bare /venta.
    expect(url).toBe("https://www.alisedainmobiliaria.com/venta");
  });
});
