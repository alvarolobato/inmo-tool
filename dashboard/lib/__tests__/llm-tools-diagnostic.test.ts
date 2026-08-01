import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("@/lib/db-write", () => ({
  sql: mockSql,
}));

import {
  buildAgenticErrorDiagnostic,
  persistAgenticError,
} from "@/lib/llm-tools/diagnostic";
import { AgenticRunnerError } from "@/lib/llm-tools/runner";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";

const orCfg: DashboardLlmConfig = {
  provider: "openrouter",
  openrouterModel: "anthropic/claude-sonnet-4",
  cliModel: "sonnet",
  cliDriver: "claude_code",
  cliBin: "claude",
  cliExtraArgs: [],
  cliTimeoutMs: 5000,
  cliMaxCaptureBytes: 1_000_000,
};

const cliCfg: DashboardLlmConfig = { ...orCfg, provider: "cli" };

describe("buildAgenticErrorDiagnostic", () => {
  it("populates provider/driver/model from cfg for an OpenRouter error", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "boom", "req_1");
    const diag = buildAgenticErrorDiagnostic(err, orCfg);
    expect(diag.provider).toBe("openrouter");
    expect(diag.driver).toBe(null);
    expect(diag.model).toBe(orCfg.openrouterModel);
    expect(diag.phase).toBe("tool_call"); // default
    expect(diag.durationMs).toBe(0);
    expect(diag.toolRoundsUsed).toBe(0);
    expect(diag.toolCallsUsed).toBe(0);
    // No CLI block when err carries no cli data.
    expect(diag.cli).toBeUndefined();
    // Limits at failure default to env-driven config (positive numbers).
    expect(typeof diag.limitsAtFailure.maxRounds).toBe("number");
    expect(diag.limitsAtFailure.maxRounds).toBeGreaterThan(0);
    expect(diag.limitsAtFailure.maxToolCalls).toBeGreaterThan(0);
  });

  it("propagates phase, durations, and last tool call from the runner diagnostic", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "exhausted", "req_2", {
      phase: "limits",
      toolRoundsUsed: 4,
      toolCallsUsed: 12,
      durationMs: 5500,
      lastToolCall: { name: "execute_query", argumentsTruncated: '{"sql":"SELECT 1"}' },
      limitsAtFailure: {
        maxRounds: 4,
        maxToolCalls: 12,
        toolTimeoutMs: 15000,
        executeRowLimit: 200,
        payloadCharLimit: 20000,
      },
    });

    const diag = buildAgenticErrorDiagnostic(err, orCfg);
    expect(diag.phase).toBe("limits");
    expect(diag.toolRoundsUsed).toBe(4);
    expect(diag.toolCallsUsed).toBe(12);
    expect(diag.durationMs).toBe(5500);
    expect(diag.lastToolCall?.name).toBe("execute_query");
    expect(diag.lastToolCall?.argumentsTruncated).toBe('{"sql":"SELECT 1"}');
    expect(diag.limitsAtFailure.maxRounds).toBe(4);
  });

  it("surfaces CLI fields (sanitized) only when provider is 'cli'", () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "exit", "req_3", {
      phase: "cli_exit",
      toolRoundsUsed: 0,
      toolCallsUsed: 0,
      durationMs: 100,
      cli: {
        exitCode: 1,
        command: ["claude", "-p", "..."],
        stderrTail: "boom\nstack",
        stdoutTail: "{}",
        innerErrorCode: 401,
      },
      limitsAtFailure: {
        maxRounds: 4,
        maxToolCalls: 12,
        toolTimeoutMs: 15000,
        executeRowLimit: 200,
        payloadCharLimit: 20000,
      },
    });

    const cliDiag = buildAgenticErrorDiagnostic(err, cliCfg);
    expect(cliDiag.provider).toBe("cli");
    expect(cliDiag.driver).toBe("claude_code");
    expect(cliDiag.cli).toBeDefined();
    expect(cliDiag.cli?.exitCode).toBe(1);
    expect(cliDiag.cli?.innerErrorCode).toBe(401);
    expect(typeof cliDiag.cli?.stderrTail).toBe("string");
    expect(typeof cliDiag.cli?.stdoutTail).toBe("string");
    expect(Array.isArray(cliDiag.cli?.command)).toBe(true);

    // Same err but OR cfg → cli block is dropped.
    const orDiag = buildAgenticErrorDiagnostic(err, orCfg);
    expect(orDiag.cli).toBeUndefined();
    expect(orDiag.driver).toBe(null);
  });

  it("composes subError as `<code>: <sanitized message>`", () => {
    const err = new AgenticRunnerError("LIMITS_EXCEEDED", "rounds=4", "req_4");
    const diag = buildAgenticErrorDiagnostic(err, orCfg);
    expect(diag.subError).toMatch(/^LIMITS_EXCEEDED: /);
    expect(diag.subError).toContain("rounds=4");
  });
});

describe("persistAgenticError", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  it("inserts an llm_errors row using the provided diagnostic and endpoint", async () => {
    const err = new AgenticRunnerError("AGENTIC_RUNNER", "blew up", "req_5", {
      phase: "tool_call",
      toolRoundsUsed: 1,
      toolCallsUsed: 2,
      durationMs: 250,
      limitsAtFailure: {
        maxRounds: 4,
        maxToolCalls: 12,
        toolTimeoutMs: 15000,
        executeRowLimit: 200,
        payloadCharLimit: 20000,
      },
    });
    const diag = buildAgenticErrorDiagnostic(err, orCfg);

    persistAgenticError("generateDashboard", err, diag);

    // persistAgenticError is fire-and-forget; let microtasks drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSql).toHaveBeenCalledOnce();
    const [query, params] = mockSql.mock.calls[0];
    expect(query).toContain("INSERT INTO llm_errors");
    expect(params[0]).toBe("req_5"); // request_id
    expect(params[1]).toBe("generateDashboard"); // endpoint
    expect(params[2]).toBe("AGENTIC_RUNNER"); // code
    expect(params[3]).toMatch(/AGENTIC_RUNNER: blew up/); // sub_error
    expect(params[4]).toBe("openrouter"); // provider
    expect(params[5]).toBe(null); // driver
    expect(params[6]).toBe(orCfg.openrouterModel); // model
    expect(params[7]).toBe("tool_call"); // phase
    expect(params[8]).toBe(250); // duration_ms
  });
});
