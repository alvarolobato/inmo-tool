/**
 * Unit tests for the Claude CLI usage/cost parser (`llm-provider/cli/usage.ts`).
 *
 * The envelope shapes asserted here were captured from a live
 * `claude -p ... --output-format json` run — see the module doc for the
 * measured before/after that motivated `CLI_LEAN_ARGS`.
 */

import { describe, it, expect } from "vitest";
import {
  CLI_LEAN_ARGS,
  parseCliReportedUsage,
  addCliReportedUsage,
} from "../llm-provider/cli/usage";

describe("parseCliReportedUsage", () => {
  it("maps a real CLI envelope to normalised usage", () => {
    const envelope = {
      type: "result",
      is_error: false,
      result: "OK",
      total_cost_usd: 0.0176284,
      usage: {
        input_tokens: 9,
        output_tokens: 36,
        cache_creation_input_tokens: 7521,
        cache_read_input_tokens: 18134,
      },
    };

    expect(parseCliReportedUsage(envelope)).toEqual({
      prompt_tokens: 9,
      completion_tokens: 36,
      total_tokens: 25_700,
      cache_creation_input_tokens: 7521,
      cache_read_input_tokens: 18_134,
      cost_usd: 0.0176284,
    });
  });

  it("treats cache counters as separate from input_tokens (Anthropic semantics)", () => {
    // input_tokens is EXCLUSIVE of cache tokens; summing them into
    // prompt_tokens would double-count against the cache columns.
    const parsed = parseCliReportedUsage({
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 },
    });
    expect(parsed?.prompt_tokens).toBe(100);
    expect(parsed?.cache_read_input_tokens).toBe(900);
    expect(parsed?.total_tokens).toBe(1010);
  });

  it("returns null rather than a fake zero when nothing is reported", () => {
    // "Unreported" must stay distinguishable from "genuinely free" — a zero
    // here is what made the whole CLI provider look costless.
    expect(parseCliReportedUsage({ result: "hi" })).toBeNull();
    expect(parseCliReportedUsage(null)).toBeNull();
    expect(parseCliReportedUsage("not an object")).toBeNull();
    expect(parseCliReportedUsage([])).toBeNull();
  });

  it("keeps a reported cost even when the token breakdown is missing", () => {
    const parsed = parseCliReportedUsage({ total_cost_usd: 0.5 });
    expect(parsed?.cost_usd).toBe(0.5);
    expect(parsed?.total_tokens).toBe(0);
  });

  it("ignores nonsense values instead of propagating them", () => {
    const parsed = parseCliReportedUsage({
      total_cost_usd: -1,
      usage: { input_tokens: "many", output_tokens: 5 },
    });
    expect(parsed?.prompt_tokens).toBe(0);
    expect(parsed?.completion_tokens).toBe(5);
    expect(parsed?.cost_usd).toBeNull();
  });
});

describe("addCliReportedUsage", () => {
  it("sums rounds of an agentic run, preserving null as 'unreported'", () => {
    const a = {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 10,
      cost_usd: 0.001,
    };
    const b = {
      prompt_tokens: 4,
      completion_tokens: 5,
      total_tokens: 9,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 20,
      cost_usd: 0.002,
    };

    expect(addCliReportedUsage(a, b)).toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 30,
      cost_usd: 0.003,
    });
    expect(addCliReportedUsage(null, b)).toEqual(b);
    expect(addCliReportedUsage(a, null)).toEqual(a);
    expect(addCliReportedUsage(null, null)).toBeNull();
  });
});

describe("CLI_LEAN_ARGS", () => {
  it("disables the built-in tool catalog and ambient config", () => {
    // These four flags are what took an identical task from 25,664 to 167
    // input tokens. `--tools ""` (empty string value) is the big one.
    expect(CLI_LEAN_ARGS).toEqual([
      "--tools",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--setting-sources",
      "",
    ]);
  });

  it("does not use --bare, which would break OAuth credential auth", () => {
    // --bare forces ANTHROPIC_API_KEY and never reads the credentials file the
    // launchd sync maintains (D-025).
    expect(CLI_LEAN_ARGS).not.toContain("--bare");
  });
});
