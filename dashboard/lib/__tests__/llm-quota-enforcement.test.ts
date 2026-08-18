/**
 * Seam-level enforcement of the subscription-quota cap (D-107).
 *
 * `llm-quota.test.ts` covers the pure parse/decide logic. This file pins the
 * two load-bearing CLAIMS about how it is wired, which that one cannot:
 *
 *   1. the cap is enforced before any provider work, so it cannot be bypassed;
 *   2. a disabled cap (the default) performs NO database query at all.
 *
 * Mirrors the shape of the D-105 kill-switch seam test in llm-client.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCliSingleShot, mockLogUsage, mockCallWithCircuitBreaker, mockGetLatest } =
  vi.hoisted(() => ({
    mockCliSingleShot: vi.fn(),
    mockLogUsage: vi.fn(),
    mockCallWithCircuitBreaker: vi.fn(),
    mockGetLatest: vi.fn(),
  }));

vi.mock("@/lib/llm-provider/cli/claude-code", () => ({
  claudeCliSingleShot: mockCliSingleShot,
}));
vi.mock("../llm-usage", () => ({
  logUsage: mockLogUsage,
  checkDailyBudget: vi.fn().mockResolvedValue(undefined),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));
vi.mock("../llm-circuit-breaker", () => ({
  callWithCircuitBreaker: mockCallWithCircuitBreaker,
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {},
}));
vi.mock("@/lib/db/llm-quota", () => ({ getLatestQuotaReading: mockGetLatest }));

import { llmComplete } from "../llm-client";
import { assertQuotaAvailable, LlmQuotaExceededError } from "../llm-enabled";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

const overQuota = {
  session: { pctUsed: 91, resetsAt: null },
  week: { pctUsed: 30, resetsAt: null },
  weekTopModel: null,
  readAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
  resetDashboardLlmConfigCache();
  mockCliSingleShot.mockReset();
  mockLogUsage.mockReset();
  mockGetLatest.mockReset();
  mockCallWithCircuitBreaker.mockReset();
  mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
  mockCliSingleShot.mockResolvedValue({ text: "should never be produced", usage: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetDashboardLlmConfigCache();
});

describe("quota cap — enforcement seam", () => {
  it("makes NO provider call when the cap is reached", async () => {
    vi.stubEnv("DASHBOARD_LLM_QUOTA_STOP_PCT", "80");
    resetDashboardLlmConfigCache();
    mockGetLatest.mockResolvedValue(overQuota);

    await expect(
      llmComplete({
        flow: "generate",
        systemPrompt: { stable: "s" },
        messages: [{ role: "user", content: "q" }],
      }),
    ).rejects.toBeInstanceOf(LlmQuotaExceededError);

    expect(mockCliSingleShot).not.toHaveBeenCalled();
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  it("performs NO database query when the cap is disabled (the default)", async () => {
    // Claimed in D-107 and in the config description; a query per LLM call
    // would be a silent tax on the default configuration.
    resetDashboardLlmConfigCache();
    await assertQuotaAvailable();
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it("fails OPEN when the reading cannot be loaded", async () => {
    // A cost guard must not become an outage: a DB blip allows the call.
    vi.stubEnv("DASHBOARD_LLM_QUOTA_STOP_PCT", "80");
    resetDashboardLlmConfigCache();
    mockGetLatest.mockRejectedValue(new Error("db down"));
    await expect(assertQuotaAvailable()).resolves.toBeUndefined();
  });

  it("reports the window that is actually highest, not the first declared", async () => {
    vi.stubEnv("DASHBOARD_LLM_QUOTA_STOP_PCT", "80");
    resetDashboardLlmConfigCache();
    mockGetLatest.mockResolvedValue({
      session: { pctUsed: 82, resetsAt: null },
      week: { pctUsed: 97, resetsAt: null },
      weekTopModel: null,
      readAt: new Date().toISOString(),
    });
    await expect(assertQuotaAvailable()).rejects.toMatchObject({
      pctUsed: 97,
      window: "week",
    });
  });
});
