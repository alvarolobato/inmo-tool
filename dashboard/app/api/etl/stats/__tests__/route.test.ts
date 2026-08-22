// @vitest-environment node
//
// #642 P2 shrank this endpoint from six aggregates to three: `duration_trend`,
// `listings_trend`, `connector_durations` and `top_connectors_by_listings`
// existed only to feed `EvolutionCharts`, which died with the `/etl` monitor
// page. The tests for them went with them rather than being left asserting a
// shape nothing renders. The three that remain feed the Estado board's
// `<CrawlRollup/>`.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { GET } from "../route";
import { query } from "@/lib/db";

const mockQuery = vi.mocked(query);

const MOCK_RATE_ROWS = [[30, 28, 1, 1]];

// id, duration_ms, total_discovered, total_fetched, fetch_rate
const MOCK_LAST_RUN = [[42, 3600000, 72, 46, 0.6389]];

const MOCK_ERRORS_24H = [[1, 2]];

/** Query order is rate → last run → errors; mocks must follow it. */
function setupMocks() {
  mockQuery
    .mockResolvedValueOnce({ rows: MOCK_RATE_ROWS, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_LAST_RUN, columns: [] })
    .mockResolvedValueOnce({ rows: MOCK_ERRORS_24H, columns: [] });
}

describe("GET /api/etl/stats", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns exactly the three aggregates the Estado rollup renders", async () => {
    setupMocks();
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["errors_24h", "last_run", "success_rate"]);
    // The chart aggregates are gone with `/etl` (#642 P2), not merely unused:
    // an endpoint that keeps computing four unread SELECTs per request is the
    // inherited dead weight this tracker exists to delete. Pinned so a future
    // change has to re-add them deliberately rather than by reflex.
    for (const gone of [
      "duration_trend",
      "listings_trend",
      "connector_durations",
      "top_connectors_by_listings",
    ]) {
      expect(body, `${gone} should be gone`).not.toHaveProperty(gone);
    }
    // The watermark KPI is deliberately gone too: it read etl_watermarks, a
    // table nothing writes since the per-table sync was removed.
    expect(body).not.toHaveProperty("watermarks");
  });

  it("issues exactly three queries", async () => {
    setupMocks();
    await GET();
    expect(mockQuery).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce({ rows: [[0, 0, 0, 0]], columns: [] }) // rate
      .mockResolvedValueOnce({ rows: [], columns: [] }) // last run
      .mockResolvedValueOnce({ rows: [[0, 0]], columns: [] }); // errors

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success_rate.total).toBe(0);
    // null, never 0 — "no run recorded" is not "a run that fetched nothing".
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
      .mockResolvedValueOnce({ rows: [], columns: [] }) // no rate row
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
