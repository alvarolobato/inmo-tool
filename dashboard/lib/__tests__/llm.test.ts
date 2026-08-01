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

import { _resetCircuitBreaker } from "../llm-circuit-breaker";
import { generateDashboard, modifyDashboard, resetClient } from "../llm";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

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

  describe("generateDashboard", () => {
    it("throws if OPENROUTER_API_KEY is not set (openrouter provider)", async () => {
      delete process.env.OPENROUTER_API_KEY;
      resetClient();
      resetDashboardLlmConfigCache();
      await expect(generateDashboard("test")).rejects.toThrow(
        "OPENROUTER_API_KEY is not set. Set it in your environment, config.yaml, or .env file."
      );
    });

    it("calls the LLM with system and user messages", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '{"title": "Test", "widgets": []}' } },
        ],
      });

      const result = await generateDashboard("Créame un dashboard de ventas");

      expect(result).toBe('{"title": "Test", "widgets": []}');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "system" }),
            expect.objectContaining({
              role: "user",
              content: "Créame un dashboard de ventas",
            }),
          ]),
          temperature: 0.2,
        })
      );
    });

    it("system prompt contains key sections", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await generateDashboard("test");

      const rawContent = mockCreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === "system"
      )?.content;
      const systemContent = Array.isArray(rawContent)
        ? (rawContent as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : rawContent;

      expect(systemContent).toContain("dashboard generator");
      expect(systemContent).toContain("kpi_row");
      expect(systemContent).toContain("ps_ventas");
      expect(systemContent).toContain("total_si");
    });

    it("throws on empty LLM response", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      await expect(generateDashboard("test")).rejects.toThrow(
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

      await generateDashboard("test");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "anthropic/claude-sonnet-4",
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

      await generateDashboard("test");

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
      const resultPromise = generateDashboard("test");

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('{"ok":true}');
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    });

    it("does not retry on 400 bad request", async () => {
      const error400 = Object.assign(new Error("Bad request"), { status: 400 });
      mockCreate.mockRejectedValue(error400);

      await expect(generateDashboard("test")).rejects.toMatchObject({
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
      const resultPromise = generateDashboard("test");

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('{"ok":true}');
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    });

    it("exhausts retries and re-throws after 3 attempts", async () => {
      const error503 = Object.assign(new Error("Service unavailable"), {
        status: 503,
      });
      mockCreate.mockRejectedValue(error503);

      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const assertion = expect(generateDashboard("test")).rejects.toMatchObject({
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
      const resultPromise = generateDashboard("test");

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
      const resultPromise = generateDashboard("test");

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
      const resultPromise = generateDashboard("test");

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
    });
  });

  describe("modifyDashboard", () => {
    it("includes current spec in the system prompt", async () => {
      const currentSpec = '{"title":"Existing","widgets":[]}';
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '{"title":"Updated","widgets":[]}' } },
        ],
      });

      const result = await modifyDashboard(currentSpec, "Añade el margen");

      expect(result).toBe('{"title":"Updated","widgets":[]}');

      const rawContent = mockCreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === "system"
      )?.content;
      const systemContent = Array.isArray(rawContent)
        ? (rawContent as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : rawContent;
      expect(systemContent).toContain("Existing");
      expect(systemContent).toContain("dashboard modifier");
    });

    it("sends user modification prompt", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await modifyDashboard("{}", "Añade gráfico de tendencia");

      const userContent = mockCreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === "user"
      )?.content;
      expect(userContent).toBe("Añade gráfico de tendencia");
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

      await generateDashboard("test");

      expect(callOrder).toEqual(["budget", "llm"]);
    });

    it("calls logUsage with EMPTY_USAGE fallback when response.usage is missing", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
        // no usage field
      });

      await generateDashboard("test");

      expect(mockLogUsage).toHaveBeenLastCalledWith(
        "generateDashboard",
        "anthropic/claude-sonnet-4",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        { provider: "openrouter", driver: null },
        { requestId: "req_local" },
      );
    });

    it("calls logUsage with actual usage when response.usage is present", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      await generateDashboard("test");

      expect(mockLogUsage).toHaveBeenLastCalledWith(
        "generateDashboard",
        "anthropic/claude-sonnet-4",
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        { provider: "openrouter", driver: null },
        { requestId: "req_local" },
      );
    });

    it("propagates BudgetExceededError from checkDailyBudget", async () => {
      const { BudgetExceededError } = await import("../llm-usage");
      mockCheckDailyBudget.mockRejectedValue(new BudgetExceededError());

      await expect(generateDashboard("test")).rejects.toThrow(BudgetExceededError);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
