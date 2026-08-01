// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";

const mockQuery = vi.mocked(query);

// Mock returns data in DESC order (newest first), matching ORDER BY started_at DESC.
// Columns: started_at, duration_ms, status, total_rows_synced.
const MOCK_TREND_ROWS_DESC = [
  [new Date("2026-04-11T02:00:00Z"), null, "failed", null], // newest
  [new Date("2026-04-10T02:00:00Z"), 3600000, "success", 46000],
  [new Date("2026-04-09T02:00:00Z"), 3500000, "success", 45000], // oldest
];

const MOCK_TABLE_DUR_ROWS = [
  ["stock", 2700000, 2800000],
  ["ventas", 900000, 950000],
];

const MOCK_RATE_ROWS = [[30, 28, 1, 1]];

const MOCK_TOP_ROWS = [
  ["ps_stock_tienda", 12_300_000],
  ["ps_lineas_ventas", 1_700_000],
  ["ps_ventas", 911_000],
];

const MOCK_LAST_RUN = [[42, 3600000, 46000, 12.78]];

const MOCK_WATERMARK = [["ps_stock", 90_000]];

const MOCK_ERRORS_24H = [[1, 2]];

function setupMocks() {
  mockQuery
    .mockResolvedValueOnce({ rows: MOCK_TREND_ROWS_DESC, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_TABLE_DUR_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_RATE_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_TOP_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_LAST_RUN, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_WATERMARK, columns: [] })
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
    expect(body).toHaveProperty("rows_trend");
    expect(body).toHaveProperty("table_durations");
    expect(body).toHaveProperty("top_tables_by_rows");
    expect(body).toHaveProperty("success_rate");
    expect(body).toHaveProperty("last_run");
    expect(body).toHaveProperty("watermarks");
    expect(body).toHaveProperty("errors_24h");
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

  it("rows_trend reversed to oldest-first for charting", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.rows_trend).toHaveLength(3);
    expect(body.rows_trend[0].started_at).toBe("2026-04-09T02:00:00.000Z");
    expect(body.rows_trend[2].started_at).toBe("2026-04-11T02:00:00.000Z");
    expect(body.rows_trend[2].total_rows_synced).toBeNull();
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

  it("table_durations sorted by avg_duration_ms DESC", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.table_durations[0].table_name).toBe("stock");
    expect(body.table_durations[0].avg_duration_ms).toBe(2700000);
    expect(body.table_durations[1].table_name).toBe("ventas");
  });

  it("top_tables_by_rows preserves server order and row counts", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.top_tables_by_rows).toHaveLength(3);
    expect(body.top_tables_by_rows[0]).toEqual({
      table_name: "ps_stock_tienda",
      rows_synced: 12_300_000,
    });
    expect(body.top_tables_by_rows[2]).toEqual({
      table_name: "ps_ventas",
      rows_synced: 911_000,
    });
  });

  it("last_run exposes throughput and total rows", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.last_run.run_id).toBe(42);
    expect(body.last_run.duration_ms).toBe(3600000);
    expect(body.last_run.total_rows_synced).toBe(46000);
    expect(body.last_run.throughput_rows_per_sec).toBeCloseTo(12.78);
  });

  it("watermarks returns the oldest watermark age", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.watermarks.table_name).toBe("ps_stock");
    expect(body.watermarks.max_age_seconds).toBe(90_000);
  });

  it("errors_24h returns runs_failed and tables_failed", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(body.errors_24h.runs_failed).toBe(1);
    expect(body.errors_24h.tables_failed).toBe(2);
  });

  it("handles empty runs table gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], columns: [] }) // trend
      .mockResolvedValueOnce({ rows: [], columns: [] }) // table durations
      .mockResolvedValueOnce({ rows: [[0, 0, 0, 0]], columns: [] }) // rate
      .mockResolvedValueOnce({ rows: [], columns: [] }) // top rows
      .mockResolvedValueOnce({ rows: [], columns: [] }) // last run
      .mockResolvedValueOnce({ rows: [], columns: [] }) // watermarks
      .mockResolvedValueOnce({ rows: [[0, 0]], columns: [] }); // errors

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.duration_trend).toHaveLength(0);
    expect(body.success_rate.total).toBe(0);
    expect(body.top_tables_by_rows).toHaveLength(0);
    expect(body.last_run.run_id).toBeNull();
    expect(body.watermarks.max_age_seconds).toBeNull();
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
    expect(body.errors_24h.tables_failed).toBe(0);
  });
});
