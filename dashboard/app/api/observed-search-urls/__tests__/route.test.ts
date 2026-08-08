// @vitest-environment node
/**
 * Unit tests for /api/observed-search-urls — the passive Idealista search-URL
 * observer channel (issue #488, part of #471).
 *
 * Mocks @/lib/db-write's `sql` so the route exercises the REAL validation +
 * persistence orchestration (observable-page check, portal derivation, norm_key
 * derivation, UPSERT / list SQL) without a DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { POST, GET } from "../route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);
const ADMIN_KEY = "test-admin-key";

const LISTADO_URL = "https://www.idealista.com/venta-viviendas/estepona-malaga/?b=2&a=1";
const AREAS_SHAPE_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29";

function postReq(body: Record<string, unknown>, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/observed-search-urls", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function getReq(opts: { adminKey?: string; limit?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  const qs = opts.limit ? `?limit=${opts.limit}` : "";
  return new NextRequest(`http://localhost:4000/api/observed-search-urls${qs}`, {
    method: "GET",
    headers,
  });
}

describe("POST /api/observed-search-urls", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without a valid admin key", async () => {
    const res = await POST(postReq({ url: LISTADO_URL }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when url is missing", async () => {
    const res = await POST(postReq({}, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on a non-observable idealista page (home / detail)", async () => {
    for (const url of [
      "https://www.idealista.com/",
      "https://www.idealista.com/inmueble/106387165/",
    ]) {
      const res = await POST(postReq({ url }, { adminKey: ADMIN_KEY }));
      expect(res.status).toBe(400);
    }
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on a non-idealista URL and a look-alike host", async () => {
    for (const url of [
      "https://www.alisedainmobiliaria.com/comprar-viviendas/",
      "https://idealista.com.evil.example/venta-viviendas/",
      "javascript://idealista.com/venta-viviendas/",
    ]) {
      const res = await POST(postReq({ url }, { adminKey: ADMIN_KEY }));
      expect(res.status).toBe(400);
    }
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("upserts a valid observable URL (portal + norm_key derived, url verbatim)", async () => {
    mockSql.mockResolvedValue([
      { id: 3, seen_count: 1, first_seen: "2026-08-08T10:00:00.000Z", last_seen: "2026-08-08T10:00:00.000Z" },
    ]);
    const res = await POST(
      postReq({ url: LISTADO_URL, title: "  Viviendas  " }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, id: 3, portal: "idealista", seen_count: 1 });

    expect(mockSql).toHaveBeenCalledTimes(1);
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("idealista"); // portal derived server-side
    expect(params[1]).toBe(LISTADO_URL); // url stored verbatim
    // norm_key derived server-side: www stripped, trailing slash gone, params sorted.
    expect(params[2]).toBe("idealista.com/venta-viviendas/estepona-malaga?a=1&b=2");
    expect(params[3]).toBe("Viviendas"); // title trimmed
  });

  it("keeps shape= intact in the stored url and derives a shape norm_key", async () => {
    mockSql.mockResolvedValue([
      { id: 4, seen_count: 2, first_seen: "x", last_seen: "y" },
    ]);
    await POST(postReq({ url: AREAS_SHAPE_URL }, { adminKey: ADMIN_KEY }));
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(AREAS_SHAPE_URL); // verbatim, shape= untouched
    expect(String(params[2])).toContain("shape="); // norm_key carries the zone
    expect(params[3]).toBeNull(); // no title → NULL
  });

  it("500 when the DB write throws", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await POST(postReq({ url: LISTADO_URL }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/observed-search-urls", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without a valid admin key", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns the observed rows", async () => {
    const rows = [
      {
        id: 2,
        portal: "idealista",
        url: AREAS_SHAPE_URL,
        title: "Zona dibujada",
        seen_count: 5,
        first_seen: "2026-08-01T10:00:00.000Z",
        last_seen: "2026-08-08T10:00:00.000Z",
      },
    ];
    mockSql.mockResolvedValue(rows);
    const res = await GET(getReq({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, rows });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("clamps a garbage limit to the default", async () => {
    mockSql.mockResolvedValue([]);
    await GET(getReq({ adminKey: ADMIN_KEY, limit: "not-a-number" }));
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(200);
  });

  it("500 when the DB read throws", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await GET(getReq({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(500);
  });
});
