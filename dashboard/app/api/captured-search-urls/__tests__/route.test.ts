// @vitest-environment node
/**
 * Unit tests for /api/captured-search-urls — capture + review of raw Idealista
 * search URLs (issue #475, part of #471).
 *
 * Mocks @/lib/db-write's `sql` so the route exercises the REAL validation +
 * persistence orchestration (idealista host check, portal derivation, insert /
 * list SQL) without a DB.
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

// A drawn-zone results URL: "Dibuja tu zona" encodes the polygon into `shape=`.
const IDEALISTA_SHAPE_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28abc123%29%29";

function postReq(body: Record<string, unknown>, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/captured-search-urls", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function getReq(opts: { adminKey?: string; limit?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  const qs = opts.limit ? `?limit=${opts.limit}` : "";
  return new NextRequest(`http://localhost:4000/api/captured-search-urls${qs}`, {
    method: "GET",
    headers,
  });
}

describe("POST /api/captured-search-urls", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without a valid admin key", async () => {
    const res = await POST(postReq({ url: IDEALISTA_SHAPE_URL }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when url is missing", async () => {
    const res = await POST(postReq({}, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on a non-http(s) scheme", async () => {
    const res = await POST(
      postReq({ url: "javascript://idealista.com/x" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on a non-idealista URL", async () => {
    const res = await POST(
      postReq({ url: "https://www.alisedainmobiliaria.com/venta?zona=x" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on a look-alike host that only ends near idealista.com", async () => {
    const res = await POST(
      postReq({ url: "https://idealista.com.evil.example/x" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("persists a valid idealista shape= URL (portal derived, title trimmed)", async () => {
    mockSql.mockResolvedValue([{ id: 7, captured_at: "2026-08-08T10:00:00.000Z" }]);
    const res = await POST(
      postReq(
        { url: IDEALISTA_SHAPE_URL, title: "  Viviendas en venta  " },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      id: 7,
      portal: "idealista",
      captured_at: "2026-08-08T10:00:00.000Z",
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("idealista"); // portal derived server-side
    expect(params[1]).toBe(IDEALISTA_SHAPE_URL); // url stored verbatim (shape= intact)
    expect(params[2]).toBe("Viviendas en venta"); // title trimmed
  });

  it("stores NULL title when none is provided", async () => {
    mockSql.mockResolvedValue([{ id: 8, captured_at: "2026-08-08T10:00:00.000Z" }]);
    await POST(postReq({ url: IDEALISTA_SHAPE_URL }, { adminKey: ADMIN_KEY }));
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[2]).toBeNull();
  });

  it("500 when the DB write throws", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await POST(postReq({ url: IDEALISTA_SHAPE_URL }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/captured-search-urls", () => {
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

  it("returns the captured rows, newest first", async () => {
    const rows = [
      {
        id: 2,
        portal: "idealista",
        url: IDEALISTA_SHAPE_URL,
        title: "Zona dibujada",
        captured_at: "2026-08-08T10:00:00.000Z",
        notes: null,
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
