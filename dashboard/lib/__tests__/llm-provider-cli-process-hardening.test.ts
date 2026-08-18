// @vitest-environment node
/**
 * Spawn-level hardening for the CLI runner, learned from the sibling
 * obsidian-meeting-copilot project's CLI bridge.
 *
 * These run the REAL `runCliProcess` against real child processes (`sh`), not
 * a mock: the behaviours under test are properties of Node's stream and
 * process plumbing, which a mock would simply assert away.
 */
import { describe, it, expect } from "vitest";
import { runCliProcess } from "../llm-provider/cli/process";
import { tmpdir } from "node:os";

const base = {
  timeoutMs: 20_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 100_000,
};

describe("runCliProcess — stdin EPIPE", () => {
  it("survives a child that exits before draining a large stdin", async () => {
    // Reproduced before the fix as `UNCAUGHT: EPIPE` killing the whole Node
    // process. An unhandled `error` on the stdin stream is fatal, and
    // `child.on("error")` does NOT cover it — that only sees spawn failures.
    //
    // Not hypothetical: assessment prompts carrying several listings exceed
    // the ~64 KB pipe buffer, so the write cannot complete synchronously, and
    // any fast-failing CLI invocation (rejected flag, auth failure) races it.
    const bigPrompt = "x".repeat(5_000_000);

    const result = await runCliProcess({
      file: "sh",
      args: ["-c", "exit 3"],
      stdin: bigPrompt,
      ...base,
    });

    // The point is that we get here at all, with the exit code intact.
    expect(result.exitCode).toBe(3);
  });

  it("still delivers stdin normally to a child that reads it", async () => {
    const result = await runCliProcess({
      file: "sh",
      args: ["-c", "cat"],
      stdin: "hola mundo",
      ...base,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hola mundo");
  });
});

describe("runCliProcess — working directory", () => {
  it("runs from a neutral cwd, not the server's", async () => {
    // Claude Code auto-discovers CLAUDE.md from the working directory and
    // walks up. Measured from this repo's root, that added 22,490 cached
    // tokens to a trivial prompt and let the model describe the project.
    // The lean flags suppress it today, but `llm_cli_lean_mode = false` (the
    // documented debug escape hatch) and `npm run dev` from the repo root
    // would both re-open it; a neutral cwd closes it structurally.
    const result = await runCliProcess({
      file: "sh",
      args: ["-c", "pwd"],
      ...base,
    });
    // macOS reports /var/... for the /private/var tmpdir (or vice versa).
    const seen = result.stdout.trim().replace(/^\/private/, "");
    const expected = tmpdir().replace(/^\/private/, "");
    expect(seen).toBe(expected);
    expect(seen).not.toBe(process.cwd());
  });
});
