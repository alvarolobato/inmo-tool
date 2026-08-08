/**
 * Unit tests for the idealista search-URL builder (issue #471 P2: drawn-polygon
 * `shape=` geography).
 *
 * Grammar (owner-confirmed specimen 2026-08-08):
 *   /areas/<operation>[/con-<f1>,<f2>,…]/mapa-google?shape=((<polyline>))
 * where the polyline is a Google Encoded Polyline (precision 5, lat,lng) of the
 * profile circle rendered as a 24-gon, wrapped + percent-encoded. Filters ride
 * in the PATH before /mapa-google. The circle→polyline encoder is pinned to the
 * real captured specimen in geo.test.ts; here we test the BUILDER's assembly.
 *
 * Idealista searches one operation section at a time → one task per section.
 */

import { describe, it, expect } from "vitest";
import { idealistaBuilder } from "@/lib/search-url/portals/idealista";
import { decodeShapeValue, polygonCentroid } from "@/lib/search-url/geo";
import type { CanonicalSearchScope } from "@/lib/search-url/types";

// Dos Hermanas — the town whose real drawn shape was captured in issue #471.
const DOS_HERMANAS: readonly [number, number] = [37.2836, -5.9222];
const ESTEPONA: readonly [number, number] = [36.4268, -5.1468];

const BASE: CanonicalSearchScope = {
  center: DOS_HERMANAS,
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

/** Decode the `shape` param of a built URL into its polygon ring. */
function ringOf(url: string): Array<[number, number]> {
  const m = /shape=(.+)$/.exec(url)!;
  return decodeShapeValue(m[1])!;
}

describe("idealistaBuilder — drawn-polygon geography (#471)", () => {
  it("pins the exact shape URL for a fixed Dos Hermanas piso ≤200k scope", () => {
    const task = one({ priceMax: 200000 });
    expect(task.portal).toBe("idealista");
    expect(task.url).toBe(
      "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_200000/mapa-google?shape=%28%28oyybFvtcc%40rHm%7BAl%5BcuAbl%40%7DhAzy%40ww%40ncAsb%40nhAcKnhAfKncAtb%40xy%40vw%40bl%40%7ChAj%5B%60uArHh%7BAsHh%7BAk%5B%60uAcl%40%7ChAyy%40vw%40ocAtb%40ohAfKohAcKocAsb%40%7By%40ww%40cl%40%7DhAm%5BcuAsHm%7BA%29%29",
    );
    // A faithful polygon rendering of the circle → NO geography loosened flag.
    expect(task.loosened).toEqual([]);
  });

  it("emits the /areas/<op>/…/mapa-google?shape=(( grammar", () => {
    const url = one({ priceMax: 200000 }).url;
    expect(url).toContain("idealista.com/areas/venta-viviendas/");
    expect(url).toContain("/mapa-google?shape=%28%28");
    expect(url).toContain("/con-precio-hasta_200000/mapa-google");
  });

  it("renders the circle as a closed 24-gon whose centroid is the profile centre", () => {
    const ring = ringOf(one({}).url);
    expect(ring).toHaveLength(25); // 24 vertices + closing repeat
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const [lat, lng] = polygonCentroid(ring);
    expect(lat).toBeCloseTo(DOS_HERMANAS[0], 3);
    expect(lng).toBeCloseTo(DOS_HERMANAS[1], 3);
  });

  it("no longer discards the radius: two radii around one centre → DIFFERENT URLs", () => {
    const r5 = one({ radiusKm: 5 }).url;
    const r30 = one({ radiusKm: 30 }).url;
    expect(r5).not.toBe(r30);
    // And the larger radius really is a larger polygon.
    const spanKm = (ring: Array<[number, number]>) => {
      const lats = ring.map((v) => v[0]);
      return Math.max(...lats) - Math.min(...lats);
    };
    expect(spanKm(ringOf(r30))).toBeGreaterThan(spanKm(ringOf(r5)));
  });

  it("appends the owner-confirmed 4-5+ rooms token, comma-joined after price, in the path", () => {
    const url = one({ priceMax: 200000, roomsMin: 4 }).url;
    expect(url).toContain(
      "/con-precio-hasta_200000,de-cuatro-cinco-habitaciones-o-mas/mapa-google",
    );
  });

  it("omits and flags a rooms minimum with no confirmed token (< 4)", () => {
    const task = one({ priceMax: 200000, roomsMin: 2 });
    expect(task.url).not.toContain("habitaciones");
    expect(task.loosened.some((l) => l.constraint === "rooms")).toBe(true);
  });

  it("emits a bare /areas/<op>/mapa-google (no con- segment) when there are no filters", () => {
    const url = one({}).url;
    expect(url).toContain("/areas/venta-viviendas/mapa-google?shape=");
    expect(url).not.toContain("/con-");
  });

  it("emits price-desde/hasta and metros tokens in the path, comma-joined", () => {
    const url = one({ priceMin: 100000, priceMax: 300000, sizeMin: 60, sizeMax: 120 }).url;
    expect(url).toContain(
      "/con-precio-desde_100000,precio-hasta_300000,metros-cuadrados-mas-de_60,metros-cuadrados-menos-de_120/mapa-google",
    );
  });

  it("rounds fractional bounds", () => {
    const url = one({ priceMax: 299999.6, sizeMin: 59.4 }).url;
    expect(url).toContain("precio-hasta_300000");
    expect(url).toContain("metros-cuadrados-mas-de_59");
  });

  it("gives each task a stable, geometry-keyed id (same geometry+filters → same id)", () => {
    const a = one({ priceMax: 200000 }).id;
    expect(a).toBe(one({ priceMax: 200000 }).id);
    expect(a).toMatch(/^idealista:venta-viviendas:[0-9a-f]{8}$/);
    // Rooms change the search → change the id.
    expect(one({ priceMax: 200000, roomsMin: 4 }).id).not.toBe(a);
    // Radius now participates in identity (it no longer collapses away).
    expect(one({ priceMax: 200000, radiusKm: 30 }).id).not.toBe(a);
  });

  it("splits a multi-section profile into one task per section, with distinct stable ids", () => {
    const tasks = build({ propertyTypes: ["piso", "atico", "garaje"], priceMax: 200000 });
    // piso + atico collapse into the single venta-viviendas section.
    expect(tasks).toHaveLength(2);
    expect(tasks[0].url).toContain("/areas/venta-viviendas/con-precio-hasta_200000/mapa-google?shape=");
    expect(tasks[1].url).toContain("/areas/venta-garajes/con-precio-hasta_200000/mapa-google?shape=");
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  it("selects the right section for each non-homes type", () => {
    expect(one({ propertyTypes: ["garaje"] }).url).toContain("/areas/venta-garajes/");
    expect(one({ propertyTypes: ["terreno"] }).url).toContain("/areas/venta-terrenos/");
    expect(one({ propertyTypes: ["local"] }).url).toContain("/areas/venta-locales/");
    expect(one({ propertyTypes: ["edificio"] }).url).toContain("/areas/venta-edificios/");
  });

  it("labels a shape task with the nearest municipio + radius (readable, not a polyline)", () => {
    expect(one({ priceMax: 200000 }).label).toBe(
      "Idealista — pisos ~Dos Hermanas (r=5 km) ≤200.000 €",
    );
    // A far centre with no known town falls back to a generic area name.
    expect(one({ center: [40.4168, -3.7038] }).label).toContain("~zona");
  });

  // issue #444: geography is now the profile's OWN circle, so no profile can
  // ever resolve to a neighbouring town — every centre pins its own polygon.
  it.each([
    ["Sevilla", [37.3891, -5.9845]],
    ["Dos Hermanas", DOS_HERMANAS],
    ["Estepona", ESTEPONA],
  ] as const)("centres the %s profile's polygon on its own coordinates, no geography flag", (_n, center) => {
    const task = one({ center: center as [number, number] });
    const [lat, lng] = polygonCentroid(ringOf(task.url));
    expect(lat).toBeCloseTo(center[0], 3);
    expect(lng).toBeCloseTo(center[1], 3);
    expect(task.loosened.some((l) => l.constraint === "geography")).toBe(false);
  });
});
