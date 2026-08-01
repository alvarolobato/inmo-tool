/**
 * Mock agentic adapter (DASHBOARD_LLM_PROVIDER=mock).
 *
 * Implements the same AgenticModelAdapter contract as the OpenRouter and CLI
 * adapters, but returns deterministic scripted steps instead of calling a real
 * model. The runner, tool dispatch, and persistence are all exercised for real
 * — see mock/script.ts.
 */

import type { AgenticModelAdapter, AgenticRunStepInput, AgenticStepResult } from "@/lib/llm-tools/runner-types";
import { mockRunStep } from "./script";

export function createMockAgenticAdapter(): AgenticModelAdapter {
  return {
    async runStep(input: AgenticRunStepInput): Promise<AgenticStepResult> {
      return mockRunStep(input.messages);
    },
  };
}
