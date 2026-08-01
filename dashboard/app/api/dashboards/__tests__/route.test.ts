import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg module before importing anything that uses it
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

import { GET, POST } from "../route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboards", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_SPEC = {
  title: "Test Dashboard",
  widgets: [
    { type: "table", title: "T", sql: "SELECT 1" },
  ],
};

describe("GET /api/dashboards", () => {
  beforeEach(async () => {
    mockQuery.mockReset();
    mockEnd.mockClear();
    await resetPool();
  });

  it("returns empty array when no dashboards exist", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it("returns dashboards ordered by updated_at DESC", async () => {
    const dashboards = [
      { id: 2, name: "Second", description: null, updated_at: "2026-04-04T10:00:00Z" },
      { id: 1, name: "First", description: "Desc", updated_at: "2026-04-03T10:00:00Z" },
    ];
    mockQuery.mockResolvedValue({ rows: dashboards });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].id).toBe(2);
    expect(json[1].id).toBe(1);
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("connection failed"));

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBeDefined();
    expect(json.code).toBe("DB_QUERY");
    expect(json.requestId).toBeDefined();
  });
});

describe("POST /api/dashboards", () => {
  beforeEach(async () => {
    mockQuery.mockReset();
    mockEnd.mockClear();
    await resetPool();
  });

  it("creates a dashboard with valid data", async () => {
    const created = {
      id: 1,
      name: "My Dashboard",
      description: null,
      spec: VALID_SPEC,
      created_at: "2026-04-04T10:00:00Z",
      updated_at: "2026-04-04T10:00:00Z",
    };
    mockQuery.mockResolvedValue({ rows: [created] });

    const res = await POST(makeRequest({ name: "My Dashboard", spec: VALID_SPEC }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.id).toBe(1);
    expect(json.name).toBe("My Dashboard");
  });

  it("creates a dashboard with description", async () => {
    const created = {
      id: 2,
      name: "Sales",
      description: "Sales panel",
      spec: VALID_SPEC,
      created_at: "2026-04-04T10:00:00Z",
      updated_at: "2026-04-04T10:00:00Z",
    };
    mockQuery.mockResolvedValue({ rows: [created] });

    const res = await POST(
      makeRequest({ name: "Sales", description: "Sales panel", spec: VALID_SPEC }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.description).toBe("Sales panel");
  });

  it("rejects missing name with 400", async () => {
    const res = await POST(makeRequest({ spec: VALID_SPEC }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("name");
  });

  it("rejects empty name with 400", async () => {
    const res = await POST(makeRequest({ name: "", spec: VALID_SPEC }));
    expect(res.status).toBe(400);
  });

  it("rejects missing spec with 400", async () => {
    const res = await POST(makeRequest({ name: "Test" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("spec");
  });

  it("rejects invalid spec with 400", async () => {
    const res = await POST(
      makeRequest({ name: "Test", spec: { title: "No widgets" } }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.code).toBe("VALIDATION");
    expect(json.details).toBeDefined();
  });

  it("rejects invalid JSON body with 400", async () => {
    const req = new NextRequest("http://localhost:4000/api/dashboards", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects array body with 400", async () => {
    const res = await POST(makeRequest([1, 2, 3]));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("VALIDATION");
    expect(json.requestId).toBeDefined();
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("insert failed"));

    const res = await POST(makeRequest({ name: "Test", spec: VALID_SPEC }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBeDefined();
    expect(json.code).toBe("DB_QUERY");
    expect(json.requestId).toBeDefined();
  });
});
