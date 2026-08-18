import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreate, mockCheckDailyBudget, mockLogUsage } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCheckDailyBudget: vi.fn(),
  mockLogUsage: vi.fn(),
}));

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

vi.mock("../llm-usage", () => ({
  checkDailyBudget: mockCheckDailyBudget,
  logUsage: mockLogUsage,
  BudgetExceededError: class BudgetExceededError extends Error {
    constructor() {
      super("Límite diario de generación alcanzado. Reintente mañana.");
      this.name = "BudgetExceededError";
    }
  },
}));

// Run the real config loader, but against a config.yaml that does not exist, so
// these tests read env vars and schema defaults only — never the developer's
// ~/.config/inmo-tool/config.yaml.
//
// getOpenRouterApiKey() prefers the loader's value over process.env, and a
// scaffolded config.yaml still holds `openrouter.api_key: your_openrouter_api_key`.
// That placeholder is truthy, so "throws if OPENROUTER_API_KEY is not set" stopped
// asserting anything locally while still passing in CI, where no config.yaml exists.
//
// Note this delegates rather than returning a stub object: getSystemConfig() is
// itself the env-var reader (env > file > default), so stubbing it empty would
// also blank DASHBOARD_LLM_PROVIDER and silently route these tests to the CLI
// provider, spawning a real `claude` process.
vi.mock("@/lib/system-config/loader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/system-config/loader")>();
  return {
    ...actual,
    getSystemConfig: (opts?: Parameters<typeof actual.getSystemConfig>[0]) =>
      actual.getSystemConfig({
        ...opts,
        configPath: "/nonexistent/inmo-tool-test-config.yaml",
        noCache: true,
      }),
  };
});

import { _resetCircuitBreaker } from "../llm-circuit-breaker";
import { assessOccupancy, compareCandidates, resetClient } from "../llm";
import type { ListingSnapshot } from "../llm-context";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

const LISTING: ListingSnapshot = {
  propertyId: 1,
  description: "Piso reformado en Chamberí, se entrega libre de inquilinos.",
};
const LISTING_B: ListingSnapshot = { propertyId: 2, description: "Ático a reformar." };

describe("llm", () => {
  beforeEach(() => {
    _resetCircuitBreaker();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key-123");
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    vi.stubEnv("DASHBOARD_AGENTIC_TOOLS_ENABLED", "false");
    resetClient();
    resetDashboardLlmConfigCache();
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClient();
    resetDashboardLlmConfigCache();
    _resetCircuitBreaker();
  });

  describe("assessOccupancy", () => {
    it("throws if OPENROUTER_API_KEY is not set (openrouter provider)", async () => {
      delete process.env.OPENROUTER_API_KEY;
      resetClient();
      resetDashboardLlmConfigCache();
      await expect(assessOccupancy([LISTING])).rejects.toThrow(
        "OPENROUTER_API_KEY is not set. Set it in your environment, config.yaml, or .env file."
      );
    });

    it("calls the LLM with system and user messages", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '{"title": "Test", "widgets": []}' } },
        ],
      });

      const result = await assessOccupancy([LISTING]);

      // #25 returns { text, model } rather than a bare string, so a stored
      // verdict can record which model produced it.
      expect(result.text).toBe('{"title": "Test", "widgets": []}');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "system" }),
            expect.objectContaining({
              role: "user",
              content: expect.stringContaining("occupancy"),
            }),
          ]),
          temperature: 0,
        })
      );
    });

    it("system prompt carries the occupancy task and the listing payload", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await assessOccupancy([LISTING]);

      const rawContent = mockCreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === "system"
      )?.content;
      const systemContent = Array.isArray(rawContent)
        ? (rawContent as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : rawContent;

      // Domain framing + this flow's task, from buildOccupancyPrompt.
      expect(systemContent).toContain("inversión inmobiliaria");
      // #145 widened this flow from occupancy-only to three independent axes
      // (occupancy / what is transmitted / how much right), so the heading
      // moved. It is also what detectMockFlow keys on — keep them in step.
      expect(systemContent).toContain("Tarea: ¿qué se compra exactamente");
      expect(systemContent).toContain("occupied_illegally");
      // The volatile half must carry the actual listing under assessment.
      expect(systemContent).toContain("libre de inquilinos");
      // And must NOT carry the retired dashboard-generation content.
      expect(systemContent).not.toContain("kpi_row");
      expect(systemContent).not.toContain("ps_ventas");
    });

    it("throws on empty LLM response", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      await expect(assessOccupancy([LISTING])).rejects.toThrow(
        "LLM returned an empty response"
      );
    });

    it("uses default model when DASHBOARD_LLM_MODEL is not set", async () => {
      delete process.env.DASHBOARD_LLM_MODEL;
      delete process.env.DASHBOARD_LLM_MODEL_OPENROUTER;
      resetDashboardLlmConfigCache();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await assessOccupancy([LISTING]);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "anthropic/claude-haiku-4.5",
        })
      );
    });

    it("uses custom model from DASHBOARD_LLM_MODEL_OPENROUTER", async () => {
      vi.stubEnv("DASHBOARD_LLM_MODEL_OPENROUTER", "anthropic/claude-opus-4");
      delete process.env.DASHBOARD_LLM_MODEL;
      resetClient();
      resetDashboardLlmConfigCache();
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await assessOccupancy([LISTING]);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "anthropic/claude-opus-4",
        })
      );
    });
  });

  describe("retry and backoff", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("retries on 429 with 1s then 2s delay", async () => {
      const error429 = Object.assign(new Error("Rate limit exceeded"), {
        status: 429,
        headers: {},
      });
      mockCreate
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"ok":true}' } }],
        });

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const resultPromise = assessOccupancy([LISTING]);

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.text).toBe('{"ok":true}');
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    });

    it("does not retry on 400 bad request", async () => {
      const error400 = Object.assign(new Error("Bad request"), { status: 400 });
      mockCreate.mockRejectedValue(error400);

      await expect(assessOccupancy([LISTING])).rejects.toMatchObject({
        status: 400,
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("retries on network error (no status) with backoff", async () => {
      const networkError = new Error("Network failure");
      mockCreate
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"ok":true}' } }],
        });

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const resultPromise = assessOccupancy([LISTING]);

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.text).toBe('{"ok":true}');
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    });

    it("exhausts retries and re-throws after 3 attempts", async () => {
      const error503 = Object.assign(new Error("Service unavailable"), {
        status: 503,
      });
      mockCreate.mockRejectedValue(error503);

      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const assertion = expect(assessOccupancy([LISTING])).rejects.toMatchObject({
        status: 503,
      });
      await vi.runAllTimersAsync();
      await assertion;
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it("respects Retry-After header on 429", async () => {
      const error429 = Object.assign(new Error("Rate limit exceeded"), {
        status: 429,
        headers: { "retry-after": "5" },
      });
      mockCreate
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"ok":true}' } }],
        });

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const resultPromise = assessOccupancy([LISTING]);

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });

    it("respects Retry-After header with canonical casing", async () => {
      const error429 = Object.assign(new Error("Rate limit exceeded"), {
        status: 429,
        headers: { "Retry-After": "7" },
      });
      mockCreate
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"ok":true}' } }],
        });

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const resultPromise = assessOccupancy([LISTING]);

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7000);
    });

    it("respects Retry-After header from a Headers instance", async () => {
      const hdrs = new Headers({ "retry-after": "3" });
      const error429 = Object.assign(new Error("Rate limit exceeded"), {
        status: 429,
        headers: hdrs,
      });
      mockCreate
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"ok":true}' } }],
        });

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const resultPromise = assessOccupancy([LISTING]);

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
    });
  });

  describe("compareCandidates", () => {
    it("includes every candidate and the thesis in the system prompt", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"ranking":[]}' } }],
      });

      const result = await compareCandidates(
        [LISTING, LISTING_B],
        "Comprar para alquilar con rentabilidad > 6%",
      );

      expect(result).toBe('{"ranking":[]}');

      const rawContent = mockCreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === "system"
      )?.content;
      const systemContent = Array.isArray(rawContent)
        ? (rawContent as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : rawContent;

      expect(systemContent).toContain("Tarea: comparativa de candidatos");
      expect(systemContent).toContain("CANDIDATO 1");
      expect(systemContent).toContain("CANDIDATO 2");
      expect(systemContent).toContain("rentabilidad > 6%");
    });

    it("rejects a comparison of fewer than two candidates before calling the LLM", async () => {
      await expect(compareCandidates([LISTING])).rejects.toThrow(
        "compareCandidates requires at least two candidates",
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("budget enforcement and usage logging", () => {
    beforeEach(() => {
      mockCheckDailyBudget.mockResolvedValue(undefined);
      mockLogUsage.mockReturnValue(undefined);
      mockLogUsage.mockClear();
    });

    it("awaits checkDailyBudget before calling the LLM", async () => {
      const callOrder: string[] = [];
      mockCheckDailyBudget.mockImplementation(async () => {
        callOrder.push("budget");
      });
      mockCreate.mockImplementation(async () => {
        callOrder.push("llm");
        return { choices: [{ message: { content: "{}" } }] };
      });

      await assessOccupancy([LISTING]);

      expect(callOrder).toEqual(["budget", "llm"]);
    });

    it("calls logUsage with EMPTY_USAGE fallback when response.usage is missing", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
        // no usage field
      });

      await assessOccupancy([LISTING]);

      expect(mockLogUsage).toHaveBeenLastCalledWith(
        "occupancy",
        "anthropic/claude-haiku-4.5",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        { provider: "openrouter", driver: null },
        { requestId: null },
      );
    });

    it("calls logUsage with actual usage when response.usage is present", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      await assessOccupancy([LISTING]);

      expect(mockLogUsage).toHaveBeenLastCalledWith(
        "occupancy",
        "anthropic/claude-haiku-4.5",
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        { provider: "openrouter", driver: null },
        { requestId: null },
      );
    });

    it("propagates BudgetExceededError from checkDailyBudget", async () => {
      const { BudgetExceededError } = await import("../llm-usage");
      mockCheckDailyBudget.mockRejectedValue(new BudgetExceededError());

      await expect(assessOccupancy([LISTING])).rejects.toThrow(BudgetExceededError);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
