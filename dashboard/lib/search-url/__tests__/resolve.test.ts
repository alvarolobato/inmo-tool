// @vitest-environment node
/**
 * Unit tests for the capture-to-infer resolver (issue #293), reworked for the
 * #296 slug grammar + `SearchTask[]` shape. Mocks the DB read
 * (findExamplesForPortal) so no Postgres is needed — the resolver's job is the
 * per-task three-tier matching over whatever learned examples exist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/search-url-example", () => ({
  findExamplesForPortal: vi.fn(),
}));

import { resolveSearchTasks, AREA_MATCH_KM } from "@/lib/search-url/resolve";
import { idealistaBuilder, idealistaParser } from "@/lib/search-url/portals/idealista";
import { alisedaBuilder, alisedaParser } from "@/lib/search-url/portals/aliseda";
import * as exampleDb from "@/lib/db/search-url-example";
import type { SearchUrlExampleRow } from "@/lib/db/search-url-example";
import type { CanonicalSearchScope, PortalSearchUrlBuilder, PortalSearchUrlParser } from "@/lib/search-url/types";
import type { Scope } from "@/lib/profiles-schema";

const mockFind = vi.mocked(exampleDb.findExamplesForPortal);

const ESTEPONA: [number, number] = [36.4268, -5.1468];
const MANILVA: [number, number] = [36.3766, -5.2493]; // ~10 km from Estepona
const MADRID: [number, number] = [40.4168, -3.7038];

/** Craft a learned example row from a single-section scope via build + parse. */
function exampleRow(
  builder: PortalSearchUrlBuilder,
  parser: PortalSearchUrlParser,
  scope: CanonicalSearchScope,
  id: number,
): SearchUrlExampleRow {
  const url = builder.build(scope)[0].url;
  const parsed = parser.parse(url)!;
  return {
    id,
    portal: builder.portal,
    url,
    match_key: `k${id}`,
    filters: parsed.filters,
    category_key: parsed.categoryKey,
    template: parsed.template,
    created_at: "2026-08-05T00:00:00.000Z",
  };
}

function scope(center: [number, number], extra: Partial<Scope> = {}): Scope {
  return {
    geography: { type: "radius", center, radius_km: 8 },
    property_types: ["piso"],
    hard_exclusions: {},
    ...extra,
  } as Scope;
}

/** Route findExamplesForPortal to per-portal fixtures. */
function withExamples(byPortal: Record<string, SearchUrlExampleRow[]>) {
  mockFind.mockImplementation(async (portal: string) => byPortal[portal] ?? []);
}

function idealistaTask(tasks: Awaited<ReturnType<typeof resolveSearchTasks>>) {
  return tasks.find((t) => t.portal === "idealista")!;
}

describe("resolveSearchTasks — capture-to-infer tiers (slug grammar)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tier 1: exact section + exact location slug → substitute profile values, NO reuse flag", async () => {
    // Learned: Estepona piso at 200k. Profile: Estepona piso at 180k.
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 1);
    withExamples({ idealista: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>));
    const t = idealistaTask(tasks);
    // Confirmed template used + the PROFILE's price substituted in.
    expect(t.url).toBe("https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_180000/");
    expect(t.loosened.find((l) => l.reason.includes("reutilizada"))).toBeUndefined();
  });

  it("tier 2: same section, different (nearby) location slug → reuse WITH loosened flag", async () => {
    // Learned: piso in MANILVA (manilva-malaga). Profile: piso in ESTEPONA (~10 km).
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: MANILVA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 150000,
    }, 2);
    withExamples({ idealista: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>));
    const t = idealistaTask(tasks);
    // Reused the nearby example's slug (manilva-malaga), profile's price.
    expect(t.url).toBe("https://www.idealista.com/venta-viviendas/manilva-malaga/con-precio-hasta_180000/");
    const flag = t.loosened.find((l) => l.reason.includes("reutilizada"));
    expect(flag).toBeDefined();
    expect(flag!.constraint).toBe("geography");
  });

  it("tier 3: only a DIFFERENT-section example exists → hand-written task unchanged", async () => {
    // Learned: a garaje example. Profile: piso → different section, no match.
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["garaje"],
    }, 3);
    withExamples({ idealista: [ex] });

    const s = scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>);
    const tasks = await resolveSearchTasks(s);
    const t = idealistaTask(tasks);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    expect(t.url).toBe(base.url);
  });

  it("tier 3: no learned examples → every task is the builder's output", async () => {
    withExamples({});
    const s = scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>);
    const tasks = await resolveSearchTasks(s);
    const canonical: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 };
    expect(tasks).toEqual([...idealistaBuilder.build(canonical), ...alisedaBuilder.build(canonical)]);
  });

  it("tier 1 works for aliseda too (exact section + province slug)", async () => {
    const ex = exampleRow(alisedaBuilder, alisedaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 4);
    withExamples({ aliseda: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 175000 } as Partial<Scope>));
    const t = tasks.find((x) => x.portal === "aliseda")!;
    expect(t.url).toBe(
      "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?subtipo=36&precio=0-175000",
    );
    expect(t.loosened.find((l) => l.reason.includes("reutilizada"))).toBeUndefined();
  });

  it("preserves the deterministic task id + label (only url/loosened change)", async () => {
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 5);
    withExamples({ idealista: [ex] });

    const s = scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    const t = idealistaTask(await resolveSearchTasks(s));
    expect(t.id).toBe(base.id);
    expect(t.label).toBe(base.label);
  });

  it("AREA_MATCH_KM is a coarse, non-trivial radius", () => {
    expect(AREA_MATCH_KM).toBeGreaterThan(0);
  });
});
