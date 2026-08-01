/**
 * Unit tests for the turn executor (turn-background.ts).
 * All dependencies are mocked — no LLM or DB required.
 */

import { describe, it, vi, expect, beforeEach } from "vitest";

// ── Static import mocks ────────────────────────────────────────────────────────

const mockUpdateTurnStatus = vi.fn();
const mockInsertTurnEvent = vi.fn();
const mockSetTurnContextFile = vi.fn();
const mockPruneStreamEvents = vi.fn();

vi.mock("@/lib/turn-events", () => ({
  updateTurnStatus: (...a: unknown[]) => mockUpdateTurnStatus(...a),
  insertTurnEvent: (...a: unknown[]) => mockInsertTurnEvent(...a),
  setTurnContextFile: (...a: unknown[]) => mockSetTurnContextFile(...a),
  pruneStreamEvents: (...a: unknown[]) => mockPruneStreamEvents(...a),
}));

const mockWriteTurnContext = vi.fn();
vi.mock("@/lib/conversation-context-store", () => ({
  writeTurnContext: (...a: unknown[]) => mockWriteTurnContext(...a),
}));

const mockAppendMessage = vi.fn();
const mockLoadMessages = vi.fn();
const mockMaybeGenerateTitle = vi.fn();
const mockTouchConversation = vi.fn();

vi.mock("@/lib/conversations", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  loadMessages: (...a: unknown[]) => mockLoadMessages(...a),
  maybeGenerateTitle: (...a: unknown[]) => mockMaybeGenerateTitle(...a),
  touchConversation: (...a: unknown[]) => mockTouchConversation(...a),
}));

vi.mock("@/lib/errors", () => ({
  generateRequestId: () => "req_test",
}));

// ── Dynamic import mocks ───────────────────────────────────────────────────────

const mockRunAgenticChat = vi.fn();
const mockAssembleRequest = vi.fn();

vi.mock("@/lib/conversation-context", () => ({}));

vi.mock("@/lib/llm-tools/runner", () => ({
  runAgenticChat: (...a: unknown[]) => mockRunAgenticChat(...a),
  AgenticRunnerError: class AgenticRunnerError extends Error {},
}));

vi.mock("@/lib/llm-provider/config", () => ({
  loadDashboardLlmConfig: () => ({ provider: "openrouter" }),
  getEffectiveDashboardModel: () => "claude-sonnet-4-6",
  getEffectiveOpenRouterProvider: () => null,
}));

vi.mock("@/lib/llm-client", () => ({
  createDashboardAgenticAdapter: () => ({}),
  llmComplete: vi.fn().mockResolvedValue({ text: "Generic LLM reply", usage: {}, model: "m" }),
}));

vi.mock("@/lib/llm-context", () => ({
  assembleRequest: (...a: unknown[]) => mockAssembleRequest(...a),
}));

const mockSql = vi.fn();
const mockUpdateDashboardSpecWithVersion = vi.fn();
vi.mock("@/lib/db-write", () => ({
  sql: (...a: unknown[]) => mockSql(...a),
  updateDashboardSpecWithVersion: (...a: unknown[]) =>
    mockUpdateDashboardSpecWithVersion(...a),
}));

const mockAnalyzeDashboard = vi.fn();
const mockModifyDashboard = vi.fn();
vi.mock("@/lib/llm", () => ({
  analyzeDashboard: (...a: unknown[]) => mockAnalyzeDashboard(...a),
  modifyDashboard: (...a: unknown[]) => mockModifyDashboard(...a),
}));

import { runTurnBackground } from "@/lib/turn-background";
import type { ConversationRow } from "@/lib/turn-background";
import type { InitialContext } from "@/lib/conversation-types";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TURN_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "abcdef012345",
    mode: "chat",
    title: null,
    first_user_prompt: null,
    context_url: null,
    context_kind: "global",
    context_ref: null,
    created_at: "2026-01-01T00:00:00Z",
    last_interaction_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    last_status: "ok",
    llm_provider: "openrouter",
    llm_driver: null,
    initial_context: null,
    created_by: null,
    last_read_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateTurnStatus.mockResolvedValue(undefined);
  mockInsertTurnEvent.mockResolvedValue(undefined);
  mockSetTurnContextFile.mockResolvedValue(undefined);
  mockPruneStreamEvents.mockResolvedValue(undefined);
  mockWriteTurnContext.mockResolvedValue("abcdef012345/turn-1.json");
  mockLoadMessages.mockResolvedValue([]);
  mockAppendMessage.mockResolvedValue({ id: "msg-001" });
  mockMaybeGenerateTitle.mockResolvedValue(undefined);
  mockTouchConversation.mockResolvedValue(undefined);
  mockRunAgenticChat.mockResolvedValue({ content: "LLM reply" });
  // Default: invoke onSystemPromptReady so the context-log file write path runs,
  // mirroring how assembleRequest surfaces the assembled prompt.
  mockAssembleRequest.mockImplementation(async (...args: unknown[]) => {
    const opts = args[4] as {
      ctx?: { onSystemPromptReady?: (p: string, t?: unknown[]) => void };
    };
    opts?.ctx?.onSystemPromptReady?.("SYSTEM PROMPT", []);
    return { text: "LLM reply", usage: {}, model: "m" };
  });
  mockSql.mockResolvedValue([]);
  mockAnalyzeDashboard.mockResolvedValue("Analysis result");
  mockModifyDashboard.mockResolvedValue("Modify result");
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("runTurnBackground — free-chat path", () => {
  it("transitions status streaming→complete on success", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hello");

    expect(mockUpdateTurnStatus).toHaveBeenNthCalledWith(1, TURN_ID, "streaming");
    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
  });

  it("writes the context log to a file (not Postgres) and records the pointer", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hello");

    // The heavy context goes to a file…
    expect(mockWriteTurnContext).toHaveBeenCalledTimes(1);
    const [convId, turnId, ctx] = mockWriteTurnContext.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(convId).toBe("abcdef012345");
    expect(turnId).toBe(TURN_ID);
    expect(ctx.system_prompt_stable).toBe("SYSTEM PROMPT");
    // …and the pointer is recorded on the turn.
    expect(mockSetTurnContextFile).toHaveBeenCalledWith(TURN_ID, "abcdef012345/turn-1.json");
    // No heavy "context" event is stored in Postgres — only a lightweight ref.
    const types = mockInsertTurnEvent.mock.calls.map((c) => c[2]);
    expect(types).not.toContain("context");
    expect(types).toContain("context_ref");
  });

  it("emits a lightweight context_ref event pointing at the file", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hello");

    const refCall = mockInsertTurnEvent.mock.calls.find((c) => c[2] === "context_ref");
    expect(refCall).toBeDefined();
    const payload = refCall![3] as Record<string, unknown>;
    expect(payload.file).toBe("abcdef012345/turn-1.json");
    expect(payload.requestId).toBe("req_test");
    // The heavy fields (system prompt, tools, history) are NOT in the DB payload.
    expect(payload.system_prompt_stable).toBeUndefined();
  });

  it("persists user message to conversation_messages before LLM call", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "user input");

    const appendCalls = mockAppendMessage.mock.calls;
    const userCall = appendCalls.find(([, role]) => role === "user");
    expect(userCall).toBeDefined();
    expect(userCall?.[2]).toEqual({ text: "user input" });
  });

  it("persists assistant reply to conversation_messages", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hello");

    const appendCalls = mockAppendMessage.mock.calls;
    const assistantCall = appendCalls.find(([, role]) => role === "assistant");
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.[2]).toEqual({ text: "LLM reply" });
  });

  it("writes the full untruncated prior history into the context-log file", async () => {
    mockLoadMessages.mockResolvedValueOnce([
      { role: "user", content: { text: "primera pregunta" } },
      { role: "assistant", content: { text: "primera respuesta" } },
    ]);

    await runTurnBackground(TURN_ID, makeConv(), "segunda pregunta");

    const ctx = mockWriteTurnContext.mock.calls[0][2] as {
      seed_prompt: string;
      prior_messages: number;
      prior_messages_history: Array<{ role: string; content: string }>;
    };
    expect(ctx.seed_prompt).toBe("segunda pregunta");
    expect(ctx.prior_messages).toBe(2);
    expect(ctx.prior_messages_history).toEqual([
      { role: "user", content: "primera pregunta" },
      { role: "assistant", content: "primera respuesta" },
    ]);
  });

  // Tool-result preservation: tool calls the model made this turn are persisted
  // on the assistant message (DB ToolCallRecord shape) so later turns retain them.
  it("persists tool calls captured during the turn onto the assistant message", async () => {
    mockAssembleRequest.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[4] as {
        ctx?: { toolCalls?: Array<Record<string, unknown>> };
      };
      // Simulate the runner capturing a tool round-trip into ctx.toolCalls.
      if (opts.ctx) {
        opts.ctx.toolCalls = [
          {
            id: "call_1",
            name: "execute_query",
            arguments: '{"sql":"SELECT 1"}',
            result: '{"rows":[{"n":1}]}',
            ok: true,
            ms: 12,
          },
        ];
      }
      return { text: "Hecho.", usage: {}, model: "m" };
    });

    await runTurnBackground(TURN_ID, makeConv(), "consulta algo");

    const assistantCall = mockAppendMessage.mock.calls.find(([, role]) => role === "assistant");
    expect(assistantCall).toBeDefined();
    const content = assistantCall?.[2] as { text: string; tool_calls?: Array<Record<string, unknown>> };
    expect(content.text).toBe("Hecho.");
    expect(content.tool_calls).toHaveLength(1);
    expect(content.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      name: "execute_query",
      // Raw JSON args are parsed to an object for storage.
      arguments: { sql: "SELECT 1" },
      result: '{"rows":[{"n":1}]}',
      success: true,
      duration_ms: 12,
    });
  });

  it("omits tool_calls on the assistant message when the turn made none", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hola");
    const assistantCall = mockAppendMessage.mock.calls.find(([, role]) => role === "assistant");
    const content = assistantCall?.[2] as { text: string; tool_calls?: unknown };
    expect(content.tool_calls).toBeUndefined();
  });

  // The free-chat turn must wire ctx.onSystemPromptReady so the EXACT prompt + tools
  // sent to the LLM are written to the turn's context-log file.
  it("writes the exact system prompt + tools to the context-log file via onSystemPromptReady", async () => {
    mockAssembleRequest.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[4] as {
        ctx?: { onSystemPromptReady?: (p: string, t?: unknown[]) => void };
      };
      opts?.ctx?.onSystemPromptReady?.("FULL SYSTEM PROMPT", [
        { name: "execute_query", schema: {} },
      ]);
      return { text: "LLM reply", usage: {}, model: "m" };
    });

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    expect(mockWriteTurnContext).toHaveBeenCalledTimes(1);
    const ctx = mockWriteTurnContext.mock.calls[0][2] as Record<string, unknown>;
    expect(ctx.system_prompt_stable).toBe("FULL SYSTEM PROMPT");
    expect(ctx.tools).toEqual([{ name: "execute_query", schema: {} }]);
    expect(ctx.flow).toBe("chat");
    expect(ctx.seed_prompt).toBe("hello");
  });
  // Regression guard: a follow-up reply must send the FULL prior conversation
  // (the user's past comments AND the assistant's past replies) to the LLM, so it
  // has the conversation context — not just the latest message.
  it("forwards full prior conversation history to assembleRequest on a follow-up", async () => {
    mockLoadMessages.mockResolvedValueOnce([
      { role: "user", content: { text: "¿Cuánto vendimos ayer?" } },
      { role: "assistant", content: { text: "Ayer vendisteis 12.345 €." } },
      { role: "tool", content: { tool_name: "execute_query", content: "…" } },
      { role: "user", content: { text: "¿Y la semana pasada?" } },
      { role: "assistant", content: { text: "La semana pasada 80.123 €." } },
    ]);

    await runTurnBackground(TURN_ID, makeConv(), "¿Y este mes?");

    const opts = mockAssembleRequest.mock.calls[0][4] as {
      priorMessages: Array<{ role: string; content: string }>;
    };
    // All user + assistant turns are forwarded (tool messages flattened out),
    // in order — the current message is appended separately by assembleRequest.
    expect(opts.priorMessages).toEqual([
      { role: "user", content: "¿Cuánto vendimos ayer?" },
      { role: "assistant", content: "Ayer vendisteis 12.345 €." },
      { role: "user", content: "¿Y la semana pasada?" },
      { role: "assistant", content: "La semana pasada 80.123 €." },
    ]);
    // The current user message is passed as the 4th positional arg, not inside history.
    expect(mockAssembleRequest.mock.calls[0][3]).toBe("¿Y este mes?");
  });
});

describe("runTurnBackground — error path", () => {
  it("marks turn as error when LLM throws", async () => {
    mockAssembleRequest.mockRejectedValue(new Error("LLM unavailable"));

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    expect(mockUpdateTurnStatus).toHaveBeenCalledWith(TURN_ID, "error", "LLM unavailable");
  });

  it("marks turn as error when loadMessages throws", async () => {
    mockLoadMessages.mockRejectedValue(new Error("DB down"));

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    expect(mockUpdateTurnStatus).toHaveBeenCalledWith(TURN_ID, "error", "DB down");
  });

  it("stores error event with message and timestamp", async () => {
    mockAssembleRequest.mockRejectedValue(new Error("boom"));

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    const errCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "error");
    expect(errCall).toBeDefined();
    expect((errCall?.[3] as Record<string, unknown>).message).toBe("boom");
  });

  it("persists an is_error assistant message so the failed turn survives reloads (#824)", async () => {
    mockAssembleRequest.mockRejectedValue(new Error("LLM exploded"));
    mockAppendMessage.mockResolvedValue({ id: "err-msg-001" });

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    const assistantCall = mockAppendMessage.mock.calls.find(
      ([, role]) => role === "assistant",
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall?.[2]).toMatchObject({
      text: "LLM exploded",
      is_error: true,
    });
    // The error event carries the messageId so the client can attach the
    // turn's logs/context panel to the persisted error message.
    const errCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "error");
    expect((errCall?.[3] as Record<string, unknown>).messageId).toBe("err-msg-001");
  });

  it("prunes transient stream events after an errored turn (#834)", async () => {
    mockAssembleRequest.mockRejectedValue(new Error("boom"));

    await runTurnBackground(TURN_ID, makeConv(), "hello");

    expect(mockPruneStreamEvents).toHaveBeenCalledWith(TURN_ID);
  });

  it("flushes queued stream inserts before pruning on the error path", async () => {
    // Queued token/thinking inserts resolve with latency; pruning must wait
    // for them or it would delete nothing and the late inserts would
    // resurrect the rows (Copilot review on #845).
    const order: string[] = [];
    mockInsertTurnEvent.mockImplementation(
      (_turnId, _seq, type) =>
        new Promise((resolve) =>
          setTimeout(() => {
            order.push(`insert:${type}`);
            resolve(1);
          }, 5),
        ),
    );
    mockPruneStreamEvents.mockImplementation(() => {
      order.push("prune");
      return Promise.resolve();
    });
    mockAssembleRequest.mockImplementation(async (...args: unknown[]) => {
      const opts = args[4] as {
        ctx?: { onAgenticProgress?: (ev: Record<string, unknown>) => void };
      };
      opts?.ctx?.onAgenticProgress?.({ type: "model_text_delta", text: "parcial" });
      opts?.ctx?.onAgenticProgress?.({ type: "model_thinking_delta", text: "hmm" });
      throw new Error("mid-stream crash");
    });

    await runTurnBackground(TURN_ID, makeConv(), "hola");

    const pruneIdx = order.indexOf("prune");
    const tokenIdx = order.indexOf("insert:token");
    const thinkingIdx = order.indexOf("insert:thinking");
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(pruneIdx).toBeGreaterThan(tokenIdx);
    expect(pruneIdx).toBeGreaterThan(thinkingIdx);
  });
});

describe("runTurnBackground — stream-state durability (#825/#834)", () => {
  it("persists the final thinking text onto the assistant message", async () => {
    mockAssembleRequest.mockImplementation(async (...args: unknown[]) => {
      const opts = args[4] as {
        ctx?: {
          onSystemPromptReady?: (p: string, t?: unknown[]) => void;
          onAgenticProgress?: (ev: Record<string, unknown>) => void;
        };
      };
      opts?.ctx?.onSystemPromptReady?.("SYSTEM PROMPT", []);
      // Cumulative thinking deltas — the LAST one is the final text.
      opts?.ctx?.onAgenticProgress?.({ type: "model_thinking_delta", text: "pensando…" });
      opts?.ctx?.onAgenticProgress?.({
        type: "model_thinking_delta",
        text: "pensando… ya casi está",
      });
      return { text: "respuesta final", usage: {}, model: "m" };
    });

    await runTurnBackground(TURN_ID, makeConv(), "hola");

    const assistantCall = mockAppendMessage.mock.calls.find(
      ([, role]) => role === "assistant",
    );
    expect(assistantCall?.[2]).toMatchObject({
      text: "respuesta final",
      thinking: "pensando… ya casi está",
    });
  });

  it("omits thinking on the assistant message when the turn produced none", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hola");

    const assistantCall = mockAppendMessage.mock.calls.find(
      ([, role]) => role === "assistant",
    );
    expect(assistantCall?.[2]).not.toHaveProperty("thinking");
  });

  it("prunes transient stream events after a completed turn", async () => {
    await runTurnBackground(TURN_ID, makeConv(), "hola");

    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
    expect(mockPruneStreamEvents).toHaveBeenCalledWith(TURN_ID);
  });

  it("inserts streamed events in seq order even when emitted in a burst", async () => {
    const insertedSeqs: number[] = [];
    mockInsertTurnEvent.mockImplementation((_turnId, seq) => {
      insertedSeqs.push(seq as number);
      // Random-ish completion latency: without the per-turn chain these
      // inserts could land out of order.
      return new Promise((resolve) =>
        setTimeout(() => resolve(undefined), insertedSeqs.length % 3),
      );
    });
    mockAssembleRequest.mockImplementation(async (...args: unknown[]) => {
      const opts = args[4] as {
        ctx?: { onAgenticProgress?: (ev: Record<string, unknown>) => void };
      };
      for (let i = 1; i <= 5; i++) {
        opts?.ctx?.onAgenticProgress?.({ type: "model_text_delta", text: `t${i}` });
      }
      return { text: "done", usage: {}, model: "m" };
    });

    await runTurnBackground(TURN_ID, makeConv(), "hola");

    const sorted = [...insertedSeqs].sort((a, b) => a - b);
    expect(insertedSeqs).toEqual(sorted);
  });
});

describe("runTurnBackground — dashboard analyze path", () => {
  it("calls analyzeDashboard and completes turn", async () => {
    const conv = makeConv({ mode: "analyze", context_kind: "dashboard", context_ref: "42" });
    mockSql.mockResolvedValue([{ spec: { widgets: [] } }]);

    await runTurnBackground(TURN_ID, conv, "explain the data");

    expect(mockAnalyzeDashboard).toHaveBeenCalledOnce();
    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
  });

  it("does NOT emit spec_update for analyze turns", async () => {
    const conv = makeConv({ mode: "analyze", context_kind: "dashboard", context_ref: "42" });
    mockSql.mockResolvedValue([]);

    await runTurnBackground(TURN_ID, conv, "analyze");

    const specCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "spec_update");
    expect(specCall).toBeUndefined();
  });

  it("handles missing dashboard spec gracefully", async () => {
    const conv = makeConv({ mode: "analyze", context_kind: "dashboard", context_ref: "999" });
    mockSql.mockResolvedValue([]);

    await runTurnBackground(TURN_ID, conv, "analyze");

    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
  });
});

describe("runTurnBackground — dashboard modify path", () => {
  it("emits spec_update when modifyDashboard sets modifyResult", async () => {
    const conv = makeConv({ mode: "modify", context_kind: "dashboard", context_ref: "42" });
    mockSql.mockResolvedValue([{ spec: { widgets: [] } }]);
    mockUpdateDashboardSpecWithVersion.mockResolvedValue({ id: 42 });
    mockModifyDashboard.mockImplementation(
      (_spec: unknown, _msg: unknown, agenticCtx: Record<string, unknown>) => {
        agenticCtx.modifyResult = { spec: { widgets: [{ type: "kpi" }] }, summary: "Updated" };
        return Promise.resolve("I've updated the dashboard.");
      },
    );

    await runTurnBackground(TURN_ID, conv, "add a KPI widget");

    // Persisted through the single versioned writer with the user prompt.
    expect(mockUpdateDashboardSpecWithVersion).toHaveBeenCalledWith(
      42,
      { widgets: [{ type: "kpi" }] },
      "add a KPI widget",
    );
    const specCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "spec_update");
    expect(specCall).toBeDefined();
    expect((specCall?.[3] as Record<string, unknown>).prompt).toBe("add a KPI widget");
  });

  it("does not emit spec_update when modifyResult is absent", async () => {
    const conv = makeConv({ mode: "modify", context_kind: "dashboard", context_ref: "42" });
    mockSql.mockResolvedValue([{ spec: { widgets: [] } }]);

    await runTurnBackground(TURN_ID, conv, "change colors");

    const specCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "spec_update");
    expect(specCall).toBeUndefined();
  });

  it("completes without spec_update when DB persist fails", async () => {
    const conv = makeConv({ mode: "modify", context_kind: "dashboard", context_ref: "42" });
    mockSql.mockResolvedValue([{ spec: { widgets: [] } }]);
    mockUpdateDashboardSpecWithVersion.mockRejectedValueOnce(new Error("DB write failure"));
    mockModifyDashboard.mockImplementation(
      (_spec: unknown, _msg: unknown, agenticCtx: Record<string, unknown>) => {
        agenticCtx.modifyResult = { spec: { widgets: [] }, summary: "" };
        return Promise.resolve("Updated.");
      },
    );

    await runTurnBackground(TURN_ID, conv, "tweak layout");

    // Turn completes successfully even if spec persist failed
    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
    const specCall = mockInsertTurnEvent.mock.calls.find(([, , type]) => type === "spec_update");
    expect(specCall).toBeUndefined();
  });
});

describe("runTurnBackground — generic fallback path", () => {
  it("uses assembleRequest for non-chat, non-analyze, non-modify modes", async () => {
    const conv = makeConv({ mode: "view", context_kind: "dashboard" });

    await runTurnBackground(TURN_ID, conv, "show me the data");

    expect(mockAssembleRequest).toHaveBeenCalledOnce();
    expect(mockUpdateTurnStatus).toHaveBeenLastCalledWith(TURN_ID, "complete");
  });
});
