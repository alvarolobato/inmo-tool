// @vitest-environment node
/**
 * Unit tests for the connector-search-preview DB layer (issue #478 P4).
 *
 * Mocks `pg` (the Pool) so the reader exercises its real SQL shaping + defensive
 * JSONB parsing without a database — same pattern as profile-connector-filter.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import {
  getEtlConnectorPreviews,
  getConnectorOverrideHostSuffix,
} from "../connector-search-preview";
import { resetPool } from "@/lib/db-write";

beforeEach(async () => {
  mockQuery.mockReset();
  await resetPool();
});

describe("getEtlConnectorPreviews", () => {
  it("joins registry + previews, filters to discoverable registered connectors, parses JSONB", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          connector: "pisos",
          override_host_suffix: "pisos.com",
          supports_search_override: false,
          search_url_grammar: {
            build_template: "https://www.pisos.com/venta/pisos-{geography}/",
            parse_pattern: "^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$",
            params: { geography: { label: "Municipio", source: "profile" } },
          },
          previews: [
            {
              label: "Pisos.com — sevilla",
              url: "https://www.pisos.com/venta/pisos-sevilla/",
              kind: "search_page",
              tunable: true,
              notes: null,
              params: [
                { key: "geography", label: "Municipio", value: "sevilla", source: "profile", in_url: true, notes: null },
                { key: "operation", label: "Operación", value: "venta", source: "constant", in_url: true, notes: null },
              ],
            },
          ],
          computed_at: new Date("2026-08-08T10:00:00.000Z"),
        },
        {
          connector: "cimenta2",
          override_host_suffix: null,
          supports_search_override: false,
          search_url_grammar: null,
          previews: [
            { label: "Cimenta2 — barrido nacional", url: "https://inmuebles.cimenta2.com/inmuebles/s/sitemap.xml", kind: "sitemap", tunable: false, notes: "Barrido nacional" },
          ],
          computed_at: new Date("2026-08-08T10:00:00.000Z"),
        },
      ],
    });

    const out = await getEtlConnectorPreviews(7);
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("FROM connector_registry g");
    expect(text).toContain("LEFT JOIN connector_search_preview p");
    expect(text).toContain("g.registered = true");
    expect(text).toContain("g.supports_discovery = true");
    expect(text).toContain("g.search_url_grammar");
    expect(params).toEqual([7]);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ connector: "pisos", overrideHostSuffix: "pisos.com", supportsSearchOverride: false });
    expect(out[0].previews[0].kind).toBe("search_page");
    expect(out[0].computedAt).toBe("2026-08-08T10:00:00.000Z");
    // Issue #491: the grammar is camelCased and the params parsed.
    expect(out[0].searchUrlGrammar).toEqual({
      buildTemplate: "https://www.pisos.com/venta/pisos-{geography}/",
      parsePattern: "^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$",
      params: { geography: { label: "Municipio", source: "profile" } },
      // issue #493: parseGrammar always yields a rejectReasons array (empty when
      // the stored grammar declares none, as pisos does).
      rejectReasons: [],
    });
    expect(out[0].previews[0].params).toEqual([
      { key: "geography", label: "Municipio", value: "sevilla", source: "profile", inUrl: true, notes: null },
      { key: "operation", label: "Operación", value: "venta", source: "constant", inUrl: true, notes: null },
    ]);
    expect(out[1]).toMatchObject({ connector: "cimenta2", overrideHostSuffix: null });
    expect(out[1].searchUrlGrammar).toBeNull();
    expect(out[1].previews[0].tunable).toBe(false);
    // Old-shape preview with no params array → [].
    expect(out[1].previews[0].params).toEqual([]);
  });

  it("handles a connector with no computed preview yet (LEFT JOIN NULLs)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { connector: "diglo", override_host_suffix: "digloservicer.com", supports_search_override: false, previews: null, computed_at: null },
      ],
    });
    const out = await getEtlConnectorPreviews(7);
    expect(out[0].previews).toEqual([]);
    expect(out[0].computedAt).toBeNull();
  });

  it("coerces a bad stored kind to search_page and drops non-object entries", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          connector: "pisos",
          override_host_suffix: "pisos.com",
          supports_search_override: false,
          previews: [{ label: "x", url: "https://x", kind: "weird", tunable: true, notes: null }, 42, null],
          computed_at: null,
        },
      ],
    });
    const out = await getEtlConnectorPreviews(7);
    expect(out[0].previews).toHaveLength(1);
    expect(out[0].previews[0].kind).toBe("search_page");
  });

  it("returns [] (no error surface) when the table doesn't exist yet (42P01)", async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    expect(await getEtlConnectorPreviews(7)).toEqual([]);
  });

  it("rethrows non-undefined-table errors", async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "08006" }));
    await expect(getEtlConnectorPreviews(7)).rejects.toThrow("boom");
  });
});

describe("getConnectorOverrideHostSuffix", () => {
  it("returns the registry override_host_suffix for a registered connector", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ override_host_suffix: "fotocasa.es" }] });
    const out = await getConnectorOverrideHostSuffix("fotocasa");
    expect(out).toBe("fotocasa.es");
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain("FROM connector_registry");
    expect(text).toContain("registered = true");
    expect(params).toEqual(["fotocasa"]);
  });

  it("returns null for an unknown/unregistered connector", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getConnectorOverrideHostSuffix("nope")).toBeNull();
  });

  it("returns null when the connector declares no override host suffix", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ override_host_suffix: null }] });
    expect(await getConnectorOverrideHostSuffix("cimenta2")).toBeNull();
  });
});
