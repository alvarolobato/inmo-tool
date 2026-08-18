// @vitest-environment node
/**
 * F-0c CLI prompt-cache probe — pure-logic unit tests. The script's main()
 * spawns the real `claude` CLI (that's the point — see the script header), so
 * only the extracted pure pieces (verdict classification, stable-block
 * determinism and size) are unit-tested here; the live measurement itself was
 * run manually and recorded in docs/roadmap/llm-batching-plan.md's Phase 0
 * section (PR 0c).
 */

import { describe, it, expect } from "vitest";
import {
  buildStablePrefix,
  classifyCacheVerdict,
  PREFIX_REPEATS,
  type ProbeResult,
} from "../probe-cli-cache";

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
  it("is deterministic — the whole probe depends on every call sending the IDENTICAL block", () => {
    expect(buildStablePrefix()).toBe(buildStablePrefix());
  });

  it("stays above Haiku 4.5's 4,096-token minimum cacheable prefix", () => {
    // 20,120 chars ≈ 5.8k tokens as measured on 2026-08-18. Below the model
    // minimum NOTHING caches — an earlier 7,920-char probe read zero on every
    // variant and looked like "the CLI doesn't cache", which was a size
    // artefact, not a finding. Pinned off PREFIX_REPEATS so shrinking the
    // block trips this test instead of silently invalidating the measurement.
    const chars = buildStablePrefix().length;
    expect(PREFIX_REPEATS).toBe(40);
    expect(chars).toBe(20120);
    // ~3.5 chars/token in Spanish; stay clear of the 4,096-token floor.
    expect(chars / 3.5).toBeGreaterThan(4096);
  });
});

describe("classifyCacheVerdict", () => {
  it("reports 'works' when a warm call reads back cached tokens (variant C2's measured 5,498)", () => {
    const v = classifyCacheVerdict(makeResult({ cache_read_input_tokens: 5498, cache_creation_input_tokens: 255 }));
    expect(v).toEqual({ kind: "works", cacheReadTokens: 5498 });
  });

  it("reports 'not_observed' when the call wrote fresh cache instead of reading it (variant A2's measured 5,826/0)", () => {
    // This is the production shape's actual result: a differing tail defeats
    // the stdin-concatenated prefix entirely.
    const v = classifyCacheVerdict(
      makeResult({ cache_read_input_tokens: 0, cache_creation_input_tokens: 5826 }),
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
