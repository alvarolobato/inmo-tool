// @vitest-environment node
/**
 * Unit tests for POST /api/extension/search-url-example — the capture-to-infer
 * learned-example endpoint (issue #293).
 *
 * Mocks @/lib/db-write's `sql` so the route exercises the REAL parse + upsert
 * orchestration (portal derivation, parse(), dedupe) without a DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { POST } from "../search-url-example/route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);
const ADMIN_KEY = "test-admin-key";

// Owner-confirmed #296 slug grammar.
const IDEALISTA_SEARCH =
  "https://www.idealista.com/venta-viviendas/estepona-malaga/con-precio-hasta_200000/";

function req(body: Record<string, unknown>, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/extension/search-url-example", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/extension/search-url-example", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without a valid admin key", async () => {
    const res = await POST(req({ url: IDEALISTA_SEARCH }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when url is missing", async () => {
    const res = await POST(req({}, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
  });

  it("400 on a non-http(s) scheme", async () => {
    const res = await POST(req({ url: "javascript://idealista.com/x" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("200 stored:false for an unknown (non-capture) portal, no DB write", async () => {
    const res = await POST(req({ url: "https://example.com/venta?tipo=x" }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, stored: false, reason: "unknown_portal" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("200 stored:false (unparseable) for a capture portal but non-search URL", async () => {
    const res = await POST(
      req({ url: "https://www.idealista.com/inmueble/12345/" }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(false);
    expect(body.reason).toBe("unparseable");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("parses and stores a real idealista search URL (inserted)", async () => {
    mockSql.mockResolvedValue([{ id: 42, inserted: true }]);
    const res = await POST(req({ url: IDEALISTA_SEARCH }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, stored: true, inserted: true });
    expect(body.categoryKey).toBe("venta-viviendas");

    // Persisted the derived portal, canonical match_key, decoded category_key
    // and a template with the numeric value swapped for a placeholder.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("idealista"); // portal derived from the URL host
    expect(params[4]).toBe("venta-viviendas"); // category_key = section
    expect(params[5]).toContain("precio-hasta_{price_max}"); // template placeholder
    const filters = JSON.parse(params[3] as string);
    expect(filters.priceMax).toBe(200000);
    expect(filters.locationSlug).toBe("estepona-malaga");
  });

  it("persists the harvested resultCount when provided (issue #376)", async () => {
    mockSql.mockResolvedValue([{ id: 42, inserted: true }]);
    const res = await POST(
      req({ url: IDEALISTA_SEARCH, resultCount: 37 }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(200);
    const params = mockSql.mock.calls[0][1] as unknown[];
    // 7th param is last_result_count.
    expect(params[6]).toBe(37);
  });

  it("stores NULL last_result_count when no resultCount is provided", async () => {
    mockSql.mockResolvedValue([{ id: 42, inserted: true }]);
    await POST(req({ url: IDEALISTA_SEARCH }, { adminKey: ADMIN_KEY }));
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[6]).toBeNull();
  });

  it("dedupes: a re-capture of the same URL reports inserted:false", async () => {
    mockSql.mockResolvedValueOnce([{ id: 42, inserted: true }]);
    mockSql.mockResolvedValueOnce([{ id: 42, inserted: false }]);
    const first = await (await POST(req({ url: IDEALISTA_SEARCH }, { adminKey: ADMIN_KEY }))).json();
    const second = await (await POST(req({ url: IDEALISTA_SEARCH }, { adminKey: ADMIN_KEY }))).json();
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it("500 when the DB write throws", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await POST(req({ url: IDEALISTA_SEARCH }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(500);
  });
});
