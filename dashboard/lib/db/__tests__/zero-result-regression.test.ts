// @vitest-environment node
/**
 * Unit tests for getZeroResultRegressions() (issue #376). `@/lib/db`'s
 * read-only `query` is mocked to return one expanded (connector, run, scope)
 * row per observation (the jsonb_array_elements shape), and the system-config
 * loader is stubbed to control N. Exercises the grouping + measurement-outcome
 * filtering + count-read that the pure detector then judges — no real DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@/lib/db", () => ({ query: mockQuery }));
vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: vi.fn(() => ({})),
}));

import { getZeroResultRegressions, getZeroResultRegressionRuns } from "../zero-result-regression";
import * as loader from "@/lib/system-config/loader";

const mockConfig = vi.mocked(loader.getSystemConfig);

/** One expanded row: [connector_name, started_at, geography_scope entry]. */
function row(
  connector: string,
  day: number,
  scopeKey: string,
  outcome: string,
  discovered_count: number | null,
): unknown[] {
  return [
    connector,
    new Date(Date.UTC(2026, 0, day)),
    { scope_key: scopeKey, outcome, discovered_count },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.mockReturnValue({} as never);
});

describe("getZeroResultRegressions", () => {
  it("flags a scope that went nonzero → 0 for N consecutive runs", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("fotocasa", 1, "madrid-capital", "crawled", 12),
        row("fotocasa", 2, "madrid-capital", "crawled", 9),
        row("fotocasa", 3, "madrid-capital", "empty", 0),
        row("fotocasa", 4, "madrid-capital", "empty", 0),
        row("fotocasa", 5, "madrid-capital", "empty", 0),
      ],
    });

    const flags = await getZeroResultRegressions();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      connector: "fotocasa",
      scope_key: "madrid-capital",
      consecutive_zeros: 3,
      last_nonzero_count: 9,
    });
  });

  it("does NOT flag a scope that was always empty (sparse area)", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("fotocasa", 1, "teruel-rural", "empty", 0),
        row("fotocasa", 2, "teruel-rural", "empty", 0),
        row("fotocasa", 3, "teruel-rural", "empty", 0),
      ],
    });
    expect(await getZeroResultRegressions()).toEqual([]);
  });

  it("does NOT flag a single transient zero", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("pisos", 1, "sevilla", "crawled", 4),
        row("pisos", 2, "sevilla", "crawled", 5),
        row("pisos", 3, "sevilla", "empty", 0),
      ],
    });
    expect(await getZeroResultRegressions()).toEqual([]);
  });

  it("clears the flag after a recovery (latest run nonzero)", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("pisos", 1, "sevilla", "crawled", 4),
        row("pisos", 2, "sevilla", "empty", 0),
        row("pisos", 3, "sevilla", "empty", 0),
        row("pisos", 4, "sevilla", "empty", 0),
        row("pisos", 5, "sevilla", "crawled", 6),
      ],
    });
    expect(await getZeroResultRegressions()).toEqual([]);
  });

  it("ignores non-measurement outcomes (blocked/skipped runs are not zeros)", async () => {
    // A nonzero baseline, then 3 runs where the scope was NOT actually searched
    // (uncovered/budget/failed). Those must NOT count as zero observations, so
    // the scope is not flagged despite three 0-less runs in a row.
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("solvia", 1, "malaga", "crawled", 7),
        row("solvia", 2, "malaga", "uncovered", null),
        row("solvia", 3, "malaga", "budget", null),
        row("solvia", 4, "malaga", "failed", null),
      ],
    });
    expect(await getZeroResultRegressions()).toEqual([]);
  });

  it("falls back to the outcome when discovered_count is absent (legacy rows)", async () => {
    // Pre-#376 rows have no discovered_count; 'empty' → 0, 'crawled' → 1.
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("fotocasa", 1, "bilbao", "crawled", null),
        row("fotocasa", 2, "bilbao", "empty", null),
        row("fotocasa", 3, "bilbao", "empty", null),
        row("fotocasa", 4, "bilbao", "empty", null),
      ],
    });
    const flags = await getZeroResultRegressions();
    expect(flags).toHaveLength(1);
    expect(flags[0].last_nonzero_count).toBe(1);
  });

  it("keeps each (connector, scope) series independent", async () => {
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        // Drifted scope
        row("fotocasa", 1, "madrid", "crawled", 5),
        row("fotocasa", 2, "madrid", "empty", 0),
        row("fotocasa", 3, "madrid", "empty", 0),
        row("fotocasa", 4, "madrid", "empty", 0),
        // Healthy scope on the same connector
        row("fotocasa", 1, "barcelona", "crawled", 8),
        row("fotocasa", 2, "barcelona", "crawled", 9),
        row("fotocasa", 3, "barcelona", "crawled", 7),
      ],
    });
    const flags = await getZeroResultRegressions();
    expect(flags.map((f) => f.scope_key)).toEqual(["madrid"]);
  });

  it("respects a configured N from etl.zero_result_regression_runs", async () => {
    mockConfig.mockReturnValue({
      "etl.zero_result_regression_runs": { value: 5 },
    } as never);
    mockQuery.mockResolvedValueOnce({
      columns: [],
      rows: [
        row("fotocasa", 1, "madrid", "crawled", 5),
        row("fotocasa", 2, "madrid", "empty", 0),
        row("fotocasa", 3, "madrid", "empty", 0),
        row("fotocasa", 4, "madrid", "empty", 0),
      ],
    });
    // Only 3 trailing zeros < configured N=5 → not flagged.
    expect(await getZeroResultRegressions()).toEqual([]);
  });
});

describe("getZeroResultRegressionRuns", () => {
  it("defaults to 3 when unset", () => {
    mockConfig.mockReturnValue({} as never);
    expect(getZeroResultRegressionRuns()).toBe(3);
  });

  it("reads a valid configured value", () => {
    mockConfig.mockReturnValue({
      "etl.zero_result_regression_runs": { value: 4 },
    } as never);
    expect(getZeroResultRegressionRuns()).toBe(4);
  });

  it("falls back to the default for an invalid value", () => {
    mockConfig.mockReturnValue({
      "etl.zero_result_regression_runs": { value: 0 },
    } as never);
    expect(getZeroResultRegressionRuns()).toBe(3);
  });
});
