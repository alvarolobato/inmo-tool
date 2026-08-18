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
  CLI_SAFETY_ARGS,
  parseCliReportedUsage,
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
      // prompt + completion only — cache has its own columns, same as the
      // OpenRouter path (a mixed-provider SUM of this column must mean one thing).
      total_tokens: 45,
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
    expect(parsed?.total_tokens).toBe(110);
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

describe("CLI safety vs lean args", () => {
  it("keeps tool-disabling in the SAFETY set, not the cost set", () => {
    // Our prompts carry untrusted scraped listing text. Disabling Claude's
    // built-in Bash/Edit tools is a security control, so it must not live
    // behind `dashboard.llm_cli_lean_mode`, which exists to be turned off
    // for debugging. Guarding this split is the whole point of the test.
    expect(CLI_SAFETY_ARGS).toContain("--tools");
    expect(CLI_SAFETY_ARGS[CLI_SAFETY_ARGS.indexOf("--tools") + 1]).toBe("");
    expect(CLI_LEAN_ARGS).not.toContain("--tools");
  });

  it("keeps scraped listing text out of on-disk transcripts", () => {
    expect(CLI_SAFETY_ARGS).toContain("--no-session-persistence");
  });

  it("puts only cost flags in the lean set", () => {
    // These took an identical task from 25,664 to 167 input tokens.
    expect(CLI_LEAN_ARGS).toEqual([
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--setting-sources",
      "",
    ]);
  });

  it("does not use --bare in either set, which would break OAuth credential auth", () => {
    // --bare forces ANTHROPIC_API_KEY and never reads the credentials file the
    // launchd sync maintains (D-025).
    expect([...CLI_SAFETY_ARGS, ...CLI_LEAN_ARGS]).not.toContain("--bare");
  });
});
