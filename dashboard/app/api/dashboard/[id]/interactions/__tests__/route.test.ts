// @vitest-environment node
/**
 * Unit tests for GET /api/dashboard/[id]/interactions
 * Mocks @/lib/db-write so no real DB connection is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock DB before importing the route
// ---------------------------------------------------------------------------

vi.mock("@/lib/db-write", () => ({
  sql: vi.fn(),
}));

import { GET } from "../route";
import * as dbWrite from "@/lib/db-write";

const mockSql = vi.mocked(dbWrite.sql);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RouteContext = { params: Promise<{ id: string }> };

function makeRequest(id: string): [NextRequest, RouteContext] {
  const req = new NextRequest(
    `http://localhost:4000/api/dashboard/${id}/interactions`,
  );
  const ctx: RouteContext = { params: Promise.resolve({ id }) };
  return [req, ctx];
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "uuid-1",
    request_id: "req_abc",
    endpoint: "generate",
    dashboard_id: 1,
    prompt: "Crea un dashboard",
    final_output: null,
    lines: [],
    llm_provider: "openrouter",
    llm_driver: null,
    started_at: "2026-04-24T10:00:00Z",
    finished_at: null,
    status: "completed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/[id]/interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 on invalid dashboard id (non-numeric)", async () => {
    const [req, ctx] = makeRequest("abc");
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 on invalid dashboard id (zero)", async () => {
    const [req, ctx] = makeRequest("0");
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 200 with interactions ordered by started_at DESC", async () => {
    const rows = [
      makeRow({ started_at: "2026-04-24T12:00:00Z", request_id: "req_newer" }),
      makeRow({ started_at: "2026-04-24T10:00:00Z", request_id: "req_older" }),
    ];
    mockSql.mockResolvedValue(rows);

    const [req, ctx] = makeRequest("1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.interactions)).toBe(true);
    // First result is newest (DESC order from DB — we trust the DB ordering)
    expect(body.interactions[0].request_id).toBe("req_newer");
    expect(typeof body.has_more).toBe("boolean");
  });

  it("sets has_more=false when fewer than 20 rows returned", async () => {
    mockSql.mockResolvedValue([makeRow()]);

    const [req, ctx] = makeRequest("1");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(body.has_more).toBe(false);
  });

  it("returns 500 structured error response on DB failure", async () => {
    mockSql.mockRejectedValue(new Error("connection refused"));

    const [req, ctx] = makeRequest("5");
    const res = await GET(req, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    // Must follow the structured ApiError format
    expect(body.code).toBeDefined();
    expect(typeof body.error).toBe("string");
    expect(typeof body.requestId).toBe("string");
  });
});
