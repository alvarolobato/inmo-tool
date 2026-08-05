/**
 * Round-trip tests for the per-portal URL parsers (capture-to-infer, #293).
 *
 * The mechanism that stops us getting the grammar wrong: for representative
 * profiles, `parse(build(scope))` must decode back to `scope`'s section/filters
 * AND re-substituting into the returned `template` must reproduce the original
 * URL byte-for-byte. Because the parsers mirror the CURRENT (owner-confirmed,
 * #296) builders, any later change to a `build()` grammar fails these loudly.
 */

import { describe, it, expect } from "vitest";
import { idealistaBuilder, idealistaParser } from "@/lib/search-url/portals/idealista";
import { alisedaBuilder, alisedaParser } from "@/lib/search-url/portals/aliseda";
import { haversineKm } from "@/lib/search-url/parse-shared";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

const ESTEPONA: [number, number] = [36.4268, -5.1468]; // owner-confirmed → estepona-malaga
const INLAND_MALAGA: [number, number] = [37.0, -4.5]; // in málaga bbox, far from any town → province fallback
const MADRID: [number, number] = [40.4168, -3.7038]; // outside both known markets → national / no geo

/** The idealista task for a single-section profile (build → exactly one task here). */
function idealistaOne(scope: CanonicalSearchScope): string {
  const tasks = idealistaBuilder.build(scope);
  expect(tasks.length).toBe(1);
  return tasks[0].url;
}
function alisedaOne(scope: CanonicalSearchScope): string {
  const tasks = alisedaBuilder.build(scope);
  expect(tasks.length).toBe(1);
  return tasks[0].url;
}

describe("idealistaParser round-trips buildIdealista (#296 slug grammar)", () => {
  it("Estepona piso with a full price/size band", () => {
    const scope: CanonicalSearchScope = {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
      sizeMin: 60,
      sizeMax: 120,
    };
    const url = idealistaOne(scope);
    expect(url).toBe(
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000,metros-cuadrados-mas-de_60,metros-cuadrados-menos-de_120/",
    );
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.categoryKey).toBe("venta-viviendas");
    expect(parsed.filters.section).toBe("venta-viviendas");
    expect(parsed.filters.locationSlug).toBe("estepona-malaga");
    // Section IS the granularity → all home subtypes recovered.
    expect(parsed.filters.propertyTypes).toEqual(["piso", "chalet", "atico"]);
    expect(parsed.filters.priceMax).toBe(200000);
    expect(parsed.filters.sizeMin).toBe(60);
    expect(parsed.filters.sizeMax).toBe(120);
    expect(parsed.filters.center).toBeDefined();
    expect(haversineKm(parsed.filters.center!, ESTEPONA)).toBeLessThan(1);

    const { url: rebuilt, unfilled } = idealistaParser.substitute(parsed.template, scope);
    expect(rebuilt).toBe(url); // byte-for-byte
    expect(unfilled).toEqual([]);
  });

  it("garaje section (single type per section)", () => {
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["garaje"], priceMax: 30000 };
    const url = idealistaOne(scope);
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.filters.section).toBe("venta-garajes");
    expect(parsed.filters.propertyTypes).toEqual(["garaje"]);
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("province fallback slug (<provincia>-provincia) resolves a centroid", () => {
    const scope: CanonicalSearchScope = { center: INLAND_MALAGA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 150000 };
    const url = idealistaOne(scope);
    expect(url).toContain("/venta-viviendas/malaga-provincia/con-");
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.filters.locationSlug).toBe("malaga-provincia");
    expect(parsed.filters.center).toBeDefined(); // province bbox centre
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("national search (no known location) → empty slug, no centroid", () => {
    const scope: CanonicalSearchScope = { center: MADRID, radiusKm: 8, propertyTypes: ["piso"], priceMax: 250000 };
    const url = idealistaOne(scope);
    expect(url).toBe("https://www.idealista.com/venta-viviendas/con-precio-hasta_250000/");
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.filters.locationSlug).toBe("");
    expect(parsed.filters.center).toBeUndefined();
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("returns null for a non-search / non-idealista URL", () => {
    expect(idealistaParser.parse("https://www.idealista.com/inmueble/123/")).toBeNull();
    expect(idealistaParser.parse("https://example.com/venta-viviendas/estepona-malaga/")).toBeNull();
  });

  it("substitute drops a token the profile omits and flags a missing placeholder", () => {
    const template =
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_{price_max}/";
    const { url, unfilled } = idealistaParser.substitute(template, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      sizeMin: 60,
    });
    expect(url).toBe("https://www.idealista.com/venta-viviendas/estepona-malaga/");
    expect(unfilled).toContain("size_min");
  });
});

describe("alisedaParser round-trips buildAliseda (#296 slug grammar)", () => {
  it("Estepona-area piso ≤200.000 € (owner-confirmed example)", () => {
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 200000 };
    const url = alisedaOne(scope);
    expect(url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
    );
    const parsed = alisedaParser.parse(url)!;
    expect(parsed.categoryKey).toBe("pisos");
    expect(parsed.filters.section).toBe("pisos");
    expect(parsed.filters.propertyTypes).toEqual(["piso"]);
    expect(parsed.filters.locationSlug).toBe("andalucia/malaga");
    expect(parsed.filters.priceMax).toBe(200000);
    expect(parsed.filters.priceMin).toBeUndefined(); // 0 is the "no min" sentinel
    expect(parsed.filters.center).toBeDefined();

    const { url: rebuilt, unfilled } = alisedaParser.substitute(parsed.template, scope);
    expect(rebuilt).toBe(url); // byte-for-byte
    expect(unfilled).toEqual([]);
  });

  it("explicit price floor round-trips (precio=min-max)", () => {
    const scope: CanonicalSearchScope = {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMin: 50000,
      priceMax: 200000,
    };
    const url = alisedaOne(scope);
    expect(url).toContain("precio=50000-200000");
    const parsed = alisedaParser.parse(url)!;
    expect(parsed.filters.priceMin).toBe(50000);
    expect(alisedaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("no price → no precio param", () => {
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"] };
    const url = alisedaOne(scope);
    expect(url).toBe("https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36");
    const parsed = alisedaParser.parse(url)!;
    expect(alisedaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("no known province → no geo segments", () => {
    const scope: CanonicalSearchScope = { center: MADRID, radiusKm: 8, propertyTypes: ["piso"], priceMax: 250000 };
    const url = alisedaOne(scope);
    expect(url).toBe("https://www.alisedainmobiliaria.com/comprar-viviendas/pisos?subtipo=36&precio=0-250000");
    const parsed = alisedaParser.parse(url)!;
    expect(parsed.filters.locationSlug).toBe("");
    expect(parsed.filters.center).toBeUndefined();
    expect(alisedaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("substitute drops precio when the profile has no upper bound and flags price_min + size", () => {
    const template =
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio={price_min}-{price_max}";
    const { url, unfilled } = alisedaParser.substitute(template, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMin: 50000,
      sizeMin: 70,
    });
    expect(url).toBe("https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36");
    expect(unfilled).toContain("price_min");
    expect(unfilled).toContain("size_min");
  });

  it("returns null for a non-aliseda URL", () => {
    expect(alisedaParser.parse("https://www.idealista.com/comprar-viviendas/pisos")).toBeNull();
  });
});
