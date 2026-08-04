import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
  // db-shared.ts (#155) registers the int8 type parser at module load —
  // the mock needs a minimal stand-in so that import doesn't throw.
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

import { GET } from "../route";
import { resetPool } from "@/lib/db";
import { resetPool as resetWritePool } from "@/lib/db-write";

const HOUR = 60 * 60 * 1000;

// The route runs two queries in order: db.query("SELECT 1") on the read pool,
// then the connector-freshness query on the write pool (db-write.sql). Both
// hit the same mock; queue the connectivity probe first, freshness second.
function okProbe() {
  return { rows: [[1]], fields: [] };
}

// A freshness query result row shape (named columns — db-write.sql returns
// result.rows verbatim).
function freshnessRows(
  rows: Array<{
    connector: string;
    enabled: boolean;
    last_success_at: Date | null;
    last_run_at: Date | null;
    last_run_status: string | null;
  }>,
) {
  return { rows, fields: [] };
}

describe("GET /api/ready", () => {
  beforeEach(async () => {
    mockQuery.mockReset();
    mockEnd.mockClear();
    delete process.env.READY_CHECK_BUDGET_MS;
    delete process.env.FRESHNESS_STALE_THRESHOLD_HOURS;
    await resetPool();
    await resetWritePool();
  });

  afterEach(() => {
    delete process.env.READY_CHECK_BUDGET_MS;
    delete process.env.FRESHNESS_STALE_THRESHOLD_HOURS;
  });

  it("returns 200 ready when postgres and connector tables respond fresh", async () => {
    const now = Date.now();
    mockQuery.mockResolvedValueOnce(okProbe()).mockResolvedValueOnce(
      freshnessRows([
        {
          connector: "fotocasa",
          enabled: true,
          last_success_at: new Date(now - 1 * HOUR),
          last_run_at: new Date(now - 1 * HOUR),
          last_run_status: "ok",
        },
      ]),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.postgres).toBe("ok");
    expect(body.connectors).toBe(1);
    expect(body.overall_stale).toBe(false);
    expect(body.stalest_connector).toBe("fotocasa");
    expect(typeof body.freshest_success_at).toBe("string");
  });

  it("returns status degraded when an enabled connector is stale", async () => {
    const now = Date.now();
    mockQuery.mockResolvedValueOnce(okProbe()).mockResolvedValueOnce(
      freshnessRows([
        {
          connector: "milanuncios",
          enabled: true,
          last_success_at: new Date(now - 40 * HOUR), // > 24h default
          last_run_at: new Date(now - 1 * HOUR),
          last_run_status: "failed",
        },
      ]),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.overall_stale).toBe(true);
    expect(body.stalest_connector).toBe("milanuncios");
  });

  it("ignores disabled connectors for the stale headline", async () => {
    const now = Date.now();
    mockQuery.mockResolvedValueOnce(okProbe()).mockResolvedValueOnce(
      freshnessRows([
        {
          connector: "idealista",
          enabled: false,
          last_success_at: new Date(now - 100 * HOUR),
          last_run_at: new Date(now - 100 * HOUR),
          last_run_status: "ok",
        },
        {
          connector: "fotocasa",
          enabled: true,
          last_success_at: new Date(now - 1 * HOUR),
          last_run_at: new Date(now - 1 * HOUR),
          last_run_status: "ok",
        },
      ]),
    );

    const res = await GET();
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.overall_stale).toBe(false);
    // Only the enabled connector drives the headline.
    expect(body.stalest_connector).toBe("fotocasa");
  });

  it("returns 200 ready with a note when connector tables are missing (42P01)", async () => {
    mockQuery
      .mockResolvedValueOnce(okProbe())
      .mockRejectedValueOnce(
        Object.assign(new Error("relation does not exist"), { code: "42P01" }),
      );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.note).toBe("connector tables missing");
    expect(body.connectors).toBe(0);
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
