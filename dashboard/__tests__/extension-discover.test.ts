// @vitest-environment jsdom
/**
 * Unit tests for the browser-extension's pure URL-building discovery helpers
 * (issue #336). These import the REAL extension module
 * (browser-extension/discover.js) — not a copy — so the shipped enumeration
 * logic is what's under test. The DOM/timing/chrome wiring in content-script.js
 * (poll-until-ready, sendMessage) is not unit-testable in-process; this file
 * covers the pure core: portal detection, embedded-config extraction, live-form
 * option reading, and the full payload assembly.
 */

import { describe, it, expect } from "vitest";
import * as mod from "../../browser-extension/discover.js";
import * as detectMod from "../../browser-extension/detect.js";
import { withDiscoverSignal, DISCOVER_SIGNAL } from "@/lib/extension-discover";

const D = (mod as unknown as { default?: Record<string, unknown> }).default ?? mod;
const {
  discoverPortalForUrl,
  normalizeOption,
  extractEmbeddedOptions,
  extractFormOptions,
  buildDiscoveryAxes,
  buildDiscoveryPayload,
} = D as {
  discoverPortalForUrl: (u: string) => string | null;
  normalizeOption: (raw: unknown) => Record<string, unknown> | null;
  extractEmbeddedOptions: (scriptText: string) => Array<Record<string, unknown>>;
  extractFormOptions: (doc: Document) => Array<Record<string, unknown>>;
  buildDiscoveryAxes: (
    portal: string,
    doc: Document,
  ) => { source: string; axes: Record<string, unknown[]> } | null;
  buildDiscoveryPayload: (
    pageUrl: string,
    doc: Document,
    now?: Date,
  ) => Record<string, unknown> | null;
};

/** Build a jsdom document from an HTML body string. */
function docFrom(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

describe("discoverPortalForUrl", () => {
  it("maps known portal hosts (incl. www / subdomains) and rejects others", () => {
    expect(discoverPortalForUrl("https://www.alisedainmobiliaria.com/comprar-viviendas")).toBe("aliseda");
    expect(discoverPortalForUrl("https://alisedainmobiliaria.com/x")).toBe("aliseda");
    expect(discoverPortalForUrl("https://www.idealista.com/venta-viviendas/")).toBe("idealista");
    expect(discoverPortalForUrl("https://example.com/")).toBeNull();
    expect(discoverPortalForUrl("not a url")).toBeNull();
  });
});

describe("normalizeOption", () => {
  it("reads label + explicit fragment + subtipo/category, tolerating field aliases", () => {
    expect(
      normalizeOption({ nombre: "Piso", href: "https://x/comprar-viviendas/pisos", subtipo: 36, categoria: "comprar-viviendas" }),
    ).toEqual({
      label: "Piso",
      urlFragment: "/comprar-viviendas/pisos",
      category: "comprar-viviendas",
      subtipo: 36,
    });
  });

  it("builds a fragment from a bare slug when no explicit URL is present", () => {
    expect(normalizeOption({ label: "Chalet", slug: "chalets" })).toMatchObject({
      label: "Chalet",
      urlFragment: "/comprar-viviendas/chalets",
    });
  });

  it("coerces a numeric-string subtipo and captures portalValue", () => {
    expect(normalizeOption({ label: "Piso", slug: "pisos", value: "36", subtipo: "36" })).toMatchObject({
      portalValue: "36",
      subtipo: 36,
    });
  });

  it("returns null without a usable label or fragment", () => {
    expect(normalizeOption({ slug: "pisos" })).toBeNull(); // no label
    expect(normalizeOption({ label: "Piso" })).toBeNull(); // no fragment/slug
    expect(normalizeOption(null)).toBeNull();
  });
});

describe("extractEmbeddedOptions", () => {
  it("extracts the largest option array from a JSON blob", () => {
    const json = JSON.stringify({
      filters: {
        propertyTypes: [
          { label: "Piso", slug: "pisos", subtipo: 36 },
          { label: "Chalet adosado", slug: "chalets-adosados", subtipo: 31 },
        ],
        misc: [{ id: 1 }], // not option-like (no label+link) → ignored
      },
    });
    const opts = extractEmbeddedOptions(json);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toMatchObject({ label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 });
  });

  it("pulls a JSON literal out of a JS assignment (not pure JSON)", () => {
    const script = `window.__CFG = {"types":[{"label":"Ático","slug":"aticos","subtipo":40}]}; init();`;
    const opts = extractEmbeddedOptions(script);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ label: "Ático", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 });
  });

  it("returns [] when a script has no option-like JSON", () => {
    expect(extractEmbeddedOptions("console.log('hi')")).toEqual([]);
    expect(extractEmbeddedOptions("")).toEqual([]);
  });
});

describe("extractFormOptions", () => {
  it("reads <select> options, skipping placeholders, deriving fragment + numeric subtipo", () => {
    const doc = docFrom(`
      <form>
        <select name="tipoInmueble">
          <option value="">Todos</option>
          <option value="36">Piso</option>
          <option value="31" data-url="/comprar-viviendas/chalets-adosados">Chalet adosado</option>
        </select>
      </form>
    `);
    const opts = extractFormOptions(doc);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toMatchObject({ label: "Piso", portalValue: "36", subtipo: 36 });
    expect(opts[1]).toMatchObject({ label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados" });
  });
});

describe("buildDiscoveryAxes / buildDiscoveryPayload", () => {
  it("prefers embedded config over the form (least brittle) for Aliseda", () => {
    const doc = docFrom(`
      <script type="application/json">{"t":[{"label":"Piso","slug":"pisos","subtipo":36}]}</script>
      <form><select name="tipo"><option value="99">Otro</option></select></form>
    `);
    const built = buildDiscoveryAxes("aliseda", doc);
    expect(built?.source).toBe("embedded-config");
    expect(built?.axes.property_type).toHaveLength(1);
  });

  it("falls back to the form when no embedded config is present", () => {
    const doc = docFrom(`<form><select name="tipo"><option value="36">Piso</option></select></form>`);
    const built = buildDiscoveryAxes("aliseda", doc);
    expect(built?.source).toBe("form-options");
  });

  it("returns null for a non-wired portal", () => {
    const doc = docFrom(`<form><select name="tipo"><option value="1">X</option></select></form>`);
    expect(buildDiscoveryAxes("idealista", doc)).toBeNull();
  });

  it("assembles the full POST payload with a deterministic capturedAt", () => {
    const doc = docFrom(`<script type="application/json">{"t":[{"label":"Piso","slug":"pisos","subtipo":36}]}</script>`);
    const now = new Date("2026-08-05T10:00:00.000Z");
    const payload = buildDiscoveryPayload("https://www.alisedainmobiliaria.com/comprar-viviendas#inmo-discover", doc, now);
    expect(payload).toMatchObject({
      pageUrl: "https://www.alisedainmobiliaria.com/comprar-viviendas#inmo-discover",
      source: "embedded-config",
      capturedAt: "2026-08-05T10:00:00.000Z",
    });
    expect((payload as { axes: { property_type: unknown[] } }).axes.property_type).toHaveLength(1);
  });

  it("returns null when the page yields no options", () => {
    const doc = docFrom(`<div>nada</div>`);
    expect(buildDiscoveryPayload("https://www.alisedainmobiliaria.com/comprar-viviendas", doc, new Date())).toBeNull();
  });
});

describe("discover signal contract (dashboard opener ↔ extension reader)", () => {
  const Detect = (detectMod as unknown as { default?: Record<string, unknown> }).default ?? detectMod;
  const { discoverSignalPresent, DISCOVER_SIGNAL: EXT_SIGNAL } = Detect as {
    discoverSignalPresent: (u: string) => boolean;
    DISCOVER_SIGNAL: string;
  };

  it("the two sides agree on the signal token", () => {
    expect(EXT_SIGNAL).toBe(DISCOVER_SIGNAL);
    expect(DISCOVER_SIGNAL).toBe("inmo-discover");
  });

  it("a URL tagged by the dashboard is recognized by the extension (fragment form)", () => {
    const tagged = withDiscoverSignal("https://www.alisedainmobiliaria.com/comprar-viviendas");
    expect(tagged).toBe("https://www.alisedainmobiliaria.com/comprar-viviendas#inmo-discover");
    expect(discoverSignalPresent(tagged)).toBe(true);
  });

  it("falls back to the query form when a fragment already exists, still recognized", () => {
    const tagged = withDiscoverSignal("https://www.alisedainmobiliaria.com/comprar-viviendas#seccion");
    expect(tagged).toContain("inmo-discover=1");
    expect(discoverSignalPresent(tagged)).toBe(true);
  });

  it("an untagged URL is not recognized", () => {
    expect(discoverSignalPresent("https://www.alisedainmobiliaria.com/comprar-viviendas")).toBe(false);
  });
});
