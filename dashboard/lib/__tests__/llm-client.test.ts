import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────
const {
  mockOpenRouterCreate,
  mockCliSingleShot,
  mockLogUsage,
  mockCallWithCircuitBreaker,
} = vi.hoisted(() => ({
  mockOpenRouterCreate: vi.fn(),
  mockCliSingleShot: vi.fn(),
  mockLogUsage: vi.fn(),
  mockCallWithCircuitBreaker: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenRouterCreate } };
  },
}));

vi.mock("@/lib/llm-provider/cli/claude-code", () => ({
  claudeCliSingleShot: mockCliSingleShot,
}));

vi.mock("../llm-usage", () => ({
  logUsage: mockLogUsage,
  checkDailyBudget: vi.fn().mockResolvedValue(undefined),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));

vi.mock("../llm-circuit-breaker", () => ({
  callWithCircuitBreaker: mockCallWithCircuitBreaker,
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {},
}));

// Import after mocks are registered.
import { llmComplete, resetClient } from "../llm-client";
import { resetDashboardLlmConfigCache } from "../llm-model-config";

// ── Helpers ────────────────────────────────────────────────────────────────────

function stubOpenRouter(responseText: string) {
  mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
  mockOpenRouterCreate.mockResolvedValue({
    choices: [{ message: { content: responseText } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function stubCli(
  responseText: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    cost_usd: number | null;
  } | null = null,
) {
  mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
  mockCliSingleShot.mockResolvedValue({ text: responseText, usage });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("llmComplete", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key-or");
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    resetClient();
    resetDashboardLlmConfigCache();
    mockOpenRouterCreate.mockReset();
    mockCliSingleShot.mockReset();
    mockLogUsage.mockReset();
    mockCallWithCircuitBreaker.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClient();
    resetDashboardLlmConfigCache();
  });

  // ── Provider routing ─────────────────────────────────────────────────────────

  it("routes to OpenRouter when provider=openrouter", async () => {
    stubOpenRouter("openrouter response");

    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "You are helpful." },
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(resp.provider).toBe("openrouter");
    expect(resp.text).toBe("openrouter response");
    expect(mockOpenRouterCreate).toHaveBeenCalledOnce();
    expect(mockCliSingleShot).not.toHaveBeenCalled();
  });

  it("routes to CLI when provider=cli", async () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();

    stubCli("cli response");

    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "You are helpful." },
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(resp.provider).toBe("cli");
    expect(resp.driver).toBe("claude_code");
    expect(resp.text).toBe("cli response");
    expect(mockCliSingleShot).toHaveBeenCalledOnce();
    expect(mockOpenRouterCreate).not.toHaveBeenCalled();
  });

  // ── System-prompt assembly ───────────────────────────────────────────────────

  it("assembles system prompt from stable only when volatile is absent", async () => {
    stubOpenRouter("ok");

    await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "STABLE_PART" },
      messages: [{ role: "user", content: "q" }],
    });

    // The OpenRouter path wraps the stable portion in a cache_control block
    // (Task 4: prompt caching) so the system message content is an array of
    // content blocks, not a plain string.
    const callArgs = mockOpenRouterCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const sysMsg = callArgs.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toEqual([
      { type: "text", text: "STABLE_PART", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("emits stable as cached block and volatile as separate uncached block", async () => {
    stubOpenRouter("ok");

    await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "STABLE", volatile: "VOLATILE" },
      messages: [{ role: "user", content: "q" }],
    });

    // The stable portion is wrapped in cache_control; volatile is appended as
    // a second un-cached text block so it does not bust the cached prefix.
    const callArgs = mockOpenRouterCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const sysMsg = callArgs.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "VOLATILE" },
    ]);
  });

  it("places user messages after the system message", async () => {
    stubOpenRouter("ok");

    await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "sys" },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });

    const callArgs = mockOpenRouterCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].role).toBe("system");
    expect(callArgs.messages[1]).toMatchObject({ role: "user", content: "first" });
    expect(callArgs.messages[2]).toMatchObject({ role: "assistant", content: "second" });
    expect(callArgs.messages[3]).toMatchObject({ role: "user", content: "third" });
  });

  // ── Telemetry ────────────────────────────────────────────────────────────────

  it("calls logUsage exactly once per llmComplete call (openrouter)", async () => {
    stubOpenRouter("result");

    await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "sys" },
      messages: [{ role: "user", content: "q" }],
      requestId: "req-123",
      endpoint: "generateDashboard",
    });

    expect(mockLogUsage).toHaveBeenCalledOnce();
    expect(mockLogUsage).toHaveBeenCalledWith(
      "generateDashboard",
      expect.any(String),
      expect.objectContaining({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
      expect.objectContaining({ provider: "openrouter" }),
      expect.objectContaining({ requestId: "req-123" }),
    );
  });

  it("calls logUsage exactly once per llmComplete call (cli)", async () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();
    stubCli("cli result");

    await llmComplete({
      flow: "analyze",
      systemPrompt: { stable: "sys" },
      messages: [{ role: "user", content: "q" }],
      requestId: "req-cli",
      endpoint: "analyzeDashboard",
    });

    expect(mockLogUsage).toHaveBeenCalledOnce();
    expect(mockLogUsage).toHaveBeenCalledWith(
      "analyzeDashboard",
      expect.any(String),
      expect.objectContaining({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
      expect.objectContaining({ provider: "cli" }),
      expect.objectContaining({ requestId: "req-cli" }),
    );
  });

  it("defaults endpoint to flow when endpoint is not provided", async () => {
    stubOpenRouter("ok");

    await llmComplete({
      flow: "suggest",
      systemPrompt: { stable: "sys" },
      messages: [{ role: "user", content: "q" }],
    });

    expect(mockLogUsage).toHaveBeenCalledWith(
      "suggest",
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  // ── Error mapping ────────────────────────────────────────────────────────────

  it("propagates errors from the OpenRouter provider", async () => {
    mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
    mockOpenRouterCreate.mockRejectedValue(new Error("OpenRouter API error"));

    await expect(
      llmComplete({
        flow: "generate",
        systemPrompt: { stable: "sys" },
        messages: [{ role: "user", content: "q" }],
      }),
    ).rejects.toThrow("OpenRouter API error");
  });

  it("propagates errors from the CLI provider", async () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();
    mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
    mockCliSingleShot.mockRejectedValue(new Error("CLI execution failed"));

    await expect(
      llmComplete({
        flow: "generate",
        systemPrompt: { stable: "sys" },
        messages: [{ role: "user", content: "q" }],
      }),
    ).rejects.toThrow("CLI execution failed");
  });

  // ── LlmResponse shape ────────────────────────────────────────────────────────

  it("returns normalized usage from openrouter", async () => {
    stubOpenRouter("text");

    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "s" },
      messages: [{ role: "user", content: "q" }],
    });

    expect(resp.usage).toEqual(
      expect.objectContaining({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
    );
  });

  it("falls back to zero usage when the CLI reports none (older binary)", async () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();
    stubCli("cli text");

    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "s" },
      messages: [{ role: "user", content: "q" }],
    });

    expect(resp.usage).toEqual(
      expect.objectContaining({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    );
  });

  it("logs the CLI's real tokens and reported cost, not a hard-coded zero", async () => {
    // Regression guard for the reason the owner could not see any spend: this
    // path used to log EMPTY_USAGE unconditionally, so every `cli` row in
    // llm_usage read 0 tokens / $0 no matter how much the call actually cost.
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();
    stubCli("answer", {
      prompt_tokens: 9,
      completion_tokens: 36,
      total_tokens: 25_700,
      cache_creation_input_tokens: 7521,
      cache_read_input_tokens: 18_134,
      cost_usd: 0.0176284,
    });

    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "s" },
      messages: [{ role: "user", content: "q" }],
    });

    expect(resp.usage).toEqual(
      expect.objectContaining({ prompt_tokens: 9, completion_tokens: 36, total_tokens: 25_700 }),
    );
    const [, , loggedUsage, , options] = mockLogUsage.mock.calls.at(-1)!;
    expect(loggedUsage).toEqual(
      expect.objectContaining({
        prompt_tokens: 9,
        cache_creation_input_tokens: 7521,
        cache_read_input_tokens: 18_134,
      }),
    );
    expect(options).toEqual(expect.objectContaining({ reportedCostUsd: 0.0176284 }));
  });

  // ── onTextDelta streaming callback ───────────────────────────────────────────

  it("invokes onTextDelta with single delta for cli provider", async () => {
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "cli");
    resetDashboardLlmConfigCache();
    stubCli("hello world");

    const deltas: Array<[number, number]> = [];
    await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "s" },
      messages: [{ role: "user", content: "q" }],
      onTextDelta: (chars, totalChars) => deltas.push([chars, totalChars]),
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual(["hello world".length, "hello world".length]);
  });

  it("streams OpenRouter response: calls onTextDelta per chunk and extracts usage from final chunk", async () => {
    // Stub an async-iterable stream simulating OpenRouter SSE chunks.
    const fakeChunks = [
      { choices: [{ delta: { content: "Hello" } }], usage: null },
      { choices: [{ delta: { content: " world" } }], usage: null },
      {
        choices: [{ delta: { content: "" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];

    async function* makeStream() {
      for (const chunk of fakeChunks) yield chunk;
    }

    mockCallWithCircuitBreaker.mockImplementation((fn: () => unknown) => fn());
    mockOpenRouterCreate.mockResolvedValue(makeStream());

    const deltas: Array<[number, number]> = [];
    const resp = await llmComplete({
      flow: "generate",
      systemPrompt: { stable: "s" },
      messages: [{ role: "user", content: "q" }],
      onTextDelta: (chars, totalChars) => deltas.push([chars, totalChars]),
    });

    // Accumulated text from chunks with non-empty content.
    expect(resp.text).toBe("Hello world");

    // onTextDelta called once per chunk that has content.
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual([5, 5]);   // "Hello" (5 chars, running total 5)
    expect(deltas[1]).toEqual([6, 11]);  // " world" (6 chars, running total 11)

    // Usage extracted from the final chunk.
    expect(resp.usage).toEqual(
      expect.objectContaining({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
    );

    // Telemetry written once.
    expect(mockLogUsage).toHaveBeenCalledOnce();
  });
});
