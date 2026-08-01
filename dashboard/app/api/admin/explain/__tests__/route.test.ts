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

import { POST } from "../route";
import { resetPool } from "@/lib/db";
import { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/admin/explain", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": process.env.ADMIN_API_KEY ?? "",
    },
  });
}

describe("POST /api/admin/explain", () => {
  beforeEach(async () => {
    vi.stubEnv("ADMIN_API_KEY", "test-admin-secret");
    mockQuery.mockReset();
    mockEnd.mockClear();
    await resetPool();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── Successful EXPLAIN ───────────────────────────────────────────────

  it("returns plan for a valid SELECT", async () => {
    mockQuery.mockResolvedValue({
      fields: [{ name: "QUERY PLAN" }],
      rows: [
        ["Aggregate  (cost=1000.00..1000.01 rows=1 width=8)"],
        ["  ->  Seq Scan on ps_ventas  (cost=0.00..900.00 rows=40000 width=0)"],
      ],
    });

    const res = await POST(makeRequest({ sql: "SELECT count(*) FROM ps_ventas" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.plan).toContain("Aggregate");
    expect(json.plan).toContain("Seq Scan");
  });

  it("joins multi-line plan with newlines", async () => {
    mockQuery.mockResolvedValue({
      fields: [{ name: "QUERY PLAN" }],
      rows: [["Line 1"], ["Line 2"], ["Line 3"]],
    });

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.plan).toBe("Line 1\nLine 2\nLine 3");
  });

  it("wraps user SQL with EXPLAIN FORMAT TEXT — not ANALYZE", async () => {
    mockQuery.mockResolvedValue({
      fields: [{ name: "QUERY PLAN" }],
      rows: [["Seq Scan on ps_ventas  (cost=0.00..900.00 rows=40000 width=8)"]],
    });

    await POST(makeRequest({ sql: "SELECT id FROM ps_ventas" }));

    const calledSql = mockQuery.mock.calls[0][0].text as string;
    expect(calledSql).toMatch(/^EXPLAIN \(FORMAT TEXT\)/i);
    expect(calledSql).not.toMatch(/ANALYZE/i);
    expect(calledSql).toContain("SELECT id FROM ps_ventas");
  });

  // ─── Write rejection (403) ────────────────────────────────────────────

  it("rejects DELETE with 403", async () => {
    const res = await POST(makeRequest({ sql: "DELETE FROM ps_ventas" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.code).toBe("VALIDATION");
  });

  it("rejects UPDATE with 403", async () => {
    const res = await POST(makeRequest({ sql: "UPDATE ps_ventas SET total_si = 0" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION");
  });

  it("rejects INSERT with 403", async () => {
    const res = await POST(makeRequest({ sql: "INSERT INTO ps_ventas (id) VALUES (1)" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION");
  });

  it("rejects DROP with 403", async () => {
    const res = await POST(makeRequest({ sql: "DROP TABLE ps_ventas" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION");
  });

  // ─── EXPLAIN prefix rejection (400) ───────────────────────────────────

  it("rejects SQL that already starts with EXPLAIN with 400", async () => {
    const res = await POST(makeRequest({ sql: "EXPLAIN SELECT 1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION");
  });

  it("rejects case-insensitive EXPLAIN prefix", async () => {
    const res = await POST(makeRequest({ sql: "explain select 1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION");
  });

  // ─── Missing / empty sql (400) ────────────────────────────────────────

  it("rejects missing sql field with 400", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("rejects empty sql string with 400", async () => {
    const res = await POST(makeRequest({ sql: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects whitespace-only sql with 400", async () => {
    const res = await POST(makeRequest({ sql: "   " }));
    expect(res.status).toBe(400);
  });

  it("rejects non-string sql with 400", async () => {
    const res = await POST(makeRequest({ sql: 42 }));
    expect(res.status).toBe(400);
  });

  it("rejects null body with 400", async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it("rejects array body with 400", async () => {
    const res = await POST(makeRequest([1, 2, 3]));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON body with 400", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/explain", {
      method: "POST",
      body: "not json",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": "test-admin-secret",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 401 without admin key", async () => {
    const req = new NextRequest("http://localhost:4000/api/admin/explain", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT 1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── DB errors ────────────────────────────────────────────────────────

  it("returns 400 on PG syntax error (42601)", async () => {
    mockQuery.mockRejectedValue({ code: "42601", message: 'syntax error at or near "SELEC"' });

    const res = await POST(makeRequest({ sql: "SELECT SELEC FROM ps_ventas" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("DB_QUERY");
  });

  it("returns 408 on query timeout", async () => {
    mockQuery.mockRejectedValue({ code: "57014", message: "canceling statement due to statement timeout" });

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    expect(res.status).toBe(408);
    const json = await res.json();
    expect(json.code).toBe("TIMEOUT");
  });

  it("returns 503 on connection error", async () => {
    mockQuery.mockRejectedValue({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" });

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("DB_CONNECTION");
  });

  it("returns 500 on unexpected errors", async () => {
    mockQuery.mockRejectedValue(new Error("something internal went wrong"));

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("UNKNOWN");
  });

  // ─── Standard error response shape ───────────────────────────────────

  it("error responses include requestId and timestamp", async () => {
    const res = await POST(makeRequest({}));
    const json = await res.json();
    expect(json.requestId).toMatch(/^req_/);
    expect(json.timestamp).toBeTruthy();
  });
});
