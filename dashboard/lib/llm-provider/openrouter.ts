/**
 * OpenRouter via OpenAI SDK (chat completions + agentic steps).
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgenticModelAdapter, AgenticStepResult } from "@/lib/llm-tools/runner-types";
import { getSystemConfig } from "@/lib/system-config/loader";

/**
 * OpenRouter/Anthropic cache token fields that appear in the usage object
 * alongside the standard OpenAI-compat fields.
 */
export interface OpenRouterCacheUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Tokens written to the Anthropic prompt cache (charged at 25% premium). */
  cache_creation_input_tokens?: number;
  /** Tokens read from the Anthropic prompt cache (90% discount). */
  cache_read_input_tokens?: number;
}

/**
 * Content block type that includes Anthropic's cache_control extension.
 * Used for building cached system prompt arrays passed to OpenRouter.
 *
 * OpenRouter forwards these fields to Anthropic verbatim when using
 * anthropic/* models, enabling server-side prompt caching.
 */
type CachedContentBlock =
  | { type: "text"; text: string; cache_control: { type: "ephemeral" } }
  | { type: "text"; text: string };

/**
 * Build a system message that places `stable` under Anthropic's
 * `cache_control: { type: "ephemeral" }` marker.  OpenRouter forwards the
 * marker to Anthropic when the model supports caching (e.g. claude-sonnet-4).
 *
 * The `volatile` block (e.g. the current dashboard spec) is appended as a
 * second un-cached text block so it does not bust the cached prefix.
 *
 * When `volatile` is omitted the message has a single cached block.
 */
export function buildCachedSystemMessage(
  stable: string,
  volatile?: string,
): ChatCompletionMessageParam {
  const blocks: CachedContentBlock[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    ...(volatile ? [{ type: "text" as const, text: volatile }] : []),
  ];
  // The OpenAI SDK types don't include cache_control — cast to pass the
  // extra field through to OpenRouter's JSON body verbatim.
  return { role: "system", content: blocks as any };
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

function getStatus(err: unknown): number | undefined {
  if (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

function getHeaderValue(headers: unknown, name: string): string | null | undefined {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    const targetName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === targetName && typeof value === "string") {
        return value;
      }
    }
  }
  return undefined;
}

function getRetryAfterMs(err: unknown): number | undefined {
  if (err === null || typeof err !== "object" || !("headers" in err)) return undefined;
  const headers = (err as { headers: unknown }).headers;
  const value = getHeaderValue(headers, "retry-after");
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 0 ? undefined : Math.min(parsed * 1000, MAX_RETRY_DELAY_MS);
}

export async function withOpenRouterRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = getStatus(err);

      if (status === 400) throw err;
      if (attempt === MAX_ATTEMPTS - 1) break;

      const shouldRetry = status === undefined || status === 429 || status >= 500;
      if (!shouldRetry) throw err;

      let delay = BASE_DELAY_MS * Math.pow(2, attempt);
      if (status === 429) {
        const retryAfterMs = getRetryAfterMs(err);
        if (retryAfterMs !== undefined) delay = retryAfterMs;
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

let _client: OpenAI | null = null;

export function getOpenRouterApiKey(): string {
  // Prefer the value from the central config loader (env > config.yaml > default).
  // Fall back to process.env directly when the loader throws (e.g. schema.yaml is
  // missing or tests that stub env but don't set up the full config loader).
  let cfgKey: string | null | undefined;
  try {
    const cfg = getSystemConfig();
    cfgKey = cfg["openrouter.api_key"]?.value as string | null | undefined;
  } catch {
    cfgKey = undefined;
  }
  const key =
    (cfgKey !== null && cfgKey !== undefined ? String(cfgKey).trim() : "") ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    "";
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Set it in your environment, config.yaml, or .env file.",
    );
  }
  return key;
}

export function getOpenRouterClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: getOpenRouterApiKey(),
    });
  }
  return _client;
}

export function resetOpenRouterClient(): void {
  _client = null;
}

export function openRouterExtras(provider?: Record<string, unknown>): { provider?: Record<string, unknown> } {
  if (!provider || Object.keys(provider).length === 0) return {};
  return { provider };
}

export function createOpenRouterAgenticAdapter(client: OpenAI): AgenticModelAdapter {
  return {
    async runStep(input): Promise<AgenticStepResult> {
      // Use streaming so we can emit model_text_delta and model_thinking_delta
      // events while tokens arrive.
      //
      // Merge `reasoning: { effort: "medium" }` only when the caller opts in
      // via input.enableReasoning. This activates extended thinking for capable
      // models (Claude 3.7+, o3, DeepSeek R1, Gemini 3, etc.) but causes extra
      // token spend and latency, so it should not be forced on every request.
      // Build streaming params. `tool_choice` needs "auto" as const to match
      // the OpenAI union type. Object.assign merges the optional reasoning param
      // without TypeScript type assertions that OXC parsers reject in .ts files.
      const toolChoice = "auto" as const;
      const baseParams = {
        model: input.model,
        messages: input.messages,
        tools: input.tools,
        tool_choice: toolChoice,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        stream: true as const,
        ...openRouterExtras(input.openRouterProvider),
      };
      const finalParams = input.enableReasoning
        ? Object.assign({}, baseParams, { reasoning: { effort: "medium" } })
        : baseParams;
      const stream = await withOpenRouterRetry(() =>
        client.chat.completions.create(finalParams),
      ) as import("openai/streaming").Stream<import("openai/resources/chat/completions").ChatCompletionChunk>;

      // Accumulate content, tool_call, and reasoning/thinking deltas.
      let textContent = "";
      let totalCharsEmitted = 0;
      let thinkingContent = "";
      let totalThinkingChars = 0;
      const toolCallAccum: Record<
        number,
        { id: string; type: "function"; function: { name: string; arguments: string } }
      > = {};
      let usage: OpenRouterCacheUsage | null = null;

      for await (const chunk of stream) {
        // Cast delta to a plain object so we can read non-standard fields
        // (reasoning, reasoning_details) without TypeScript errors.
        const delta = (chunk.choices[0]?.delta ?? {}) as Record<string, unknown>;

        // ── Reasoning / thinking tokens ─────────────────────────────────────
        // OpenRouter surfaces reasoning in two formats. IMPORTANT: some models
        // (e.g. claude-3-7-sonnet via OpenRouter) include BOTH fields on the
        // same chunk, which would double the text. Always prefer one source:
        //   • reasoning_details (structured array) when present — use it exclusively
        //   • reasoning (legacy string) only as fallback when reasoning_details absent
        const reasoningDetails = Array.isArray(delta.reasoning_details)
          ? (delta.reasoning_details as Array<{ type?: string; text?: string; summary?: string }>)
          : [];

        let thinkingChunk = "";
        if (reasoningDetails.length > 0) {
          // Structured form — extract text from each detail object
          for (const detail of reasoningDetails) {
            if (detail.type === "reasoning.text" && typeof detail.text === "string") {
              thinkingChunk += detail.text;
            } else if (detail.type === "reasoning.summary" && typeof detail.summary === "string") {
              thinkingChunk += detail.summary;
            }
            // reasoning.encrypted: skip — opaque bytes / [REDACTED]
          }
        } else if (typeof delta.reasoning === "string" && delta.reasoning) {
          // Legacy string field — only used when reasoning_details is absent
          thinkingChunk = delta.reasoning;
        }

        if (thinkingChunk) {
          thinkingContent += thinkingChunk;
          totalThinkingChars += thinkingChunk.length;
          if (input.onThinkingDelta) {
            try {
              input.onThinkingDelta(thinkingChunk.length, totalThinkingChars, thinkingContent);
            } catch {
              /* ignore callback errors */
            }
          }
        }

        // ── Text content ─────────────────────────────────────────────────────
        const contentStr = typeof delta.content === "string" ? delta.content : null;
        if (contentStr) {
          textContent += contentStr;
          const deltaChars = contentStr.length;
          totalCharsEmitted += deltaChars;
          if (input.onTextDelta) {
            try {
              input.onTextDelta(deltaChars, totalCharsEmitted, textContent);
            } catch {
              /* ignore callback errors */
            }
          }
        }

        // ── Tool call deltas ──────────────────────────────────────────────────
        const toolCallsArr = Array.isArray(delta.tool_calls)
          ? (delta.tool_calls as Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>)
          : [];
        for (const tc of toolCallsArr) {
          const idx = tc.index ?? 0;
          if (!toolCallAccum[idx]) {
            toolCallAccum[idx] = {
              id: tc.id ?? "",
              type: "function",
              function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
            };
          } else {
            const acc = toolCallAccum[idx];
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.function.name += tc.function.name;
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
          }
        }

        // ── Usage (last chunk) ────────────────────────────────────────────────
        if (chunk.usage) {
          const u = chunk.usage as OpenRouterCacheUsage;
          usage = {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
            cache_read_input_tokens: u.cache_read_input_tokens,
          };
        }
      }

      const toolCalls = Object.values(toolCallAccum);
      if (toolCalls.length > 0) {
        return {
          kind: "tools",
          tool_calls: toolCalls
            .filter((tc) => tc.type === "function" && tc.function.name)
            .map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments || "{}",
              },
            })),
          usage,
        };
      }

      const text = textContent.trim();
      if (!text) {
        return {
          kind: "error",
          code: "LLM_EMPTY",
          message: "The model returned empty content.",
          usage,
        };
      }

      return { kind: "final", content: text, usage };
    },
  };
}

export async function openRouterChatCompletion(params: {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
  /** Optional OpenRouter `provider` routing object. */
  provider?: Record<string, unknown>;
}): Promise<{
  content: string;
  usage: OpenRouterCacheUsage | null;
}> {
  const response = await withOpenRouterRetry(() =>
    params.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: false as const,
      ...openRouterExtras(params.provider),
    }),
  ) as import("openai/resources/chat/completions").ChatCompletion;
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned an empty response");
  }
  // Cast usage to our extended type so cache fields are accessible without
  // the SDK's strict type complaining about unknown properties.
  const u = response.usage as OpenRouterCacheUsage | undefined;
  return {
    content,
    usage:
      u === undefined
        ? null
        : {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
            cache_read_input_tokens: u.cache_read_input_tokens,
          },
  };
}
