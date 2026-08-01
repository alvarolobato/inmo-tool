import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPoolQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      query = mockPoolQuery;
      end = mockEnd;
      connect = vi.fn();
    },
  };
});

import { GET } from "../route";
import { resetPool } from "@/lib/db-write";
import { NextRequest } from "next/server";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/dashboard/1/versions", {
    method: "GET",
  });
}

describe("GET /api/dashboard/[id]/versions", () => {
  beforeEach(async () => {
    mockPoolQuery.mockReset();
    mockEnd.mockClear();
    await resetPool();
  });

  it("returns version list when dashboard exists", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 3,
            version_number: 3,
            prompt: "Añade el margen por familia",
            widget_count: 5,
            created_at: new Date("2026-04-18T10:23:00.000Z"),
          },
          {
            id: 2,
            version_number: 2,
            prompt: null,
            widget_count: 2,
            created_at: new Date("2026-04-17T10:00:00.000Z"),
          },
        ],
      });

    const res = await GET(makeRequest(), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
    expect(json[0].id).toBe(3);
    expect(json[0].version_number).toBe(3);
    expect(json[0].widget_count).toBe(5);
    expect(json[0].created_at).toBe("2026-04-18T10:23:00.000Z");
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when dashboard exists but has no versions", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it("returns 404 when dashboard not found", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(makeRequest(), makeContext("999"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid ID", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("VALIDATION");
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for zero ID", async () => {
    const res = await GET(makeRequest(), makeContext("0"));
    expect(res.status).toBe(400);
  });

  it("returns 500 on database error", async () => {
    mockPoolQuery.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(), makeContext("1"));
    expect(res.status).toBe(500);
  });
});
