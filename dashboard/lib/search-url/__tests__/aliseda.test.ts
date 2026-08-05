/**
 * Unit tests for the aliseda search-URL builder (issue #277; owner-reported
 * grammar fix + task-list restructure 2026-08-05).
 *
 * Grammar (owner-confirmed):
 *   /comprar-viviendas/<tipo-plural>/<comunidad>/<provincia>?subtipo=<code>&precio=<min>-<max>
 * Confirmed example: Estepona-area piso ≤ 200 000 € →
 *   https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000
 *
 * Aliseda searches one property type at a time (type is a path segment), so a
 * multi-type profile yields ONE TASK PER TYPE.
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

describe("alisedaBuilder", () => {
  it("reproduces the owner's confirmed Estepona piso ≤200k example exactly", () => {
    const task = one({ priceMax: 200000 });

    expect(task.portal).toBe("aliseda");
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
    );
    expect(task.label).toContain("Aliseda");
    // Piso plural + subtipo are confirmed; only geography (radius→province) loosens.
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
    expect(one({ priceMin: 50000, priceMax: 200000 }).url).toContain("precio=50000-200000");
  });

  it("resolves greater-Sevilla coordinates to andalucia/sevilla", () => {
    // Sevilla capital ~ (37.3891, -5.9845).
    const task = one({ center: [37.3891, -5.9845], priceMax: 200000 });
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/sevilla?subtipo=36&precio=0-200000",
    );
  });

  it("ALWAYS loosens geography — radius broadens to the whole province", () => {
    const geo = one({ priceMax: 200000 }).loosened.find((l) => l.constraint === "geography");
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

  it("guesses non-piso plural segments and flags them, and omits an unknown subtipo", () => {
    const task = one({ propertyTypes: ["atico"], priceMax: 200000 });
    // Guessed plural in the path, no subtipo param (unknown code).
    expect(task.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/aticos/andalucia/malaga?precio=0-200000",
    );
    const typeFlags = task.loosened.filter((l) => l.constraint === "property_types");
    // One flag for the guessed plural, one for the unknown subtipo.
    expect(typeFlags.length).toBe(2);
    expect(typeFlags.some((f) => f.reason.includes("conjetura"))).toBe(true);
    expect(typeFlags.some((f) => f.reason.includes("subtipo"))).toBe(true);
  });

  it("yields one task per property type (type is a path segment), with distinct ids", () => {
    const tasks = build({ propertyTypes: ["piso", "atico"], priceMax: 200000 });
    expect(tasks.map((t) => t.url)).toEqual([
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-200000",
      "https://www.alisedainmobiliaria.com/comprar-viviendas/aticos/andalucia/malaga?precio=0-200000",
    ]);
    // Distinct, stable ids per task.
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
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
