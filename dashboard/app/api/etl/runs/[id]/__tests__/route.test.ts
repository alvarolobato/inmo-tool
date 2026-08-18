// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";
import { NextRequest } from "next/server";

const mockQuery = vi.mocked(query);

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:4000/api/etl/runs/1");
}

// id, started_at, finished_at, duration_ms, status, total_connectors,
// connectors_ok, connectors_failed, connectors_skipped, trigger,
// total_discovered, total_fetched (the last two aggregated by the route's
// LATERAL join, not stored on connector_runs).
const MOCK_RUN_ROW = [
  1,
  new Date("2026-04-10T02:00:00Z"),
  new Date("2026-04-10T03:00:00Z"),
  3600000,
  "success",
  2,
  2,
  0,
  0,
  "scheduled",
  72,
  45,
];

// id, connector_name, started_at, finished_at, status, discovered_count,
// fetched_count, error_count, error_msg, failure_classification (#242),
// geography_scope (#109), extraction_quality_summary (#171), duration_ms (derived last).
const MOCK_CONNECTOR_ROWS = [
  [1, "fotocasa", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:15:00Z"), "ok", 31, 28, 3, null, null, [{ scope_key: "madrid", center: [40.4, -3.7], radius_km: 10, rooms: null, outcome: "crawled" }], { n: 28, mean_score: 0.88, grade_histogram: { A: 20, B: 6, C: 2, F: 0 }, low_quality_count: 2, weights_version: 1, trend: { baseline_mean: 0.86, baseline_n_runs: 4, delta: 0.02, degraded: false } }, 900000],
  [2, "milanuncios", new Date("2026-04-10T02:15:00Z"), new Date("2026-04-10T03:00:00Z"), "ok", 41, 17, 0, null, null, null, null, 2700000],
];

describe("GET /api/etl/runs/[id]", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns run detail with per-connector results", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: MOCK_CONNECTOR_ROWS, columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.run.id).toBe(1);
    expect(body.run.status).toBe("success");
    expect(body.run.trigger).toBe("scheduled");
    expect(body.run.total_discovered).toBe(72);
    expect(body.run.total_fetched).toBe(45);
    expect(body.connectors).toHaveLength(2);
    expect(body.connectors[0].connector_name).toBe("fotocasa");
    expect(body.connectors[0].discovered_count).toBe(31);
    expect(body.connectors[0].fetched_count).toBe(28);
    expect(body.connectors[0].error_count).toBe(3);
    expect(body.connectors[0].duration_ms).toBe(900000);
    // #242 + #109: the typed classification and resolved geography pass through.
    expect(body.connectors[0].failure_classification).toBeNull();
    // #530: the mock row above predates profile_ids (a historical JSONB entry) —
    // the read boundary defaults the missing field to [] (never null/undefined),
    // so a (connector × profile) consumer can always read `.profile_ids`.
    expect(body.connectors[0].geography_scope).toEqual([
      { scope_key: "madrid", center: [40.4, -3.7], radius_km: 10, rooms: null, outcome: "crawled", profile_ids: [] },
    ]);
    expect(body.connectors[1].connector_name).toBe("milanuncios");
    expect(body.connectors[1].geography_scope).toBeNull();
    // #171: the extraction-quality aggregate + trend passes through as a parsed
    // object; null when the row has none.
    expect(body.connectors[0].extraction_quality_summary).toEqual({
      n: 28, mean_score: 0.88, grade_histogram: { A: 20, B: 6, C: 2, F: 0 },
      low_quality_count: 2, weights_version: 1,
      trend: { baseline_mean: 0.86, baseline_n_runs: 4, delta: 0.02, degraded: false },
    });
    expect(body.connectors[1].extraction_quality_summary).toBeNull();
  });

  it("passes through profile_ids attribution on geography scopes (#530)", async () => {
    const attributedConnector = [4, "fotocasa", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:15:00Z"), "ok", 5, 5, 0, null, null, [{ scope_key: "madrid", center: [40.4, -3.7], radius_km: 10, rooms: null, outcome: "crawled", profile_ids: [7, 9] }], null, 900000];
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [attributedConnector], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // A scope shared by two profiles keeps both ids (crawled once, names both) —
    // the shape #531/#532 read to build a (connector × profile) view.
    expect(body.connectors[0].geography_scope[0].profile_ids).toEqual([7, 9]);
  });

  it("returns 404 when run not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest(), makeContext("99999"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 400 for non-numeric ID", async () => {
    const res = await GET(makeRequest(), makeContext("abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 for zero ID", async () => {
    const res = await GET(makeRequest(), makeContext("0"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative ID", async () => {
    const res = await GET(makeRequest(), makeContext("-1"));
    expect(res.status).toBe(400);
  });

  // Risk: RISK-ORCH-VALIDATION — decimal strings like "1.5" must not parse as valid integer IDs
  it("returns 400 for decimal ID (e.g. 1.5)", async () => {
    const res = await GET(makeRequest(), makeContext("1.5"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns empty connectors array when run has no result rows", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connectors).toHaveLength(0);
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("DB_QUERY");
  });

  it("returns connector with error_msg when status is failed", async () => {
    const failedConnector = [3, "idealista", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:01:00Z"), "failed", 0, 0, 1, "Connection timeout", "network", [{ scope_key: "madrid", center: null, radius_km: null, rooms: null, outcome: "failed" }], null, 60000];
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [failedConnector], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connectors[0].status).toBe("failed");
    expect(body.connectors[0].error_msg).toBe("Connection timeout");
    expect(body.connectors[0].failure_classification).toBe("network");
    expect(body.connectors[0].geography_scope[0].outcome).toBe("failed");
  });

  it("passes through the circuit_open and skipped statuses", async () => {
    // Neither exists in the per-table model this route was inherited from;
    // a route that silently dropped or coerced them would make a tripped
    // breaker and an operator-disabled connector both look like plain 'ok'.
    const rows = [
      [4, "fotocasa", new Date("2026-04-10T02:00:00Z"), new Date("2026-04-10T02:05:00Z"), "circuit_open", 31, 4, 8, "circuit breaker open after 8/10 errors", "structure_change", null, null, 300000],
      [5, "milanuncios", new Date("2026-04-10T02:05:00Z"), new Date("2026-04-10T02:05:00Z"), "skipped", 0, 0, 0, "disabled via connector_config", null, null, null, 0],
    ];
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows, columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connectors[0].status).toBe("circuit_open");
    expect(body.connectors[1].status).toBe("skipped");
    expect(body.connectors[1].error_msg).toBe("disabled via connector_config");
  });

  it("tolerates a null duration when a connector never finished", async () => {
    const unfinished = [6, "fotocasa", new Date("2026-04-10T02:00:00Z"), null, "failed", 0, 0, 0, "killed mid-run", "other", null, null, null];
    mockQuery
      .mockResolvedValueOnce({ rows: [MOCK_RUN_ROW], columns: [] })
      .mockResolvedValueOnce({ rows: [unfinished], columns: [] });

    const res = await GET(makeRequest(), makeContext("1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connectors[0].duration_ms).toBeNull();
    expect(body.connectors[0].finished_at).toBeNull();
  });
});
