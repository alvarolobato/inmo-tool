/**
 * Unit tests for the Hipoges search-URL builder + parser (issue #561).
 *
 * REVISED after a fresh-context Opus review of the first version (PR #562,
 * B1/B2/N3/N4): the typology/operation/town vocabulary here is what the
 * review confirmed from the site's public bundle (`main-*.js`/`chunk-*.js`/
 * `es.json`), not the wrong `flat`/`house`/`sale` guesses the first version
 * shipped — see hipoges.ts's module docstring for the full trace.
 */
import { describe, it, expect } from "vitest";
import { hipogesBuilder, hipogesParser } from "@/lib/search-url/portals/hipoges";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

// Estepona (Costa del Sol) — a known municipio (municipios.ts), and the ONE
// real captured Hipoges town example the review confirmed the FORMAT from
// ("Estepona, Málaga" -> "estepona_malaga").
const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];
// Sevilla capital — the OTHER known market, and its own province capital row.
const SEVILLA: readonly [number, number] = [37.3891, -5.9845];
// Madrid — outside every known municipio/province box in this tool's tables.
const MADRID: readonly [number, number] = [40.4168, -3.7038];

const BASE: CanonicalSearchScope = {
  center: ESTEPONA,
  radiusKm: 5,
  propertyTypes: ["piso"],
};

function build(scope: Partial<CanonicalSearchScope>) {
  return hipogesBuilder.build({ ...BASE, ...scope });
}

function one(scope: Partial<CanonicalSearchScope>) {
  const tasks = build(scope);
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

describe("hipogesBuilder — grammar honesty, narrowed to :operation alone (issue #561 review)", () => {
  it("carries a 'grammar' flag scoped to the operation token, not the whole route", () => {
    const task = one({});
    const grammar = task.loosened.find((l) => l.constraint === "grammar");
    expect(grammar).toBeDefined();
    expect(grammar!.reason).toContain("operación");
    expect(grammar!.reason.toLowerCase()).toContain("d-051");
  });

  it("emits the confirmed route: /es/venta/<typology>/espana/<town>", () => {
    const task = one({});
    expect(task.url).toBe("https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga");
  });
});

describe("hipogesBuilder — typology sections are CONFIRMED, not per-type guesses (issue #561 review, N3)", () => {
  it("piso, chalet and atico all collapse into ONE pisos-y-casas task (the site's own taxonomy)", () => {
    const tasks = build({ propertyTypes: ["piso", "chalet", "atico"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toContain("/venta/pisos-y-casas/");
    // No property_types flag: this is the site's real section, not an approximation.
    expect(tasks[0].loosened.some((l) => l.constraint === "property_types")).toBe(false);
  });

  it("local and nave collapse into ONE locales-y-naves task", () => {
    const tasks = build({ propertyTypes: ["local", "nave"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toContain("/venta/locales-y-naves/");
  });

  it.each([
    ["garaje", "garajes"],
    ["terreno", "terrenos"],
    ["edificio", "edificios"],
  ] as const)("%s -> its own confirmed typology %s", (type, typology) => {
    expect(one({ propertyTypes: [type] }).url).toContain(`/venta/${typology}/`);
  });

  it("a mixed profile fans out into one task PER TYPOLOGY SECTION, not per canonical type", () => {
    const tasks = build({ propertyTypes: ["piso", "chalet", "local", "garaje"] });
    // pisos-y-casas (piso+chalet), locales-y-naves (local), garajes — THREE
    // sections, not four canonical types.
    expect(tasks.map((t) => t.url)).toEqual([
      "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga",
      "https://realestate.hipoges.com/es/venta/locales-y-naves/espana/estepona_malaga",
      "https://realestate.hipoges.com/es/venta/garajes/espana/estepona_malaga",
    ]);
  });
});

describe("hipogesBuilder — :town format (issue #561 review, B1: underscore-joined, not bare municipio)", () => {
  it("resolves a known municipio to <municipio>_<provincia>, not the bare municipio", () => {
    const task = one({ center: ESTEPONA });
    expect(task.url).toContain("/espana/estepona_malaga");
    expect(task.url).not.toContain("/espana/estepona/"); // bare form is the confirmed-WRONG old shape
  });

  it("Sevilla capital resolves to sevilla_sevilla (its own known-municipio row)", () => {
    expect(one({ center: SEVILLA }).url).toContain("/espana/sevilla_sevilla");
  });

  it("never repeats the country segment as the town — falls back to a <municipio>_<provincia>-shaped default instead (issue #561 review, N4)", () => {
    const task = one({ center: MADRID });
    expect(task.url).not.toContain("/espana/espana");
    expect(task.url).toMatch(/\/espana\/[a-z]+_[a-z]+$/);
  });
});

describe("hipogesBuilder — [:features] (issue #561 review, N2: known shape, unconfirmed codes)", () => {
  it("never encodes price or size into the URL", () => {
    const task = one({ priceMin: 50000, priceMax: 200000, sizeMin: 40, sizeMax: 100 });
    expect(task.url).toBe("https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga");
  });

  it("flags price_min/price_max/size_min/size_max as dropped, honestly describing [:features] as a known-shape/unconfirmed-codes list", () => {
    const task = one({ priceMin: 50000, priceMax: 200000, sizeMin: 40, sizeMax: 100 });
    const constraints = task.loosened.map((l) => l.constraint);
    expect(constraints).toEqual(
      expect.arrayContaining(["price_min", "price_max", "size_min", "size_max"]),
    );
    const priceFlag = task.loosened.find((l) => l.constraint === "price_max")!;
    expect(priceFlag.reason).not.toMatch(/sin gramática confirmada/i);
    expect(priceFlag.reason.toLowerCase()).toContain("configuración");
  });

  it("adds no price/size flags when the profile sets none", () => {
    const task = one({});
    const constraints = task.loosened.map((l) => l.constraint);
    expect(constraints).not.toEqual(
      expect.arrayContaining(["price_min", "price_max", "size_min", "size_max"]),
    );
  });
});

describe("hipogesBuilder — task ids", () => {
  it("gives a stable, deterministic id and a distinct id for a different geography", () => {
    const a = one({}).id;
    const b = one({}).id;
    expect(a).toBe(b);
    expect(a).toMatch(/^hipoges:venta\/pisos-y-casas:[0-9a-f]{8}$/);
    expect(one({ center: MADRID }).id).not.toBe(a);
  });
});

describe("hipogesParser — round trip with hipogesBuilder", () => {
  it("parse(build(scope)) recovers the section and location", () => {
    const task = one({ propertyTypes: ["chalet"], center: ESTEPONA });
    const parsed = hipogesParser.parse(task.url);
    expect(parsed).not.toBeNull();
    expect(parsed!.filters.section).toBe("venta/pisos-y-casas");
    expect(parsed!.filters.propertyTypes).toEqual(["piso", "chalet", "atico"]);
    expect(parsed!.filters.locationSlug).toBe("espana/estepona_malaga");
    expect(parsed!.categoryKey).toBe("venta/pisos-y-casas");
  });

  it("re-substituting the template reproduces the URL byte-for-byte", () => {
    const task = one({ propertyTypes: ["piso"], center: ESTEPONA });
    const parsed = hipogesParser.parse(task.url)!;
    const { url } = hipogesParser.substitute(parsed.template, BASE);
    expect(url).toBe(task.url);
  });

  it("reports price/size as unfilled on substitute (no confirmed numeric grammar)", () => {
    const task = one({ propertyTypes: ["piso"] });
    const parsed = hipogesParser.parse(task.url)!;
    const { unfilled } = hipogesParser.substitute(parsed.template, {
      ...BASE,
      priceMax: 300000,
      sizeMin: 60,
    });
    expect(unfilled).toEqual(expect.arrayContaining(["price_max", "size_min"]));
  });
});

describe("hipogesParser — real navigated URLs are ALWAYS learnable (issue #561 review, B2)", () => {
  it("never returns null for an unrecognised typology — a real capture must always be storable", () => {
    // The whole point of D-051: a real navigated URL, even one whose typology
    // this project has no canonical type for (oficinas/trasteros/obra_parada
    // are real Hipoges typologies), must still decode and be learnable.
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/venta/oficinas/espana/malaga_malaga",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.filters.propertyTypes).toEqual([]); // honest: we don't map this typology, never fabricated
    expect(parsed!.filters.section).toBe("venta/oficinas");
  });

  it("never returns null for an operation other than the guessed 'venta' — alquiler decodes and stays distinct", () => {
    const rentParsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/alquiler/pisos-y-casas/espana/estepona_malaga",
    );
    const saleParsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga",
    );
    expect(rentParsed).not.toBeNull();
    expect(rentParsed!.categoryKey).not.toBe(saleParsed!.categoryKey);
  });

  it("never returns null for a completely unexpected operation token either", () => {
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/subasta/pisos-y-casas/espana/estepona_malaga",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.filters.section).toBe("subasta/pisos-y-casas");
  });

  it("decodes the confirmed real typology tokens even though only one canonical bucket is mapped", () => {
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/venta/locales-y-naves/espana/malaga_malaga",
    );
    expect(parsed!.filters.propertyTypes).toEqual(["local", "nave"]);
  });

  it("keeps an optional [:features] segment and query string verbatim in the template", () => {
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/malaga_malaga/12,45,7?x=1",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.template).toContain("/12,45,7");
    expect(parsed!.template).toContain("?x=1");
  });

  it("returns null for a detail URL (never conflates search with detail)", () => {
    expect(hipogesParser.parse("https://realestate.hipoges.com/es/detail/ABC123")).toBeNull();
    expect(
      hipogesParser.parse("https://realestate.hipoges.com/es/npl/detail/ABC123"),
    ).toBeNull();
  });

  it("returns null for a non-Hipoges host", () => {
    expect(
      hipogesParser.parse("https://www.idealista.com/es/venta/pisos-y-casas/espana/madrid_madrid"),
    ).toBeNull();
  });
});
