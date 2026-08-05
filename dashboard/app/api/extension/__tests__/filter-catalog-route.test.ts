// @vitest-environment node
/**
 * Unit tests for POST /api/extension/filter-catalog — the URL-building
 * discovery ingest (issue #336, D-063).
 *
 * Covers: the admin-key gate, host-derived connector (never client-claimed),
 * payload validation (source / capturedAt / axes / at-least-one-option), the
 * happy-path persist + echoed counts, and DB failure. Mocks @/lib/db-write so
 * no real DB is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db-write", () => ({ sql: vi.fn() }));

import { POST } from "../filter-catalog/route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);
const ADMIN_KEY = "test-admin-key";
const ALISEDA_SEARCH = "https://www.alisedainmobiliaria.com/comprar-viviendas";

function req(body: Record<string, unknown>, opts: { adminKey?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  return new NextRequest("http://localhost:4000/api/extension/filter-catalog", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_AXES = {
  property_type: [
    { label: "Piso", portalValue: "36", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
    { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
  ],
};

describe("POST /api/extension/filter-catalog", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("401 without a valid admin key, no DB write", async () => {
    const res = await POST(req({ pageUrl: ALISEDA_SEARCH, source: "embedded-config", axes: VALID_AXES }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when pageUrl is missing", async () => {
    const res = await POST(req({ source: "embedded-config", axes: VALID_AXES }, { adminKey: ADMIN_KEY }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("200 stored:false for an unknown (non-capture) host, no DB write", async () => {
    const res = await POST(
      req({ pageUrl: "https://example.com/buscar", source: "embedded-config", axes: VALID_AXES }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, stored: false, reason: "unknown_connector" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 for an invalid source", async () => {
    const res = await POST(
      req({ pageUrl: ALISEDA_SEARCH, source: "bogus", axes: VALID_AXES }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 when no axis carries a usable option", async () => {
    const res = await POST(
      req({ pageUrl: ALISEDA_SEARCH, source: "form-options", axes: { property_type: [] } }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("derives the connector from the host (ignores any client-claimed connector) and persists", async () => {
    mockSql.mockResolvedValue([{ id: 7 }]);
    const res = await POST(
      req(
        {
          pageUrl: ALISEDA_SEARCH,
          connector: "idealista", // must be ignored — host wins
          source: "embedded-config",
          capturedAt: "2026-08-05T10:00:00.000Z",
          axes: VALID_AXES,
        },
        { adminKey: ADMIN_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      stored: true,
      connector: "aliseda",
      source: "embedded-config",
      axes_count: 1,
      options_count: 2,
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
    const params = mockSql.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("aliseda"); // host-derived, not "idealista"
    expect(params[1]).toBe("embedded-config");
    expect(params[3]).toBe("2026-08-05T10:00:00.000Z");
    const axes = JSON.parse(params[2] as string);
    expect(axes.property_type).toHaveLength(2);
    expect(axes.property_type[0]).toMatchObject({ label: "Piso", subtipo: 36 });
  });

  it("500 when the DB write throws", async () => {
    mockSql.mockRejectedValue(new Error("boom"));
    const res = await POST(
      req({ pageUrl: ALISEDA_SEARCH, source: "embedded-config", axes: VALID_AXES }, { adminKey: ADMIN_KEY }),
    );
    expect(res.status).toBe(500);
  });
});
