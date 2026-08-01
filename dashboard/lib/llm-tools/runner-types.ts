/**
 * Provider-agnostic agentic step contract (OpenRouter native tools vs CLI JSON protocol).
 */

import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export interface AgenticStepToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Shared usage shape for all AgenticStepResult variants. */
type AgenticStepUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Tokens written to the Anthropic prompt cache (charged at 25% premium). */
  cache_creation_input_tokens?: number | null;
  /** Tokens read from the Anthropic prompt cache (90% discount). */
  cache_read_input_tokens?: number | null;
} | null;

export type AgenticStepResult =
  | {
      kind: "final";
      content: string;
      usage: AgenticStepUsage;
    }
  | {
      kind: "tools";
      tool_calls: AgenticStepToolCall[];
      usage: AgenticStepUsage;
    }
  | {
      kind: "error";
      code: string;
      message: string;
      usage: AgenticStepUsage;
    };

export interface AgenticRunStepInput {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  model: string;
  /** OpenRouter-only: forwarded as the `provider` object on chat completions. */
  openRouterProvider?: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  /** Optional callback invoked as the model streams text chunks. `chars` is the
   *  incremental count for this chunk; `totalChars` is the running total.
   *  `accumulatedText` is the full assistant text emitted so far this step,
   *  so the UI can render Claude's response in real time. */
  onTextDelta?: (chars: number, totalChars: number, accumulatedText: string) => void;
  /** Optional callback invoked while the model is in extended-thinking mode.
   *  Same contract as `onTextDelta` but for the chain-of-thought block. Fires
   *  *before* the final answer text starts streaming.
   *
   *  For the CLI (claude_code) adapter: fires when the Claude CLI emits
   *  `thinking_delta` events in its native NDJSON stream.
   *
   *  For the OpenRouter adapter: fires when `enableReasoning=true` and the
   *  model returns reasoning tokens (via `delta.reasoning_details` or
   *  `delta.reasoning`). Supported by claude-3-7-sonnet, o3, deepseek-r1, etc. */
  onThinkingDelta?: (chars: number, totalChars: number, accumulatedThinking: string) => void;
  /**
   * OpenRouter adapter only: when true, adds `reasoning: { effort: "medium" }`
   * to the API request, activating extended thinking for capable models
   * (Claude 3.7+, o3, DeepSeek R1, Gemini 3, etc.).
   *
   * Defaults to false. Enable explicitly when using a known thinking-capable
   * model to avoid unexpected cost/latency increases on standard models.
   */
  enableReasoning?: boolean;
}

export interface AgenticModelAdapter {
  runStep(input: AgenticRunStepInput): Promise<AgenticStepResult>;
}
