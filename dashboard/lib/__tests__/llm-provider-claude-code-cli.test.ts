import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunCliProcess, mockRunCliProcessStreaming } = vi.hoisted(() => ({
  mockRunCliProcess: vi.fn(),
  mockRunCliProcessStreaming: vi.fn(),
}));

vi.mock("@/lib/llm-provider/cli/process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runCliProcess: mockRunCliProcess,
    runCliProcessStreaming: mockRunCliProcessStreaming,
  };
});

import {
  claudeCliSingleShot,
  claudeCliAgenticStep,
  parseStreamJsonLine,
} from "@/lib/llm-provider/cli/claude-code";
import { CliRunnerError } from "@/lib/llm-client";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";

const cfg: DashboardLlmConfig = {
  provider: "cli",
  openrouterModel: "anthropic/claude-sonnet-4",
  cliModel: "sonnet",
  cliDriver: "claude_code",
  cliBin: "claude",
  cliExtraArgs: ["--quiet"],
  cliTimeoutMs: 5000,
  cliMaxCaptureBytes: 1_000_000,
};

function okResult(stdout: string) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 50,
  };
}

/**
 * Build a mock for runCliProcessStreaming that feeds NDJSON lines via onStdoutLine,
 * then resolves with `result`. This simulates what the streaming CLI produces.
 */
function makeStreamingMock(
  ndjsonLines: string[],
  result?: Partial<ReturnType<typeof okResult>>,
) {
  return vi.fn().mockImplementation(
    async ({ onStdoutLine }: { onStdoutLine: (line: string) => void }) => {
      for (const line of ndjsonLines) {
        onStdoutLine(line);
      }
      return { ...okResult(""), ...result };
    },
  );
}

/**
 * Build stream-json NDJSON lines that represent the final model output.
 * The result line contains the final text in the `result` field.
 */
function makeStreamJsonResult(finalText: string): string[] {
  return [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalText }] } }),
    JSON.stringify({ type: "result", is_error: false, result: finalText }),
  ];
}

describe("parseStreamJsonLine", () => {
  it("parses cumulative assistant text content as text_full", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const r = parseStreamJsonLine(line);
    expect(r.kind).toBe("text_full");
    if (r.kind === "text_full") expect(r.text).toBe("hello");
  });

  it("parses incremental content_block_delta text_delta as text_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "1, 2, 3" },
      },
    });
    const r = parseStreamJsonLine(line);
    expect(r.kind).toBe("text_delta");
    if (r.kind === "text_delta") expect(r.text).toBe("1, 2, 3");
  });

  it("parses extended-thinking content_block_delta thinking_delta as thinking_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me check the data..." },
      },
    });
    const r = parseStreamJsonLine(line);
    expect(r.kind).toBe("thinking_delta");
    if (r.kind === "thinking_delta") expect(r.text).toBe("Let me check the data...");
  });

  it("ignores signature_delta (extended-thinking signature, not visible)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc123" },
      },
    });
    expect(parseStreamJsonLine(line).kind).toBe("ignore");
  });

  it("ignores non-text content_block_delta variants (e.g. input_json_delta)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"a\":" },
      },
    });
    expect(parseStreamJsonLine(line).kind).toBe("ignore");
  });

  it("ignores tool_use content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "validate_query", id: "x" }] },
    });
    expect(parseStreamJsonLine(line).kind).toBe("ignore");
  });

  it("parses result line", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "final output" });
    const r = parseStreamJsonLine(line);
    expect(r.kind).toBe("result");
    if (r.kind === "result") {
      expect(r.isError).toBe(false);
      expect(r.text).toBe("final output");
    }
  });

  it("parses error result line", () => {
    const line = JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "auth fail" });
    const r = parseStreamJsonLine(line);
    expect(r.kind).toBe("result");
    if (r.kind === "result") {
      expect(r.isError).toBe(true);
      expect(r.status).toBe(401);
    }
  });

  it("ignores system init lines", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseStreamJsonLine(line).kind).toBe("ignore");
  });

  it("ignores malformed JSON", () => {
    expect(parseStreamJsonLine("not json").kind).toBe("ignore");
  });

  it("ignores empty string", () => {
    expect(parseStreamJsonLine("").kind).toBe("ignore");
  });

  it("ignores incomplete lines (partial JSON)", () => {
    expect(parseStreamJsonLine('{"type":"assistant"').kind).toBe("ignore");
  });
});

describe("claudeCliSingleShot", () => {
  beforeEach(() => {
    mockRunCliProcess.mockReset();
  });

  it("invokes the CLI with the configured args and returns trimmed stdout", async () => {
    mockRunCliProcess.mockResolvedValueOnce(okResult("  hello world  "));

    const out = await claudeCliSingleShot({ cfg, prompt: "do the thing" });
    expect(out).toBe("hello world");

    const callArgs = mockRunCliProcess.mock.calls[0][0];
    expect(callArgs.file).toBe("claude");
    expect(callArgs.args).toContain("-p");
    expect(callArgs.args).toContain("--model");
    expect(callArgs.args).toContain("sonnet");
    expect(callArgs.args[0]).toBe("--quiet"); // cliExtraArgs prepended
    expect(callArgs.stdin).toBe("do the thing");
    expect(callArgs.timeoutMs).toBe(5000);
  });

  it("throws LLM_CLI_EMPTY when the CLI returns empty stdout on success", async () => {
    mockRunCliProcess.mockResolvedValueOnce(okResult("   \n  "));

    const promise = claudeCliSingleShot({ cfg, prompt: "x" });
    await expect(promise).rejects.toBeInstanceOf(CliRunnerError);
    await expect(promise).rejects.toMatchObject({ code: "LLM_CLI_EMPTY" });
  });

  it("propagates CliRunnerError from non-zero exit", async () => {
    mockRunCliProcess.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 50,
    });

    await expect(
      claudeCliSingleShot({ cfg, prompt: "x" }),
    ).rejects.toBeInstanceOf(CliRunnerError);
  });
});

describe("claudeCliAgenticStep", () => {
  beforeEach(() => {
    mockRunCliProcessStreaming.mockReset();
  });

  it("parses a 'final' step from stream-json result line", async () => {
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock(makeStreamJsonResult('{"kind":"final","content":"answer"}')),
    );

    const step = await claudeCliAgenticStep({
      cfg,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      expect(step.content).toBe("answer");
    }
  });

  it("parses a 'tools' step from stream-json result line", async () => {
    const toolsJson = '{"kind":"tools","calls":[{"name":"list_ps_tables","arguments":"{}"}]}';
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock(makeStreamJsonResult(toolsJson)),
    );

    const step = await claudeCliAgenticStep({
      cfg,
      messages: [{ role: "user", content: "list tables" }],
    });
    expect(step.kind).toBe("tools");
    if (step.kind === "tools") {
      expect(step.calls[0].name).toBe("list_ps_tables");
    }
  });

  it("falls back to accumulated text when no result line is seen (older CLI)", async () => {
    // Simulate a CLI that emits assistant text chunks but no result line.
    const bareJson = '{"kind":"final","content":"raw"}';
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock([
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: bareJson }] } }),
        // No result line — older binary
      ]),
    );

    const step = await claudeCliAgenticStep({
      cfg,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(step.kind).toBe("final");
    if (step.kind === "final") {
      expect(step.content).toBe("raw");
    }
  });

  it("throws LLM_CLI_AUTH when result line is_error=true with 401", async () => {
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock([
        JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "invalid credentials" }),
      ]),
    );

    await expect(
      claudeCliAgenticStep({ cfg, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "LLM_CLI_AUTH" });
  });

  it("throws LLM_CLI_API_ERROR when result line is_error=true with non-auth status", async () => {
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock([
        JSON.stringify({ type: "result", is_error: true, api_error_status: 503, result: "upstream timeout" }),
      ]),
    );

    await expect(
      claudeCliAgenticStep({ cfg, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "LLM_CLI_API_ERROR" });
  });

  it("invokes onTextDelta for each token-level text_delta and forwards accumulated text", async () => {
    const finalText = '{"kind":"final","content":"answer"}';
    // Newer claude builds emit incremental stream_event content_block_delta
    // events with --include-partial-messages; we forward each one through
    // onTextDelta and also pass the running cumulative text.
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock([
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"kind":"fina' } },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'l","content":"answer"}' } },
        }),
        // The cumulative assistant envelope follows; runner skips it because
        // text_delta events were already seen for this message.
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalText }] } }),
        JSON.stringify({ type: "result", is_error: false, result: finalText }),
      ]),
    );

    const deltas: { chars: number; totalChars: number; accumulated: string }[] = [];
    await claudeCliAgenticStep({
      cfg,
      messages: [{ role: "user", content: "hi" }],
      onTextDelta: (chars, totalChars, accumulated) => deltas.push({ chars, totalChars, accumulated }),
    });

    expect(deltas.length).toBe(2);
    expect(deltas[0].accumulated).toBe('{"kind":"fina');
    expect(deltas[1].accumulated).toBe(finalText);
    expect(deltas[1].totalChars).toBe(finalText.length);
  });

  it("falls back to text_full when no deltas arrive (older binary or flag ignored)", async () => {
    const finalText = '{"kind":"final","content":"ok"}';
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock([
        // No stream_event deltas — only the cumulative assistant envelope.
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalText }] } }),
        JSON.stringify({ type: "result", is_error: false, result: finalText }),
      ]),
    );

    const deltas: { chars: number; totalChars: number; accumulated: string }[] = [];
    await claudeCliAgenticStep({
      cfg,
      messages: [{ role: "user", content: "hi" }],
      onTextDelta: (chars, totalChars, accumulated) => deltas.push({ chars, totalChars, accumulated }),
    });

    expect(deltas.length).toBe(1);
    expect(deltas[0].accumulated).toBe(finalText);
  });

  it("uses --output-format stream-json --verbose --include-partial-messages flags", async () => {
    const finalText = '{"kind":"final","content":"ok"}';
    mockRunCliProcessStreaming.mockImplementation(
      makeStreamingMock(makeStreamJsonResult(finalText)),
    );

    await claudeCliAgenticStep({ cfg, messages: [{ role: "user", content: "x" }] });

    const callArgs = mockRunCliProcessStreaming.mock.calls[0][0];
    expect(callArgs.args).toContain("--output-format");
    expect(callArgs.args).toContain("stream-json");
    expect(callArgs.args).toContain("--verbose");
    expect(callArgs.args).toContain("--include-partial-messages");
  });
});
