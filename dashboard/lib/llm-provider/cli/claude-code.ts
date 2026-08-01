/**
 * Claude Code CLI driver: non-interactive `claude -p` with `--model` and JSON protocol rounds.
 * Large prompts are passed on stdin to avoid OS argv limits (E2BIG).
 */

import type { DashboardLlmConfig } from "../types";
import { runCliProcess, runCliProcessStreaming, assertCliSuccess } from "./process";
import { CliRunnerError } from "./errors";
import { serializeChatMessagesForCli } from "./transcript";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DASHBOARD_AGENTIC_TOOLS } from "@/lib/llm-tools/catalog";
import { sanitize, sanitizeArgv, sanitizeTail } from "../sanitize";
import { triggerHostTokenSync } from "./host-token-sync";

/**
 * Run a CLI operation and, on `LLM_CLI_AUTH` failure (typically caused by an
 * out-of-band rotation of the Keychain refresh_token while the container was
 * holding the previous access_token), trigger an on-demand sync of the host
 * Keychain into the credentials file via launchd's WatchPaths and retry once.
 *
 * Strict scope: this NEVER refreshes the token itself — the kick fires the
 * existing host-side sync-only script. Single-refresher rule (D-025) stands.
 */
async function withAuthAutoRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!(err instanceof CliRunnerError) || err.code !== "LLM_CLI_AUTH") {
      throw err;
    }
    const sync = await triggerHostTokenSync();
    if (!sync.ok) {
      // Plumbing missing on the host — the retry would fail the same way.
      // Surface the original auth error verbatim.
      console.warn(
        `[claude-cli] auth-recovery skipped: ${sync.reason}`,
      );
      throw err;
    }
    const note = "timeout" in sync && sync.timeout
      ? `mtime didn't advance within ${sync.waitedMs}ms — retrying anyway`
      : `creds refreshed in ${sync.waitedMs}ms`;
    console.warn(`[claude-cli] LLM_CLI_AUTH → kicked host launchd, ${note}; retrying once`);
    return await operation();
  }
}

/** Tail size to retain on CliRunnerError details (matches process.ts). */
const TAIL_MAX_BYTES = 4096;

const SINGLE_SHOT_PRINT_ARG = `You are the dashboard assistant.
The UTF-8 stdin contains the full multi-section prompt (## system, ## user, etc.).
Execute the task and write the answer to stdout only.`;

const AGENTIC_PROTOCOL_INSTRUCTION = `You are the dashboard agentic planner. Reply with ONE JSON object only, no markdown fences, no prose.

Schema:
1) Final assistant text to show the user:
{"kind":"final","content":"<string>"}

2) Request tool calls (server will execute them and send you tool results):
{"kind":"tools","calls":[{"name":"<tool_name>","arguments":"<JSON string of args>"}]}

UTF-8 stdin format:
- After the line TOOL_CATALOG_JSON comes one line of minified JSON (OpenAI tools array).
- After the line TRANSCRIPT comes the conversation text (markdown sections).

Use exact tool names from the tool catalog JSON. Arguments must be a JSON string (escaped JSON inside JSON), matching OpenAI function-calling style.`;

function buildCompactToolCatalogJson(): string {
  const tools = DASHBOARD_AGENTIC_TOOLS.filter((t) => t.type === "function").map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
  return JSON.stringify(tools);
}

function buildAgenticStdin(transcript: string): string {
  return `TOOL_CATALOG_JSON\n${buildCompactToolCatalogJson()}\nTRANSCRIPT\n${transcript}\n`;
}

export interface ClaudeCliSingleShotInput {
  cfg: DashboardLlmConfig;
  /** Full user-facing prompt (system + task combined when only one block is needed). */
  prompt: string;
}

export function claudeCliSingleShot(input: ClaudeCliSingleShotInput): Promise<string> {
  return withAuthAutoRecovery(() => claudeCliSingleShotOnce(input));
}

async function claudeCliSingleShotOnce(input: ClaudeCliSingleShotInput): Promise<string> {
  const { cfg, prompt } = input;
  const args = [
    ...cfg.cliExtraArgs,
    "-p",
    SINGLE_SHOT_PRINT_ARG,
    "--model",
    cfg.cliModel,
    "--output-format",
    "text",
  ];
  const fullArgv = [cfg.cliBin, ...args];
  const result = await runCliProcess({
    file: cfg.cliBin,
    args,
    stdin: prompt,
    timeoutMs: cfg.cliTimeoutMs,
    maxStdoutBytes: cfg.cliMaxCaptureBytes,
    maxStderrBytes: Math.min(cfg.cliMaxCaptureBytes, 512_000),
  });
  try {
    assertCliSuccess(result, "claude single-shot", fullArgv);
  } catch (e) {
    if (e instanceof CliRunnerError) throw e;
    throw e;
  }
  const text = result.stdout.trim();
  if (!text) {
    throw new CliRunnerError("LLM_CLI_EMPTY", "claude single-shot: empty stdout", {
      stderr: sanitizeTail(result.stderr, TAIL_MAX_BYTES),
      command: sanitizeArgv(fullArgv),
      phase: "empty",
      durationMs: result.durationMs,
    });
  }
  return text;
}

export interface ClaudeCliAgenticStepInput {
  cfg: DashboardLlmConfig;
  messages: ChatCompletionMessageParam[];
  /** Optional callback invoked as the model streams text. `chars` is the delta;
   *  `totalChars` is the running total since this step began. */
  onTextDelta?: (chars: number, totalChars: number, accumulatedText: string) => void;
  /** Optional callback invoked as the model streams extended-thinking content.
   *  Same contract as onTextDelta but for the chain-of-thought block (only
   *  emitted on Claude builds with thinking enabled). */
  onThinkingDelta?: (chars: number, totalChars: number, accumulatedThinking: string) => void;
}

export type ClaudeAgenticStepKind = "final" | "tools";

export interface ClaudeAgenticStepFinal {
  kind: "final";
  content: string;
}

export interface ClaudeAgenticStepTools {
  kind: "tools";
  calls: { name: string; arguments: string }[];
}

export type ClaudeAgenticStep = ClaudeAgenticStepFinal | ClaudeAgenticStepTools;

function extractJsonObject(text: string): string {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  if (start === -1) {
    throw new CliRunnerError(
      "LLM_CLI_PARSE",
      "claude agentic: no JSON object found in output",
      { stderr: sanitize(body.slice(0, 500)), phase: "parse" },
    );
  }
  // Walk forward counting balanced braces, respecting strings and escapes,
  // so trailing content (explanation prose, extra `}` chars) is ignored.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return body.slice(start, i + 1);
      }
    }
  }
  throw new CliRunnerError(
    "LLM_CLI_PARSE",
    "claude agentic: unterminated JSON object in output",
    { stderr: sanitize(body.slice(start, start + 500)) },
  );
}

export function parseClaudeAgenticStepJson(stdout: string): ClaudeAgenticStep {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(stdout));
  } catch (e) {
    throw new CliRunnerError(
      "LLM_CLI_PARSE",
      `claude agentic: invalid JSON (${e instanceof Error ? e.message : "parse error"})`,
      { stderr: sanitize(stdout.slice(0, 800)) },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliRunnerError("LLM_CLI_PARSE", "claude agentic: JSON root must be an object");
  }
  const o = parsed as Record<string, unknown>;
  const kind = o.kind;
  if (kind === "final") {
    const content = o.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new CliRunnerError("LLM_CLI_PARSE", "claude agentic: final.content must be a non-empty string");
    }
    return { kind: "final", content: content.trim() };
  }
  if (kind === "tools") {
    const callsRaw = o.calls;
    if (!Array.isArray(callsRaw) || callsRaw.length === 0) {
      throw new CliRunnerError("LLM_CLI_PARSE", "claude agentic: tools.calls must be a non-empty array");
    }
    const calls: { name: string; arguments: string }[] = [];
    for (const c of callsRaw) {
      if (!c || typeof c !== "object") continue;
      const cr = c as Record<string, unknown>;
      const name = cr.name;
      const args = cr.arguments;
      if (typeof name !== "string" || !name) {
        throw new CliRunnerError("LLM_CLI_PARSE", "claude agentic: each call needs a string name");
      }
      const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
      calls.push({ name, arguments: argStr });
    }
    if (!calls.length) {
      throw new CliRunnerError("LLM_CLI_PARSE", "claude agentic: no valid tool calls parsed");
    }
    return { kind: "tools", calls };
  }
  // Model skipped the wrapper and returned a bare dashboard spec or other JSON directly.
  // If it looks like a final answer (has title+widgets or is otherwise not a tool request),
  // treat the whole extracted JSON as the content string.
  if (kind === undefined || (typeof kind === "string" && kind !== "tools")) {
    const content = extractJsonObject(stdout);
    if (content) return { kind: "final", content };
  }
  throw new CliRunnerError(
    "LLM_CLI_PARSE",
    `claude agentic: unknown kind ${String(kind)}`,
  );
}

/**
 * Parse a single stream-json NDJSON line from `claude --output-format stream-json --verbose`.
 *
 * With `--include-partial-messages` the binary also emits incremental
 * `stream_event` lines with `content_block_delta` for each token chunk —
 * we surface those as `text_delta` so the UI can show Claude typing in
 * real time. The cumulative `assistant` envelope is emitted at the end
 * of each message and carries the same content; on newer builds (where
 * deltas are present) callers should treat it as a redundant duplicate.
 *
 * Supported event shapes (defensive — unknown shapes are silently ignored):
 *   { type: "system", subtype: "init", ... }
 *   { type: "stream_event", event: { type:"content_block_delta", delta:{ type:"text_delta", text:"..." } } }
 *   { type: "assistant", message: { content: [ {type:"text", text:"..."} | {type:"tool_use",...} ] } }
 *   { type: "result", is_error: bool, result: string, ... }
 *
 * Returns:
 *   { kind: "text_delta", text: string }    — incremental token chunk (partial-messages flag)
 *   { kind: "text_full",  text: string }    — cumulative assistant text (one per message)
 *   { kind: "result", text: string, isError: bool, status?: number }  — terminal result line
 *   { kind: "ignore" }                     — all other lines
 */
export type StreamJsonLineParse =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "text_full"; text: string }
  | { kind: "result"; text: string; isError: boolean; status?: number | null }
  | { kind: "ignore" };

export function parseStreamJsonLine(line: string): StreamJsonLineParse {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "ignore" };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }

  const type = obj.type;

  // Terminal result line — emitted at the end of a step.
  if (type === "result") {
    const isError = obj.is_error === true;
    const resultText = typeof obj.result === "string" ? obj.result : "";
    const status = typeof obj.api_error_status === "number" ? obj.api_error_status : null;
    return { kind: "result", text: resultText, isError, status };
  }

  // Incremental token chunks emitted with --include-partial-messages.
  if (type === "stream_event") {
    const ev = obj.event;
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return { kind: "ignore" };
    const e = ev as Record<string, unknown>;
    if (e.type === "content_block_delta") {
      const delta = e.delta;
      if (delta && typeof delta === "object" && !Array.isArray(delta)) {
        const d = delta as Record<string, unknown>;
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          return { kind: "text_delta", text: d.text };
        }
        // Extended thinking: visible chain-of-thought reasoning emitted before
        // the final answer. Surface it so the UI can show "Claude razonando".
        if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
          return { kind: "thinking_delta", text: d.thinking };
        }
      }
    }
    return { kind: "ignore" };
  }

  // Assistant message — can carry text content or tool_use blocks.
  if (type === "assistant") {
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return { kind: "ignore" };
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return { kind: "ignore" };
    // Extract text chunks; skip tool_use blocks (they appear in the result envelope).
    const textParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        textParts.push(b.text);
      }
    }
    const joined = textParts.join("");
    if (joined) return { kind: "text_full", text: joined };
    return { kind: "ignore" };
  }

  return { kind: "ignore" };
}

export function claudeCliAgenticStep(input: ClaudeCliAgenticStepInput): Promise<ClaudeAgenticStep> {
  return withAuthAutoRecovery(() => claudeCliAgenticStepOnce(input));
}

async function claudeCliAgenticStepOnce(input: ClaudeCliAgenticStepInput): Promise<ClaudeAgenticStep> {
  const { cfg, messages, onTextDelta, onThinkingDelta } = input;
  const transcript = serializeChatMessagesForCli(messages);
  const printArg = AGENTIC_PROTOCOL_INSTRUCTION;
  const stdinBody = buildAgenticStdin(transcript);

  // Use --output-format stream-json --verbose --include-partial-messages so we get
  // token-level NDJSON events while the model is generating. Each token chunk
  // arrives as { type:"stream_event", event:{ type:"content_block_delta", delta:
  // { type:"text_delta", text } } } and is forwarded via onTextDelta so the UI
  // can show Claude typing in real time. The cumulative `type:"assistant"`
  // envelope at the end of each message is treated as a duplicate and skipped
  // (sawAnyDelta below). On older binaries that ignore --include-partial-messages
  // no deltas arrive — we then fall back to the cumulative assistant message
  // and emit it as a single chunk.
  const args = [
    ...cfg.cliExtraArgs,
    "-p",
    printArg,
    "--model",
    cfg.cliModel,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  const fullArgv = [cfg.cliBin, ...args];

  // Accumulate assistant text across chunks so we can parse the full step JSON
  // once the result line arrives. Extended-thinking blocks accumulate in
  // parallel and are forwarded via onThinkingDelta.
  let accumulatedText = "";
  let totalCharsEmitted = 0;
  let accumulatedThinking = "";
  let totalThinkingCharsEmitted = 0;
  // Whether any incremental text_delta events arrived for this step. When true,
  // the cumulative `type:"assistant"` envelope (text_full) is a duplicate and
  // must be ignored to avoid double-counting.
  let sawAnyDelta = false;
  // Store the last result line so we can use its envelope for error detection.
  // Use a box object to avoid TypeScript control-flow narrowing issues with
  // variables mutated inside closures.
  const resultBox: { line: { text: string; isError: boolean; status?: number | null } | null } = { line: null };

  const emitDelta = (deltaText: string) => {
    accumulatedText += deltaText;
    totalCharsEmitted += deltaText.length;
    if (onTextDelta) {
      try {
        onTextDelta(deltaText.length, totalCharsEmitted, accumulatedText);
      } catch {
        /* ignore callback errors */
      }
    }
  };

  const emitThinkingDelta = (deltaText: string) => {
    accumulatedThinking += deltaText;
    totalThinkingCharsEmitted += deltaText.length;
    if (onThinkingDelta) {
      try {
        onThinkingDelta(deltaText.length, totalThinkingCharsEmitted, accumulatedThinking);
      } catch {
        /* ignore callback errors */
      }
    }
  };

  const result = await runCliProcessStreaming({
    file: cfg.cliBin,
    args,
    stdin: stdinBody,
    timeoutMs: cfg.cliTimeoutMs,
    maxStdoutBytes: cfg.cliMaxCaptureBytes,
    maxStderrBytes: Math.min(cfg.cliMaxCaptureBytes, 512_000),
    onStdoutLine: (line) => {
      const parsed = parseStreamJsonLine(line);
      if (parsed.kind === "text_delta") {
        sawAnyDelta = true;
        emitDelta(parsed.text);
      } else if (parsed.kind === "thinking_delta") {
        emitThinkingDelta(parsed.text);
      } else if (parsed.kind === "text_full") {
        // Older CLI builds (or partial-messages flag silently ignored) emit
        // only the cumulative assistant message — surface it as one chunk.
        // Newer builds emit deltas first and then this duplicate; skip it.
        if (!sawAnyDelta) {
          emitDelta(parsed.text);
        }
      } else if (parsed.kind === "result") {
        resultBox.line = parsed;
      }
    },
  });

  try {
    assertCliSuccess(result, "claude agentic step", fullArgv);
  } catch (e) {
    if (e instanceof CliRunnerError) throw e;
    throw e;
  }

  // Check for is_error on the result line — same D-024 handling as before.
  const resultLine = resultBox.line;
  if (resultLine?.isError) {
    const status = resultLine.status ?? null;
    const innerRaw = resultLine.text;
    const inner = sanitize(innerRaw);
    const isAuth = status === 401 || status === 403 || /authentication|invalid.*credentials|unauthorized/i.test(inner);
    throw new CliRunnerError(
      isAuth ? "LLM_CLI_AUTH" : "LLM_CLI_API_ERROR",
      `claude agentic step: ${inner.slice(0, 240) || `api_error_status=${status}`}`,
      {
        exitCode: result.exitCode,
        stderr: sanitizeTail(result.stderr, TAIL_MAX_BYTES),
        stdout: sanitizeTail(result.stdout, TAIL_MAX_BYTES),
        command: sanitizeArgv(fullArgv),
        phase: isAuth ? "auth" : "exit",
        durationMs: result.durationMs,
        innerErrorCode: status,
      },
    );
  }

  // Prefer the result line text over the accumulated text — the result line
  // contains the final model output and is more reliable than accumulation.
  // Fall back to accumulated text if no result line was seen (e.g. older CLI).
  const textOutput = resultLine?.text || accumulatedText;
  // (resultBox used above)

  // Final fallback: if stdout has a single-object JSON envelope (older --output-format json
  // compatible binary), try to parse it the old way.
  if (!textOutput.trim()) {
    const stdoutTrimmed = result.stdout.trim();
    if (stdoutTrimmed) {
      try {
        const envelope = JSON.parse(stdoutTrimmed) as Record<string, unknown>;
        if (envelope?.is_error === true) {
          const status = typeof envelope.api_error_status === "number" ? envelope.api_error_status : null;
          const innerRaw = typeof envelope.result === "string" ? envelope.result : "";
          const inner = sanitize(innerRaw);
          const isAuth = status === 401 || status === 403 || /authentication|invalid.*credentials|unauthorized/i.test(inner);
          throw new CliRunnerError(
            isAuth ? "LLM_CLI_AUTH" : "LLM_CLI_API_ERROR",
            `claude agentic step: ${inner.slice(0, 240) || `api_error_status=${status}`}`,
            {
              exitCode: result.exitCode,
              stderr: sanitizeTail(result.stderr, TAIL_MAX_BYTES),
              stdout: sanitizeTail(result.stdout, TAIL_MAX_BYTES),
              command: sanitizeArgv(fullArgv),
              phase: isAuth ? "auth" : "exit",
              durationMs: result.durationMs,
              innerErrorCode: status,
            },
          );
        }
        if (typeof envelope.result === "string") {
          return parseClaudeAgenticStepJson(envelope.result);
        }
      } catch (e) {
        if (e instanceof CliRunnerError) throw e;
        // JSON parse failed — fall through to raw stdout
      }
      return parseClaudeAgenticStepJson(stdoutTrimmed);
    }
    throw new CliRunnerError("LLM_CLI_EMPTY", "claude agentic step: empty output", {
      stderr: sanitizeTail(result.stderr, TAIL_MAX_BYTES),
      command: sanitizeArgv(fullArgv),
      phase: "empty",
      durationMs: result.durationMs,
    });
  }

  return parseClaudeAgenticStepJson(textOutput);
}
