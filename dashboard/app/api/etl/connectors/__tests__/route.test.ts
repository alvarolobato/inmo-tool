import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      query = mockQuery;
      end = mockEnd;
    },
    // db-shared.ts (#155) registers the int8 type parser at module load —
    // the mock needs a minimal stand-in so that import doesn't throw.
    types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
  };
});

import { GET } from "../route";
import { PATCH } from "../[name]/route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/etl/connectors/fotocasa", {
    method: "PATCH",
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

function registryRow(overrides: Record<string, unknown> = {}) {
  return {
    connector_name: "fotocasa",
    registered: true,
    rate_limit_per_minute: 20,
    discovers_full_inventory: false,
    supports_discovery: true,
    supported_filters: ["rooms"],
    override_host_suffix: "fotocasa.es",
    supports_search_override: true,
    search_url_grammar: null,
    enabled: null,
    capture_enabled: null,
    geography_override: null,
    filters: null,
    has_config: false,
    // Issue #295 (D-050): freshness-cadence columns from the LEFT JOINs.
    freshness_interval_hours: null,
    last_fresh_at: null,
    cycle_started_at: null,
    cycle_target_scope_count: null,
    covered_scope_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  resetPool();
});

describe("GET /api/etl/connectors", () => {
  it("returns a connector with no config row as enabled and using defaults", async () => {
    mockQuery
      // registry LEFT JOIN config
      .mockResolvedValueOnce({ rows: [registryRow()] })
      // last runs
      .mockResolvedValueOnce({ rows: [] })
      // active profile scopes
      .mockResolvedValueOnce({ rows: [] });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectors).toHaveLength(1);
    const c = body.connectors[0];
    expect(c.name).toBe("fotocasa");
    expect(c.enabled).toBe(true);
    // Issue #263: no config row => capture enabled (column default TRUE).
    expect(c.capture_enabled).toBe(true);
    expect(c.usingDefaults).toBe(true);
    expect(c.geography_override).toBeNull();
    // No override and no active profiles -> nothing will be ingested.
    expect(c.scopeSource).toBe("none");
  });

  it("reports scopeSource=profiles and lists the profiles it derives from", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [registryRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            // search_profile.id (BIGSERIAL) arrives as a real JS number via
            // the driver-level int8 type parser (db-shared.ts, #155) — this
            // mock stands in for what `sql()` actually returns post-parser,
            // not the raw pre-#155 string.
            id: 7,
            name: "Madrid centro",
            scope: { geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 } },
          },
        ],
      });

    const body = await (await GET()).json();
    const c = body.connectors[0];
    expect(c.scopeSource).toBe("profiles");
    expect(c.derivedFrom).toEqual([
      { profile_id: 7, profile_name: "Madrid centro", center: [40.4168, -3.7038], radius_km: 5 },
    ]);
    // BIGSERIAL must not leak through a number-typed field as a string (the
    // recurring bigint-serialization bug class) — now guaranteed by the
    // driver-level parser rather than a per-site coercion.
    expect(typeof c.derivedFrom[0].profile_id).toBe("number");
  });

  it("an explicit override wins over active profiles", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          registryRow({
            enabled: true,
            has_config: true,
            geography_override: { center: [37.3891, -5.9845], radius_km: 12 },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Madrid",
            scope: { geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 } },
          },
        ],
      });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.scopeSource).toBe("override");
    expect(c.geography_override).toEqual({ center: [37.3891, -5.9845], radius_km: 12 });
    // derivedFrom is only meaningful when profiles actually drive the scope.
    expect(c.derivedFrom).toEqual([]);
  });

  it("a malformed stored override is reported as no override, matching ETL fallback", async () => {
    // etl/orchestrator.py's _scopes_for_connector falls back to the
    // profile-derived scope for a malformed override, so the UI must not
    // claim an override is in effect that the ETL will ignore.
    mockQuery
      .mockResolvedValueOnce({
        rows: [registryRow({ has_config: true, enabled: true, geography_override: "madrid" })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.geography_override).toBeNull();
    expect(c.scopeSource).toBe("none");
  });

  it("reads back a stored override whose numbers are strings, as the ETL does", async () => {
    // The ETL coerces center elements with float(), so {center: ["40.4",
    // "-3.7"]} is a genuinely live override there. Reading it back as "not
    // configured" would be the UI lying in the opposite direction from the
    // malformed case above (issue #100 review).
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          registryRow({
            has_config: true,
            enabled: true,
            geography_override: { center: ["37.3891", "-5.9845"], radius_km: 12 },
            filters: { rooms: "3" },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.geography_override).toEqual({ center: [37.3891, -5.9845], radius_km: 12 });
    expect(c.scopeSource).toBe("override");
    // int("3") === 3 in the ETL, so the filter really is applied.
    expect(c.filters).toEqual({ rooms: 3 });
  });

  it("ignores a profile whose geography isn't type=radius, as the ETL does", async () => {
    // _active_profile_scopes requires type === "radius"; without the same
    // check the UI listed a profile as a live ingestion source that the ETL
    // silently skipped (issue #100 review).
    mockQuery
      .mockResolvedValueOnce({ rows: [registryRow({ enabled: true, has_config: true })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Polígono dibujado",
            scope: { geography: { type: "polygon", center: [40.4, -3.7], radius_km: 5 } },
          },
        ],
      });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.derivedFrom).toEqual([]);
    expect(c.scopeSource).toBe("none");
  });

  it("a capture-only connector reports scopeSource=capture-only", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          registryRow({
            connector_name: "idealista",
            supports_discovery: false,
            supported_filters: [],
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, name: "Madrid", scope: { geography: { type: "radius", center: [40.4, -3.7], radius_km: 5 } } },
        ],
      });

    const c = (await (await GET()).json()).connectors[0];
    // Even with active profiles present, it never discovers.
    expect(c.scopeSource).toBe("capture-only");
  });

  it("resolves the effective freshness interval and derives cadence state (issue #295)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          // No override → effective interval is the 24h default; a cycle in
          // progress (started recently) → refreshing, with N/M counts.
          registryRow({
            has_config: true,
            enabled: true,
            freshness_interval_hours: null,
            cycle_started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
            cycle_target_scope_count: 4,
            covered_scope_count: 1,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.freshness.effectiveIntervalHours).toBe(24);
    expect(c.freshness.intervalHours).toBeNull();
    expect(c.freshness.kind).toBe("refreshing");
    expect(c.freshness.targetScopeCount).toBe(4);
    expect(c.freshness.coveredScopeCount).toBe(1);
  });

  it("reports 'fresh' with the override interval when set (issue #295)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          registryRow({
            has_config: true,
            enabled: true,
            freshness_interval_hours: 6,
            last_fresh_at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
            cycle_started_at: null,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const c = (await (await GET()).json()).connectors[0];
    expect(c.freshness.effectiveIntervalHours).toBe(6);
    expect(c.freshness.intervalHours).toBe(6);
    expect(c.freshness.kind).toBe("fresh");
  });

  it("returns 500 with an error body when the query fails", async () => {
    mockQuery.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("DB_QUERY");
  });
});

describe("PATCH /api/etl/connectors/:name", () => {
  it("persists an enabled toggle", async () => {
    mockQuery
      // registry lookup
      .mockResolvedValueOnce({
        rows: [{ connector_name: "fotocasa", registered: true, supports_discovery: true, supported_filters: ["rooms"] }],
      })
      // upsert
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ enabled: false }), {
      params: { name: "fotocasa" },
    });
    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[1];
    expect(upsert[0]).toContain("INSERT INTO connector_config");
    // [name, setEnabled, enabled, setGeography, geo, setFilters, filters]
    expect(upsert[1][0]).toBe("fotocasa");
    expect(upsert[1][1]).toBe(true);
    expect(upsert[1][2]).toBe(false);
    // Not supplied -> must not be written, so a toggle can't wipe an override.
    expect(upsert[1][3]).toBe(false);
    expect(upsert[1][5]).toBe(false);
  });

  it("persists a capture_enabled toggle without touching the crawl flag", async () => {
    // Issue #263: capture processing is independent of the crawl `enabled`
    // flag. Toggling capture must set capture_enabled and leave enabled alone.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ connector_name: "fotocasa", registered: true, supports_discovery: true, supported_filters: ["rooms"] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ capture_enabled: false }), {
      params: { name: "fotocasa" },
    });
    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[1];
    expect(upsert[0]).toContain("capture_enabled");
    // [name, setEnabled, enabled, setGeo, geo, setFilters, filters,
    //  setCaptureEnabled, captureEnabled]
    expect(upsert[1][1]).toBe(false); // enabled not supplied -> left alone
    expect(upsert[1][7]).toBe(true); // setCaptureEnabled
    expect(upsert[1][8]).toBe(false); // the new value
  });

  it("accepts a capture_enabled toggle on a capture-only connector", async () => {
    // The whole point of #263: a capture-only portal (Idealista) has the
    // crawl `enabled=false`, but must still be able to enable/disable capture
    // processing. The capture-only guard (which rejects geography/filters)
    // must NOT block this.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ connector_name: "idealista", registered: true, supports_discovery: false, supported_filters: [] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ capture_enabled: true }), {
      params: { name: "idealista" },
    });
    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[1];
    expect(upsert[1][7]).toBe(true); // setCaptureEnabled
    expect(upsert[1][8]).toBe(true); // the new value
  });

  it("accepts a freshness_interval_hours override on a capture-only connector (issue #295)", async () => {
    // Unlike geography_override/filters (rejected below for capture-only), the
    // freshness cadence is a valid knob for capture-only portals too — it's the
    // staleness window #289's manual-capture UI reads. The capture-only guard
    // must NOT block it.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ connector_name: "idealista", registered: true, supports_discovery: false, supported_filters: [] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ freshness_interval_hours: 72 }), {
      params: { name: "idealista" },
    });
    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[1];
    // Params: …, setFreshness($10)=index 9, freshnessVal($11)=index 10.
    expect(upsert[1][9]).toBe(true); // setFreshness supplied
    expect(upsert[1][10]).toBe(72); // the new value
  });

  it("clears a freshness override with an explicit null (issue #295)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ connector_name: "fotocasa", registered: true, supports_discovery: true, supported_filters: ["rooms"] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ freshness_interval_hours: null }), {
      params: { name: "fotocasa" },
    });
    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[1];
    expect(upsert[1][9]).toBe(true); // supplied (clear)…
    expect(upsert[1][10]).toBeNull(); // …with null value = back to default
  });

  it("rejects a non-positive or over-cap freshness interval (issue #295)", async () => {
    // Zod bounds — no DB call should happen (registry lookup never reached).
    for (const bad of [0, -1, 24 * 90 + 1, 1.5]) {
      const res = await PATCH(makeRequest({ freshness_interval_hours: bad }), {
        params: { name: "fotocasa" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("VALIDATION");
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("404s for a connector that isn't registered", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await PATCH(makeRequest({ enabled: false }), { params: { name: "nope" } });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("409s for a connector that left the Python registry", async () => {
    // registered=false means it can never run again, so any config write
    // would be a silent no-op the operator has no way to notice.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          connector_name: "retired",
          registered: false,
          supports_discovery: true,
          supported_filters: [],
        },
      ],
    });
    const res = await PATCH(makeRequest({ enabled: true }), { params: { name: "retired" } });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    // Nothing written.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a filter the connector does not declare support for", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ connector_name: "milanuncios", registered: true, supports_discovery: true, supported_filters: [] }],
    });
    const res = await PATCH(makeRequest({ filters: { rooms: 3 } }), {
      params: { name: "milanuncios" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no admite el filtro");
    // Nothing written.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a geography override on a capture-only connector", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ connector_name: "idealista", registered: true, supports_discovery: false, supported_filters: [] }],
    });
    const res = await PATCH(
      makeRequest({ geography_override: { center: [40.4, -3.7], radius_km: 5 } }),
      { params: { name: "idealista" } },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("solo captura");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit null override as 'clear it'", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ connector_name: "fotocasa", registered: true, supports_discovery: true, supported_filters: ["rooms"] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(makeRequest({ geography_override: null }), {
      params: { name: "fotocasa" },
    });
    expect(res.status).toBe(200);
    const params = mockQuery.mock.calls[1][1];
    // setGeography true (the key was present) with a null value = clear.
    expect(params[3]).toBe(true);
    expect(params[4]).toBeNull();
  });

  it("rejects an unknown top-level field", async () => {
    const res = await PATCH(makeRequest({ nonsense: true }), { params: { name: "fotocasa" } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
  });

  it("rejects a non-numeric rooms value", async () => {
    const res = await PATCH(makeRequest({ filters: { rooms: "dos" } }), {
      params: { name: "fotocasa" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
  });
});
