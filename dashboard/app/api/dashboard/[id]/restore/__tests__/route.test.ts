import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPoolQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      query = mockPoolQuery;
      end = mockEnd;
      connect = vi.fn().mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
      });
    },
  };
});

import { POST } from "../route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

const TARGET_SPEC = {
  title: "Restored",
  widgets: [{ type: "table" as const, title: "T", sql: "SELECT 1" }],
};

const CURRENT_SPEC = {
  title: "Current",
  widgets: [{ type: "table" as const, title: "T2", sql: "SELECT 2" }],
};

const RETURNING_ROW = {
  id: 1,
  name: "Sales",
  description: null,
  spec: TARGET_SPEC,
  created_at: "2026-04-01T10:00:00Z",
  updated_at: "2026-04-18T12:00:00Z",
};

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboard/1/restore", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/dashboard/[id]/restore", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockClear();
    mockEnd.mockClear();
    await resetPool();
  });

  it("restores spec, appends current spec as new version, and returns dashboard", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 10, spec: TARGET_SPEC, version_number: 2 }],
      }) // target version
      .mockResolvedValueOnce({
        rows: [{ spec: CURRENT_SPEC }],
      }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT version
      .mockResolvedValueOnce({ rows: [RETURNING_ROW] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await POST(makePostRequest({ version_id: 10 }), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.spec).toEqual(TARGET_SPEC);

    expect(mockClientQuery.mock.calls[0][0]).toBe("BEGIN");

    const insertCall = mockClientQuery.mock.calls[3];
    expect(insertCall[0]).toContain("INSERT INTO dashboard_versions");
    expect(insertCall[1][0]).toBe(1);
    expect(JSON.parse(insertCall[1][1] as string)).toEqual(CURRENT_SPEC);
    expect(insertCall[1][2]).toBe("Restauración a versión 2");

    const updateCall = mockClientQuery.mock.calls[4];
    expect(updateCall[0]).toContain("UPDATE dashboards");
    expect(JSON.parse(updateCall[1][0] as string)).toEqual(TARGET_SPEC);

    expect(mockClientQuery.mock.calls[5][0]).toBe("COMMIT");
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("returns 404 when version not found or wrong dashboard", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // target
      .mockResolvedValueOnce({ rows: [] }); // COMMIT (withTransaction always commits unless fn throws)

    const res = await POST(makePostRequest({ version_id: 99 }), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
  });

  it("returns 404 when dashboard row missing after version found", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 10, spec: TARGET_SPEC, version_number: 1 }],
      })
      .mockResolvedValueOnce({ rows: [] }) // dashboard missing
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await POST(makePostRequest({ version_id: 10 }), makeContext("1"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when version_id is missing", async () => {
    const res = await POST(makePostRequest({}), makeContext("1"));
    expect(res.status).toBe(400);
    expect(mockClientRelease).not.toHaveBeenCalled();
  });

  it("returns 400 when version_id is not a positive integer", async () => {
    const res = await POST(makePostRequest({ version_id: "10" }), makeContext("1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when stored spec fails schema validation", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 10, spec: { title: "Sin widgets" }, version_number: 1 }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await POST(makePostRequest({ version_id: 10 }), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("VALIDATION");
  });

  it("returns 400 when stored spec fails SQL lint", async () => {
    const badLintSpec = {
      title: "Lint",
      widgets: [
        {
          type: "table" as const,
          title: "T",
          sql: "SELECT EXTRACT(days FROM CURRENT_DATE)",
        },
      ],
    };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 10, spec: badLintSpec, version_number: 1 }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await POST(makePostRequest({ version_id: 10 }), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("SQL_LINT");
  });

  it("returns 400 for invalid dashboard id", async () => {
    const res = await POST(makePostRequest({ version_id: 1 }), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new NextRequest("http://localhost:4000/api/dashboard/1/restore", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, makeContext("1"));
    expect(res.status).toBe(400);
  });

  it("returns 500 on database error", async () => {
    mockClientQuery.mockRejectedValue(new Error("db error"));

    const res = await POST(makePostRequest({ version_id: 1 }), makeContext("1"));
    expect(res.status).toBe(500);
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
