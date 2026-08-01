import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBuildDiagnostic, mockPersistAgenticError } = vi.hoisted(() => ({
  mockBuildDiagnostic: vi.fn(),
  mockPersistAgenticError: vi.fn(),
}));

vi.mock("@/lib/llm-tools/diagnostic", () => ({
  buildAgenticErrorDiagnostic: mockBuildDiagnostic,
  persistAgenticError: mockPersistAgenticError,
}));

import { buildLlmErrorPayload } from "@/lib/llm-error-payload";
import { AgenticRunnerError, BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";
import type { AgenticErrorDiagnostic } from "@/lib/errors";

const orCfg: DashboardLlmConfig = {
  provider: "openrouter",
  openrouterModel: "anthropic/claude-sonnet-4",
  openrouterModelByFlow: { generate: "", modify: "", analyze: "", weekly: "" },
  cliModel: "sonnet",
  cliDriver: "claude_code",
  cliBin: "claude",
  cliExtraArgs: [],
  cliTimeoutMs: 5000,
  cliMaxCaptureBytes: 1_000_000,
};

const fakeDiagnostic: AgenticErrorDiagnostic = {
  subError: "AGENTIC_RUNNER: boom",
  provider: "openrouter",
  driver: null,
  model: "anthropic/claude-sonnet-4",
  phase: "tool_call",
  durationMs: 0,
  toolRoundsUsed: 0,
  toolCallsUsed: 0,
  limitsAtFailure: {
    maxRounds: 4,
    maxToolCalls: 12,
    toolTimeoutMs: 15000,
    executeRowLimit: 200,
    payloadCharLimit: 20000,
  },
};

describe("buildLlmErrorPayload — AgenticRunnerError branch", () => {
  beforeEach(() => {
    mockBuildDiagnostic.mockReset().mockReturnValue(fakeDiagnostic);
    mockPersistAgenticError.mockReset();
  });

  it("uses generate flow message and persists with 'generate' endpoint", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "timeout", "req_gen");
    const result = buildLlmErrorPayload(err, "req_gen", orCfg, "generate");

    expect(result.status).toBe(500);
    expect(result.payload.code).toBe("AGENTIC_RUNNER");
    expect(result.payload.error).toContain("Reformula el prompt");
    expect(mockPersistAgenticError).toHaveBeenCalledWith("generate", err, fakeDiagnostic);
  });

  it("uses modify flow message and persists with 'modify' endpoint", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "timeout", "req_mod");
    const result = buildLlmErrorPayload(err, "req_mod", orCfg, "modify");

    expect(result.status).toBe(500);
    expect(result.payload.code).toBe("AGENTIC_RUNNER");
    expect(result.payload.error).toContain("Reformula el cambio");
    expect(mockPersistAgenticError).toHaveBeenCalledWith("modify", err, fakeDiagnostic);
  });

  it("uses analyze flow message (no reformulation hint) and persists with 'analyze' endpoint", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "timeout", "req_ana");
    const result = buildLlmErrorPayload(err, "req_ana", orCfg, "analyze");

    expect(result.status).toBe(500);
    expect(result.payload.code).toBe("AGENTIC_RUNNER");
    expect(result.payload.error).not.toContain("Reformula");
    expect(result.payload.error).toContain("Inténtalo de nuevo");
    expect(mockPersistAgenticError).toHaveBeenCalledWith("analyze", err, fakeDiagnostic);
  });

  it("attaches the diagnostic to the payload", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "limits", "req_diag");
    const result = buildLlmErrorPayload(err, "req_diag", orCfg, "generate");

    expect(result.payload.diagnostic).toBe(fakeDiagnostic);
  });

  it("uses err.requestId (not outer requestId) as the payload requestId", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "boom", "inner_req");
    const result = buildLlmErrorPayload(err, "outer_req", orCfg, "generate");

    expect(result.payload.requestId).toBe("inner_req");
  });
});

describe("buildLlmErrorPayload — classifyLlmError fallback", () => {
  beforeEach(() => {
    mockBuildDiagnostic.mockReset();
    mockPersistAgenticError.mockReset();
  });

  it("returns 500 / LLM_ERROR for a generic Error and does not call persistAgenticError", () => {
    const err = new Error("unknown failure");
    const result = buildLlmErrorPayload(err, "req_gen_err", orCfg, "generate");

    expect(result.status).toBe(500);
    expect(result.payload.code).toBe("LLM_ERROR");
    expect(mockPersistAgenticError).not.toHaveBeenCalled();
  });

  it("classifies rate limit errors as 429 / LLM_RATE_LIMIT", () => {
    const err = new Error("rate limit exceeded (429)");
    const result = buildLlmErrorPayload(err, "req_rl", orCfg, "modify");

    expect(result.status).toBe(429);
    expect(result.payload.code).toBe("LLM_RATE_LIMIT");
    expect(mockPersistAgenticError).not.toHaveBeenCalled();
  });

  it("classifies BudgetExceededError as 429 / LLM_BUDGET_EXCEEDED", () => {
    const err = new BudgetExceededError();
    const result = buildLlmErrorPayload(err, "req_budget", orCfg, "analyze");

    expect(result.status).toBe(429);
    expect(result.payload.code).toBe("LLM_BUDGET_EXCEEDED");
    expect(mockPersistAgenticError).not.toHaveBeenCalled();
  });

  it("classifies CircuitBreakerOpenError as 503 / LLM_CIRCUIT_OPEN", () => {
    const err = new CircuitBreakerOpenError();
    const result = buildLlmErrorPayload(err, "req_cb", orCfg, "generate");

    expect(result.status).toBe(503);
    expect(result.payload.code).toBe("LLM_CIRCUIT_OPEN");
    expect(mockPersistAgenticError).not.toHaveBeenCalled();
  });
});
