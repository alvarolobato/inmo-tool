import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  // db-shared.ts (#155) registers the int8 type parser at module load — the
  // mock needs a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import { GET } from "../route";
import { GET as SOURCES_GET } from "../../candidate-sources/route";
import { resetPool } from "@/lib/db-write";
import { OCCUPIED_STATUSES, WARN_CAVEAT_CODES } from "@/lib/candidates";
import { NextRequest } from "next/server";

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

const ctx = (id: string) => ({ params: { id } });

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: 3,
  name: "Perfil",
  scope: {
    geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
    property_types: ["piso"],
  },
  thesis_params: {},
  archived_at: null,
  created_at: "2026-08-02T00:00:00.000Z",
  last_materialized_at: null,
  last_viewed_at: null,
  ...overrides,
});

beforeEach(async () => {
  mockQuery.mockReset();
  mockEnd.mockClear();
  await resetPool();
});

describe("GET /api/profiles/[id]/candidates — source (portal) filter (#265)", () => {
  it("rejects a malformed source before touching the DB (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?source=Idealista!"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an uppercase source (slugs are lowercase) (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?source=IDEALISTA"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("accepts a valid slug and passes it as $5 to listCandidates", async () => {
    // 1st query: getProfileById. 2nd: listCandidates main query (empty result
    // → loadFlags issues no further query).
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?source=milanuncios_rental"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });

    const candidatesCall = mockQuery.mock.calls[1];
    expect(candidatesCall[0]).toContain("lf.source = $5");
    // #310 appended $7–$11 (occupancy, occupied-statuses list, condition,
    // renovation, min-below-market); #386 appended $13/$14 (caveat, redflagType);
    // all null/default when only source is set.
    expect(candidatesCall[1]).toEqual([
      3,
      null,
      null,
      31,
      "milanuncios_rental",
      WARN_CAVEAT_CODES,
      null,
      OCCUPIED_STATUSES,
      null,
      null,
      null,
      false,
      null,
      null,
    ]);
  });

  it("treats an absent source as no filter ($5 = null)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(makeRequest("http://localhost/api/profiles/3/candidates"), ctx("3"));
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[1][1]).toEqual([
      3,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      null,
      OCCUPIED_STATUSES,
      null,
      null,
      null,
      false,
      null,
      null,
    ]);
  });
});

describe("GET /api/profiles/[id]/candidates — #310 hard filters (D-059)", () => {
  it("rejects an unknown occupancy value before touching the DB (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?occupancy=maybe"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown condition value (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?condition=ruina"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown renovation value (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?renovation=media"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a minDiscount outside 0–100 (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?minDiscount=150"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric minDiscount (400)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?minDiscount=cheap"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes valid filters through: occupancy=$7, condition=$9, renovation=$10, minDiscount(pct→fraction)=$11", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?occupancy=occupied&condition=a_reformar&renovation=integral&minDiscount=15",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[1][1]).toEqual([
      3,
      null,
      null,
      31,
      null,
      WARN_CAVEAT_CODES,
      "occupied",
      OCCUPIED_STATUSES,
      "a_reformar",
      "integral",
      0.15, // 15% → fraction
      false,
      null,
      null,
    ]);
  });

  it("rejects an unknown caveat value before touching the DB (400) (#386)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?caveat=hipoteca"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown redflagType value (400) (#386)", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?redflagType=goteras"),
      ctx("3"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("passes valid caveat=$13 and redflagType=$14 through to listCandidates (#386)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest(
        "http://localhost/api/profiles/3/candidates?caveat=venta_deuda&redflagType=unfinished_construction",
      ),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = mockQuery.mock.calls[1][1];
    expect(params[12]).toBe("venta_deuda");
    expect(params[13]).toBe("unfinished_construction");
  });

  it("accepts subasta_judicial as a valid redflagType and passes it through (#389)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?redflagType=subasta_judicial"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = mockQuery.mock.calls[1][1];
    expect(params[13]).toBe("subasta_judicial");
  });

  it("passes includeRejected=true to listCandidates as $12 when the show-rejected toggle is on (#379)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost/api/profiles/3/candidates?includeRejected=true"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    const params = mockQuery.mock.calls[1][1];
    // $12 is the includeRejected flag ($13/$14 caveat/redflagType follow it).
    expect(params[11]).toBe(true);
  });

  it("keeps rejected hidden ($12 = false) for any includeRejected value other than the exact string 'true' (#379)", async () => {
    for (const raw of ["", "1", "false", "TRUE", "yes"]) {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await GET(
        makeRequest(`http://localhost/api/profiles/3/candidates?includeRejected=${raw}`),
        ctx("3"),
      );
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[1][1][11]).toBe(false);
    }
  });
});

describe("GET /api/profiles/[id]/candidate-sources (#265)", () => {
  it("returns 400 for a non-numeric id", async () => {
    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/abc/candidate-sources"),
      ctx("abc"),
    );
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for an archived profile", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow({ archived_at: "2026-08-01T00:00:00Z" })] });
    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/3/candidate-sources"),
      ctx("3"),
    );
    expect(res.status).toBe(404);
  });

  it("returns the distinct sources for an active profile", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ source: "aliseda" }, { source: "fotocasa" }, { source: "idealista" }],
    });

    const res = await SOURCES_GET(
      makeRequest("http://localhost/api/profiles/3/candidate-sources"),
      ctx("3"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: ["aliseda", "fotocasa", "idealista"] });
  });
});
