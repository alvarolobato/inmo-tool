import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { runCliProcess } from "@/lib/llm-provider/cli/process";

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

describe("runCliProcess (mocked spawn)", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes stdin utf-8 and resolves stdout on exit 0", async () => {
    mockSpawn.mockImplementation(() => {
      const child = baseChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("ok"));
        child.emit("close", 0);
      });
      return child;
    });

    const r = await runCliProcess({
      file: "/bin/true",
      args: [],
      stdin: "payload",
      timeoutMs: 5000,
      maxStdoutBytes: 1000,
      maxStderrBytes: 500,
    });

    expect(r.stdout).toBe("ok");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    const child = mockSpawn.mock.results[0].value as MockChild;
    expect(child.stdin.write).toHaveBeenCalledWith("payload", "utf8");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("sets timedOut when watchdog fires and child exits after kill", async () => {
    vi.useFakeTimers();
    mockSpawn.mockImplementation(() => {
      const child = baseChild();
      return child;
    });

    const p = runCliProcess({
      file: "x",
      args: [],
      timeoutMs: 50,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    });
    await vi.advanceTimersByTimeAsync(60);
    const r = await p;
    expect(r.timedOut).toBe(true);
  });

  it("caps stdout bytes across multiple chunks", async () => {
    mockSpawn.mockImplementation(() => {
      const child = baseChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.alloc(40, "a"));
        child.stdout.emit("data", Buffer.alloc(40, "b"));
        child.emit("close", 0);
      });
      return child;
    });

    const r = await runCliProcess({
      file: "x",
      args: [],
      timeoutMs: 2000,
      maxStdoutBytes: 50,
      maxStderrBytes: 100,
    });
    expect(r.stdout.length).toBe(50);
    expect(r.truncatedStdout).toBe(true);
  });

  it("rejects when child emits error", async () => {
    mockSpawn.mockImplementation(() => {
      const child = baseChild();
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    await expect(
      runCliProcess({
        file: "missing-binary",
        args: [],
        timeoutMs: 1000,
        maxStdoutBytes: 100,
        maxStderrBytes: 100,
      }),
    ).rejects.toThrow("spawn ENOENT");
  });
});
