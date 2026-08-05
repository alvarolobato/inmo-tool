/**
 * Unit tests for the aliseda search-URL builder.
 *
 * Grammar (verified against the live portal 2026-08-05, issue #336):
 *   top-level category  → /comprar-<category>/<comunidad>/<provincia>
 *   residential subtype → /comprar-viviendas/<subtype-slug>/<comunidad>/<provincia>?subtipo=<code>
 * Confirmed owner example: Estepona-area piso ≤ 200 000 € →
 *   https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000
 *
 * Provenance (captured, no live network in these tests):
 *   - category slugs from /sitemap-category-aliseda-es-0.xml
 *     (viviendas, locales, naves, garajes, terrenos, edificios, …);
 *   - vivienda subtype slugs from the app bundle main-*.js i18n map
 *     (pisos, duplex, casas, chalets-adosados, … — NO `aticos`);
 *   - subtipo codes pisos=36 / chalets-adosados=31 from Google-indexed URLs.
 *
 * Root-cause the fix addresses: Aliseda has NO `ático` category (the string
 * never appears in its app), and non-home types are their OWN top-level
 * categories — so the old `/comprar-viviendas/aticos/…` and
 * `/comprar-viviendas/locales/…` URLs matched nothing.
 */

import { describe, it, expect } from "vitest";
import { alisedaBuilder } from "@/lib/search-url/portals/aliseda";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

// Estepona (Costa del Sol) — the owner's confirmed example centre.
const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];

const BASE: CanonicalSearchScope = {
  center: ESTEPONA,
  radiusKm: 5,
  propertyTypes: ["piso"],
};

function build(scope: Partial<CanonicalSearchScope>) {
  return alisedaBuilder.build({ ...BASE, ...scope });
}

/** Convenience: the single task for a single-type scope. */
function one(scope: Partial<CanonicalSearchScope>) {
  const tasks = build(scope);
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

describe("alisedaBuilder — residential (comprar-viviendas + subtipo)", () => {
  it("reproduces the owner's confirmed Estepona piso ≤200k example exactly", () => {
    const task = one({ priceMax: 200000 });

    expect(task.portal).toBe("aliseda");
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
    );
    expect(task.label).toContain("Aliseda");
    // Piso is exact; only geography (radius→province) loosens.
    expect(task.loosened.map((l) => l.constraint)).toEqual(["geography"]);
  });

  it("gives each task a stable, deterministic id (same filters → same id)", () => {
    const a = one({ priceMax: 200000 }).id;
    const b = one({ priceMax: 200000 }).id;
    expect(a).toBe(b);
    expect(a).toMatch(/^aliseda:pisos:[0-9a-f]{8}$/);
    // A different price band → a different id.
    expect(one({ priceMax: 150000 }).id).not.toBe(a);
  });

  it("defaults precio min to 0 and honours an explicit min", () => {
    expect(one({ priceMax: 200000 }).url).toContain("precio=0-200000");
    expect(one({ priceMin: 50000, priceMax: 200000 }).url).toContain(
      "precio=50000-200000",
    );
  });

  it("resolves greater-Sevilla coordinates to andalucia/sevilla", () => {
    // Sevilla capital ~ (37.3891, -5.9845).
    const task = one({ center: [37.3891, -5.9845], priceMax: 200000 });
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/sevilla?subtipo=36&precio=0-200000",
    );
  });
});

describe("alisedaBuilder — ático fix (#336: Aliseda has no ático category)", () => {
  it("maps ático onto the pisos subtype (subtipo=36) and flags the broadening", () => {
    const task = one({ propertyTypes: ["atico"], priceMax: 200000 });
    // Áticos are published as pisos on Aliseda → the SAME valid pisos URL,
    // NOT the old broken `/comprar-viviendas/aticos/…` that matched nothing.
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
    );
    const typeFlags = task.loosened.filter(
      (l) => l.constraint === "property_types",
    );
    expect(typeFlags).toHaveLength(1);
    expect(typeFlags[0].reason).toContain("ático");
    expect(typeFlags[0].reason.toLowerCase()).toContain("pisos");
    // No invalid `aticos` slug anywhere.
    expect(task.url).not.toContain("aticos");
  });

  it("de-duplicates piso + ático (both collapse to the pisos search) into ONE task", () => {
    const tasks = build({ propertyTypes: ["piso", "atico"], priceMax: 200000 });
    expect(tasks).toHaveLength(1);
    // The exact `piso` task wins the de-dup (no property_types flag).
    expect(tasks[0].loosened.map((l) => l.constraint)).toEqual(["geography"]);
    expect(tasks[0].url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
    );
  });
});

describe("alisedaBuilder — chalet (approximate: adosados only)", () => {
  it("maps chalet onto chalets-adosados (subtipo=31) and flags the approximation", () => {
    const task = one({ propertyTypes: ["chalet"], priceMax: 200000 });
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/chalets-adosados/andalucia/malaga?subtipo=31&precio=0-200000",
    );
    const typeFlags = task.loosened.filter(
      (l) => l.constraint === "property_types",
    );
    expect(typeFlags).toHaveLength(1);
    expect(typeFlags[0].reason.toLowerCase()).toContain("chalet");
  });
});

describe("alisedaBuilder — non-residential top-level categories (#336 fix)", () => {
  it.each([
    ["local", "comprar-locales"],
    ["nave", "comprar-naves"],
    ["garaje", "comprar-garajes"],
    ["terreno", "comprar-terrenos"],
    ["edificio", "comprar-edificios"],
  ] as const)(
    "%s → its own top-level category %s (NOT nested under viviendas)",
    (type, category) => {
      const task = one({ propertyTypes: [type], priceMax: 200000 });
      expect(task.url).toBe(
        `https://www.alisedainmobiliaria.com/${category}/andalucia/malaga?precio=0-200000`,
      );
      // No subtipo for non-residential categories, and never nested under viviendas.
      expect(task.url).not.toContain("subtipo");
      expect(task.url).not.toContain("comprar-viviendas");
      // Category is exact → only geography loosens.
      expect(task.loosened.map((l) => l.constraint)).toEqual(["geography"]);
    },
  );
});

describe("alisedaBuilder — geography", () => {
  it("ALWAYS loosens geography — radius broadens to the whole province", () => {
    const geo = one({ priceMax: 200000 }).loosened.find(
      (l) => l.constraint === "geography",
    );
    expect(geo).toBeDefined();
    expect(geo!.reason).toContain("provincia");
    expect(geo!.reason).toContain("radio");
  });

  it("falls back to a province-less search and flags geography when the point matches no known province", () => {
    // Madrid — outside both Andalusian boxes.
    const task = one({ center: [40.4168, -3.7038], priceMax: 200000 });
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos?subtipo=36&precio=0-200000",
    );
    const geo = task.loosened.find((l) => l.constraint === "geography");
    expect(geo).toBeDefined();
    expect(geo!.reason).toContain("Provincia no determinada");
  });
});

describe("alisedaBuilder — multi-type fan-out and numeric constraints", () => {
  it("yields one task per DISTINCT Aliseda search, with distinct ids", () => {
    const tasks = build({
      propertyTypes: ["piso", "local", "garaje"],
      priceMax: 200000,
    });
    expect(tasks.map((t) => t.url)).toEqual([
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
      "https://www.alisedainmobiliaria.com/comprar-locales/andalucia/malaga?precio=0-200000",
      "https://www.alisedainmobiliaria.com/comprar-garajes/andalucia/malaga?precio=0-200000",
    ]);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(3);
  });

  it("drops a lower-bound-only price (needs a range) and flags price_min", () => {
    const task = one({ priceMin: 80000 });
    expect(task.url).not.toContain("precio=");
    expect(task.loosened.some((l) => l.constraint === "price_min")).toBe(true);
  });

  it("drops size (no confirmed grammar) and flags size_min / size_max", () => {
    const task = one({ priceMax: 200000, sizeMin: 50, sizeMax: 120 });
    expect(task.url).not.toContain("superficie");
    expect(task.loosened.some((l) => l.constraint === "size_min")).toBe(true);
    expect(task.loosened.some((l) => l.constraint === "size_max")).toBe(true);
  });
});
