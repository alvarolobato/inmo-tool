import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

const { ok } = vi.hoisted(() => ({
  ok: <T>(data: T) => ({ ok: true as const, data }),
}));

/**
 * Create an async iterable from a sequence of chunks, simulating what OpenAI
 * streaming `chat.completions.create({ stream: true })` returns. Each item in
 * `chunks` is a partial chat completion chunk.
 */
function makeStreamResponse(chunks: object[]): AsyncIterable<object> {
  return {
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next() {
          if (idx < chunks.length) {
            return { value: chunks[idx++], done: false as const };
          }
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

/** Make a text-content streaming response (single chunk). */
function makeTextStream(content: string, usage?: object): AsyncIterable<object> {
  const chunks: object[] = [
    { choices: [{ delta: { content } }] },
  ];
  if (usage) {
    chunks.push({ choices: [], usage });
  }
  return makeStreamResponse(chunks);
}

/** Make a tool-call streaming response (single chunk with tool_calls). */
function makeToolCallStream(
  toolCalls: { id: string; function: { name: string; arguments: string } }[],
  usage?: object,
): AsyncIterable<object> {
  const chunks: object[] = [
    {
      choices: [
        {
          delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: "function",
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
        },
      ],
    },
  ];
  if (usage) {
    chunks.push({ choices: [], usage });
  }
  return makeStreamResponse(chunks);
}

vi.mock("@/lib/llm-tools/logging", () => ({
  logLlmToolCall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/llm-tools/handlers/sql", () => ({
  handleValidateQuery: vi.fn().mockResolvedValue(ok({ valid: true })),
  handleExecuteQuery: vi.fn().mockResolvedValue(ok({ rows: [], columns: [] })),
  handleExplainQuery: vi.fn().mockResolvedValue(ok({ explain: [] })),
  handleListPsTables: vi.fn().mockResolvedValue(ok({ tables: ["ps_ventas"] })),
  handleDescribePsTable: vi.fn().mockResolvedValue(ok({ columns: [] })),
}));

vi.mock("@/lib/llm-tools/handlers/dashboards", () => ({
  handleListDashboards: vi.fn().mockResolvedValue(ok({ dashboards: [] })),
  handleGetDashboardSpec: vi.fn().mockResolvedValue(ok({ spec: {} })),
  handleGetDashboardQueries: vi.fn().mockResolvedValue(ok({ queries: [] })),
  handleGetDashboardWidgetRawValues: vi.fn().mockResolvedValue(ok({ rows: [] })),
  handleGetDashboardAllWidgetStatus: vi.fn().mockResolvedValue(ok({ widgets: [] })),
}));

vi.mock("@/lib/llm-tools/handlers/start-dashboard-generation", () => ({
  handleStartDashboardGeneration: vi.fn().mockResolvedValue(
    ok({ dashboard_id: "1", redirect_url: "/dashboards/1?tab=modify", summary: "Created" }),
  ),
}));

const mockSetConversationTitleOnce = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/conversations", () => ({
  setConversationTitleOnce: (...a: unknown[]) => mockSetConversationTitleOnce(...a),
}));

import { runAgenticChat, AgenticRunnerError } from "@/lib/llm-tools/runner";
import { createOpenRouterAgenticAdapter } from "@/lib/llm-provider/openrouter";

const ctx = {
  requestId: "req_runner_test",
  endpoint: "testEndpoint",
  llmProvider: "openrouter" as const,
  llmDriver: null as null,
};

describe("runAgenticChat", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS", "4");
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_CALLS", "12");
    vi.stubEnv("DASHBOARD_AGENTIC_TOOL_TIMEOUT_MS", "5000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns content when the model answers without tools", async () => {
    const create = vi.fn().mockReturnValue(
      makeTextStream("solo texto", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    const out = await runAgenticChat({
      adapter,
      model: "anthropic/claude-sonnet-4",
      systemPrompt: "sys",
      userContent: "user",
      ctx,
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(out.content).toBe("solo texto");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("handles one tool round then a final message", async () => {
    const create = vi
      .fn()
      .mockReturnValueOnce(
        makeToolCallStream(
          [{ id: "call_1", function: { name: "list_ps_tables", arguments: "{}" } }],
          { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
        ),
      )
      .mockReturnValueOnce(
        makeTextStream("listo", { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }),
      );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    const out = await runAgenticChat({
      adapter,
      model: "m",
      systemPrompt: "sys",
      userContent: "hi",
      ctx,
      temperature: 0,
      maxTokens: 200,
    });

    expect(out.content).toBe("listo");
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1][0] as { messages: unknown[] };
    expect(second.messages.some((m) => (m as { role: string }).role === "tool")).toBe(
      true,
    );
  });

  it("captures tool round-trips into ctx.toolCalls for later persistence", async () => {
    const create = vi
      .fn()
      .mockReturnValueOnce(
        makeToolCallStream(
          [{ id: "call_1", function: { name: "list_ps_tables", arguments: "{}" } }],
          { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
        ),
      )
      .mockReturnValueOnce(
        makeTextStream("listo", { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }),
      );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    // Fresh ctx (not a spread of the shared one) so the runner-mutated
    // toolCalls array starts empty and isn't polluted by other tests.
    const runCtx: import("@/lib/llm-tools/types").LlmAgenticContext = {
      requestId: "req_runner_test",
      endpoint: "testEndpoint",
      llmProvider: "openrouter",
      llmDriver: null,
    };
    await runAgenticChat({
      adapter,
      model: "m",
      systemPrompt: "sys",
      userContent: "hi",
      ctx: runCtx,
      temperature: 0,
      maxTokens: 200,
    });

    expect(runCtx.toolCalls).toHaveLength(1);
    expect(runCtx.toolCalls?.[0]).toMatchObject({
      id: "call_1",
      name: "list_ps_tables",
      arguments: "{}",
      ok: true,
    });
    // The result payload the model received is captured (contains the tool output).
    expect(runCtx.toolCalls?.[0].result).toContain("ps_ventas");
    expect(typeof runCtx.toolCalls?.[0].ms).toBe("number");
  });

  it("throws AgenticRunnerError when max tool rounds is exceeded", async () => {
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS", "1");
    const create = vi.fn().mockReturnValue(
      makeToolCallStream(
        [{ id: "c1", function: { name: "list_ps_tables", arguments: "{}" } }],
        { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      ),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    await expect(
      runAgenticChat({
        adapter,
        model: "m",
        systemPrompt: "s",
        userContent: "u",
        ctx,
        temperature: 0,
        maxTokens: 50,
      }),
    ).rejects.toMatchObject({ name: "AgenticRunnerError", code: "AGENTIC_MAX_ROUNDS" });
  });

  it("throws AgenticRunnerError when max tool calls is exceeded", async () => {
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_CALLS", "1");
    const create = vi.fn().mockReturnValue(
      makeToolCallStream(
        [
          { id: "a", function: { name: "list_ps_tables", arguments: "{}" } },
          { id: "b", function: { name: "list_ps_tables", arguments: "{}" } },
        ],
        { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      ),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    await expect(
      runAgenticChat({
        adapter,
        model: "m",
        systemPrompt: "s",
        userContent: "u",
        ctx,
        temperature: 0,
        maxTokens: 50,
      }),
    ).rejects.toMatchObject({
      name: "AgenticRunnerError",
      code: "AGENTIC_MAX_TOOL_CALLS",
    });
  });

  it("throws AgenticRunnerError on empty final content", async () => {
    const create = vi.fn().mockReturnValue(makeTextStream("", {}));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    await expect(
      runAgenticChat({
        adapter,
        model: "m",
        systemPrompt: "s",
        userContent: "u",
        ctx,
        temperature: 0,
        maxTokens: 10,
      }),
    ).rejects.toBeInstanceOf(AgenticRunnerError);
  });

  it("calls setConversationTitleOnce when set_title is invoked with a valid title", async () => {
    mockSetConversationTitleOnce.mockReset().mockResolvedValue(undefined);
    const create = vi
      .fn()
      .mockReturnValueOnce(
        makeToolCallStream([
          { id: "call_title", function: { name: "set_title", arguments: JSON.stringify({ title: "  Mi Panel  " }) } },
        ]),
      )
      .mockReturnValueOnce(makeTextStream("Título establecido"));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    await runAgenticChat({
      adapter,
      model: "m",
      systemPrompt: "s",
      userContent: "u",
      ctx: { ...ctx, conversationId: "conv_abc123" },
      temperature: 0,
      maxTokens: 200,
    });

    expect(mockSetConversationTitleOnce).toHaveBeenCalledTimes(1);
    expect(mockSetConversationTitleOnce).toHaveBeenCalledWith("conv_abc123", "Mi Panel");
  });

  it("does not call setConversationTitleOnce when set_title receives an empty title", async () => {
    mockSetConversationTitleOnce.mockReset().mockResolvedValue(undefined);
    const create = vi
      .fn()
      .mockReturnValueOnce(
        makeToolCallStream([
          { id: "call_title", function: { name: "set_title", arguments: JSON.stringify({ title: "" }) } },
        ]),
      )
      .mockReturnValueOnce(makeTextStream("ok"));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const adapter = createOpenRouterAgenticAdapter(client);

    await runAgenticChat({
      adapter,
      model: "m",
      systemPrompt: "s",
      userContent: "u",
      ctx: { ...ctx, conversationId: "conv_abc123" },
      temperature: 0,
      maxTokens: 200,
    });

    expect(mockSetConversationTitleOnce).not.toHaveBeenCalled();
  });
});
