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
import { WARN_CAVEAT_CODES } from "@/lib/candidates";
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
    expect(candidatesCall[1]).toEqual([3, null, null, 31, "milanuncios_rental", WARN_CAVEAT_CODES]);
  });

  it("treats an absent source as no filter ($5 = null)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [profileRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(makeRequest("http://localhost/api/profiles/3/candidates"), ctx("3"));
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[1][1]).toEqual([3, null, null, 31, null, WARN_CAVEAT_CODES]);
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
