/**
 * Unit tests for assembleRequest() in llm-context/assemble.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockLlmComplete = vi.fn();
const mockRunAgenticChat = vi.fn();
const mockCallWithCircuitBreaker = vi.fn((fn: () => Promise<unknown>) => fn());
const mockLoadMessages = vi.fn();
const mockBuildCachedSystemMessage = vi.fn((stable: string, volatile?: string) => ({
  role: "system" as const,
  content: [{ type: "text", text: stable }],
}));
const mockCreateDashboardAgenticAdapter = vi.fn(() => ({}));

vi.mock("@/lib/llm-client", () => ({
  llmComplete: (...a: unknown[]) => mockLlmComplete(...a),
  buildCachedSystemMessage: (...a: unknown[]) => mockBuildCachedSystemMessage(...a),
  createDashboardAgenticAdapter: () => mockCreateDashboardAgenticAdapter(),
}));

vi.mock("@/lib/llm-tools/runner", () => ({
  runAgenticChat: (...a: unknown[]) => mockRunAgenticChat(...a),
}));

vi.mock("@/lib/llm-circuit-breaker", () => ({
  callWithCircuitBreaker: (...a: Parameters<typeof mockCallWithCircuitBreaker>) =>
    mockCallWithCircuitBreaker(...a),
}));

vi.mock("@/lib/conversations", () => ({
  loadMessages: (...a: unknown[]) => mockLoadMessages(...a),
}));

vi.mock("@/lib/llm-tools/catalog", () => ({
  CHAT_TOOLS: [],
  INSPECTION_TOOL_NAMES: new Set<string>(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { assembleRequest } from "../assemble";

describe("assembleRequest", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_AGENTIC_TOOLS_ENABLED", "false");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "openrouter");
    mockLlmComplete.mockReset();
    mockRunAgenticChat.mockReset();
    mockLoadMessages.mockReset();
    mockLoadMessages.mockResolvedValue([]);
    mockLlmComplete.mockResolvedValue({
      text: "mocked response",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
      provider: "openrouter",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns AssembleResult with correct model field", async () => {
    const result = await assembleRequest("occupancy", {}, null, "Evalúa el anuncio");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("usage");
    expect(result).toHaveProperty("model");
    expect(typeof result.model).toBe("string");
  });

  it("for occupancy flow: stable system prompt contains the domain + task framing", async () => {
    const result = await assembleRequest("occupancy", {}, null, "Evalúa el anuncio");
    expect(result.text).toBe("mocked response");
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt?.stable).toContain("inversión inmobiliaria");
    expect(callArgs?.systemPrompt?.stable).toContain("Tarea: estado de ocupación");
  });

  it("for compare flow: systemPrompt.volatile carries every candidate", async () => {
    await assembleRequest(
      "compare",
      {
        candidates: [
          { propertyId: 1, description: "Piso reformado" },
          { propertyId: 2, description: "Ático a reformar" },
        ],
        profileThesis: "Alquiler de larga duración",
      },
      null,
      "Compara",
    );
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt?.volatile).toContain("CANDIDATO 1");
    expect(callArgs?.systemPrompt?.volatile).toContain("CANDIDATO 2");
    expect(callArgs?.systemPrompt?.volatile).toContain("Alquiler de larga duración");
  });

  it("history is empty when no conversationId and no priorMessages", async () => {
    await assembleRequest("occupancy", {}, null, "Test prompt");
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    // messages should only contain the user message (no prior turns)
    expect(callArgs?.messages).toHaveLength(1);
    expect(callArgs?.messages[0]).toEqual({ role: "user", content: "Test prompt" });
  });

  it("userMessage appears as last message in messages array", async () => {
    const userMsg = "¿Cuáles son las ventas del mes?";
    await assembleRequest("occupancy", {}, null, userMsg);
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    const lastMsg = callArgs?.messages[callArgs.messages.length - 1];
    expect(lastMsg?.role).toBe("user");
    expect(lastMsg?.content).toBe(userMsg);
  });

  it("uses priorMessages from opts when provided (skips DB load)", async () => {
    const priorMessages = [
      { role: "user" as const, content: "Mensaje previo" },
      { role: "assistant" as const, content: "Respuesta previa" },
    ];
    await assembleRequest("chat", {}, null, "Nueva pregunta", { priorMessages });
    expect(mockLoadMessages).not.toHaveBeenCalled();
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.messages).toHaveLength(3); // 2 prior + 1 new
  });

  it("loads messages from DB when conversationId is provided", async () => {
    mockLoadMessages.mockResolvedValueOnce([
      { role: "user", content: "Hola", created_at: "2026-01-01" },
      { role: "assistant", content: "Hola! ¿En qué puedo ayudarte?", created_at: "2026-01-01" },
    ]);
    await assembleRequest("chat", {}, "conv-abc123", "Nueva pregunta");
    expect(mockLoadMessages).toHaveBeenCalledWith("conv-abc123");
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.messages).toHaveLength(3); // 2 from DB + 1 new
  });

  it("flow field is passed through to llmComplete", async () => {
    await assembleRequest("compare", {}, null, "Compara los candidatos");
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.flow).toBe("compare");
  });

  // EC-2 (#24): the ported plumbing runs end to end for an assessment flow
  // before any real flow logic exists, so #25-#30 build on a proven seam.
  it("assembleRequest works for stub occupancy flow", async () => {
    const result = await assembleRequest(
      "occupancy",
      { listing: { propertyId: 7, description: "Se entrega libre de inquilinos." } },
      null,
      "Evalúa el anuncio",
    );

    expect(result).toEqual(
      expect.objectContaining({
        text: "mocked response",
        model: expect.any(String),
        usage: expect.objectContaining({ total_tokens: 30 }),
      }),
    );

    // Single-shot path: no tools, so it must not touch the agentic runner.
    expect(mockRunAgenticChat).not.toHaveBeenCalled();
    expect(mockLlmComplete).toHaveBeenCalledTimes(1);

    // The listing payload reaches the model in the volatile half.
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt?.volatile).toContain("libre de inquilinos");
  });

  it("single-shot assessment flows carry no conversation history", async () => {
    mockLoadMessages.mockResolvedValueOnce([
      { role: "user", content: "Un anuncio anterior", created_at: "2026-01-01" },
    ]);

    // Both a conversationId and explicit priorMessages are supplied; an
    // assessment must ignore both — carrying another listing's text into the
    // context is how findings leak across unrelated properties.
    await assembleRequest("occupancy", {}, "conv-xyz", "Evalúa", {
      priorMessages: [{ role: "user", content: "Otro anuncio" }],
    });

    expect(mockLoadMessages).not.toHaveBeenCalled();
    const callArgs = mockLlmComplete.mock.calls[0]?.[0];
    expect(callArgs?.messages).toHaveLength(1); // just the new user message
  });

  // Regression guard (issue: llm-context-missing): every flow must surface the
  // EXACT prompt + tools it sends to the LLM via ctx.onSystemPromptReady, so the
  // conversation UI can render "Contexto original" and persist it for resume.
  // Before the fix this callback was dead — assembleRequest never invoked it.
  it("invokes ctx.onSystemPromptReady with the assembled system prompt + tools", async () => {
    const onSystemPromptReady = vi.fn();
    await assembleRequest("occupancy", {}, null, "Evalúa el anuncio", {
      ctx: { requestId: "req_1", endpoint: "occupancy", onSystemPromptReady },
    });

    expect(onSystemPromptReady).toHaveBeenCalledTimes(1);
    const [systemPrompt, tools] = onSystemPromptReady.mock.calls[0];
    // Full prompt = stable (+ volatile) — must match what was sent to the LLM.
    expect(typeof systemPrompt).toBe("string");
    expect(systemPrompt).toContain("Tarea: estado de ocupación");
    const sent = mockLlmComplete.mock.calls[0]?.[0]?.systemPrompt;
    const expectedFull = sent?.volatile
      ? `${sent.stable}\n\n${sent.volatile}`
      : sent?.stable;
    expect(systemPrompt).toBe(expectedFull);
    expect(Array.isArray(tools)).toBe(true);
  });

  it("does not throw when ctx.onSystemPromptReady itself throws", async () => {
    const onSystemPromptReady = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(
      assembleRequest("occupancy", {}, null, "Evalúa", {
        ctx: { requestId: "req_2", endpoint: "occupancy", onSystemPromptReady },
      }),
    ).resolves.toHaveProperty("text", "mocked response");
    expect(onSystemPromptReady).toHaveBeenCalled();
  });
});
