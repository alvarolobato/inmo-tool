/**
 * CLI-backed AgenticModelAdapter (Claude Code JSON tool protocol).
 */

import type { DashboardLlmConfig } from "../types";
import type { AgenticModelAdapter } from "@/lib/llm-tools/runner-types";
import { claudeCliAgenticStep } from "./claude-code";

function makeToolCallId(round: number, index: number): string {
  return `cli_r${round}_i${index}`;
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
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      return {
        kind: "tools",
        tool_calls: step.calls.map((c, i) => ({
          id: makeToolCallId(r, i),
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        })),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}
