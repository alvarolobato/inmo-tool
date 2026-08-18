/**
 * Unit tests for the Hipoges search-URL builder + parser (issue #561).
 *
 * Grammar: `/<lang>/<operation>/<typology>/<country>/<town>[/<features>]` —
 * the ROUTE shape is grounded (etl/connectors/hipoges.py's docstring, D-111);
 * every token inside it is an unconfirmed INFERENCE, which is what the
 * always-present `"grammar"` loosened flag exists to make impossible to miss.
 */
import { describe, it, expect } from "vitest";
import { hipogesBuilder, hipogesParser } from "@/lib/search-url/portals/hipoges";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

// Estepona (Costa del Sol) — a known municipio (municipios.ts).
const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];
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

describe("hipogesBuilder — grammar honesty (issue #561)", () => {
  it("ALWAYS carries a 'grammar' loosened flag — the vocabulary is never presented as confirmed", () => {
    const task = one({});
    const grammar = task.loosened.find((l) => l.constraint === "grammar");
    expect(grammar).toBeDefined();
    expect(grammar!.reason).toContain("INFERENCIA");
    expect(grammar!.reason.toLowerCase()).toContain("d-051");
  });

  it("emits the grounded route shape with the inferred sale/flat/espana tokens", () => {
    const task = one({});
    expect(task.url).toBe("https://realestate.hipoges.com/es/sale/flat/espana/estepona");
    expect(task.portal).toBe("hipoges");
  });
});

describe("hipogesBuilder — typology mapping", () => {
  it("piso -> flat (exact, no property_types flag)", () => {
    const task = one({ propertyTypes: ["piso"] });
    expect(task.url).toContain("/sale/flat/");
    expect(task.loosened.some((l) => l.constraint === "property_types")).toBe(false);
  });

  it("atico folds onto flat (approximate, flagged)", () => {
    const task = one({ propertyTypes: ["atico"] });
    expect(task.url).toContain("/sale/flat/");
    const flag = task.loosened.find((l) => l.constraint === "property_types");
    expect(flag).toBeDefined();
    expect(flag!.reason.toLowerCase()).toContain("ático");
  });

  it("de-duplicates piso + atico (both fold onto flat) into ONE task, piso wins", () => {
    const tasks = build({ propertyTypes: ["piso", "atico"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].loosened.some((l) => l.constraint === "property_types")).toBe(false);
  });

  it("chalet -> house (exact)", () => {
    expect(one({ propertyTypes: ["chalet"] }).url).toContain("/sale/house/");
  });

  it("local -> office (approximate, flagged)", () => {
    const task = one({ propertyTypes: ["local"] });
    expect(task.url).toContain("/sale/office/");
    expect(task.loosened.some((l) => l.constraint === "property_types")).toBe(true);
  });

  it("nave folds onto building (approximate, flagged) and de-dupes with edificio", () => {
    const tasks = build({ propertyTypes: ["nave", "edificio"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toContain("/sale/building/");
    // nave precedes edificio in canonical PROPERTY_TYPES order, so nave (the
    // approximate one) wins the fold — the property_types flag stays.
    const flag = tasks[0].loosened.find((l) => l.constraint === "property_types");
    expect(flag).toBeDefined();
    expect(flag!.reason.toLowerCase()).toContain("nave");
  });

  it.each([
    ["garaje", "garage"],
    ["terreno", "land"],
    ["edificio", "building"],
  ] as const)("%s -> %s (exact)", (type, token) => {
    expect(one({ propertyTypes: [type] }).url).toContain(`/sale/${token}/`);
  });
});

describe("hipogesBuilder — geography (least-grounded segment)", () => {
  it("resolves a known municipio to the :town segment", () => {
    expect(one({ center: ESTEPONA }).url).toContain("/espana/estepona");
  });

  it("falls back to the province, then to 'espana', when no municipio resolves", () => {
    // Madrid capital is outside the known-municipio table but may resolve to a
    // province; assert it never throws and always yields a non-empty town token.
    const task = one({ center: MADRID });
    expect(task.url).toMatch(/\/espana\/[a-z-]+$/);
  });
});

describe("hipogesBuilder — price/size (no confirmed [:features] grammar)", () => {
  it("never encodes price or size into the URL", () => {
    const task = one({ priceMin: 50000, priceMax: 200000, sizeMin: 40, sizeMax: 100 });
    expect(task.url).toBe("https://realestate.hipoges.com/es/sale/flat/espana/estepona");
  });

  it("flags price_min/price_max/size_min/size_max as dropped when the profile sets them", () => {
    const task = one({ priceMin: 50000, priceMax: 200000, sizeMin: 40, sizeMax: 100 });
    const constraints = task.loosened.map((l) => l.constraint);
    expect(constraints).toEqual(
      expect.arrayContaining(["price_min", "price_max", "size_min", "size_max"]),
    );
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
    expect(a).toMatch(/^hipoges:sale\/flat:[0-9a-f]{8}$/);
    expect(one({ center: MADRID }).id).not.toBe(a);
  });
});

describe("hipogesParser — round trip with hipogesBuilder", () => {
  it("parse(build(scope)) recovers the section and location", () => {
    const task = one({ propertyTypes: ["chalet"], center: ESTEPONA });
    const parsed = hipogesParser.parse(task.url);
    expect(parsed).not.toBeNull();
    expect(parsed!.filters.section).toBe("sale/house");
    expect(parsed!.filters.propertyTypes).toEqual(["chalet"]);
    expect(parsed!.filters.locationSlug).toBe("espana/estepona");
    expect(parsed!.categoryKey).toBe("sale/house");
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

describe("hipogesParser — real navigated URLs (D-051 capture-to-infer)", () => {
  it("recognises a typology token the builder never emits (apartment/storage) — decode more than we generate", () => {
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/sale/apartment/espana/malaga",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.filters.propertyTypes).toEqual(["piso"]);
  });

  it("recognises 'rent' as an operation and keeps it distinct from 'sale' in categoryKey", () => {
    const rentParsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/rent/flat/espana/estepona",
    );
    const saleParsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/sale/flat/espana/estepona",
    );
    expect(rentParsed!.categoryKey).not.toBe(saleParsed!.categoryKey);
  });

  it("keeps an optional [:features] segment and query string verbatim in the template", () => {
    const parsed = hipogesParser.parse(
      "https://realestate.hipoges.com/es/sale/flat/espana/malaga/some-feature-code?x=1",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.template).toContain("/some-feature-code");
    expect(parsed!.template).toContain("?x=1");
  });

  it("returns null for a detail URL (never conflates search with detail)", () => {
    expect(hipogesParser.parse("https://realestate.hipoges.com/es/detail/ABC123")).toBeNull();
    expect(
      hipogesParser.parse("https://realestate.hipoges.com/es/npl/detail/ABC123"),
    ).toBeNull();
  });

  it("returns null for an unrecognised typology token", () => {
    expect(
      hipogesParser.parse("https://realestate.hipoges.com/es/sale/spaceship/espana/madrid"),
    ).toBeNull();
  });

  it("returns null for a non-Hipoges host", () => {
    expect(hipogesParser.parse("https://www.idealista.com/es/sale/flat/espana/madrid")).toBeNull();
  });
});
