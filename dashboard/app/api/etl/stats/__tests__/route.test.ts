// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";

const mockQuery = vi.mocked(query);

// Mock returns data in DESC order (newest first), matching ORDER BY started_at DESC.
// Columns: started_at, duration_ms, status, total_discovered, total_fetched.
const MOCK_TREND_ROWS_DESC = [
  [new Date("2026-04-11T02:00:00Z"), null, "failed", null, null], // newest
  [new Date("2026-04-10T02:00:00Z"), 3600000, "success", 72, 46],
  [new Date("2026-04-09T02:00:00Z"), 3500000, "success", 70, 45], // oldest
];

const MOCK_CONNECTOR_DUR_ROWS = [
  ["milanuncios", 2700000, 2800000],
  ["fotocasa", 900000, 950000],
];

const MOCK_RATE_ROWS = [[30, 28, 1, 1]];

const MOCK_TOP_ROWS = [
  ["fotocasa", 28],
  ["milanuncios", 17],
  ["idealista", 3],
];

// id, duration_ms, total_discovered, total_fetched, fetch_rate
const MOCK_LAST_RUN = [[42, 3600000, 72, 46, 0.6389]];

const MOCK_ERRORS_24H = [[1, 2]];

function setupMocks() {
  mockQuery
    .mockResolvedValueOnce({ rows: MOCK_TREND_ROWS_DESC, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_CONNECTOR_DUR_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_RATE_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_TOP_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_LAST_RUN, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_ERRORS_24H, columns: [] });
}

describe("GET /api/etl/stats", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns all stats fields", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("duration_trend");
    expect(body).toHaveProperty("listings_trend");
    expect(body).toHaveProperty("connector_durations");
    expect(body).toHaveProperty("top_connectors_by_listings");
    expect(body).toHaveProperty("success_rate");
    expect(body).toHaveProperty("last_run");
    expect(body).toHaveProperty("errors_24h");
    // The watermark KPI is deliberately gone: it read etl_watermarks, a
    // table nothing writes since the per-table sync was removed.
    expect(body).not.toHaveProperty("watermarks");
  });

  it("duration_trend reversed to oldest-first for charting", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.duration_trend).toHaveLength(3);
    expect(body.duration_trend[0].started_at).toBe("2026-04-09T02:00:00.000Z");
    expect(body.duration_trend[2].started_at).toBe("2026-04-11T02:00:00.000Z");
    expect(body.duration_trend[2].duration_ms).toBeNull();
    expect(body.duration_trend[2].status).toBe("failed");
  });

  it("listings_trend reversed to oldest-first, carrying both funnel series", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.listings_trend).toHaveLength(3);
    expect(body.listings_trend[0].started_at).toBe("2026-04-09T02:00:00.000Z");
    expect(body.listings_trend[0].discovered).toBe(70);
    expect(body.listings_trend[0].fetched).toBe(45);
    expect(body.listings_trend[2].started_at).toBe("2026-04-11T02:00:00.000Z");
    expect(body.listings_trend[2].discovered).toBeNull();
  });

  it("success_rate has correct totals", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.success_rate.total).toBe(30);
    expect(body.success_rate.success).toBe(28);
    expect(body.success_rate.partial).toBe(1);
    expect(body.success_rate.failed).toBe(1);
  });

  it("connector_durations sorted by avg_duration_ms DESC", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.connector_durations[0].connector_name).toBe("milanuncios");
    expect(body.connector_durations[0].avg_duration_ms).toBe(2700000);
    expect(body.connector_durations[1].connector_name).toBe("fotocasa");
  });

  it("top_connectors_by_listings preserves server order and counts", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.top_connectors_by_listings).toHaveLength(3);
    expect(body.top_connectors_by_listings[0]).toEqual({
      connector_name: "fotocasa",
      fetched_count: 28,
    });
    expect(body.top_connectors_by_listings[2]).toEqual({
      connector_name: "idealista",
      fetched_count: 3,
    });
  });

  it("last_run exposes the funnel totals and fetch rate", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.last_run.run_id).toBe(42);
    expect(body.last_run.duration_ms).toBe(3600000);
    expect(body.last_run.total_discovered).toBe(72);
    expect(body.last_run.total_fetched).toBe(46);
    expect(body.last_run.fetch_rate).toBeCloseTo(0.6389);
  });

  it("errors_24h returns runs_failed and connectors_failed", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.errors_24h.runs_failed).toBe(1);
    expect(body.errors_24h.connectors_failed).toBe(2);
  });

  it("handles empty runs table gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], columns: [] }) // trend
      .mockResolvedValueOnce({ rows: [], columns: [] }) // connector durations
      .mockResolvedValueOnce({ rows: [[0, 0, 0, 0]], columns: [] }) // rate
      .mockResolvedValueOnce({ rows: [], columns: [] }) // top connectors
      .mockResolvedValueOnce({ rows: [], columns: [] }) // last run
      .mockResolvedValueOnce({ rows: [[0, 0]], columns: [] }); // errors

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.duration_trend).toHaveLength(0);
    expect(body.success_rate.total).toBe(0);
    expect(body.top_connectors_by_listings).toHaveLength(0);
    expect(body.last_run.run_id).toBeNull();
    expect(body.last_run.fetch_rate).toBeNull();
    expect(body.errors_24h.runs_failed).toBe(0);
  });

  it("returns 500 on database error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("DB_QUERY");
    expect(body.requestId).toBeDefined();
  });

  it("defaults success_rate to zeros when rate query returns no rows", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] }) // no rate row
      .mockResolvedValueOnce({ rows: [], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] })
      .mockResolvedValueOnce({ rows: [], columns: [] });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success_rate.total).toBe(0);
    expect(body.success_rate.success).toBe(0);
    expect(body.success_rate.partial).toBe(0);
    expect(body.success_rate.failed).toBe(0);
    expect(body.errors_24h.runs_failed).toBe(0);
    expect(body.errors_24h.connectors_failed).toBe(0);
  });
});
