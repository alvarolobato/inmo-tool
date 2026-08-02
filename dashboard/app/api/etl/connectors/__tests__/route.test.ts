import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      query = mockQuery;
      end = mockEnd;
    },
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
    enabled: null,
    geography_override: null,
    filters: null,
    has_config: false,
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
            id: "7",
            name: "Madrid centro",
            scope: { geography: { center: [40.4168, -3.7038], radius_km: 5 } },
          },
        ],
      });

    const body = await (await GET()).json();
    const c = body.connectors[0];
    expect(c.scopeSource).toBe("profiles");
    expect(c.derivedFrom).toEqual([
      { profile_id: 7, profile_name: "Madrid centro", center: [40.4168, -3.7038], radius_km: 5 },
    ]);
    // BIGSERIAL comes back from pg as a string — it must not leak through
    // a number-typed field (the recurring bigint-serialization bug class).
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
            scope: { geography: { center: [40.4168, -3.7038], radius_km: 5 } },
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
          { id: 1, name: "Madrid", scope: { geography: { center: [40.4, -3.7], radius_km: 5 } } },
        ],
      });

    const c = (await (await GET()).json()).connectors[0];
    // Even with active profiles present, it never discovers.
    expect(c.scopeSource).toBe("capture-only");
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
        rows: [{ connector_name: "fotocasa", supports_discovery: true, supported_filters: ["rooms"] }],
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

  it("404s for a connector that isn't registered", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await PATCH(makeRequest({ enabled: false }), { params: { name: "nope" } });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("rejects a filter the connector does not declare support for", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ connector_name: "milanuncios", supports_discovery: true, supported_filters: [] }],
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
      rows: [{ connector_name: "idealista", supports_discovery: false, supported_filters: [] }],
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
        rows: [{ connector_name: "fotocasa", supports_discovery: true, supported_filters: ["rooms"] }],
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
