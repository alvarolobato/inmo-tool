// @vitest-environment node
/**
 * Unit tests for GET /api/admin/interactions
 * Mocks @/lib/db-write so no real DB connection is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const ADMIN_KEY = "test-admin-key";

function makeRequest(
  opts: {
    adminKey?: string;
    search?: string;
  } = {},
): NextRequest {
  const url = `http://localhost:4000/api/admin/interactions${opts.search ?? ""}`;
  const headers: Record<string, string> = {};
  if (opts.adminKey) {
    headers["x-admin-key"] = opts.adminKey;
  }
  return new NextRequest(url, { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/interactions", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_API_KEY", ADMIN_KEY);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid admin key", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 400 on invalid endpoint filter", async () => {
    const res = await GET(
      makeRequest({ adminKey: ADMIN_KEY, search: "?endpoint=badvalue" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
    expect(body.error).toContain("endpoint");
  });

  it("returns 200 with interactions array on valid request", async () => {
    const fakeRows = [
      {
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
      },
    ];
    mockSql.mockResolvedValue(fakeRows);

    const res = await GET(makeRequest({ adminKey: ADMIN_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.interactions)).toBe(true);
    expect(body.interactions).toHaveLength(1);
    expect(body.returned).toBe(1);
    // `total` should not be present (renamed to `returned`)
    expect(body.total).toBeUndefined();
  });
});
