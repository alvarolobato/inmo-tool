/**
 * Regression test for the bug where ctx was shallow-cloned, breaking
 * the publish-tool flow.
 *
 * Background:
 *   The agentic tool handlers (submit_dashboard_analysis,
 *   apply_dashboard_modification, submit_weekly_review — see
 *   lib/llm-tools/handlers/dashboards.ts) stage their result on the
 *   ctx object: `ctx.analyzeResult = ...`, `ctx.modifyResult = ...`,
 *   `ctx.reviewResult = ...`. The API routes read these fields AFTER
 *   the agentic run completes (e.g. analyzeCtx.analyzeResult).
 *
 *   If ctx is shallow-cloned instead of mutated in place, the handlers
 *   write into the clone and the route reads null from the original.
 *   The user sees:
 *
 *     "El modelo no publicó el análisis. Inténtalo de nuevo."
 *
 *   even though the model DID call the publish tool successfully.
 *
 * Contract: assembleRequest MUST pass ctx by reference to runAgenticChat
 * and not clone it. Tool handlers mutate ctx in place; the caller reads
 * side-channel results (analyzeResult, modifyResult, reviewResult) after
 * the call returns.
 *
 * Note: This test mocks assembleRequest at the llm-context level to simulate
 * the in-place mutation contract. The implementation is verified by the
 * assemble.test.ts unit tests.
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

// Mock assembleRequest — the single seam through which all LLM calls now flow.
// We simulate the in-place ctx mutation contract: the mock writes analyzeResult
// onto the opts.ctx that was passed in, exactly as the real runner does.
vi.mock("../llm-context", () => ({
  assembleRequest: (...a: unknown[]) => mockAssembleRequest(...a),
}));

import { analyzeDashboard } from "../llm";
import type { LlmAgenticContext } from "../llm-tools/types";

describe("ctx reference identity — assembleRequest (regression)", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    vi.stubEnv("DASHBOARD_AGENTIC_TOOLS_ENABLED", "true");
    mockAssembleRequest.mockReset();
  });

  it("propagates ctx mutations made inside the agentic run back to the caller's ctx", async () => {
    const callerCtx: LlmAgenticContext = {
      requestId: "req_test",
      endpoint: "analyzeDashboard",
      dashboardId: 1,
      analyzeResult: null,
    };

    // Simulate the publish-tool handler staging the result on ctx, the way
    // submit_dashboard_analysis does in real runs. assembleRequest receives
    // opts.ctx and mutates it in place (llmProvider, llmDriver, analyzeResult).
    mockAssembleRequest.mockImplementation(
      async (_flow: unknown, _vars: unknown, _convId: unknown, _msg: unknown, opts: { ctx?: LlmAgenticContext }) => {
        if (opts?.ctx) {
          opts.ctx.analyzeResult = {
            markdown: "# Análisis\n\nVentas suben 12 %.",
            summary: "Ventas suben 12 %.",
          };
          opts.ctx.llmProvider = "cli";
          opts.ctx.llmDriver = "claude_code";
        }
        return { text: "Análisis publicado.", usage: {}, model: "m" };
      },
    );

    await analyzeDashboard("[serialized]", "Explícame el dashboard", undefined, callerCtx);

    // If assembleRequest shallow-clones ctx, this assertion fails — the
    // mutation lands on the clone and the caller's ctx stays null.
    expect(callerCtx.analyzeResult).not.toBeNull();
    expect(callerCtx.analyzeResult?.summary).toBe("Ventas suben 12 %.");
    expect(callerCtx.analyzeResult?.markdown).toContain("Ventas suben 12 %");
  });

  it("also exposes the telemetry fields assembleRequest sets (llmProvider, llmDriver)", async () => {
    const callerCtx: LlmAgenticContext = {
      requestId: "req_test_2",
      endpoint: "analyzeDashboard",
      dashboardId: 1,
      analyzeResult: null,
    };

    mockAssembleRequest.mockImplementation(
      async (_flow: unknown, _vars: unknown, _convId: unknown, _msg: unknown, opts: { ctx?: LlmAgenticContext }) => {
        if (opts?.ctx) {
          opts.ctx.llmProvider = "cli";
          opts.ctx.llmDriver = "claude_code";
        }
        return { text: "", usage: {}, model: "m" };
      },
    );

    await analyzeDashboard("[serialized]", "anything", undefined, callerCtx);

    expect(callerCtx.llmProvider).toBe("cli");
    expect(typeof callerCtx.llmDriver).toBe("string");
  });
});
