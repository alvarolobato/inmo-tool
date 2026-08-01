import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
}));

import { GET } from "../route";
import { resetPool } from "@/lib/db";

function adminRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/slow-queries", {
    headers: { "x-admin-key": process.env.ADMIN_API_KEY ?? "" },
  });
}

describe("GET /api/admin/slow-queries", () => {
  beforeEach(async () => {
    vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
    mockQuery.mockReset();
    mockEnd.mockClear();
    await resetPool();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/slow-queries");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns queries array with all 7 fields", async () => {
    mockQuery.mockResolvedValue({
      fields: [
        { name: "query" },
        { name: "calls" },
        { name: "mean_exec_time_ms" },
        { name: "max_exec_time_ms" },
        { name: "total_exec_time_ms" },
        { name: "rows" },
        { name: "cache_hit_ratio" },
      ],
      rows: [
        [
          "SELECT * FROM ps_ventas WHERE fecha_creacion > $1",
          "42",
          1.5,
          8.2,
          63.0,
          "1000",
          "99.5",
        ],
      ],
    });

    const res = await GET(adminRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.queries).toHaveLength(1);

    const q = body.queries[0];
    expect(q.query).toBe("SELECT * FROM ps_ventas WHERE fecha_creacion > $1");
    expect(q.calls).toBe(42);
    expect(q.mean_exec_time_ms).toBe(1.5);
    expect(q.max_exec_time_ms).toBe(8.2);
    expect(q.total_exec_time_ms).toBe(63.0);
    expect(q.rows).toBe(1000);
    expect(q.cache_hit_ratio).toBe(99.5);
  });

  it("returns empty queries array when no rows match", async () => {
    mockQuery.mockResolvedValue({
      fields: [
        { name: "query" },
        { name: "calls" },
        { name: "mean_exec_time_ms" },
        { name: "max_exec_time_ms" },
        { name: "total_exec_time_ms" },
        { name: "rows" },
        { name: "cache_hit_ratio" },
      ],
      rows: [],
    });

    const res = await GET(adminRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.queries).toEqual([]);
    expect(body.error).toBeUndefined();
  });

  it("returns null cache_hit_ratio when shared_blks_hit and shared_blks_read are both 0", async () => {
    mockQuery.mockResolvedValue({
      fields: [
        { name: "query" },
        { name: "calls" },
        { name: "mean_exec_time_ms" },
        { name: "max_exec_time_ms" },
        { name: "total_exec_time_ms" },
        { name: "rows" },
        { name: "cache_hit_ratio" },
      ],
      rows: [["SELECT 1", "1", 0.1, 0.1, 0.1, "0", null]],
    });

    const res = await GET(adminRequest());
    const body = await res.json();

    expect(body.queries[0].cache_hit_ratio).toBeNull();
  });

  it("returns HTTP 200 with error field when pg_stat_statements is not enabled", async () => {
    mockQuery.mockRejectedValue({
      code: "42P01",
      message: 'relation "pg_stat_statements" does not exist',
    });

    const res = await GET(adminRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.queries).toEqual([]);
    expect(body.error).toBe("pg_stat_statements not enabled");
  });

  it("returns empty queries with generic error on unexpected error without leaking details", async () => {
    mockQuery.mockRejectedValue(new Error("something internal"));

    const res = await GET(adminRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.queries).toEqual([]);
    expect(body.error).toBe("Internal server error");
  });

  it("returns multiple queries ordered by slowest first", async () => {
    mockQuery.mockResolvedValue({
      fields: [
        { name: "query" },
        { name: "calls" },
        { name: "mean_exec_time_ms" },
        { name: "max_exec_time_ms" },
        { name: "total_exec_time_ms" },
        { name: "rows" },
        { name: "cache_hit_ratio" },
      ],
      rows: [
        ["SELECT * FROM ps_stock_tienda", "5", 2500.0, 3000.0, 12500.0, "500", "85.0"],
        ["SELECT * FROM ps_ventas", "100", 50.0, 200.0, 5000.0, "1000", "99.9"],
      ],
    });

    const res = await GET(adminRequest());
    const body = await res.json();

    expect(body.queries).toHaveLength(2);
    expect(body.queries[0].query).toBe("SELECT * FROM ps_stock_tienda");
    expect(body.queries[1].query).toBe("SELECT * FROM ps_ventas");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ORDER BY mean_exec_time DESC"),
      }),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/LEFT\s*\(\s*query\s*,\s*500\s*\)/i),
      }),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/LIKE\s+['"][^'"]*ps_[^'"]*['"]/i),
      }),
    );
  });

  it("accepts Authorization Bearer admin key", async () => {
    mockQuery.mockResolvedValue({
      fields: [
        { name: "query" },
        { name: "calls" },
        { name: "mean_exec_time_ms" },
        { name: "max_exec_time_ms" },
        { name: "total_exec_time_ms" },
        { name: "rows" },
        { name: "cache_hit_ratio" },
      ],
      rows: [],
    });

    const req = new NextRequest("http://localhost:4000/api/admin/slow-queries", {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});
