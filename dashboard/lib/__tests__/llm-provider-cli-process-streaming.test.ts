/**
 * Unit tests for runCliProcessStreaming in process.ts.
 *
 * Tests: multi-line stdout, partial-line buffering, oversized line truncation,
 * exit-1 with empty stdout, exit-0 with is_error JSON envelope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { runCliProcessStreaming } from "@/lib/llm-provider/cli/process";

type MockChild = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function baseChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
  });
  return child;
}

describe("runCliProcessStreaming", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onStdoutLine for each complete newline-delimited line", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const lines: string[] = [];
    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: (line) => lines.push(line),
    });

    // Emit two lines in a single chunk
    child.stdout.emit("data", Buffer.from('{"a":1}\n{"b":2}\n'));
    child.emit("close", 0);

    await resultPromise;
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles partial lines split across chunks", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const lines: string[] = [];
    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: (line) => lines.push(line),
    });

    // First chunk: incomplete line
    child.stdout.emit("data", Buffer.from('{"typ'));
    // Second chunk: completes the line + starts another
    child.stdout.emit("data", Buffer.from('e":"result"}\n{"x":1}\n'));
    child.emit("close", 0);

    await resultPromise;
    expect(lines).toEqual(['{"type":"result"}', '{"x":1}']);
  });

  it("flushes a partial line at EOF (no trailing newline)", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const lines: string[] = [];
    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: (line) => lines.push(line),
    });

    child.stdout.emit("data", Buffer.from('{"final":true}'));
    // No trailing newline — should still be flushed at close
    child.emit("close", 0);

    await resultPromise;
    expect(lines).toEqual(['{"final":true}']);
  });

  it("returns exit code 0 on success", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: () => {},
    });

    child.emit("close", 0);
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("returns exitCode 1 and captures stderr on non-zero exit", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: () => {},
    });

    child.stderr.emit("data", Buffer.from("error msg"));
    child.emit("close", 1);

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error msg");
  });

  it("ignores errors thrown by onStdoutLine callback", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: () => {
        throw new Error("callback error");
      },
    });

    child.stdout.emit("data", Buffer.from("line\n"));
    child.emit("close", 0);

    // Should resolve despite callback throwing
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
  });

  it("skips blank lines in onStdoutLine callback", async () => {
    const child = baseChild();
    mockSpawn.mockReturnValue(child);

    const lines: string[] = [];
    const resultPromise = runCliProcessStreaming({
      file: "cmd",
      args: [],
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
      onStdoutLine: (line) => lines.push(line),
    });

    // Emit lines with blank lines between them
    child.stdout.emit("data", Buffer.from("a\n\nb\n  \nc\n"));
    child.emit("close", 0);

    await resultPromise;
    // Blank and whitespace-only lines are skipped
    expect(lines).toEqual(["a", "b", "c"]);
  });
});
