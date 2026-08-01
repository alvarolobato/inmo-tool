// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeAnomaly } from "@/lib/anomaly";
import { POST } from "../api/anomaly-check/route";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Unit tests for computeAnomaly (pure function)
// ---------------------------------------------------------------------------

describe("computeAnomaly (pure function)", () => {
  it("returns isAnomaly: false when fewer than 5 values total", () => {
    expect(computeAnomaly([100, 98, 102, 99]).isAnomaly).toBe(false);
    expect(computeAnomaly([100]).isAnomaly).toBe(false);
    expect(computeAnomaly([]).isAnomaly).toBe(false);
  });

  it("returns isAnomaly: false for exactly 4 historical values boundary", () => {
    // 5 total: current + 4 historical — minimum is MIN_HISTORICAL_VALUES (4) + 1 current
    const result = computeAnomaly([100, 98, 102, 99, 101]);
    expect(result.isAnomaly).toBe(false); // current is 100; this verifies the minimum-history boundary case
  });

  it("detects low anomaly: current << historical", () => {
    // historical: [100, 98, 102, 99, 101, 100, 99] mean ~99.86, stddev ~1.27
    // current: 50 → zScore = (50 - 99.86) / 1.27 ≈ -39 — very anomalous
    const result = computeAnomaly([50, 100, 98, 102, 99, 101, 100, 99]);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe("low");
    expect(result.zScore).toBeDefined();
    expect(result.zScore!).toBeLessThan(-2);
    expect(result.explanation).toContain("por debajo");
  });

  it("detects high anomaly: current >> historical", () => {
    // historical: [100, 98, 102, 99, 101] mean ~100, current: 200
    const result = computeAnomaly([200, 100, 98, 102, 99, 101]);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe("high");
    expect(result.explanation).toContain("por encima");
  });

  it("returns isAnomaly: false for normal value", () => {
    // All similar values, current is within range
    const result = computeAnomaly([100, 98, 102, 99, 101, 100, 99, 102]);
    expect(result.isAnomaly).toBe(false);
  });

  it("returns isAnomaly: false when all historical values are identical (zero stddev)", () => {
    const result = computeAnomaly([100, 100, 100, 100, 100, 100]);
    expect(result.isAnomaly).toBe(false);
  });

  it("zero stddev: explanation says 'es igual' when currentValue equals mean", () => {
    const result = computeAnomaly([100, 100, 100, 100, 100]);
    expect(result.isAnomaly).toBe(false);
    expect(result.explanation).toContain("es igual a la media");
  });

  it("zero stddev: explanation says 'difiere' when currentValue does not equal mean", () => {
    // historical: [100, 100, 100, 100] — mean=100, stddev=0, but current=50
    const result = computeAnomaly([50, 100, 100, 100, 100]);
    expect(result.isAnomaly).toBe(false);
    expect(result.explanation).toContain("difiere de la media");
    expect(result.explanation).toContain("50");
    expect(result.explanation).toContain("100");
  });

  it("acceptance test: [50, 100, 98, 102, 99, 101] where 50 is current — isAnomaly: true, direction: low", () => {
    // values[0] = 50 (current), values[1..5] = [100, 98, 102, 99, 101] (historical)
    const result = computeAnomaly([50, 100, 98, 102, 99, 101]);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe("low");
  });

  it("acceptance test: [100, 98, 102, 99, 101, 100] — isAnomaly: false", () => {
    // values[0] = 100 (current), all historical similar
    const result = computeAnomaly([100, 98, 102, 99, 101, 100]);
    expect(result.isAnomaly).toBe(false);
  });

  it("includes currentValue, mean, stddev in result for anomalous values", () => {
    const result = computeAnomaly([50, 100, 98, 102, 99, 101]);
    expect(result.currentValue).toBe(50);
    expect(result.mean).toBeDefined();
    expect(result.stddev).toBeDefined();
  });

  it("explanation includes percentage and direction text", () => {
    const result = computeAnomaly([50, 100, 98, 102, 99, 101]);
    expect(result.explanation).toMatch(/\d+%/);
    expect(result.explanation).toMatch(/media/i);
  });
});

// ---------------------------------------------------------------------------
// API route tests for POST /api/anomaly-check
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  validateReadOnly: vi.fn(),
  SqlValidationError: class SqlValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SqlValidationError";
    }
  },
  QueryTimeoutError: class QueryTimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "QueryTimeoutError";
    }
  },
  ConnectionError: class ConnectionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ConnectionError";
    }
  },
}));

import { query, validateReadOnly, SqlValidationError, QueryTimeoutError, ConnectionError } from "@/lib/db";

const mockQuery = vi.mocked(query);
const mockValidateReadOnly = vi.mocked(validateReadOnly);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/anomaly-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/anomaly-check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateReadOnly.mockImplementation(() => undefined);
  });

  it("returns 400 when sql is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION");
  });

  it("returns 400 when body is not an object", async () => {
    const res = await POST(makeRequest("not an object"));
    expect(res.status).toBe(400);
  });

  it("returns 403 on write SQL validation error", async () => {
    const err = new SqlValidationError("Write not allowed");
    mockValidateReadOnly.mockImplementation(() => { throw err; });

    const res = await POST(makeRequest({ sql: "DELETE FROM ps_ventas" }));
    expect(res.status).toBe(403);
  });

  it("returns isAnomaly: false for insufficient data", async () => {
    mockQuery.mockResolvedValue({
      columns: ["value"],
      rows: [[100], [98], [102]],
    });

    const res = await POST(makeRequest({ sql: "SELECT val FROM t" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAnomaly).toBe(false);
  });

  it("returns anomaly detection result for sufficient data", async () => {
    // values[0]=50 current, [1..5]=historical ~100
    mockQuery.mockResolvedValue({
      columns: ["value"],
      rows: [[50], [100], [98], [102], [99], [101]],
    });

    const res = await POST(makeRequest({ sql: "SELECT val FROM t" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAnomaly).toBe(true);
    expect(body.direction).toBe("low");
  });

  it("returns 408 on QueryTimeoutError", async () => {
    mockQuery.mockRejectedValue(new QueryTimeoutError("timed out"));

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    expect(res.status).toBe(408);
  });

  it("returns 503 on ConnectionError", async () => {
    mockQuery.mockRejectedValue(new ConnectionError("ECONNREFUSED"));

    const res = await POST(makeRequest({ sql: "SELECT 1" }));
    expect(res.status).toBe(503);
  });

  it("filters out null/non-numeric values from rows", async () => {
    mockQuery.mockResolvedValue({
      columns: ["value"],
      rows: [[50], [null], [100], [98], [102], [99], [101], ["abc"]],
    });

    const res = await POST(makeRequest({ sql: "SELECT val FROM t" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // null and "abc" are filtered; remaining are [50, 100, 98, 102, 99, 101]
    expect(body.isAnomaly).toBe(true);
  });
});
