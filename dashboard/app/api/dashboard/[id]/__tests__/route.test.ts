import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg module before importing anything that uses it.
// PUT uses pool.connect() for transactions; GET/DELETE use the sql() helper which calls pool.query().
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

import { GET, PUT, DELETE } from "../route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

const VALID_SPEC = {
  title: "Test Dashboard",
  widgets: [
    { type: "table", title: "T", sql: "SELECT 1" },
  ],
};

const UPDATED_SPEC = {
  title: "Updated Dashboard",
  widgets: [
    { type: "table", title: "T2", sql: "SELECT 2" },
  ],
};

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeGetRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboard/1", {
    method: "GET",
  });
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboard/1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboard/1", {
    method: "DELETE",
  });
}

describe("GET /api/dashboard/[id]", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockClear();
    mockEnd.mockClear();
    await resetPool();
  });

  it("returns a dashboard when found", async () => {
    const dashboard = {
      id: 1,
      name: "Sales",
      description: "Sales panel",
      spec: VALID_SPEC,
      created_at: "2026-04-04T10:00:00Z",
      updated_at: "2026-04-04T10:00:00Z",
    };
    mockPoolQuery.mockResolvedValue({ rows: [dashboard] });

    const res = await GET(makeGetRequest(), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe(1);
    expect(json.name).toBe("Sales");
    expect(json.spec).toEqual(VALID_SPEC);
  });

  it("returns 404 when not found", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await GET(makeGetRequest(), makeContext("999"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 for non-integer ID", async () => {
    const res = await GET(makeGetRequest(), makeContext("abc"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("VALIDATION");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 for zero ID", async () => {
    const res = await GET(makeGetRequest(), makeContext("0"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative ID", async () => {
    const res = await GET(makeGetRequest(), makeContext("-1"));
    expect(res.status).toBe(400);
  });

  it("returns 500 on database error", async () => {
    mockPoolQuery.mockRejectedValue(new Error("db down"));

    const res = await GET(makeGetRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/dashboard/[id]", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockClear();
    mockEnd.mockClear();
    await resetPool();
  });

  it("updates dashboard and saves old spec as version in a transaction", async () => {
    // Transaction calls: BEGIN, SELECT FOR UPDATE, INSERT version, UPDATE dashboard, COMMIT
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, spec: VALID_SPEC }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT version
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          name: "Sales",
          description: null,
          spec: UPDATED_SPEC,
          created_at: "2026-04-04T10:00:00Z",
          updated_at: "2026-04-04T11:00:00Z",
        }],
      }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await PUT(makePutRequest({ spec: UPDATED_SPEC }), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.spec).toEqual(UPDATED_SPEC);

    // Verify BEGIN was called
    expect(mockClientQuery.mock.calls[0][0]).toBe("BEGIN");

    // Verify SELECT FOR UPDATE
    expect(mockClientQuery.mock.calls[1][0]).toContain("FOR UPDATE");

    // Verify version was saved with old spec
    const versionInsertCall = mockClientQuery.mock.calls[2];
    expect(versionInsertCall[0]).toContain("INSERT INTO dashboard_versions");
    expect(versionInsertCall[1][0]).toBe(1); // dashboard_id
    expect(JSON.parse(versionInsertCall[1][1] as string)).toEqual(VALID_SPEC); // old spec

    // Verify COMMIT was called
    expect(mockClientQuery.mock.calls[4][0]).toBe("COMMIT");

    // Verify client was released
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("saves prompt in version when provided", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, spec: VALID_SPEC }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT version
      .mockResolvedValueOnce({
        rows: [{
          id: 1, name: "S", description: null, spec: UPDATED_SPEC,
          created_at: "2026-04-04T10:00:00Z", updated_at: "2026-04-04T11:00:00Z",
        }],
      }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await PUT(
      makePutRequest({ spec: UPDATED_SPEC, prompt: "Add margins" }),
      makeContext("1"),
    );

    const versionInsertCall = mockClientQuery.mock.calls[2];
    expect(versionInsertCall[1][2]).toBe("Add margins"); // prompt
  });

  it("returns 404 when dashboard not found", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (not found)
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await PUT(makePutRequest({ spec: UPDATED_SPEC }), makeContext("999"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 for missing spec", async () => {
    const res = await PUT(makePutRequest({}), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("spec");
  });

  it("returns 400 for invalid spec", async () => {
    const res = await PUT(
      makePutRequest({ spec: { title: "No widgets" } }),
      makeContext("1"),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("VALIDATION");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 for non-integer ID", async () => {
    const res = await PUT(makePutRequest({ spec: UPDATED_SPEC }), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost:4000/api/dashboard/1", {
      method: "PUT",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, makeContext("1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string prompt", async () => {
    const res = await PUT(
      makePutRequest({ spec: UPDATED_SPEC, prompt: 123 }),
      makeContext("1"),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("prompt");
  });

  it("returns 500 on database error during update", async () => {
    mockClientQuery.mockRejectedValue(new Error("db error"));

    const res = await PUT(makePutRequest({ spec: UPDATED_SPEC }), makeContext("1"));
    expect(res.status).toBe(500);

    // Verify client was released even on error
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

describe("DELETE /api/dashboard/[id]", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockClear();
    mockEnd.mockClear();
    await resetPool();
  });

  it("deletes an existing dashboard and returns 204", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 1 }] });

    const res = await DELETE(makeDeleteRequest(), makeContext("1"));

    expect(res.status).toBe(204);
  });

  it("returns 404 when dashboard not found", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const res = await DELETE(makeDeleteRequest(), makeContext("999"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
    expect(json.requestId).toBeDefined();
  });

  it("returns 400 for non-integer ID", async () => {
    const res = await DELETE(makeDeleteRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for float ID", async () => {
    const res = await DELETE(makeDeleteRequest(), makeContext("1.5"));
    expect(res.status).toBe(400);
  });

  it("returns 500 on database error", async () => {
    mockPoolQuery.mockRejectedValue(new Error("db error"));

    const res = await DELETE(makeDeleteRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});
