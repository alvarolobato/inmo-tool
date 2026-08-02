/**
 * Regression test for the bug where ctx was shallow-cloned instead of mutated
 * in place, silently dropping everything the agentic run wrote back to it.
 *
 * Background:
 *   `assembleRequest` receives `opts.ctx` and the runner mutates it during the
 *   run — telemetry (`llmProvider`, `llmDriver`) and the tool-call record
 *   (`toolCalls`) are written onto that object, and callers read them AFTER the
 *   call returns (turn-background persists ctx.toolCalls on the assistant
 *   message so later turns keep the tool context).
 *
 *   If ctx is shallow-cloned rather than mutated, every one of those writes
 *   lands on the clone and the caller sees nothing. Nothing about that contract
 *   is type-checked, so it needs a test.
 *
 * Contract: assembleRequest MUST pass ctx by reference to runAgenticChat and
 * never clone it.
 *
 * #24 note: this test previously asserted on `ctx.analyzeResult`, staged by the
 * `submit_dashboard_analysis` publish tool. That tool and the dashboard flows
 * were removed with the flow-catalog rewrite, so it now asserts the same
 * reference-identity contract through the ctx fields that survive.
 *
 * Note: this mocks assembleRequest at the llm-context level to simulate the
 * in-place mutation contract. The implementation itself is covered by
 * llm-context/__tests__/assemble.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAssembleRequest } = vi.hoisted(() => ({
  mockAssembleRequest: vi.fn(),
}));

// Mock OpenAI so importing ../llm doesn't try to instantiate a real client.
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
  },
}));

// Mock llm-usage so checkDailyBudget doesn't try to hit the DB.
vi.mock("../llm-usage", () => ({
  checkDailyBudget: vi.fn(),
  logUsage: vi.fn(),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));

// Mock assembleRequest — the single seam through which all LLM calls flow.
// The mock simulates the in-place ctx mutation contract: it writes onto the
// same opts.ctx object it was handed, exactly as the real runner does.
vi.mock("../llm-context", () => ({
  assembleRequest: (...a: unknown[]) => mockAssembleRequest(...a),
}));

import { assessOccupancy } from "../llm";
import type { LlmAgenticContext } from "../llm-tools/types";

const LISTING = {
  propertyId: 1,
  description: "Piso reformado, se entrega libre de inquilinos.",
};

describe("ctx reference identity — assembleRequest (regression)", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_AGENTIC_TOOLS_ENABLED", "true");
    mockAssembleRequest.mockReset();
  });

  it("propagates ctx mutations made inside the run back to the caller's ctx", async () => {
    const callerCtx: LlmAgenticContext = {
      requestId: "req_test",
      endpoint: "occupancy",
      toolCalls: [],
    };

    mockAssembleRequest.mockImplementation(
      async (
        _flow: unknown,
        _vars: unknown,
        _convId: unknown,
        _msg: unknown,
        opts: { ctx?: LlmAgenticContext },
      ) => {
        if (opts?.ctx) {
          opts.ctx.toolCalls = [
            {
              name: "execute_query",
              arguments: { sql: "SELECT 1" },
              result: { rows: [[1]] },
              success: true,
            } as unknown as NonNullable<LlmAgenticContext["toolCalls"]>[number],
          ];
          opts.ctx.llmProvider = "cli";
          opts.ctx.llmDriver = "claude_code";
        }
        return { text: '{"status":"vacant"}', usage: {}, model: "m" };
      },
    );

    await assessOccupancy([LISTING], { ctx: callerCtx });

    // If assembleRequest shallow-clones ctx, these fail — the mutation lands on
    // the clone and the caller's ctx is untouched.
    expect(callerCtx.toolCalls).toHaveLength(1);
    expect(callerCtx.toolCalls?.[0]?.name).toBe("execute_query");
  });

  it("also exposes the telemetry fields assembleRequest sets (llmProvider, llmDriver)", async () => {
    const callerCtx: LlmAgenticContext = {
      requestId: "req_test_2",
      endpoint: "occupancy",
    };

    mockAssembleRequest.mockImplementation(
      async (
        _flow: unknown,
        _vars: unknown,
        _convId: unknown,
        _msg: unknown,
        opts: { ctx?: LlmAgenticContext },
      ) => {
        if (opts?.ctx) {
          opts.ctx.llmProvider = "cli";
          opts.ctx.llmDriver = "claude_code";
        }
        return { text: "{}", usage: {}, model: "m" };
      },
    );

    await assessOccupancy([LISTING], { ctx: callerCtx });

    expect(callerCtx.llmProvider).toBe("cli");
    expect(typeof callerCtx.llmDriver).toBe("string");
  });
});
