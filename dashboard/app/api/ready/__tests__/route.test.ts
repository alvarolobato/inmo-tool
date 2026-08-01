import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
}));

import { GET } from "../route";
import { resetPool } from "@/lib/db";

describe("GET /api/ready", () => {
  beforeEach(async () => {
    mockQuery.mockReset();
    mockEnd.mockClear();
    delete process.env.READY_CHECK_BUDGET_MS;
    await resetPool();
  });

  afterEach(() => {
    delete process.env.READY_CHECK_BUDGET_MS;
  });

  it("returns 200 ready when postgres and watermarks respond", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    mockQuery.mockResolvedValueOnce({ rows: [[1]], fields: [] }).mockResolvedValueOnce({
      rows: [
        ["ventas", twoHoursAgo],
        ["articulos", oneHourAgo],
      ],
      fields: [],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.postgres).toBe("ok");
    expect(body.watermarks).toBe(2);
    expect(typeof body.overall_stale).toBe("boolean");
  });

  it("returns status degraded when any watermark is stale", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    mockQuery.mockResolvedValueOnce({ rows: [[1]], fields: [] }).mockResolvedValueOnce({
      rows: [
        ["ventas", old],
        ["articulos", new Date("2026-01-02T00:00:00.000Z")],
      ],
      fields: [],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.overall_stale).toBe(true);
  });

  it("returns 200 ready when etl_watermarks is missing (42P01)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [[1]], fields: [] })
      .mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.note).toBe("etl_watermarks missing");
    expect(body.watermarks).toBe(0);
  });

  it("returns 503 when the postgres connection fails", async () => {
    mockQuery.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not_ready");
    expect(body.postgres).toBe("error");
  });

  it("returns 503 when checks exceed the time budget", async () => {
    process.env.READY_CHECK_BUDGET_MS = "80";
    mockQuery.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not_ready");
    expect(body.detail).toMatch(/budget|time/i);
  });
});
