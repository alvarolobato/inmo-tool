// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";
import { NextRequest } from "next/server";

const mockQuery = vi.mocked(query);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/etl/runs/1");
}

const MOCK_RUN_ROW = [1, new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T03:00:00Z"), 3600000, "success", 22, 22, 0, 45000, "scheduled"];

const MOCK_TABLE_ROWS = [
  [1, "ventas", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:15:00Z"), 900000, "success", 1234, 911000, "upsert_delta", null, null, null],
  [2, "stock", new Date("2026-04-10T02:15:00Z"), new Date("2026-04-10T03:00:00Z"), 2700000, "success", 0, 12300000, "upsert_delta", null, null, null],
];

describe("GET /api/etl/runs/[id]", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns run detail with tables", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: MOCK_TABLE_ROWS, columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.run.id).toBe(1);
    expect(body.run.status).toBe("success");
    expect(body.run.trigger).toBe("scheduled");
    expect(body.tables).toHaveLength(2);
    expect(body.tables[0].table_name).toBe("ventas");
    expect(body.tables[1].table_name).toBe("stock");
  });

  it("returns 404 when run not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest(), makeContext("99999"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 400 for non-numeric ID", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for zero ID", async () => {
    const res = await GET(makeRequest(), makeContext("0"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative ID", async () => {
    const res = await GET(makeRequest(), makeContext("-1"));
    expect(res.status).toBe(400);
  });

  // Risk: RISK-ORCH-VALIDATION — decimal strings like "1.5" must not parse as valid integer IDs
  it("returns 400 for decimal ID (e.g. 1.5)", async () => {
    const res = await GET(makeRequest(), makeContext("1.5"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns empty tables array when run has no table entries", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tables).toHaveLength(0);
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("DB_QUERY");
  });

  it("returns table with error_msg when status is failed", async () => {
    const failedTable = [3, "articulos", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:01:00Z"), 60000, "failed", 0, null, "full_refresh", null, null, "Connection timeout"];
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [failedTable], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tables[0].status).toBe("failed");
    expect(body.tables[0].error_msg).toBe("Connection timeout");
  });
});
