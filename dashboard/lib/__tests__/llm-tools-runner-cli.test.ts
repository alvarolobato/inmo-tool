import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockClaudeStep } = vi.hoisted(() => ({
  mockClaudeStep: vi.fn(),
}));

vi.mock("@/lib/llm-tools/logging", () => ({
  logLlmToolCall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/llm-tools/handlers/sql", () => ({
  handleValidateQuery: vi.fn(),
  handleExecuteQuery: vi.fn(),
  handleExplainQuery: vi.fn(),
  handleListPsTables: vi.fn().mockResolvedValue({ ok: true as const, data: { tables: ["ps_x"] } }),
  handleDescribePsTable: vi.fn(),
}));

vi.mock("@/lib/llm-tools/handlers/dashboards", () => ({
  handleListDashboards: vi.fn(),
  handleGetDashboardSpec: vi.fn(),
  handleGetDashboardQueries: vi.fn(),
  handleGetDashboardWidgetRawValues: vi.fn(),
  handleGetDashboardAllWidgetStatus: vi.fn(),
}));

vi.mock("@/lib/llm-tools/handlers/start-dashboard-generation", () => ({
  handleStartDashboardGeneration: vi.fn().mockResolvedValue({
    ok: true as const,
    data: { dashboard_id: "1", redirect_url: "/dashboards/1?tab=modify", summary: "Created" },
  }),
}));

vi.mock("@/lib/llm-provider/cli/claude-code", () => ({
  claudeCliAgenticStep: mockClaudeStep,
}));

import { runAgenticChat, AgenticRunnerError } from "@/lib/llm-tools/runner";
import { createClaudeCodeAgenticAdapter } from "@/lib/llm-provider/cli/agent-adapter";
import { CliRunnerError } from "@/lib/llm-client";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";

const cfg: DashboardLlmConfig = {
  provider: "cli",
  openrouterModel: "anthropic/claude-sonnet-4",
  cliModel: "sonnet",
  cliDriver: "claude_code",
  cliBin: "claude",
  cliExtraArgs: [],
  cliTimeoutMs: 5000,
  cliMaxCaptureBytes: 1_000_000,
};

const ctx = {
  requestId: "req_cli_runner",
  endpoint: "generateDashboard",
  llmProvider: "cli" as const,
  llmDriver: "claude_code" as const,
};

describe("runAgenticChat (CLI adapter)", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS", "4");
    vi.stubEnv("DASHBOARD_AGENTIC_MAX_TOOL_CALLS", "12");
    vi.stubEnv("DASHBOARD_AGENTIC_TOOL_TIMEOUT_MS", "5000");
    mockClaudeStep.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issue #419: surfaces CliRunnerError with diagnostic on AgenticRunnerError", async () => {
    // Simulate the production failure: claude exits 1 with auth-error JSON envelope.
    mockClaudeStep.mockRejectedValueOnce(
      new CliRunnerError(
        "LLM_CLI_AUTH",
        "claude agentic step: Failed to authenticate. API Error: 401",
        {
          exitCode: 1,
          stderr: "",
          stdout:
            '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate"}',
          command: ["claude", "-p", "x", "--model", "sonnet"],
          phase: "auth",
          durationMs: 4321,
          innerErrorCode: 401,
        },
      ),
    );

    const adapter = createClaudeCodeAgenticAdapter(cfg);
    let caught: AgenticRunnerError | null = null;
    try {
      await runAgenticChat({
        adapter,
        model: cfg.cliModel,
        systemPrompt: "sys",
        userContent: "go",
        ctx,
        temperature: 0.2,
        maxTokens: 1000,
      });
    } catch (e) {
      caught = e as AgenticRunnerError;
    }
    expect(caught).not.toBeNull();
    expect(caught!).toBeInstanceOf(AgenticRunnerError);
    expect(caught!.code).toBe("LLM_CLI_AUTH");
    expect(caught!.diagnostic).toBeDefined();
    expect(caught!.diagnostic!.phase).toBe("cli_exit");
    expect(caught!.diagnostic!.cli).toBeDefined();
    expect(caught!.diagnostic!.cli!.exitCode).toBe(1);
    expect(caught!.diagnostic!.cli!.innerErrorCode).toBe(401);
    expect(caught!.diagnostic!.cli!.command).toEqual([
      "claude",
      "-p",
      "x",
      "--model",
      "sonnet",
    ]);
    expect(caught!.diagnostic!.limitsAtFailure.maxRounds).toBe(4);
    expect(caught!.diagnostic!.toolRoundsUsed).toBe(0);
  });

  it("runs tool round then final via Claude JSON protocol", async () => {
    mockClaudeStep
      .mockResolvedValueOnce({
        kind: "tools",
        calls: [{ name: "list_ps_tables", arguments: "{}" }],
      })
      .mockResolvedValueOnce({ kind: "final", content: '{"ok":true}' });

    const adapter = createClaudeCodeAgenticAdapter(cfg);
    const out = await runAgenticChat({
      adapter,
      model: cfg.cliModel,
      systemPrompt: "sys with tools",
      userContent: "go",
      ctx,
      temperature: 0.2,
      maxTokens: 1000,
    });

    expect(out.content).toBe('{"ok":true}');
    expect(mockClaudeStep).toHaveBeenCalledTimes(2);
  });
});
