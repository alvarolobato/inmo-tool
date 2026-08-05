// @vitest-environment node
/**
 * Unit tests for the LLM cost/usage pure helpers (issue #324). No DB — every
 * function here is pure arithmetic / parsing over plain inputs.
 */

import { describe, it, expect } from "vitest";
import {
  CLI_PROVIDER,
  DEFAULT_LLM_RATES,
  isCliProvider,
  normalizeModel,
  parseRateTable,
  rateForModel,
  modelCostEur,
  rollUpCosts,
  coverageFraction,
  projectBacklogTicks,
  projectBacklogSeconds,
  projectBacklogCostEur,
  type ModelTokenBucket,
} from "@/lib/llm-health";

describe("isCliProvider", () => {
  it("matches the cli provider case-insensitively and trims", () => {
    expect(isCliProvider(CLI_PROVIDER)).toBe(true);
    expect(isCliProvider(" CLI ")).toBe(true);
    expect(isCliProvider("openrouter")).toBe(false);
    expect(isCliProvider(null)).toBe(false);
    expect(isCliProvider(undefined)).toBe(false);
  });
});

describe("normalizeModel", () => {
  it("strips a leading openrouter/ transport prefix", () => {
    expect(normalizeModel("openrouter/anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(normalizeModel("anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(normalizeModel("  openrouter/x  ")).toBe("x");
  });
});

describe("rateForModel", () => {
  it("finds a default-rated model, with prefix normalization", () => {
    expect(rateForModel(DEFAULT_LLM_RATES, "anthropic/claude-sonnet-4")).toEqual({
      in_eur_per_mtok: 3.0,
      out_eur_per_mtok: 15.0,
    });
    expect(
      rateForModel(DEFAULT_LLM_RATES, "openrouter/anthropic/claude-sonnet-4"),
    ).toEqual({ in_eur_per_mtok: 3.0, out_eur_per_mtok: 15.0 });
  });
  it("returns null for an unknown model", () => {
    expect(rateForModel(DEFAULT_LLM_RATES, "acme/mystery-model")).toBeNull();
  });
});

describe("modelCostEur", () => {
  it("prices input+output tokens per 1M", () => {
    // 1M input @3 + 0.5M output @15 = 3 + 7.5 = 10.5
    const rate = { in_eur_per_mtok: 3, out_eur_per_mtok: 15 };
    expect(modelCostEur(rate, 1_000_000, 500_000)).toBeCloseTo(10.5, 6);
  });
  it("is 0 for a null rate", () => {
    expect(modelCostEur(null, 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("parseRateTable", () => {
  it("returns defaults on empty/null/malformed input", () => {
    expect(parseRateTable(null)).toEqual(DEFAULT_LLM_RATES);
    expect(parseRateTable("")).toEqual(DEFAULT_LLM_RATES);
    expect(parseRateTable("   ")).toEqual(DEFAULT_LLM_RATES);
    expect(parseRateTable("{not json")).toEqual(DEFAULT_LLM_RATES);
    expect(parseRateTable("[1,2,3]")).toEqual(DEFAULT_LLM_RATES);
    expect(parseRateTable("42")).toEqual(DEFAULT_LLM_RATES);
  });

  it("merges a valid override on top of defaults", () => {
    const table = parseRateTable(
      JSON.stringify({
        "acme/model-x": { in_eur_per_mtok: 1, out_eur_per_mtok: 2 },
        "anthropic/claude-sonnet-4": { in_eur_per_mtok: 99, out_eur_per_mtok: 100 },
      }),
    );
    // New model added.
    expect(table["acme/model-x"]).toEqual({ in_eur_per_mtok: 1, out_eur_per_mtok: 2 });
    // Existing default overridden.
    expect(table["anthropic/claude-sonnet-4"]).toEqual({
      in_eur_per_mtok: 99,
      out_eur_per_mtok: 100,
    });
    // Untouched default survives.
    expect(table["openai/gpt-4o"]).toEqual(DEFAULT_LLM_RATES["openai/gpt-4o"]);
  });

  it("normalizes override keys and skips junk / negative entries", () => {
    const table = parseRateTable(
      JSON.stringify({
        "openrouter/acme/y": { in_eur_per_mtok: 5, out_eur_per_mtok: 6 },
        "acme/bad-1": { in_eur_per_mtok: "nope", out_eur_per_mtok: 1 },
        "acme/bad-2": { in_eur_per_mtok: -1, out_eur_per_mtok: 1 },
        "acme/bad-3": null,
        "acme/bad-4": "string",
      }),
    );
    expect(table["acme/y"]).toEqual({ in_eur_per_mtok: 5, out_eur_per_mtok: 6 });
    expect(table["acme/bad-1"]).toBeUndefined();
    expect(table["acme/bad-2"]).toBeUndefined();
    expect(table["acme/bad-3"]).toBeUndefined();
    expect(table["acme/bad-4"]).toBeUndefined();
  });
});

describe("rollUpCosts", () => {
  const rates = {
    "anthropic/claude-sonnet-4": { in_eur_per_mtok: 3, out_eur_per_mtok: 15 },
  };

  it("prices non-CLI buckets and zeroes CLI ones", () => {
    const buckets: ModelTokenBucket[] = [
      {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        prompt_today: 1_000_000,
        completion_today: 0,
        prompt_7d: 2_000_000,
        completion_7d: 1_000_000,
      },
      {
        provider: "cli",
        model: "anthropic/claude-sonnet-4",
        prompt_today: 5_000_000,
        completion_today: 5_000_000,
        prompt_7d: 5_000_000,
        completion_7d: 5_000_000,
      },
    ];
    const r = rollUpCosts(buckets, rates);
    // openrouter today: 1M in @3 = 3
    expect(r.cost_today_eur).toBeCloseTo(3, 6);
    // openrouter 7d: 2M in @3 + 1M out @15 = 6 + 15 = 21
    expect(r.cost_7d_eur).toBeCloseTo(21, 6);
    // CLI contributes 0 to both provider buckets.
    expect(r.by_provider["cli"]).toEqual({ today: 0, week: 0 });
    expect(r.by_provider["openrouter"].week).toBeCloseTo(21, 6);
    expect(r.unpriced_models).toEqual([]);
  });

  it("tracks non-CLI models with tokens but no rate as unpriced (0 cost)", () => {
    const buckets: ModelTokenBucket[] = [
      {
        provider: "openrouter",
        model: "acme/unpriced",
        prompt_today: 0,
        completion_today: 0,
        prompt_7d: 1_000_000,
        completion_7d: 500_000,
      },
    ];
    const r = rollUpCosts(buckets, rates);
    expect(r.cost_7d_eur).toBe(0);
    expect(r.unpriced_models).toEqual(["acme/unpriced"]);
  });

  it("does not flag a CLI unpriced model", () => {
    const buckets: ModelTokenBucket[] = [
      {
        provider: "cli",
        model: "acme/unpriced",
        prompt_today: 0,
        completion_today: 0,
        prompt_7d: 1_000_000,
        completion_7d: 0,
      },
    ];
    expect(rollUpCosts(buckets, rates).unpriced_models).toEqual([]);
  });
});

describe("coverageFraction", () => {
  it("is covered/eligible, or null when nothing eligible", () => {
    expect(coverageFraction(3, 4)).toBe(0.75);
    expect(coverageFraction(0, 0)).toBeNull();
    expect(coverageFraction(5, 0)).toBeNull();
  });
});

describe("projectBacklogTicks", () => {
  it("ceils pending/batchSize, 0 when nothing pending, null when batch<=0", () => {
    expect(projectBacklogTicks(10, 5)).toBe(2);
    expect(projectBacklogTicks(11, 5)).toBe(3);
    expect(projectBacklogTicks(0, 5)).toBe(0);
    expect(projectBacklogTicks(10, 0)).toBeNull();
  });
});

describe("projectBacklogSeconds", () => {
  it("spans (ticks-1) intervals; 0 when drained; null when unable", () => {
    // 3 ticks → 2 intervals of 900s = 1800
    expect(projectBacklogSeconds(11, 5, 900)).toBe(1800);
    expect(projectBacklogSeconds(0, 5, 900)).toBe(0);
    expect(projectBacklogSeconds(10, 0, 900)).toBeNull();
  });
});

describe("projectBacklogCostEur", () => {
  it("is pending × avg per property, 0 when drained, null when cost unknown", () => {
    expect(projectBacklogCostEur(10, 0.5)).toBe(5);
    expect(projectBacklogCostEur(0, 0.5)).toBe(0);
    expect(projectBacklogCostEur(10, null)).toBeNull();
  });
});
