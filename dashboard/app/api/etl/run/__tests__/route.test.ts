// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { POST } from "../route";
import { query } from "@/lib/db";
import { sql } from "@/lib/db-write";

const mockQuery = vi.mocked(query);
const mockSql = vi.mocked(sql);

function makeRequest(body?: unknown): Request {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("http://localhost/api/etl/run", init);
}

describe("POST /api/etl/run", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSql.mockReset();
  });

  it("returns 202 with trigger_id when no run is active", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // active run check
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // pending trigger check
    mockSql.mockResolvedValueOnce([{ id: 42 }]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: 42 });
    expect(mockSql).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO etl_manual_trigger"),
      [false, [], "dashboard"],
    );
  });

  it("returns 202 with already_queued when a pending trigger exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // active run check
    mockQuery.mockResolvedValueOnce({ rows: [[55]], columns: ["id"] }); // pending trigger exists

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: 55, already_queued: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 409 with run_id when a non-stale run is active", async () => {
    const recentStart = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    mockQuery.mockResolvedValueOnce({
      rows: [[7, recentStart]],
      columns: ["id", "started_at"],
    });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "already_running", run_id: 7 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("does not block on a stale run (started > 4 hours ago)", async () => {
    const staleStart = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
    mockQuery.mockResolvedValueOnce({
      rows: [[3, staleStart]],
      columns: ["id", "started_at"],
    });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // pending trigger check
    mockSql.mockResolvedValueOnce([{ id: 99 }]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: 99 });
  });

  it("coerces string trigger_id to number (BIGSERIAL returns string)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // active run check
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // pending trigger check
    mockSql.mockResolvedValueOnce([{ id: "42" }]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: 42 });
    expect(typeof body.trigger_id).toBe("number");
  });

  it("returns 503 when the database query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "db_error" });
  });

  it("returns 503 when the INSERT throws", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // active run check
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // pending trigger check
    mockSql.mockRejectedValueOnce(new Error("DB write error"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "db_error" });
  });

  it("returns 202 with existing trigger_id when a pending trigger already exists (idempotent)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockSql.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ rows: [[77]], columns: ["id"] });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: 77 });
  });

  it("returns 202 with already_queued:true when the trigger is consumed between INSERT conflict and fallback SELECT (race condition)", async () => {
    // INSERT conflicts (DO NOTHING, rows=[]), then the ETL picks up the trigger
    // before the fallback SELECT runs → rows=[] → must not throw TypeError.
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // active run check
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // pending trigger check
    mockSql.mockResolvedValueOnce([]); // INSERT ON CONFLICT DO NOTHING → no rows
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] }); // fallback SELECT → consumed

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ trigger_id: null, already_queued: true });
  });

  // ─── Force-resync body parsing (issue #398) ────────────────────────────────

  it("accepts { force_full: true } and passes true to the INSERT", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockSql.mockResolvedValueOnce([{ id: 101 }]);

    const res = await POST(makeRequest({ force_full: true }));
    expect(res.status).toBe(202);
    expect(mockSql).toHaveBeenCalledWith(expect.any(String), [true, [], "dashboard"]);
  });

  it("accepts { tables: [...] } and passes the array to the INSERT", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockSql.mockResolvedValueOnce([{ id: 102 }]);

    const res = await POST(makeRequest({ tables: ["stock", "ventas"] }));
    expect(res.status).toBe(202);
    expect(mockSql).toHaveBeenCalledWith(expect.any(String), [
      false,
      ["stock", "ventas"],
      "dashboard",
    ]);
  });

  it("ignores tables when force_full is true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockSql.mockResolvedValueOnce([{ id: 103 }]);

    const res = await POST(
      makeRequest({ force_full: true, tables: ["stock"] }),
    );
    expect(res.status).toBe(202);
    expect(mockSql).toHaveBeenCalledWith(expect.any(String), [true, [], "dashboard"]);
  });

  it("rejects unknown table names with 400 invalid_body", async () => {
    const res = await POST(makeRequest({ tables: ["ps_ventas; DROP"] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_body");
    expect(body.detail).toContain("Unknown table name");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects non-boolean force_full with 400", async () => {
    const res = await POST(makeRequest({ force_full: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects non-array tables with 400", async () => {
    const res = await POST(makeRequest({ tables: "stock" }));
    expect(res.status).toBe(400);
  });

  it("rejects tables containing non-string entries with 400", async () => {
    const res = await POST(makeRequest({ tables: ["stock", 42] }));
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body with 400", async () => {
    const res = await POST(makeRequest("{not json"));
    expect(res.status).toBe(400);
  });

  it("treats JSON array as invalid body (must be object)", async () => {
    const res = await POST(makeRequest(["stock"]));
    expect(res.status).toBe(400);
  });

  it("deduplicates repeated table names before validation", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });
    mockSql.mockResolvedValueOnce([{ id: 104 }]);

    const res = await POST(
      makeRequest({ tables: ["stock", "stock", "ventas"] }),
    );
    expect(res.status).toBe(202);
    expect(mockSql).toHaveBeenCalledWith(expect.any(String), [
      false,
      ["stock", "ventas"],
      "dashboard",
    ]);
  });
});
