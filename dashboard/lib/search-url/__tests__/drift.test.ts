/**
 * Unit tests for deterministic filter-drift detection (issue #371, D-090): the
 * pure axis diff (added / removed / changed / no-drift) and the per-connector
 * report, plus the code mappings each URL-building portal exposes for the diff.
 */

import { describe, it, expect } from "vitest";
import {
  computeAxisDrift,
  computePortalDrift,
  driftCount,
  type CodeMappingOption,
} from "@/lib/search-url/drift";
import type { CatalogOption } from "@/lib/search-url/discovered-mapping";
import { alisedaBuilder } from "@/lib/search-url/portals/aliseda";
import { idealistaBuilder } from "@/lib/search-url/portals/idealista";
import { codeMappingForPortal } from "@/lib/search-url";

const codeAliseda: CodeMappingOption[] = [
  { slug: "pisos", label: "piso", code: 36, canonicalType: "piso" },
  { slug: "chalets-adosados", label: "chalet", code: 31, canonicalType: "chalet" },
  { slug: "comprar-locales", label: "local", canonicalType: "local" },
];

describe("computeAxisDrift", () => {
  it("no drift when the catalog matches the code mapping exactly", () => {
    const catalog: CatalogOption[] = [
      { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
      { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
      { label: "Local", urlFragment: "/comprar-locales" },
    ];
    const d = computeAxisDrift("property_type", catalog, codeAliseda);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("flags ADDED — a portal slug the code doesn't map (the real Aliseda ático case)", () => {
    const catalog: CatalogOption[] = [
      { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
      { label: "Ático", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 },
      { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
      { label: "Local", urlFragment: "/comprar-locales" },
    ];
    const d = computeAxisDrift("property_type", catalog, codeAliseda);
    expect(d.added).toEqual([{ slug: "aticos", portalLabel: "Ático", portalCode: 40 }]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("flags REMOVED — a code slug the portal no longer offers", () => {
    const catalog: CatalogOption[] = [
      { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
      { label: "Local", urlFragment: "/comprar-locales" },
    ];
    const d = computeAxisDrift("property_type", catalog, codeAliseda);
    expect(d.removed).toEqual([
      { slug: "chalets-adosados", codeLabel: "chalet", codeCode: 31 },
    ]);
    expect(d.added).toEqual([]);
  });

  it("flags CHANGED — a shared slug whose subtipo code differs", () => {
    const catalog: CatalogOption[] = [
      { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 99 }, // was 36
      { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
      { label: "Local", urlFragment: "/comprar-locales" },
    ];
    const d = computeAxisDrift("property_type", catalog, codeAliseda);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ slug: "pisos", portalCode: 99, codeCode: 36 });
    expect(d.changed[0].reason).toContain("36 → 99");
  });

  it("flags CHANGED — a shared slug whose portal label no longer resolves to the code's type", () => {
    const catalog: CatalogOption[] = [
      { label: "Trastero", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 }, // relabelled
      { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
      { label: "Local", urlFragment: "/comprar-locales" },
    ];
    const d = computeAxisDrift("property_type", catalog, codeAliseda);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ slug: "pisos" });
    expect(d.changed[0].reason).toContain("piso");
  });

  it("results are sorted by slug for a stable report", () => {
    const catalog: CatalogOption[] = [
      { label: "Zzz", urlFragment: "/comprar-viviendas/zzz" },
      { label: "Aaa", urlFragment: "/comprar-viviendas/aaa" },
    ];
    const d = computeAxisDrift("property_type", catalog, []);
    expect(d.added.map((a) => a.slug)).toEqual(["aaa", "zzz"]);
  });
});

describe("computePortalDrift", () => {
  it("reports hasCatalog:false and no drift when nothing was captured", () => {
    const report = computePortalDrift("aliseda", null, { property_type: codeAliseda });
    expect(report).toEqual({ connector: "aliseda", hasCatalog: false, hasDrift: false, axes: [] });
    expect(driftCount(report)).toBe(0);
  });

  it("reports hasDrift:true when any axis drifts", () => {
    const report = computePortalDrift(
      "aliseda",
      {
        property_type: [
          { label: "Ático", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 },
          { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
          { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
          { label: "Local", urlFragment: "/comprar-locales" },
        ],
      },
      { property_type: codeAliseda },
    );
    expect(report.hasDrift).toBe(true);
    expect(driftCount(report)).toBeGreaterThan(0);
  });

  it("reports hasDrift:false when the catalog matches the code mapping", () => {
    const report = computePortalDrift(
      "aliseda",
      {
        property_type: [
          { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
          { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
          { label: "Local", urlFragment: "/comprar-locales" },
        ],
      },
      { property_type: codeAliseda },
    );
    expect(report.hasDrift).toBe(false);
    expect(report.hasCatalog).toBe(true);
  });
});

describe("connectors expose a code mapping for the diff", () => {
  it("aliseda maps the residential subtypes + non-residential categories", () => {
    const cm = alisedaBuilder.codeMapping().property_type ?? [];
    const bySlug = new Map(cm.map((o) => [o.slug, o]));
    expect(bySlug.get("pisos")).toMatchObject({ code: 36, canonicalType: "piso" });
    expect(bySlug.get("chalets-adosados")).toMatchObject({ code: 31, canonicalType: "chalet" });
    // piso + atico both fold onto `pisos` → a single slug entry (first wins).
    expect(cm.filter((o) => o.slug === "pisos")).toHaveLength(1);
    expect(bySlug.has("comprar-locales")).toBe(true);
    expect(codeMappingForPortal("aliseda")).toEqual(alisedaBuilder.codeMapping());
  });

  it("idealista maps the venta-<section> operations (no subtipo)", () => {
    const cm = idealistaBuilder.codeMapping().property_type ?? [];
    const slugs = cm.map((o) => o.slug);
    expect(slugs).toContain("venta-viviendas");
    expect(slugs).toContain("venta-garajes");
    expect(cm.every((o) => o.code === undefined)).toBe(true);
    // A drifted idealista catalog still flags ADDED/REMOVED by section slug.
    const drift = computePortalDrift(
      "idealista",
      { property_type: [{ label: "Obra nueva", urlFragment: "/venta-obra-nueva" }] },
      idealistaBuilder.codeMapping(),
    );
    expect(drift.hasDrift).toBe(true);
  });

  it("codeMappingForPortal returns null for an unknown portal", () => {
    expect(codeMappingForPortal("nope")).toBeNull();
  });
});
