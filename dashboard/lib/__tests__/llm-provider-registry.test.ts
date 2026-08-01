import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLoadCfg, mockGetClient, mockOrAdapter, mockClaudeAdapter } = vi.hoisted(
  () => ({
    mockLoadCfg: vi.fn(),
    mockGetClient: vi.fn(),
    mockOrAdapter: vi.fn(),
    mockClaudeAdapter: vi.fn(),
  }),
);

vi.mock("@/lib/llm-provider/config", () => ({
  loadDashboardLlmConfig: mockLoadCfg,
}));

vi.mock("@/lib/llm-provider/openrouter", () => ({
  getOpenRouterClient: mockGetClient,
  createOpenRouterAgenticAdapter: mockOrAdapter,
}));

vi.mock("@/lib/llm-provider/cli/agent-adapter", () => ({
  createClaudeCodeAgenticAdapter: mockClaudeAdapter,
}));

import { createDashboardAgenticAdapter } from "@/lib/llm-provider/registry";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";

const baseCfg: DashboardLlmConfig = {
  provider: "openrouter",
  openrouterModel: "anthropic/claude-sonnet-4",
  cliModel: "sonnet",
  cliDriver: "claude_code",
  cliBin: "claude",
  cliExtraArgs: [],
  cliTimeoutMs: 5000,
  cliMaxCaptureBytes: 1_000_000,
};

describe("createDashboardAgenticAdapter", () => {
  beforeEach(() => {
    mockLoadCfg.mockReset();
    mockGetClient.mockReset();
    mockOrAdapter.mockReset();
    mockClaudeAdapter.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an OpenRouter adapter when provider is 'openrouter'", () => {
    const fakeClient = { __id: "openrouter-client" };
    const fakeAdapter = { runStep: vi.fn() };
    mockLoadCfg.mockReturnValue({ ...baseCfg, provider: "openrouter" });
    mockGetClient.mockReturnValue(fakeClient);
    mockOrAdapter.mockReturnValue(fakeAdapter);

    const adapter = createDashboardAgenticAdapter();

    expect(mockGetClient).toHaveBeenCalledOnce();
    expect(mockOrAdapter).toHaveBeenCalledWith(fakeClient);
    expect(mockClaudeAdapter).not.toHaveBeenCalled();
    expect(adapter).toBe(fakeAdapter);
  });

  it("returns a Claude Code adapter when provider is 'cli' and driver is 'claude_code'", () => {
    const fakeAdapter = { runStep: vi.fn() };
    const cfg: DashboardLlmConfig = { ...baseCfg, provider: "cli", cliDriver: "claude_code" };
    mockLoadCfg.mockReturnValue(cfg);
    mockClaudeAdapter.mockReturnValue(fakeAdapter);

    const adapter = createDashboardAgenticAdapter();

    expect(mockClaudeAdapter).toHaveBeenCalledWith(cfg);
    expect(mockOrAdapter).not.toHaveBeenCalled();
    expect(adapter).toBe(fakeAdapter);
  });

  it("returns the scripted mock adapter when provider is 'mock'", () => {
    mockLoadCfg.mockReturnValue({ ...baseCfg, provider: "mock" });

    const adapter = createDashboardAgenticAdapter();

    // No real client/CLI adapter is constructed for the mock path.
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(mockOrAdapter).not.toHaveBeenCalled();
    expect(mockClaudeAdapter).not.toHaveBeenCalled();
    expect(typeof adapter.runStep).toBe("function");
  });

  it("throws when provider is 'cli' but driver is unknown", () => {
    mockLoadCfg.mockReturnValue({
      ...baseCfg,
      provider: "cli",
      // Force an unsupported driver to exercise the fall-through error.
      cliDriver: "unknown_driver" as unknown as DashboardLlmConfig["cliDriver"],
    });

    expect(() => createDashboardAgenticAdapter()).toThrow(/Unsupported DASHBOARD_LLM_CLI_DRIVER/);
    expect(mockClaudeAdapter).not.toHaveBeenCalled();
    expect(mockOrAdapter).not.toHaveBeenCalled();
  });
});
