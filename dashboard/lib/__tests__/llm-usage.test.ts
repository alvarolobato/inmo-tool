import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSql, mockQuery } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: mockSql,
}));

vi.mock("@/lib/db", () => ({
  query: mockQuery,
}));

import {
  logUsage,
  checkDailyBudget,
  BudgetExceededError,
} from "../llm-usage";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

describe("logUsage", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls sql with correct columns and computed cost for known model", async () => {
    logUsage("generateDashboard", "anthropic/claude-sonnet-4", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });

    // logUsage is fire-and-forget; wait a tick for the promise to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0];
    expect(query).toContain("INSERT INTO llm_usage");
    expect(params[0]).toBe("generateDashboard");
    expect(params[1]).toBe("anthropic/claude-sonnet-4");
    expect(params[2]).toBe(1000);
    expect(params[3]).toBe(500);
    expect(params[4]).toBe(1500);
    // cost = 1000 * 3/1e6 + 500 * 15/1e6 = 0.003 + 0.0075 = 0.0105
    expect(params[5]).toBe("0.010500");
    expect(params[6]).toBe("openrouter");
    expect(params[7]).toBe(null);
    expect(params[8]).toBe(null);
  });

  it("falls back to DEFAULT_RATE for unknown model", async () => {
    logUsage("modifyDashboard", "unknown/model-xyz", {
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockSql).toHaveBeenCalledOnce();
    const params = mockSql.mock.calls[0][1];
    // default rate = 3/1e6 prompt + 15/1e6 completion
    // 100 * 3/1e6 + 100 * 15/1e6 = 0.0003 + 0.0015 = 0.0018
    expect(params[5]).toBe("0.001800");
    expect(params[6]).toBe("openrouter");
    expect(params[7]).toBe(null);
    expect(params[8]).toBe(null);
  });

  it("stores zero estimated cost for CLI provider rows", async () => {
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { provider: "cli", driver: "claude_code" },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[5]).toBe("0.000000");
    expect(params[6]).toBe("cli");
    expect(params[7]).toBe("claude_code");
    expect(params[8]).toBe(null);
    // CLI rows with no cache fields: both cache columns must be NULL
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
  });

  it("persists request_id when provided in options", async () => {
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      { provider: "openrouter", driver: null },
      { requestId: "req_corr_1" },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[8]).toBe("req_corr_1");
  });

  it("applies cache write premium rate for cache_creation_input_tokens", async () => {
    // 1000 prompt @ $3/1M + 500 completion @ $15/1M + 2000 cache_creation @ $3.75/1M
    // = 0.003 + 0.0075 + 0.0075 = 0.018
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: null,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[5]).toBe("0.018000");
    expect(params[9]).toBe(2000);   // cache_creation
    expect(params[10]).toBeNull();  // cache_read
  });

  it("applies cache read discount rate for cache_read_input_tokens", async () => {
    // 200 prompt @ $3/1M + 100 completion @ $15/1M + 50000 cache_read @ $0.30/1M
    // = 0.0006 + 0.0015 + 0.015 = 0.0171
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 50000,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[5]).toBe("0.017100");
    expect(params[9]).toBeNull();   // cache_creation
    expect(params[10]).toBe(50000); // cache_read
  });

  it("accumulates both cache creation and cache read costs", async () => {
    // 500 prompt @ $3/1M + 300 completion @ $15/1M + 1000 cache_creation @ $3.75/1M + 4000 cache_read @ $0.30/1M
    // = 0.0015 + 0.0045 + 0.00375 + 0.0012 = 0.01095
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      {
        prompt_tokens: 500,
        completion_tokens: 300,
        total_tokens: 800,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 4000,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[5]).toBe("0.010950");
    expect(params[9]).toBe(1000);
    expect(params[10]).toBe(4000);
  });

  it("CLI provider stores NULL cache columns when no cache data is provided", async () => {
    // In practice the CLI driver never provides cache token data — callers pass EMPTY_USAGE.
    logUsage(
      "generateDashboard",
      "anthropic/claude-sonnet-4",
      { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { provider: "cli", driver: "claude_code" },
    );

    await new Promise((r) => setTimeout(r, 0));

    const params = mockSql.mock.calls[0][1];
    expect(params[5]).toBe("0.000000");
    // NULL means "not supported", not "zero cache hits"
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
  });

  it("does not throw when sql rejects (fire-and-forget)", async () => {
    mockSql.mockRejectedValue(new Error("db error"));

    expect(() =>
      logUsage("generateDashboard", "anthropic/claude-sonnet-4", {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      })
    ).not.toThrow();

    // allow the rejection to be handled internally
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("checkDailyBudget", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Isolate from any local ~/.config/powershop-analytics/config.yaml so the
    // central config loader does not silently flip the dashboard LLM provider
    // (e.g. to "cli") and short-circuit checkDailyBudget. Pointing CONFIG_FILE
    // at a non-existent path forces the loader to use env > schema-defaults
    // only, which is the contract these tests are exercising.
    vi.stubEnv("CONFIG_FILE", "/nonexistent/test-isolation/config.yaml");
    // Default to the OpenRouter provider — the budget check is OpenRouter-only
    // by design (CLI rows log zero estimated cost, see D-019). Individual tests
    // can override this with vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli").
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    resetDashboardLlmConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetDashboardLlmConfigCache();
  });

  it("is a no-op when LLM_DAILY_BUDGET_USD is not set", async () => {
    delete process.env.LLM_DAILY_BUDGET_USD;
    await expect(checkDailyBudget()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("is a no-op when LLM_DAILY_BUDGET_USD is empty string", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "");
    await expect(checkDailyBudget()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("is a no-op when LLM_DAILY_BUDGET_USD is '0'", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "0");
    await expect(checkDailyBudget()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("is a no-op when LLM_DAILY_BUDGET_USD is negative", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "-5");
    await expect(checkDailyBudget()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("allows call when daily spend is below the limit", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "10");
    mockQuery.mockResolvedValue({ columns: ["total"], rows: [["5.00"]] });

    await expect(checkDailyBudget()).resolves.toBeUndefined();
  });

  it("throws BudgetExceededError when daily spend equals the limit", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "10");
    mockQuery.mockResolvedValue({ columns: ["total"], rows: [["10.00"]] });

    await expect(checkDailyBudget()).rejects.toThrow(BudgetExceededError);
  });

  it("throws BudgetExceededError when daily spend exceeds the limit", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "5");
    mockQuery.mockResolvedValue({ columns: ["total"], rows: [["7.50"]] });

    await expect(checkDailyBudget()).rejects.toThrow(BudgetExceededError);
    mockQuery.mockResolvedValue({ columns: ["total"], rows: [["7.50"]] });
    await expect(checkDailyBudget()).rejects.toThrow(
      "Límite diario de generación alcanzado"
    );
  });

  it("is fail-open when the query throws", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "10");
    mockQuery.mockRejectedValue(new Error("connection refused"));

    await expect(checkDailyBudget()).resolves.toBeUndefined();
  });

  it("is fail-open when the result row is missing", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "10");
    mockQuery.mockResolvedValue({ columns: ["total"], rows: [] });

    await expect(checkDailyBudget()).resolves.toBeUndefined();
  });

  it("skips the PostgreSQL budget query when dashboard LLM provider is cli", async () => {
    vi.stubEnv("LLM_DAILY_BUDGET_USD", "1");
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    mockQuery.mockClear();

    await expect(checkDailyBudget()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
