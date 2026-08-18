/**
 * CLI-backed AgenticModelAdapter (Claude Code JSON tool protocol).
 */

import type { DashboardLlmConfig } from "../types";
import type { AgenticModelAdapter } from "@/lib/llm-tools/runner-types";
import { claudeCliAgenticStep } from "./claude-code";
import type { CliReportedUsage } from "./usage";

function makeToolCallId(round: number, index: number): string {
  return `cli_r${round}_i${index}`;
}

/**
 * Map the CLI's per-round accounting onto the runner's usage shape.
 *
 * This used to return a hard-coded `{0, 0, 0}`, so every agentic chat round on
 * the CLI provider contributed nothing to `AgenticUsageTotals` — the usage
 * panel showed a free conversation no matter how long it ran. `null` (nothing
 * reported by the binary) stays `null` rather than becoming zero, so
 * "unreported" and "genuinely free" remain distinguishable downstream.
 */
function toStepUsage(u: CliReportedUsage | null | undefined) {
  if (!u) return null;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cost_usd: u.cost_usd,
  };
}

export function createClaudeCodeAgenticAdapter(cfg: DashboardLlmConfig): AgenticModelAdapter {
  let roundCounter = 0;
  return {
    async runStep({ messages, onTextDelta, onThinkingDelta }) {
      roundCounter += 1;
      const r = roundCounter;
      const step = await claudeCliAgenticStep({ cfg, messages, onTextDelta, onThinkingDelta });
      if (step.kind === "final") {
        return {
          kind: "final",
          content: step.content,
          usage: toStepUsage(step.usage),
        };
      }
      return {
        kind: "tools",
        tool_calls: step.calls.map((c, i) => ({
          id: makeToolCallId(r, i),
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        })),
        usage: toStepUsage(step.usage),
      };
    },
  };
}
