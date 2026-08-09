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

const ESTEPONA: [number, number] = [36.4268, -5.1468]; // owner-confirmed area centre
const MADRID: [number, number] = [40.4168, -3.7038]; // outside both known markets → aliseda national / no geo

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

describe("idealistaParser round-trips buildIdealista (#471 shape grammar)", () => {
  it("Estepona piso shape URL with a full price/size band (build → parse → substitute)", () => {
    const scope: CanonicalSearchScope = {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
      sizeMin: 60,
      sizeMax: 120,
    };
    const url = idealistaOne(scope);
    expect(url).toContain("/areas/venta-viviendas/");
    expect(url).toContain("/mapa-google?shape=%28%28");
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.categoryKey).toBe("venta-viviendas");
    expect(parsed.filters.section).toBe("venta-viviendas");
    expect(parsed.filters.geoKind).toBe("shape");
    expect(parsed.filters.locationSlug).toBe(""); // geometry, not a slug
    expect(parsed.filters.shapeVertexCount).toBe(25); // 24-gon + closing vertex
    // Section IS the granularity → all home subtypes recovered.
    expect(parsed.filters.propertyTypes).toEqual(["piso", "chalet", "atico"]);
    expect(parsed.filters.priceMax).toBe(200000);
    expect(parsed.filters.sizeMin).toBe(60);
    expect(parsed.filters.sizeMax).toBe(120);
    // Centre recovered from the polygon centroid.
    expect(parsed.filters.center).toBeDefined();
    expect(haversineKm(parsed.filters.center!, ESTEPONA)).toBeLessThan(1);

    const { url: rebuilt, unfilled } = idealistaParser.substitute(parsed.template, scope);
    expect(rebuilt).toBe(url); // byte-for-byte
    expect(unfilled).toEqual([]);
  });

  it("garaje shape URL (single type per section)", () => {
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["garaje"], priceMax: 30000 };
    const url = idealistaOne(scope);
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.filters.section).toBe("venta-garajes");
    expect(parsed.filters.propertyTypes).toEqual(["garaje"]);
    expect(parsed.filters.geoKind).toBe("shape");
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("still parses a LEGACY slug URL (owner-navigated / historical) for learning", () => {
    // The builder no longer emits this, but the parser must keep understanding it
    // so owner-navigated and historical slug URLs are still learnable (D-051).
    const url =
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/";
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.filters.section).toBe("venta-viviendas");
    expect(parsed.filters.geoKind).toBeUndefined(); // slug, not shape/multi
    expect(parsed.filters.locationSlug).toBe("estepona-malaga");
    expect(parsed.filters.priceMax).toBe(200000);
    expect(parsed.filters.center).toBeDefined();
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 200000 };
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("parses a MULTI-zone URL as an opaque, verbatim pinned-override shape (#471)", () => {
    const url =
      "https://www.idealista.com/multi/venta-viviendas/ac0,ac2,acY,acZ,adb,cuZ/con-precio-hasta_700000/";
    const parsed = idealistaParser.parse(url)!;
    expect(parsed.categoryKey).toBe("venta-viviendas");
    expect(parsed.filters.geoKind).toBe("multi");
    expect(parsed.filters.locationSlug).toBe("ac0,ac2,acY,acZ,adb,cuZ");
    expect(parsed.filters.priceMax).toBe(700000);
    // Zone codes stay verbatim; only numerics substitute.
    const scope: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 700000 };
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(url);
  });

  it("parses the owner-captured LISTING-form shape URL (no /mapa-google, #524)", () => {
    // Real specimen captured by the owner via the observer (#489/#510) — the
    // listing (card) form Idealista serves and toListingUrl (#506) produces:
    // `/areas/<op>/con-…/?shape=((…))` with NO `/mapa-google` and a trailing
    // slash before `?`. Before #524 this failed to parse (SHAPE_RE hard-required
    // `/mapa-google`) so Validar filtros showed "no se pudo validar".
    const listing =
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_210000/?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29";
    const parsed = idealistaParser.parse(listing)!;
    expect(parsed).not.toBeNull();
    expect(parsed.categoryKey).toBe("venta-viviendas");
    expect(parsed.filters.section).toBe("venta-viviendas");
    expect(parsed.filters.geoKind).toBe("shape");
    expect(parsed.filters.locationSlug).toBe("");
    expect(parsed.filters.shapeVertexCount).toBe(14); // owner-drawn ring
    expect(parsed.filters.priceMax).toBe(210000);
    expect(parsed.filters.center).toBeDefined();

    // The CANONICAL map form of the same search parses identically (same ring,
    // same filters) — both forms are the SAME search.
    const mapForm = listing.replace("/?shape=", "/mapa-google?shape=");
    const parsedMap = idealistaParser.parse(mapForm)!;
    expect(parsedMap).not.toBeNull();
    expect(parsedMap.filters.geoKind).toBe("shape");
    expect(parsedMap.filters.shapeVertexCount).toBe(14);
    expect(parsedMap.filters.priceMax).toBe(210000);

    // parse() normalises to the CANONICAL /mapa-google template regardless of
    // input form, so the builder's byte-for-byte round trip is unchanged: a
    // substitute against a matching scope reproduces the canonical map URL.
    expect(parsed.template).toBe(
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_{price_max}/mapa-google?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29",
    );
    const scope: CanonicalSearchScope = {
      center: parsed.filters.center!,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 210000,
    };
    expect(idealistaParser.substitute(parsed.template, scope).url).toBe(mapForm);
  });

  it("parses a LISTING-form shape URL with NO con- segment (#524)", () => {
    const listing =
      "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28ep%7DbFxcjc%40ajAojCaPsoBriByJf%60Buf%40nj%40qUb%7E%40xg%40%7Cs%40xh%40%7CJps%40kH%7CpCsu%40vXwqA%3FuiBnFy%5CxJ%29%29";
    const parsed = idealistaParser.parse(listing)!;
    expect(parsed).not.toBeNull();
    expect(parsed.filters.geoKind).toBe("shape");
    expect(parsed.filters.shapeVertexCount).toBe(14);
    expect(parsed.filters.priceMax).toBeUndefined();
  });

  it("returns null for a non-search / non-idealista / malformed-shape URL", () => {
    expect(idealistaParser.parse("https://www.idealista.com/inmueble/123/")).toBeNull();
    expect(idealistaParser.parse("https://example.com/venta-viviendas/estepona-malaga/")).toBeNull();
    // shape= present but not the ((<polyline>)) grammar → not a shape URL.
    expect(
      idealistaParser.parse("https://www.idealista.com/areas/venta-viviendas/mapa-google?shape=abc123"),
    ).toBeNull();
  });

  it("substitute drops a token the profile omits and flags a missing placeholder (slug template)", () => {
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
