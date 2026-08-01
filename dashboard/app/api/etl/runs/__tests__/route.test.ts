// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";
import { NextRequest } from "next/server";

const mockQuery = vi.mocked(query);

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:4000/api/etl/runs");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url.toString());
}

const MOCK_RUN_ROWS = [
  [1, new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T03:00:00Z"), 3600000, "success", 22, 22, 0, 45000, "scheduled"],
  [2, new Date("2026-04-11T02:00:00Z"), new Date("2026-04-11T03:00:00Z"), 3700000, "partial", 22, 21, 1, 46000, "scheduled"],
];

describe("GET /api/etl/runs", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns paginated runs with defaults", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[2]], columns: ["count"] })
      .mockResolvedValueOnce({ rows: MOCK_RUN_ROWS, columns: [] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.per_page).toBe(20);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].id).toBe(1);
    expect(body.runs[0].status).toBe("success");
    expect(body.runs[0].trigger).toBe("scheduled");
    expect(typeof body.runs[0].started_at).toBe("string");
  });

  it("supports custom page and per_page", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[10]], columns: ["count"] })
      .mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest({ page: "2", per_page: "5" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.page).toBe(2);
    expect(body.per_page).toBe(5);
    expect(body.runs).toHaveLength(0);
  });

  it("returns 400 for invalid page", async () => {
    const res = await GET(makeRequest({ page: "0" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for non-numeric page", async () => {
    const res = await GET(makeRequest({ page: "abc" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for partial-numeric page (e.g. 1abc)", async () => {
    const res = await GET(makeRequest({ page: "1abc" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for decimal per_page (e.g. 5.5)", async () => {
    const res = await GET(makeRequest({ per_page: "5.5" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for per_page=0 (below minimum)", async () => {
    const res = await GET(makeRequest({ per_page: "0" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for per_page greater than 100", async () => {
    const res = await GET(makeRequest({ per_page: "101" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns empty runs when table is empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[0]], columns: ["count"] })
      .mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.runs).toHaveLength(0);
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("connection failed"));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("DB_QUERY");
    expect(body.requestId).toBeDefined();
  });

  it("handles null finished_at and duration_ms", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[1]], columns: ["count"] })
      .mockResolvedValueOnce({
        rows: [[1, new Date("2026-04-10T02:00:00Z"), null, null, "running", null, null, null, null, "manual"]],
        columns: [],
      });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.runs[0].finished_at).toBeNull();
    expect(body.runs[0].duration_ms).toBeNull();
    expect(body.runs[0].trigger).toBe("manual");
  });

  // Risk: RISK-ORCH-DB-PARTIAL — count query succeeds but paginated SELECT fails;
  // the catch block must still return a structured 500 (not an unhandled exception).
  it("returns 500 when paginated SELECT fails after count succeeds", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[5]], columns: ["count"] })
      .mockRejectedValueOnce(new Error("connection reset"));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("DB_QUERY");
    expect(body.requestId).toBeDefined();
  });
});
