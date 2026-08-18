// @vitest-environment node
/**
 * F-0c CLI prompt-cache probe — pure-logic unit tests. The script's main()
 * spawns the real `claude` CLI (that's the point — see the script header),
 * so only the extracted pure pieces (verdict classification, stable-prefix
 * determinism) are unit-tested here; the live measurement itself was run
 * manually and recorded in docs/roadmap/llm-batching-plan.md's Phase 0
 * section (PR 0c).
 */

import { describe, it, expect } from "vitest";
import { buildStablePrefix, classifyCacheVerdict, type ProbeResult } from "../probe-cli-cache";

function makeResult(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    label: "test",
    prompt_tokens: 10,
    completion_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    total_cost_usd: null,
    duration_ms: 0,
    ...overrides,
  };
}

describe("buildStablePrefix", () => {
  it("is deterministic — the whole probe depends on both calls sending the IDENTICAL prefix", () => {
    expect(buildStablePrefix()).toBe(buildStablePrefix());
  });

  it("is sized in the same order of magnitude as a real assessment flow's stable prompt (thousands of chars)", () => {
    // occupancy's measured stable prompt is ~7,537 chars per the batching plan.
    expect(buildStablePrefix().length).toBeGreaterThan(5000);
  });
});

describe("classifyCacheVerdict", () => {
  it("reports 'works' when the second call reads back cached tokens (the actual 2026-08-18 measurement: 5,790)", () => {
    const v = classifyCacheVerdict(makeResult({ cache_read_input_tokens: 5790, cache_creation_input_tokens: 0 }));
    expect(v).toEqual({ kind: "works", cacheReadTokens: 5790 });
  });

  it("reports 'not_observed' when the second call wrote fresh cache instead of reading it", () => {
    const v = classifyCacheVerdict(
      makeResult({ cache_read_input_tokens: 0, cache_creation_input_tokens: 5790 }),
    );
    expect(v).toEqual({ kind: "not_observed", cacheReadTokens: 0 });
  });

  it("reports 'inconclusive' when the CLI envelope carried no cache fields at all", () => {
    const v = classifyCacheVerdict(
      makeResult({ cache_read_input_tokens: null, cache_creation_input_tokens: null }),
    );
    expect(v).toEqual({ kind: "inconclusive" });
  });

  it("treats a null cache_read_input_tokens alongside a present cache_creation as 'not_observed', not 'inconclusive'", () => {
    // Only BOTH fields null means the envelope carried nothing — one present
    // field means the CLI does report cache accounting, it just didn't read.
    const v = classifyCacheVerdict(
      makeResult({ cache_read_input_tokens: null, cache_creation_input_tokens: 100 }),
    );
    expect(v.kind).toBe("not_observed");
  });
});
