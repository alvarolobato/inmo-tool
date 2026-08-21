// @vitest-environment node
/**
 * Unit tests for getLlmHealth() (issue #324). `@/lib/db`'s read-only `query`
 * is mocked to return rowMode-array results in the exact order getLlmHealth
 * issues them; the scheduler config, system-config loader, and the prompt-
 * version constants are stubbed so the assembly logic is exercised without a DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@/lib/db", () => ({ query: mockQuery }));
vi.mock("@/lib/ai-assessment/scheduler", () => ({
  loadSchedulerConfig: vi.fn(() => ({
    enabled: true,
    batchSize: 5,
    intervalSeconds: 900,
    concurrency: 4,
    drainIntervalSeconds: 5,
  })),
}));
vi.mock("@/lib/system-config/loader", () => ({
  getSystemConfig: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai-assessment/occupancy", () => ({
  OCCUPANCY_PROMPT_VERSION: "occupancy/v2",
}));
vi.mock("@/lib/ai-assessment/condition", () => ({
  CONDITION_PROMPT_VERSION: "condition/v2",
}));
vi.mock("@/lib/ai-assessment/redflags", () => ({
  REDFLAGS_PROMPT_VERSION: "redflags/v3",
}));

import { getLlmHealth } from "../llm-health";

/** Helper: a rowMode-array QueryResult. */
function result(rows: unknown[][]): { columns: string[]; rows: unknown[][] } {
  return { columns: [], rows };
}

/**
 * Queue the eight reads getLlmHealth performs, in order: flows, providers,
 * models, coverage, propertiesAssessed7d, errors, errorCodes, cliZeroUsage
 * (F-8 canary).
 */
function queueReads(opts: {
  flows?: unknown[][];
  providers?: unknown[][];
  models?: unknown[][];
  coverage?: unknown[][];
  propertiesAssessed?: unknown[][];
  errors?: unknown[][];
  errorCodes?: unknown[][];
  cliZeroUsage?: unknown[][];
}) {
  mockQuery
    .mockResolvedValueOnce(result(opts.flows ?? []))
    .mockResolvedValueOnce(result(opts.providers ?? []))
    .mockResolvedValueOnce(result(opts.models ?? []))
    .mockResolvedValueOnce(result(opts.coverage ?? [[0, 0]]))
    .mockResolvedValueOnce(result(opts.propertiesAssessed ?? [[0]]))
    .mockResolvedValueOnce(result(opts.errors ?? [[0, 0]]))
    .mockResolvedValueOnce(result(opts.errorCodes ?? []))
    .mockResolvedValueOnce(result(opts.cliZeroUsage ?? [[0]]));
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getLlmHealth", () => {
  it("returns all-zero, empty, tokens_logged=false shape when tables are empty", async () => {
    queueReads({});
    const r = await getLlmHealth();
    expect(r.flows).toEqual([]);
    expect(r.providers).toEqual([]);
    expect(r.cost).toEqual({
      cost_today_eur: 0,
      cost_7d_eur: 0,
      unpriced_models: [],
    });
    expect(r.coverage.eligible).toBe(0);
    expect(r.coverage.pending).toBe(0);
    expect(r.coverage.coverage_fraction).toBeNull();
    expect(r.coverage.projected_cost_eur).toBeNull();
    expect(r.scheduler).toEqual({
      enabled: true,
      batch_size: 5,
      interval_seconds: 900,
    });
    expect(r.errors).toEqual({ errors_today: 0, errors_7d: 0, by_code: [] });
    expect(r.tokens_logged).toBe(false);
    expect(r.cli_zero_usage_24h).toBe(0);
    expect(typeof r.generated_at).toBe("string");
    // Exactly eight parallel reads.
    expect(mockQuery).toHaveBeenCalledTimes(8);
  });

  it("maps flows/providers and prices non-CLI tokens; CLI stays €0", async () => {
    queueReads({
      // endpoint, calls_today, calls_7d, tokens_today, tokens_7d
      flows: [
        ["occupancy", 2, 10, 4000, 20000],
        ["generateDashboard", 1, 3, 1000, 6000],
      ],
      // provider, calls_today, calls_7d, tokens_today, tokens_7d
      providers: [
        ["openrouter", 2, 8, 4000, 20000],
        ["cli", 1, 5, 1000, 6000],
      ],
      // provider, model, prompt_today, completion_today, prompt_7d, completion_7d
      models: [
        ["openrouter", "anthropic/claude-sonnet-4", 1_000_000, 0, 2_000_000, 1_000_000],
        ["cli", "anthropic/claude-sonnet-4", 9_000_000, 9_000_000, 9_000_000, 9_000_000],
      ],
      coverage: [[100, 40]],
      propertiesAssessed: [[8]],
      errors: [[1, 4]],
      errorCodes: [["RATE_LIMIT", 3], ["TIMEOUT", 1]],
    });

    const r = await getLlmHealth();

    expect(r.flows[0]).toEqual({
      endpoint: "occupancy",
      calls_today: 2,
      calls_7d: 10,
      tokens_today: 4000,
      tokens_7d: 20000,
    });
    // openrouter 7d € = 2M in @3 + 1M out @15 = 6 + 15 = 21
    const or = r.providers.find((p) => p.provider === "openrouter")!;
    expect(or.cost_7d_eur).toBeCloseTo(21, 6);
    expect(or.is_cli).toBe(false);
    const cli = r.providers.find((p) => p.provider === "cli")!;
    expect(cli.is_cli).toBe(true);
    expect(cli.cost_7d_eur).toBe(0);
    // openrouter today € = 1M in @3 = 3
    expect(r.cost.cost_today_eur).toBeCloseTo(3, 6);
    expect(r.cost.cost_7d_eur).toBeCloseTo(21, 6);
    expect(r.tokens_logged).toBe(true);

    // Coverage: covered = 100 - 40 = 60, fraction 0.6, backlog 40/5 = 8 ticks.
    expect(r.coverage.covered).toBe(60);
    expect(r.coverage.coverage_fraction).toBeCloseTo(0.6, 6);
    expect(r.coverage.projected_ticks).toBe(8);
    // (8-1) ticks * 5s (the #666 drain interval, not the idle interval) = 35
    expect(r.coverage.projected_seconds).toBe(35);
    // Only 'occupancy' is an assessment endpoint. Assessment share of 7d tokens
    // = 20000 / (20000+6000) = 0.769...; assessment € = 21 * that; per property
    // = / 8. Just assert it's a positive projection derived from that.
    expect(r.coverage.avg_cost_eur_per_property).not.toBeNull();
    expect(r.coverage.projected_cost_eur).not.toBeNull();
    expect(r.coverage.projected_cost_eur!).toBeGreaterThan(0);

    expect(r.errors).toEqual({
      errors_today: 1,
      errors_7d: 4,
      by_code: [
        { code: "RATE_LIMIT", count: 3 },
        { code: "TIMEOUT", count: 1 },
      ],
    });
  });

  it("flags an unpriced non-CLI model", async () => {
    queueReads({
      flows: [["generateDashboard", 0, 1, 0, 1000]],
      providers: [["openrouter", 0, 1, 0, 1000]],
      models: [
        ["openrouter", "acme/mystery", 0, 0, 500_000, 500_000],
      ],
    });
    const r = await getLlmHealth();
    expect(r.cost.unpriced_models).toEqual(["acme/mystery"]);
    expect(r.cost.cost_7d_eur).toBe(0);
  });

  it("F-8: surfaces a nonzero cli_zero_usage_24h count straight from the canary query", async () => {
    queueReads({
      flows: [["occupancy", 1, 3, 100, 300]],
      providers: [["cli", 1, 3, 100, 300]],
      cliZeroUsage: [[7]],
    });
    const r = await getLlmHealth();
    expect(r.cli_zero_usage_24h).toBe(7);
  });

  it("F-8: cli_zero_usage_24h is 0 when the CLI envelope is being parsed correctly", async () => {
    queueReads({
      flows: [["occupancy", 1, 3, 100, 300]],
      providers: [["cli", 1, 3, 100, 300]],
      cliZeroUsage: [[0]],
    });
    const r = await getLlmHealth();
    expect(r.cli_zero_usage_24h).toBe(0);
  });

  it("projects null cost when no properties were assessed in the window", async () => {
    queueReads({
      flows: [["occupancy", 0, 2, 0, 10000]],
      providers: [["openrouter", 0, 2, 0, 10000]],
      models: [["openrouter", "anthropic/claude-sonnet-4", 0, 0, 1_000_000, 0]],
      coverage: [[10, 5]],
      propertiesAssessed: [[0]],
    });
    const r = await getLlmHealth();
    expect(r.coverage.avg_cost_eur_per_property).toBeNull();
    expect(r.coverage.projected_cost_eur).toBeNull();
    // Time projection still works.
    expect(r.coverage.projected_ticks).toBe(1);
  });
});
