/**
 * Unit tests for the idealista search-URL builder (issue #277; owner-reported
 * grammar fix + task-list restructure 2026-08-05).
 *
 * Grammar (owner-confirmed):
 *   /<operation>/<municipio>-<provincia>/con-<f1>[,<f2>,…]/
 * Confirmed examples (Estepona piso ≤ 200 000 €):
 *   https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/
 *   …with 4+ rooms:
 *   https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000,de-cuatro-cinco-habitaciones-o-mas/
 *
 * Idealista searches one operation section at a time, so a multi-section
 * profile yields ONE TASK PER SECTION.
 */

import { describe, it, expect } from "vitest";
import { idealistaBuilder } from "@/lib/search-url/portals/idealista";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

// Estepona (Costa del Sol) — the owner's confirmed example centre.
const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];

const BASE: CanonicalSearchScope = {
  center: ESTEPONA,
  radiusKm: 5,
  propertyTypes: ["piso"],
};

function build(scope: Partial<CanonicalSearchScope>) {
  return idealistaBuilder.build({ ...BASE, ...scope });
}

/** Convenience: the single task for a single-section scope. */
function one(scope: Partial<CanonicalSearchScope>) {
  const tasks = build(scope);
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

describe("idealistaBuilder", () => {
  it("reproduces the owner's confirmed Estepona piso ≤200k example exactly", () => {
    const task = one({ priceMax: 200000 });
    expect(task.portal).toBe("idealista");
    expect(task.url).toBe(
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/",
    );
    // A town match is the accepted representation → no loosened flags.
    expect(task.loosened).toEqual([]);
  });

  it("appends the owner-confirmed 4-5+ rooms token, comma-joined after price", () => {
    const task = one({ priceMax: 200000, roomsMin: 4 });
    expect(task.url).toBe(
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000,de-cuatro-cinco-habitaciones-o-mas/",
    );
    expect(task.loosened).toEqual([]);
  });

  it("omits and flags a rooms minimum with no confirmed token (< 4)", () => {
    const task = one({ priceMax: 200000, roomsMin: 2 });
    expect(task.url).not.toContain("habitaciones");
    expect(task.loosened.some((l) => l.constraint === "rooms")).toBe(true);
  });

  it("gives each task a stable, deterministic id (same filters → same id)", () => {
    const a = one({ priceMax: 200000 }).id;
    expect(a).toBe(one({ priceMax: 200000 }).id);
    expect(a).toMatch(/^idealista:venta-viviendas:[0-9a-f]{8}$/);
    // Rooms change the search → change the id.
    expect(one({ priceMax: 200000, roomsMin: 4 }).id).not.toBe(a);
  });

  it("emits price-desde/hasta and metros tokens, comma-joined", () => {
    const task = one({ priceMin: 100000, priceMax: 300000, sizeMin: 60, sizeMax: 120 });
    expect(task.url).toContain(
      "/con-precio-desde_100000,precio-hasta_300000,metros-cuadrados-mas-de_60,metros-cuadrados-menos-de_120/",
    );
  });

  it("emits a bare section+location (no con- segment) when there are no filters", () => {
    const task = one({});
    expect(task.url).toBe("https://www.idealista.com/venta-viviendas/estepona-malaga/");
  });

  it("rounds fractional bounds", () => {
    const task = one({ priceMax: 299999.6, sizeMin: 59.4 });
    expect(task.url).toContain("precio-hasta_300000");
    expect(task.url).toContain("metros-cuadrados-mas-de_59");
  });

  it("splits a multi-section profile into one task per section, with distinct stable ids", () => {
    const tasks = build({ propertyTypes: ["piso", "atico", "garaje"], priceMax: 200000 });
    expect(tasks.map((t) => t.url)).toEqual([
      "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/",
      "https://www.idealista.com/venta-garajes/estepona-malaga/con-precio-hasta_200000/",
    ]);
    // piso + atico collapse into the single venta-viviendas section (no subtype token).
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  it("selects the right section for each non-homes type", () => {
    expect(one({ propertyTypes: ["garaje"] }).url).toContain("/venta-garajes/");
    expect(one({ propertyTypes: ["terreno"] }).url).toContain("/venta-terrenos/");
    expect(one({ propertyTypes: ["local"] }).url).toContain("/venta-locales/");
    expect(one({ propertyTypes: ["edificio"] }).url).toContain("/venta-edificios/");
  });

  it("falls back to a province-level slug (+ flag) when no town is near", () => {
    // Ronda (inland málaga) is in-province but > 12 km from every known town.
    const task = one({ center: [36.7429, -5.1668], priceMax: 200000 });
    expect(task.url).toContain("/venta-viviendas/malaga-provincia/");
    expect(task.loosened.some((l) => l.constraint === "geography")).toBe(true);
  });

  it("falls back to a national search (+ flag) when no province matches", () => {
    // Madrid — outside both known provinces.
    const task = one({ center: [40.4168, -3.7038], priceMax: 200000 });
    expect(task.url).toBe("https://www.idealista.com/venta-viviendas/con-precio-hasta_200000/");
    expect(task.loosened.some((l) => l.constraint === "geography")).toBe(true);
  });
});
