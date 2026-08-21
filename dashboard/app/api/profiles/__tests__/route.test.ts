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

import { GET, POST } from "../route";
import { DELETE, PATCH } from "../[id]/route";
import { POST as CLONE } from "../[id]/clone/route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

const VALID_SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
};

function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: "Alquiler alto rendimiento",
    scope: VALID_SCOPE,
    thesis_params: {},
    archived_at: null,
    created_at: "2026-08-02T00:00:00.000Z",
    last_materialized_at: null,
    last_viewed_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  mockQuery.mockReset();
  mockEnd.mockClear();
  await resetPool();
});

describe("GET /api/profiles", () => {
  it("returns empty array when no profiles exist", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns parsed profiles", async () => {
    mockQuery.mockResolvedValue({ rows: [dbRow()] });
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].name).toBe("Alquiler alto rendimiento");
  });

  it("skips a row with a malformed/empty scope instead of 500ing the whole list", async () => {
    // Regression: search_profile.scope's DB-level default is '{}', which
    // fails ScopeSchema's required geography/property_types fields. A
    // strict .parse() on every row in the list used to make one bad row
    // 500 the entire response for every other, valid profile.
    mockQuery.mockResolvedValue({
      rows: [dbRow({ id: 1, scope: {} }), dbRow({ id: 2, name: "Válido" })],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe(2);
    expect(json[0].name).toBe("Válido");
  });
});

describe("POST /api/profiles", () => {
  it("EC-1: creates a profile with valid name/scope and persists it", async () => {
    mockQuery.mockResolvedValue({ rows: [dbRow()] });
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "Alquiler alto rendimiento",
        scope: VALID_SCOPE,
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.name).toBe("Alquiler alto rendimiento");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO search_profile"),
      expect.any(Array),
    );
  });

  it("EC-2: rejects invalid scope (price_min > price_max) with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, price_min: 500000, price_max: 100000 },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("EC-2: rejects a negative radius with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: {
          ...VALID_SCOPE,
          geography: { type: "radius", center: [40.4, -3.7], radius_km: -5 },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", { scope: VALID_SCOPE }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty property_types array with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, property_types: [] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects size_min > size_max with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, size_min: 120, size_max: 60 },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing geography with 400", async () => {
    const { geography: _drop, ...scopeWithoutGeography } = VALID_SCOPE as Record<string, unknown>;
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: scopeWithoutGeography,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed geography (missing center) with 400", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, geography: { type: "radius", radius_km: 5 } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown top-level scope key with 400 (strict schema)", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, unexpected_field: "nope" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a property_type not in the DB CHECK vocabulary with 400", async () => {
    // Regression: an earlier version of this enum included local_comercial/
    // nave_industrial/edificio_completo, none of which exist in
    // etl/schema/init.sql's property.property_type CHECK constraint.
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, property_types: ["local_comercial"] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty connectors array with 400 (shape validation, before any DB call)", async () => {
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "X",
        scope: { ...VALID_SCOPE, connectors: [] },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("POST /api/profiles — connector selection (issue #660)", () => {
  it("400s naming an unknown connector rather than silently accepting it", async () => {
    // unknownConnectorNames' SELECT ... WHERE connector_name = ANY($1) finds
    // no matching row — every name in the selection is unknown.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "Novedades",
        scope: { ...VALID_SCOPE, connectors: ["no_existe"] },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(String(json.error ?? json.message ?? JSON.stringify(json))).toContain("no_existe");
    // The registry check ran, but createProfile's INSERT never did.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("creates the profile when every selected connector is registered", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ connector_name: "fotocasa" }] }) // unknownConnectorNames
      .mockResolvedValueOnce({ rows: [dbRow({ scope: { ...VALID_SCOPE, connectors: ["fotocasa"] } })] }); // INSERT
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "Solo Fotocasa",
        scope: { ...VALID_SCOPE, connectors: ["fotocasa"] },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO search_profile"),
      expect.any(Array),
    );
  });

  it("skips the registry check entirely for the default/'all' selection (no connector_registry query at all)", async () => {
    // mockResolvedValue (repeating), not Once: D-040's post-create refresh
    // (refreshProfileForScope) issues its own best-effort queries after the
    // INSERT — irrelevant to what this test checks, so every call gets a
    // harmless dbRow() rather than only the first.
    mockQuery.mockResolvedValue({ rows: [dbRow()] });
    const res = await POST(
      makeRequest("http://localhost:4000/api/profiles", "POST", {
        name: "Todas las fuentes",
        scope: VALID_SCOPE,
      }),
    );
    expect(res.status).toBe(201);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toContain("connector_registry");
    }
  });
});

describe("DELETE /api/profiles/[id] (archive)", () => {
  it("EC-3: archives a profile (soft delete, sets archived_at)", async () => {
    mockQuery.mockResolvedValue({ rows: [dbRow({ archived_at: "2026-08-02T01:00:00.000Z" })] });
    const res = await DELETE(makeRequest("http://localhost:4000/api/profiles/1", "DELETE"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.archived_at).not.toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("archived_at IS NULL"),
      [1],
    );
  });

  it("returns 404 when the profile does not exist or is already archived", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await DELETE(makeRequest("http://localhost:4000/api/profiles/999", "DELETE"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("EC-3: archiving hides from list but preserves data reachable by id", () => {
  it("GET /api/profiles excludes archived rows (query filters WHERE archived_at IS NULL)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await GET();
    expect(String(mockQuery.mock.calls[0][0])).toContain("WHERE archived_at IS NULL");
  });

  it("GET /api/profiles/[id] still returns an archived profile directly by id", async () => {
    const { GET: GET_BY_ID } = await import("../[id]/route");
    mockQuery.mockResolvedValue({ rows: [dbRow({ archived_at: "2026-08-02T01:00:00.000Z" })] });
    const res = await GET_BY_ID(makeRequest("http://localhost:4000/api/profiles/1", "GET"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.archived_at).not.toBeNull();
  });
});

describe("GET /api/profiles/[id] — last_viewed_at touch (issue #191)", () => {
  it("issues an UPDATE ... SET last_viewed_at = NOW() after a successful fetch", async () => {
    const { GET: GET_BY_ID } = await import("../[id]/route");
    mockQuery.mockResolvedValue({ rows: [dbRow()] });
    const res = await GET_BY_ID(makeRequest("http://localhost:4000/api/profiles/1", "GET"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(200);
    const touchCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("last_viewed_at = NOW()"));
    expect(touchCall).toBeDefined();
    // #416: the touch now also shifts previous_viewed_at (the novelty anchor)
    // and carries the session-debounce minutes ($2, default 30) alongside the id.
    expect(touchCall?.[1]).toEqual([1, 30]);
    expect(String(touchCall?.[0])).toContain("previous_viewed_at = CASE");
  });

  it("still returns 200 with the profile even when the last_viewed_at write fails (best-effort, must never fail the page)", async () => {
    const { GET: GET_BY_ID } = await import("../[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [dbRow()] }) // getProfileById succeeds
      .mockRejectedValueOnce(new Error("write pool exhausted")); // touchProfileViewedAt fails
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET_BY_ID(makeRequest("http://localhost:4000/api/profiles/1", "GET"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("Alquiler alto rendimiento");
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("does NOT touch last_viewed_at when the profile does not exist (404)", async () => {
    const { GET: GET_BY_ID } = await import("../[id]/route");
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await GET_BY_ID(makeRequest("http://localhost:4000/api/profiles/999", "GET"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(res.status).toBe(404);
    const touchCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("last_viewed_at = NOW()"));
    expect(touchCall).toBeUndefined();
  });
});

describe("POST /api/profiles/[id]/clone", () => {
  it("EC-4: clones scope/thesis_params into a new profile, not the feedback history", async () => {
    // First call: SELECT the source profile. Second call: INSERT the clone.
    mockQuery
      .mockResolvedValueOnce({ rows: [dbRow({ id: 1, name: "Original" })] })
      .mockResolvedValueOnce({ rows: [dbRow({ id: 2, name: "Original (copia)" })] });

    const res = await CLONE(makeRequest("http://localhost:4000/api/profiles/1/clone", "POST"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe(2);
    expect(json.name).toBe("Original (copia)");
    // ScopeSchema fills in the hard_exclusions default on parse — expected.
    expect(json.scope).toEqual({ ...VALID_SCOPE, hard_exclusions: {} });
    // Cloning never touches feedback_event/profile_listing_state — only two
    // queries run (select source, insert clone), neither references them.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toMatch(/feedback_event|profile_listing_state/);
    }
  });

  it("returns 404 when the source profile does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await CLONE(makeRequest("http://localhost:4000/api/profiles/999/clone", "POST"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/profiles/[id]", () => {
  it("updates scope and persists the change", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [dbRow()] }) // getProfileById inside updateProfile
      .mockResolvedValueOnce({ rows: [dbRow({ name: "Renombrado" })] }); // UPDATE ... RETURNING

    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/1", "PATCH", { name: "Renombrado" }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Renombrado");
  });

  it("rejects an invalid scope patch with 400", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/1", "PATCH", {
        scope: { ...VALID_SCOPE, property_types: ["not_a_real_type"] },
      }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 (not found or archived) when patching an archived profile", async () => {
    // getProfileById inside updateProfile finds the row, but it's archived —
    // updateProfile must refuse the edit rather than silently un-freezing it.
    mockQuery.mockResolvedValueOnce({
      rows: [dbRow({ archived_at: "2026-08-02T01:00:00.000Z" })],
    });
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/1", "PATCH", { name: "Intento" }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(res.status).toBe(404);
    // Only the getProfileById lookup ran — no UPDATE was attempted.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a non-numeric id rather than a raw DB error", async () => {
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/not-a-number", "PATCH", { name: "X" }),
      { params: Promise.resolve({ id: "not-a-number" }) },
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for a well-formed but non-existent id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // getProfileById finds nothing
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/999999", "PATCH", { name: "X" }),
      { params: Promise.resolve({ id: "999999" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/profiles/[id] — connector selection (issue #660)", () => {
  it("400s naming an unknown connector, before ever loading/updating the profile", async () => {
    // unknownConnectorNames' registry SELECT finds no match.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/1", "PATCH", {
        scope: { ...VALID_SCOPE, connectors: ["typo_connector"] },
      }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(String(json.error)).toContain("typo_connector");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("accepts a scope patch narrowing to a registered connector", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ connector_name: "cimenta2" }] }) // unknownConnectorNames
      .mockResolvedValueOnce({ rows: [dbRow()] }) // getProfileById inside updateProfile
      .mockResolvedValueOnce({
        rows: [dbRow({ scope: { ...VALID_SCOPE, connectors: ["cimenta2"] } })],
      }); // UPDATE ... RETURNING
    const res = await PATCH(
      makeRequest("http://localhost:4000/api/profiles/1", "PATCH", {
        scope: { ...VALID_SCOPE, connectors: ["cimenta2"] },
      }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).scope.connectors).toEqual(["cimenta2"]);
  });
});
