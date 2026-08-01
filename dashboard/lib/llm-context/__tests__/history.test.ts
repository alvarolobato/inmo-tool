/**
 * Unit tests for history flattening — including tool-result preservation across
 * turns (flattenStoredMessage / formatToolCallsForHistory) — and the history
 * cap (capHistory: summarise older messages beyond HISTORY_MAX_MESSAGES).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockChatCompletion = vi.fn();
vi.mock("@/lib/llm-provider/openrouter", () => ({
  getOpenRouterClient: () => ({}),
  openRouterChatCompletion: (...a: unknown[]) => mockChatCompletion(...a),
}));
vi.mock("@/lib/llm-provider/cli/claude-code", () => ({
  claudeCliSingleShot: vi.fn(),
}));
const mockGetModel = vi.fn(() => "test-model");
vi.mock("@/lib/llm-provider/config", () => ({
  loadDashboardLlmConfig: () => ({ provider: "openrouter" }),
  getEffectiveDashboardModel: (...a: unknown[]) => mockGetModel(...a),
  getEffectiveOpenRouterProvider: () => null,
}));
vi.mock("@/lib/llm-circuit-breaker", () => ({
  callWithCircuitBreaker: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/llm-usage", () => ({ logUsage: vi.fn() }));
vi.mock("@/lib/conversations", () => ({ loadMessages: vi.fn() }));

import {
  flattenStoredMessage,
  formatToolCallsForHistory,
  capHistory,
  HISTORY_MAX_MESSAGES,
  type HistoryMessage,
} from "../history";
import type { ToolCallRecord } from "@/lib/conversation-types";

describe("flattenStoredMessage", () => {
  it("extracts text from a user message object", () => {
    expect(flattenStoredMessage({ role: "user", content: { text: "hola" } })).toEqual({
      role: "user",
      content: "hola",
    });
  });

  it("extracts text from a plain-string content (legacy rows)", () => {
    expect(flattenStoredMessage({ role: "assistant", content: "respuesta" })).toEqual({
      role: "assistant",
      content: "respuesta",
    });
  });

  it("skips standalone tool-role rows (tool context lives on the assistant turn)", () => {
    expect(
      flattenStoredMessage({
        role: "tool",
        content: { tool_call_id: "c1", tool_name: "execute_query", content: "…" },
      }),
    ).toBeNull();
  });

  it("returns null for an empty assistant message", () => {
    expect(flattenStoredMessage({ role: "assistant", content: { text: "" } })).toBeNull();
  });

  it("folds the assistant's tool calls into the turn so results persist across turns", () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: "c1",
        name: "execute_query",
        arguments: { sql: "SELECT SUM(total) FROM ps_ventas WHERE fecha = CURRENT_DATE" },
        result: '{"rows":[{"sum":12345.67}]}',
        success: true,
      },
    ];
    const flat = flattenStoredMessage({
      role: "assistant",
      content: { text: "Ayer vendisteis 12.345,67 €.", tool_calls: toolCalls },
    });
    expect(flat).not.toBeNull();
    expect(flat!.role).toBe("assistant");
    // Tool block appears BEFORE the final text so the model sees what was queried.
    expect(flat!.content).toContain("execute_query");
    expect(flat!.content).toContain("SELECT SUM(total)");
    expect(flat!.content).toContain("12345.67");
    expect(flat!.content).toContain("Ayer vendisteis 12.345,67 €.");
    expect(flat!.content.indexOf("execute_query")).toBeLessThan(
      flat!.content.indexOf("Ayer vendisteis"),
    );
  });

  it("preserves tool context even when the assistant produced no final text", () => {
    const flat = flattenStoredMessage({
      role: "assistant",
      content: {
        tool_calls: [
          { id: "c1", name: "list_ps_tables", arguments: {}, result: "ps_ventas, ps_clientes", success: true },
        ],
      },
    });
    expect(flat).not.toBeNull();
    expect(flat!.content).toContain("list_ps_tables");
    expect(flat!.content).toContain("ps_ventas");
  });
});

describe("formatToolCallsForHistory", () => {
  it("returns empty string for no tool calls", () => {
    expect(formatToolCallsForHistory([])).toBe("");
  });

  it("marks failed tool calls", () => {
    const block = formatToolCallsForHistory([
      { id: "c1", name: "execute_query", arguments: { sql: "SELECT 1" }, result: "boom", success: false },
    ]);
    expect(block).toContain("[error]");
    expect(block).toContain("execute_query");
  });

  it("truncates very long tool results to keep only the interesting part", () => {
    const huge = "x".repeat(5000);
    const block = formatToolCallsForHistory([
      { id: "c1", name: "execute_query", arguments: {}, result: huge, success: true },
    ]);
    // Far smaller than the raw 5000-char result.
    expect(block.length).toBeLessThan(1200);
    expect(block).toContain("chars)");
  });
});

// ── capHistory — bounded context for every conversation flow (#821) ───────────

function makeMessages(n: number): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `mensaje ${i}`,
  }));
}

describe("capHistory", () => {
  beforeEach(() => {
    mockChatCompletion.mockReset();
  });

  it("returns messages unchanged (no LLM call) when within the cap", async () => {
    const msgs = makeMessages(HISTORY_MAX_MESSAGES);
    const result = await capHistory(msgs);
    expect(result).toBe(msgs);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("summarises older messages into one synthetic assistant message when over the cap", async () => {
    mockChatCompletion.mockResolvedValue({ content: "- pidió ventas\n- pidió margen", usage: null });
    const msgs = makeMessages(25);

    const result = await capHistory(msgs);

    expect(result).toHaveLength(HISTORY_MAX_MESSAGES);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("Earlier in this conversation");
    expect(result[0].content).toContain("pidió ventas");
    // The most recent (maxMessages - 1) messages are preserved verbatim.
    expect(result.slice(1)).toEqual(msgs.slice(25 - (HISTORY_MAX_MESSAGES - 1)));
    expect(mockChatCompletion).toHaveBeenCalledOnce();
  });

  it("falls back to the raw user prompts when the summarisation LLM call fails", async () => {
    mockChatCompletion.mockRejectedValue(new Error("LLM down"));
    const msgs = makeMessages(15);

    const result = await capHistory(msgs);

    expect(result).toHaveLength(HISTORY_MAX_MESSAGES);
    // Fallback embeds the older user prompts directly — turn must not fail.
    expect(result[0].content).toContain("mensaje 0");
  });

  it("respects an explicit smaller cap", async () => {
    mockChatCompletion.mockResolvedValue({ content: "- resumen", usage: null });
    const result = await capHistory(makeMessages(8), 4);
    expect(result).toHaveLength(4);
    expect(result[0].content).toContain("resumen");
  });

  it("bounds the summarisation prompt for very long histories (and the fallback)", async () => {
    mockChatCompletion.mockRejectedValue(new Error("LLM down"));
    // 200 old user messages × 200 chars would be ~40 KB unbounded.
    const msgs: HistoryMessage[] = Array.from({ length: 400 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `petición ${i} ` + "x".repeat(300),
    }));

    const result = await capHistory(msgs);

    expect(result).toHaveLength(HISTORY_MAX_MESSAGES);
    // Fallback summary (= the summariser input) stays within the char budget.
    expect(result[0].content.length).toBeLessThan(4_600);
    // Most recent old prompts win: the last old user message is included.
    expect(result[0].content).toContain("petición 388");
  });

  it("routes summarisation through the caller's flow for per-flow model overrides", async () => {
    mockChatCompletion.mockResolvedValue({ content: "- resumen", usage: null });
    await capHistory(makeMessages(15), HISTORY_MAX_MESSAGES, "modify");
    expect(mockGetModel).toHaveBeenCalledWith(expect.anything(), "modify");
  });
});
