// @vitest-environment node
/**
 * F-5 (docs/roadmap/llm-batching-plan.md Phase 0): `lib/llm-usage.ts` and
 * `lib/llm-health.ts` used to carry two independently hard-coded price
 * tables that had already drifted (e.g. haiku-4.5 was $1.0/$5.0 per MTok in
 * one and €0.8/€4.0 in the other — the latter is Haiku 3.5's price). This
 * test pins that they now price the
 * SAME configured model identically, sourced from the one shared table in
 * `lib/llm-rates.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));

vi.mock("@/lib/db-write", () => ({ sql: mockSql }));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));

import { logUsage } from "@/lib/llm-usage";
import {
  DEFAULT_LLM_RATES,
  rateForModel,
  cacheAdjustedRate,
  normalizeModel,
} from "@/lib/llm-rates";
import { modelCostEur } from "@/lib/llm-health";

describe("shared rate table (F-5)", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prices a cheap configured model identically via llm-usage.logUsage and llm-health.modelCostEur", async () => {
    // Haiku 4.5 is exactly the model that drifted pre-unification: 1.0/5.0 in
    // the old llm-usage.ts table vs 0.8/4.0 in llm-health.ts's. The first
    // unification attempt kept the WRONG one, which is why the list-price pin
    // below exists as well as this agreement check.
    const model = "anthropic/claude-haiku-4.5";
    const promptTokens = 12_345;
    const completionTokens = 6_789;

    logUsage("occupancy", model, {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSql).toHaveBeenCalledOnce();
    const params = mockSql.mock.calls[0][1];
    const usageCost = Number(params[5]);

    const rate = rateForModel(DEFAULT_LLM_RATES, model);
    expect(rate).not.toBeNull();
    const healthCost = modelCostEur(rate, promptTokens, completionTokens);

    // llm-usage's cache-adjusted formula degrades to the same plain
    // prompt/completion arithmetic as llm-health's modelCostEur when no
    // cache tokens are involved — both consumers must agree to 6 decimals
    // (llm-usage.ts's own stored precision).
    expect(usageCost).toBeCloseTo(healthCost, 6);
  });

  it("both consumers resolve the same model key via normalizeModel/rateForModel", () => {
    const model = "openrouter/anthropic/claude-haiku-4.5";
    expect(normalizeModel(model)).toBe("anthropic/claude-haiku-4.5");
    expect(rateForModel(DEFAULT_LLM_RATES, model)).toEqual({
      in_eur_per_mtok: 1.0,
      out_eur_per_mtok: 5.0,
    });
  });

  it("cacheAdjustedRate applies the documented 25% write premium / 90% read discount over the shared base rate", () => {
    const rate = rateForModel(DEFAULT_LLM_RATES, "anthropic/claude-sonnet-4");
    expect(rate).toEqual({ in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 });

    const adjusted = cacheAdjustedRate(rate!);
    expect(adjusted.prompt).toBeCloseTo(3.0 / 1_000_000, 12);
    expect(adjusted.completion).toBeCloseTo(15.0 / 1_000_000, 12);
    expect(adjusted.cacheWrite).toBeCloseTo((3.0 * 1.25) / 1_000_000, 12);
    expect(adjusted.cacheRead).toBeCloseTo((3.0 * 0.1) / 1_000_000, 12);
  });

  it("pins the DEFAULT model's rate to its published list price", () => {
    // The agreement test above compares two consumers that now read the SAME
    // constant, so it can only catch one of them un-wiring itself — never a
    // wrong shared value, which is the failure that actually happened. Haiku
    // 4.5 is the default model (D-103) and its price feeds `checkDailyBudget`
    // and /admin/usage, so pin it against the published number: $1.00 in /
    // $5.00 out per MTok. Both spellings must agree — OpenRouter uses the dot.
    for (const key of ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4.5"]) {
      expect(DEFAULT_LLM_RATES[key]).toEqual({ in_eur_per_mtok: 1.0, out_eur_per_mtok: 5.0 });
    }
  });
});
