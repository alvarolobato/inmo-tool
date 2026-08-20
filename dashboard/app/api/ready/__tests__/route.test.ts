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

// A freshness query result row shape. Issue #295 (D-050): staleness now derives
// from connector_freshness_state, so the query returns last_fresh_at /
// cycle_started_at rather than a per-run last_success_at. This helper keeps the
// test cases phrased in terms of "last fresh N hours ago, no cycle" (the common
// case) by mapping `last_success_at` → the new `last_fresh_at` column and
// defaulting the cycle columns to idle.
function freshnessRows(
  rows: Array<{
    connector: string;
    enabled: boolean;
    last_success_at: Date | null;
    last_run_at: Date | null;
    last_run_status: string | null;
    cycle_started_at?: Date | null;
    cycle_target_scope_count?: number | null;
    covered_scope_count?: number | null;
    freshness_interval_hours?: number | null;
    // Issue #586 — every real row is `supports_discovery=true` (a crawl
    // connector) unless a test explicitly says otherwise; a real DB row is
    // NEVER missing this (NOT NULL DEFAULT true in the schema), so mocks
    // default it the same way rather than leaving it undefined.
    supports_discovery?: boolean;
    capture_enabled?: boolean;
    last_capture_done_at?: Date | null;
  }>,
) {
  return {
    rows: rows.map((r) => ({
      connector: r.connector,
      enabled: r.enabled,
      supports_discovery: r.supports_discovery ?? true,
      capture_enabled: r.capture_enabled ?? true,
      freshness_interval_hours: r.freshness_interval_hours ?? null,
      last_fresh_at: r.last_success_at,
      cycle_started_at: r.cycle_started_at ?? null,
      cycle_target_scope_count: r.cycle_target_scope_count ?? null,
      covered_scope_count: r.covered_scope_count ?? 0,
      last_run_at: r.last_run_at,
      last_run_status: r.last_run_status,
      last_capture_done_at: r.last_capture_done_at ?? null,
    })),
    fields: [],
  };
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
    expect(body.overall_unknown).toBe(false);
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
    expect(body.overall_unknown).toBe(false);
    expect(body.stalest_connector).toBe("milanuncios");
  });

  it("returns status unknown (never 'ready') when nothing is in scope — fail dark, never fail green (issue #586)", async () => {
    mockQuery.mockResolvedValueOnce(okProbe()).mockResolvedValueOnce(
      freshnessRows([
        {
          // A crawl connector, deliberately turned off, with no capture
          // fallback (supports_discovery stays true) — nothing in scope to
          // honestly assert "is/isn't due" about.
          connector: "milanuncios",
          enabled: false,
          supports_discovery: true,
          last_success_at: null,
          last_run_at: null,
          last_run_status: null,
        },
      ]),
    );

    const res = await GET();
    // Readiness still gates ONLY on DB reachability — this must stay 200,
    // never flap the container over a staleness/scope question.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("unknown");
    expect(body.status).not.toBe("ready");
    expect(body.overall_unknown).toBe(true);
    expect(body.overall_stale).toBe(false);
    expect(body.stalest_connector).toBeNull();
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
    expect(body.overall_unknown).toBe(false);
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
    // A `note` (schema not applied) is its own explicit case — distinct
    // from `overall_unknown` (reachable, schema applied, nothing in scope).
    expect(body.status).toBe("ready");
    expect(body.overall_unknown).toBe(false);
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
