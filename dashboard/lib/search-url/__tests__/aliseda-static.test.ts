/**
 * Unit tests for the Aliseda STATIC-ASSET filter extractor (issue #377, D-093).
 *
 * The parse + assembly functions are pure — they run against CAPTURED FIXTURES
 * (the real category sitemap + a slice of the real app bundle), never live
 * network — and feed the same deterministic `computePortalDrift` diff the
 * /etl/discovery page uses. These assert:
 *   - the sitemap → the live top-level `comprar-<category>` set,
 *   - the bundle → exactly the 7 `comprar-viviendas` residential subtypes
 *     (NOT the non-residential subtype aliases that follow them),
 *   - the assembled catalog matches the code mapping (NO drift day-one),
 *   - a genuinely NEW subtype (`aticos`) → drift ADDED,
 *   - a builder category that vanished from the sitemap → drift REMOVED.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCategorySitemap,
  parseVivendaSubtypes,
  buildAlisedaStaticCatalog,
  labelFromSlug,
  appBundleUrlFromShell,
} from "../aliseda-static";
import { computePortalDrift } from "../drift";
import { alisedaBuilder } from "../portals/aliseda";

const FIXTURES = join(__dirname, "fixtures");
const SITEMAP = readFileSync(join(FIXTURES, "aliseda-category-sitemap.xml"), "utf8");
const BUNDLE = readFileSync(join(FIXTURES, "aliseda-main-bundle-slice.js"), "utf8");

const CODE_MAPPING = alisedaBuilder.codeMapping();

describe("parseCategorySitemap", () => {
  it("extracts the distinct top-level comprar-<category> slugs", () => {
    const cats = parseCategorySitemap(SITEMAP);
    expect(cats).toEqual(
      new Set([
        "comprar-viviendas",
        "comprar-locales",
        "comprar-naves",
        "comprar-garajes",
        "comprar-terrenos",
        "comprar-edificios",
        "comprar-oficinas",
        "comprar-trasteros",
        "comprar-obras-paradas",
        "comprar-negocios",
        "comprar-otros",
      ]),
    );
  });
});

describe("parseVivendaSubtypes", () => {
  it("extracts exactly the 7 residential subtypes, stopping before non-residential aliases", () => {
    const subs = parseVivendaSubtypes(BUNDLE);
    expect(subs).toEqual(
      new Set([
        "pisos",
        "duplex",
        "pisos-turisticos",
        "lofts",
        "casas",
        "chalets-adosados",
        "chalets-pareados",
      ]),
    );
    // The non-residential subtype aliases that follow `chalets-pareados` in the
    // bundle must NOT leak in (they'd be false ADDED drift).
    expect(subs.has("garajes")).toBe(false);
    expect(subs.has("naves-industriales")).toBe(false);
    expect(subs.has("almacenes")).toBe(false);
  });

  it("picks up a genuinely new subtype inserted into the residential run", () => {
    const drifted = BUNDLE.replace(
      '"chalets-pareados":"chalets-pareados",garajes',
      '"chalets-pareados":"chalets-pareados",aticos:"aticos",garajes',
    );
    const subs = parseVivendaSubtypes(drifted);
    expect(subs.has("aticos")).toBe(true);
  });

  it("returns empty when the residential anchor is absent (fails safe)", () => {
    expect(parseVivendaSubtypes("var x = 1;").size).toBe(0);
  });
});

describe("buildAlisedaStaticCatalog + drift", () => {
  const categorySlugs = parseCategorySitemap(SITEMAP);
  const vivendaSubtypeSlugs = parseVivendaSubtypes(BUNDLE);

  it("emits exactly the code's mapped slugs from the current live assets", () => {
    const axes = buildAlisedaStaticCatalog({ categorySlugs, vivendaSubtypeSlugs });
    const slugs = (axes.property_type ?? [])
      .map((o) => o.urlFragment.split("/").filter(Boolean).pop())
      .sort();
    expect(slugs).toEqual(
      [
        "pisos",
        "chalets-adosados",
        "comprar-locales",
        "comprar-naves",
        "comprar-garajes",
        "comprar-terrenos",
        "comprar-edificios",
      ].sort(),
    );
    // Residential slugs carry the verified subtipo codes so the diff sees no
    // false CHANGED.
    const pisos = axes.property_type?.find((o) => o.urlFragment.endsWith("/pisos"));
    expect(pisos?.subtipo).toBe(36);
    const adosados = axes.property_type?.find((o) => o.urlFragment.endsWith("/chalets-adosados"));
    expect(adosados?.subtipo).toBe(31);
  });

  it("reports NO drift when the live assets match the code (day-one green)", () => {
    const axes = buildAlisedaStaticCatalog({ categorySlugs, vivendaSubtypeSlugs });
    const report = computePortalDrift("aliseda", axes, CODE_MAPPING);
    expect(report.hasCatalog).toBe(true);
    expect(report.hasDrift).toBe(false);
  });

  it("flags ADDED when a new residential subtype (aticos) appears", () => {
    const withAtico = new Set([...vivendaSubtypeSlugs, "aticos"]);
    const axes = buildAlisedaStaticCatalog({ categorySlugs, vivendaSubtypeSlugs: withAtico });
    const report = computePortalDrift("aliseda", axes, CODE_MAPPING);
    expect(report.hasDrift).toBe(true);
    const added = report.axes.flatMap((a) => a.added.map((it) => it.slug));
    expect(added).toContain("aticos");
  });

  it("flags REMOVED when a builder category disappears from the sitemap", () => {
    const withoutLocales = new Set([...categorySlugs].filter((c) => c !== "comprar-locales"));
    const axes = buildAlisedaStaticCatalog({
      categorySlugs: withoutLocales,
      vivendaSubtypeSlugs,
    });
    const report = computePortalDrift("aliseda", axes, CODE_MAPPING);
    expect(report.hasDrift).toBe(true);
    const removed = report.axes.flatMap((a) => a.removed.map((it) => it.slug));
    expect(removed).toContain("comprar-locales");
  });

  it("does NOT flag known-but-unbuilt categories/subtypes as ADDED (no noise)", () => {
    const axes = buildAlisedaStaticCatalog({ categorySlugs, vivendaSubtypeSlugs });
    const report = computePortalDrift("aliseda", axes, CODE_MAPPING);
    const added = report.axes.flatMap((a) => a.added.map((it) => it.slug));
    // duplex/casas/comprar-oficinas are known to the code but deliberately
    // unbuilt — they must not permanently light the flag.
    expect(added).not.toContain("duplex");
    expect(added).not.toContain("casas");
    expect(added).not.toContain("comprar-oficinas");
  });
});

describe("labelFromSlug", () => {
  it("humanises category and subtype slugs", () => {
    expect(labelFromSlug("comprar-locales")).toBe("Locales");
    expect(labelFromSlug("pisos")).toBe("Pisos");
    expect(labelFromSlug("chalets-adosados")).toBe("Chalets adosados");
  });
});

describe("appBundleUrlFromShell", () => {
  it("resolves the hashed main-*.js from the app shell HTML", () => {
    expect(
      appBundleUrlFromShell('<script src="main-A2D7CB5F.js" type="module"></script>'),
    ).toBe("https://www.alisedainmobiliaria.com/main-A2D7CB5F.js");
    expect(
      appBundleUrlFromShell('<script src="https://cdn.x/main-DEAD1234.js"></script>'),
    ).toBe("https://cdn.x/main-DEAD1234.js");
    expect(appBundleUrlFromShell("<html>no bundle here</html>")).toBeNull();
  });
});
