/**
 * Resolve dashboard LLM adapters from configuration (extensible per CLI driver).
 */

import { loadDashboardLlmConfig } from "./config";
import { getOpenRouterClient, createOpenRouterAgenticAdapter } from "./openrouter";
import { createClaudeCodeAgenticAdapter } from "./cli/agent-adapter";
import { createMockAgenticAdapter } from "./mock/agent-adapter";
import type { AgenticModelAdapter } from "@/lib/llm-tools/runner-types";

export function createDashboardAgenticAdapter(): AgenticModelAdapter {
  const cfg = loadDashboardLlmConfig();
  if (cfg.provider === "mock") {
    return createMockAgenticAdapter();
  }
  if (cfg.provider === "openrouter") {
    return createOpenRouterAgenticAdapter(getOpenRouterClient());
  }
  if (cfg.cliDriver === "claude_code") {
    return createClaudeCodeAgenticAdapter(cfg);
  }
  throw new Error(`Unsupported DASHBOARD_LLM_CLI_DRIVER: ${cfg.cliDriver}`);
}
