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

vi.mock("@/lib/db/profile-connector-filter", () => ({
  findOverridesForProfile: vi.fn(),
}));

import { resolveSearchTasks, AREA_MATCH_KM } from "@/lib/search-url/resolve";
import { toCaptureUrl } from "@/lib/search-url/capture-url";
import { idealistaBuilder, idealistaParser } from "@/lib/search-url/portals/idealista";
import { alisedaBuilder, alisedaParser } from "@/lib/search-url/portals/aliseda";
import { hipogesBuilder, hipogesParser } from "@/lib/search-url/portals/hipoges";
import type { SearchTask } from "@/lib/search-url/types";
import { decodeShapeValue, polygonCentroid } from "@/lib/search-url/geo";
import { haversineKm } from "@/lib/search-url/parse-shared";
import { fallbackTaskId } from "@/lib/captura-tasks";
import * as exampleDb from "@/lib/db/search-url-example";
import * as overrideDb from "@/lib/db/profile-connector-filter";
import type { SearchUrlExampleRow } from "@/lib/db/search-url-example";
import type { ProfileConnectorFilterRow } from "@/lib/db/profile-connector-filter";
import type { CanonicalSearchScope, PortalSearchUrlBuilder, PortalSearchUrlParser } from "@/lib/search-url/types";
import type { Scope } from "@/lib/profiles-schema";

const mockFind = vi.mocked(exampleDb.findExamplesForPortal);
const mockOverrides = vi.mocked(overrideDb.findOverridesForProfile);

/** Profile id passed to resolveSearchTasks; the override lookup is mocked. */
const PROFILE_ID = 1;

/** Build a profile_connector_filter row for tier-0 tests. */
function overrideRow(
  connector: string,
  url: string,
  sectionKey = "",
): ProfileConnectorFilterRow {
  return {
    id: 1,
    profile_id: PROFILE_ID,
    connector,
    section_key: sectionKey,
    url,
    source: "manual",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
}

const ESTEPONA: [number, number] = [36.4268, -5.1468];
const SEVILLA: [number, number] = [37.3891, -5.9845];
const DOS_HERMANAS: [number, number] = [37.2836, -5.9222]; // ~13 km from Sevilla

/** Decode the polygon centroid of an idealista shape-task URL. */
function shapeCentroid(url: string): [number, number] {
  const ring = decodeShapeValue(/shape=(.+)$/.exec(url)![1])!;
  return polygonCentroid(ring);
}

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

/**
 * The resolver derives each task's `captureUrl` from its FINAL url (issue #529),
 * so a builder-output snapshot must have captureUrl recomputed the same way
 * before comparing (the builder default is the map form; the resolver strips it).
 */
function withCaptureUrls(tasks: SearchTask[]): SearchTask[] {
  return tasks.map((t) => ({ ...t, captureUrl: toCaptureUrl(t.portal, t.url) }));
}

describe("resolveSearchTasks — capture-to-infer tiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no owner-pinned overrides (tier 0 inert) — tiers 1-3 unchanged.
    mockOverrides.mockResolvedValue([]);
  });

  it("#471: an idealista shape task ignores a matching learned example (geometry is code-pinned)", async () => {
    // Even an exact-section learned example must NOT alter the profile's own
    // polygon — the builder pins concrete geometry; only a tier-0 override wins.
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 1);
    withExamples({ idealista: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID);
    const t = idealistaTask(tasks);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    expect(t.url).toBe(base.url); // the builder's own shape, unchanged
    expect(t.loosened.find((l) => l.reason.includes("reutilizada"))).toBeUndefined();
  });

  it("#444/#471: a Sevilla profile never opens a Dos Hermanas polygon", async () => {
    // The original bug: a single Dos Hermanas capture rewrote the Sevilla
    // profile's Idealista URL (the towns are ~13 km apart). With code-pinned
    // shape geometry that relocation is now structurally impossible.
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: DOS_HERMANAS,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 6);
    withExamples({ idealista: [ex] });

    const tasks = await resolveSearchTasks(scope(SEVILLA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID);
    const t = idealistaTask(tasks);
    const base = idealistaBuilder.build({ center: SEVILLA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    expect(t.url).toBe(base.url);
    // The polygon is centred on Sevilla, not on the learned Dos Hermanas example.
    const centroid = shapeCentroid(t.url);
    expect(haversineKm(centroid, SEVILLA)).toBeLessThan(1);
    expect(haversineKm(centroid, DOS_HERMANAS)).toBeGreaterThan(5);
    expect(t.loosened.find((l) => l.reason.includes("reutilizada"))).toBeUndefined();
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
    const tasks = await resolveSearchTasks(s, PROFILE_ID);
    const t = idealistaTask(tasks);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    expect(t.url).toBe(base.url);
  });

  it("tier 3: no learned examples → every task is the builder's output", async () => {
    withExamples({});
    const s = scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>);
    const tasks = await resolveSearchTasks(s, PROFILE_ID);
    const canonical: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 };
    expect(tasks).toEqual(
      withCaptureUrls([
        ...idealistaBuilder.build(canonical),
        ...alisedaBuilder.build(canonical),
        ...hipogesBuilder.build(canonical),
      ]),
    );
  });

  it("tier 1 works for aliseda too (exact section + province slug)", async () => {
    const ex = exampleRow(alisedaBuilder, alisedaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 4);
    withExamples({ aliseda: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 175000 } as Partial<Scope>), PROFILE_ID);
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
    const t = idealistaTask(await resolveSearchTasks(s, PROFILE_ID));
    expect(t.id).toBe(base.id);
    expect(t.label).toBe(base.label);
  });

  it("AREA_MATCH_KM is a coarse, non-trivial radius", () => {
    expect(AREA_MATCH_KM).toBeGreaterThan(0);
  });

  it("#529: sets captureUrl to the LISTING form for the idealista map task, = url for aliseda", async () => {
    withExamples({});
    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID);

    const ideal = idealistaTask(tasks);
    // url stays the canonical map form (display + pin, D-101)…
    expect(ideal.url).toContain("/mapa-google?shape=");
    // …captureUrl strips /mapa-google (the harvestable listing form)…
    expect(ideal.captureUrl).not.toContain("/mapa-google");
    // …with the shape= query byte-identical between the two.
    expect(new URL(ideal.captureUrl).search).toBe(new URL(ideal.url).search);

    // Aliseda has no map view → captureUrl is identical to url (identity).
    const aliseda = tasks.find((t) => t.portal === "aliseda")!;
    expect(aliseda.captureUrl).toBe(aliseda.url);
  });
});

/**
 * Issue #561 review, B2: the first version's `hipogesParser` whitelisted
 * `sale|rent` operations and a fixed (wrong) typology set, so a REALISTIC
 * captured URL decoded to `null` and D-051 never actually learned anything —
 * this whole describe block would have been red under that version, and its
 * absence in the original PR is exactly why the bug shipped unnoticed.
 * `manualExample` builds a `SearchUrlExampleRow` from a HAND-WRITTEN URL
 * string (never derived from `hipogesBuilder`'s own guess), the way a real
 * owner capture would arrive.
 */
describe("resolveSearchTasks — Hipoges tiers with a REALISTIC captured URL (issue #561 review, B2)", () => {
  const MANILVA: [number, number] = [36.3766, -5.2493]; // ~10 km from Estepona

  function manualExample(url: string, id: number): SearchUrlExampleRow {
    const parsed = hipogesParser.parse(url)!;
    if (!parsed) throw new Error(`test fixture URL did not parse: ${url}`);
    return {
      id,
      portal: "hipoges",
      url,
      match_key: `hipoges-k${id}`,
      filters: parsed.filters,
      category_key: parsed.categoryKey,
      template: parsed.template,
      created_at: "2026-08-19T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOverrides.mockResolvedValue([]);
  });

  it("tier 1: a real capture at the SAME (guessed) town upgrades the task and drops the guessed-grammar flag", async () => {
    const ex = manualExample(
      "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga",
      101,
    );
    withExamples({ hipoges: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { property_types: ["piso"] } as Partial<Scope>), PROFILE_ID);
    const t = tasks.find((x) => x.portal === "hipoges")!;
    expect(t.url).toBe("https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/estepona_malaga");
    // Confirmed by a real capture now — the operation-token "grammar" flag
    // (the ONLY thing this builder ever guesses, issue #561 review) is gone.
    expect(t.loosened.find((l) => l.constraint === "grammar")).toBeUndefined();
  });

  it("tier 2: a real capture at a DIFFERENT nearby town still upgrades the task — the #444 municipio gate does NOT apply to Hipoges", async () => {
    // Captured at Manilva; the profile is centred on Estepona (a DIFFERENT,
    // but known, municipio — municipioForPoint(ESTEPONA) resolves). For
    // idealista this would skip tier 2 entirely (#444: a code-driven slug is
    // authoritative). Hipoges' own town is an admitted guess, never
    // authoritative, so tier 2 must still fire here.
    const ex = manualExample(
      "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/manilva_malaga",
      102,
    );
    withExamples({ hipoges: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { property_types: ["piso"] } as Partial<Scope>), PROFILE_ID);
    const t = tasks.find((x) => x.portal === "hipoges")!;
    expect(t.url).toBe("https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/manilva_malaga");
    expect(t.loosened.some((l) => l.reason.includes("reutilizada"))).toBe(true);
    // The guessed-grammar flag is superseded by the tier-2 reuse flag — the
    // task is no longer running on this builder's own unconfirmed town guess.
    expect(t.loosened.find((l) => l.constraint === "grammar")).toBeUndefined();
  });

  it("tier 3: a DIFFERENT-section real capture never applies", async () => {
    const ex = manualExample(
      "https://realestate.hipoges.com/es/venta/garajes/espana/estepona_malaga",
      103,
    );
    withExamples({ hipoges: [ex] });

    const tasks = await resolveSearchTasks(scope(ESTEPONA, { property_types: ["piso"] } as Partial<Scope>), PROFILE_ID);
    const t = tasks.find((x) => x.portal === "hipoges")!;
    const base = hipogesBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"] })[0];
    expect(t.url).toBe(base.url);
  });
});

describe("resolveSearchTasks — tier 0 owner-pinned overrides (issue #478)", () => {
  const PINNED = "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc%29%29";

  beforeEach(() => {
    vi.clearAllMocks();
    mockOverrides.mockResolvedValue([]);
  });

  it("override beats tier 1 (a matching learned example) — url verbatim, loosened [], overridden", async () => {
    const ex = exampleRow(idealistaBuilder, idealistaParser, {
      center: ESTEPONA,
      radiusKm: 8,
      propertyTypes: ["piso"],
      priceMax: 200000,
    }, 1);
    withExamples({ idealista: [ex] });
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED)]);

    const t = idealistaTask(
      await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID),
    );
    expect(t.url).toBe(PINNED); // verbatim — no numeric re-substitution
    expect(t.loosened).toEqual([]);
    expect(t.overridden).toBe(true);
  });

  it("override beats tier 3 (no learned examples at all)", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED)]);
    const t = idealistaTask(
      await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID),
    );
    expect(t.url).toBe(PINNED);
    expect(t.overridden).toBe(true);
  });

  it("preserves the task id + label (capture_task_run staleness intact)", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED)]);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    const t = idealistaTask(
      await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID),
    );
    expect(t.id).toBe(base.id);
    expect(t.label).toBe(base.label);
  });

  it("a section_key override matches the task's categoryKey exactly", async () => {
    withExamples({});
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    const categoryKey = idealistaParser.parse(base.url)!.categoryKey;
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED, categoryKey)]);
    const t = idealistaTask(
      await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID),
    );
    expect(t.url).toBe(PINNED);
    expect(t.overridden).toBe(true);
  });

  it("a section_key override for a DIFFERENT section does not apply (derived URL stands)", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED, "some-other-section")]);
    const base = idealistaBuilder.build({ center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 })[0];
    const t = idealistaTask(
      await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID),
    );
    expect(t.url).toBe(base.url);
    expect(t.overridden).toBeUndefined();
  });

  it("altamira (a capture portal with no builder) synthesizes a task from an override", async () => {
    withExamples({});
    const altUrl = "https://www.altamirainmuebles.com/venta/viviendas/sevilla/";
    mockOverrides.mockResolvedValue([overrideRow("altamira", altUrl)]);
    const tasks = await resolveSearchTasks(scope(SEVILLA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID);
    const t = tasks.find((x) => x.portal === "altamira");
    expect(t).toBeDefined();
    expect(t!.url).toBe(altUrl);
    expect(t!.label).toBe("Altamira — URL fijada");
    expect(t!.id).toBe(fallbackTaskId("altamira", altUrl));
    expect(t!.overridden).toBe(true);
  });

  // Issue #659/D-147: an "everywhere" profile has no builder-derivable
  // scope, but an owner-pinned override for a portal WITH a builder (not
  // just no-builder altamira) is still a valid recall source on its own —
  // same posture as _override_scopes_for_connector on the ETL side.
  it("an everywhere profile still resolves an owner override for a portal that HAS a builder", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([overrideRow("idealista", PINNED)]);
    const everywhereScope: Scope = {
      geography: { type: "everywhere" },
      property_types: "all",
      hard_exclusions: {},
    };
    const tasks = await resolveSearchTasks(everywhereScope, PROFILE_ID);
    const t = tasks.find((x) => x.portal === "idealista");
    expect(t).toBeDefined();
    expect(t!.url).toBe(PINNED);
    expect(t!.overridden).toBe(true);
  });

  it("an everywhere profile with no override derives NO tasks for a builder-backed portal", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([]);
    const everywhereScope: Scope = {
      geography: { type: "everywhere" },
      property_types: "all",
      hard_exclusions: {},
    };
    const tasks = await resolveSearchTasks(everywhereScope, PROFILE_ID);
    expect(tasks.filter((t) => t.portal === "idealista")).toHaveLength(0);
  });

  it("with no override, output is identical to today (snapshot)", async () => {
    withExamples({});
    mockOverrides.mockResolvedValue([]);
    const canonical: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 };
    const tasks = await resolveSearchTasks(scope(ESTEPONA, { price_max: 180000 } as Partial<Scope>), PROFILE_ID);
    expect(tasks).toEqual(
      withCaptureUrls([
        ...idealistaBuilder.build(canonical),
        ...alisedaBuilder.build(canonical),
        ...hipogesBuilder.build(canonical),
      ]),
    );
  });
});

/**
 * Issue #660: a profile's `scope.connectors` selection narrows its captura
 * tasks — the same single enforcement point (`resolveSearchTasks`'s
 * CAPTURE_PORTALS loop) serves both /captura and the search-urls API route,
 * so nothing else needs its own filter. The decorative trap the issue warns
 * about: a fixture that selects EVERY portal never actually exercises the
 * exclusion — every case below selects only ONE portal while learned
 * examples/overrides exist for others too, and asserts those others are
 * ABSENT, not merely that the selected one is present.
 */
describe("resolveSearchTasks — connector selection (issue #660)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOverrides.mockResolvedValue([]);
    withExamples({});
  });

  it("a profile restricted to one connector gets tasks for ONLY that connector", async () => {
    const tasks = await resolveSearchTasks(
      scope(ESTEPONA, { price_max: 180000, connectors: ["idealista"] } as Partial<Scope>),
      PROFILE_ID,
    );
    const portals = new Set(tasks.map((t) => t.portal));
    expect(portals).toEqual(new Set(["idealista"]));
    expect(tasks.length).toBeGreaterThan(0);
  });

  it("a profile restricted to one connector gets NO owner-pinned override task for an excluded connector", async () => {
    // An override for aliseda exists, but the profile only selected idealista
    // — the override must not resurrect an excluded portal's task.
    mockOverrides.mockResolvedValue([overrideRow("aliseda", "https://alisedainmobiliaria.com/pinned")]);
    const tasks = await resolveSearchTasks(
      scope(ESTEPONA, { price_max: 180000, connectors: ["idealista"] } as Partial<Scope>),
      PROFILE_ID,
    );
    expect(tasks.some((t) => t.portal === "aliseda")).toBe(false);
  });

  it("the explicit 'all' sentinel behaves exactly like an absent connectors field (every portal present)", async () => {
    const canonical: CanonicalSearchScope = { center: ESTEPONA, radiusKm: 8, propertyTypes: ["piso"], priceMax: 180000 };
    const withAll = await resolveSearchTasks(
      scope(ESTEPONA, { price_max: 180000, connectors: "all" } as Partial<Scope>),
      PROFILE_ID,
    );
    expect(withAll).toEqual(
      withCaptureUrls([
        ...idealistaBuilder.build(canonical),
        ...alisedaBuilder.build(canonical),
        ...hipogesBuilder.build(canonical),
      ]),
    );
  });

  it("an empty selection intersection with a builder-less portal (altamira) yields nothing extra — no crash, no phantom task", async () => {
    // altamira has no BUILDERS entry at all; excluding every OTHER connector
    // must not somehow synthesize an altamira task out of nowhere.
    const tasks = await resolveSearchTasks(
      scope(ESTEPONA, { price_max: 180000, connectors: ["idealista"] } as Partial<Scope>),
      PROFILE_ID,
    );
    expect(tasks.some((t) => t.portal === "altamira")).toBe(false);
  });
});
