import { describe, it, expect } from "vitest";
import { assertCliSuccess } from "@/lib/llm-provider/cli/process";
import type { RunProcessResult } from "@/lib/llm-provider/cli/types";
import { CliRunnerError } from "@/lib/llm-client";

function makeResult(partial: Partial<RunProcessResult>): RunProcessResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 0,
    ...partial,
  };
}

describe("assertCliSuccess", () => {
  it("throws LLM_CLI_TIMEOUT when timedOut", () => {
    const r = makeResult({ exitCode: null, timedOut: true });
    expect(() => assertCliSuccess(r, "t")).toThrow(CliRunnerError);
    expect(() => assertCliSuccess(r, "t")).toThrow(/timed out/i);
  });

  it("throws LLM_CLI_TRUNCATED when streams truncated", () => {
    const r = makeResult({ stdout: "x", truncatedStdout: true });
    expect(() => assertCliSuccess(r, "t")).toThrow(/capture limit/i);
  });

  it("throws LLM_CLI_EXIT on non-zero exit", () => {
    const r = makeResult({ exitCode: 2, stderr: "boom" });
    expect(() => assertCliSuccess(r, "t")).toThrow(/exited with code 2/);
  });

  it("upgrades exit-1 with auth-failed JSON envelope to LLM_CLI_AUTH (issue #419)", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result:
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    });
    const r = makeResult({ exitCode: 1, stdout, durationMs: 4000 });
    let caught: CliRunnerError | null = null;
    try {
      assertCliSuccess(r, "claude agentic step", ["claude", "-p", "x"]);
    } catch (e) {
      caught = e as CliRunnerError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("LLM_CLI_AUTH");
    expect(caught!.details.phase).toBe("auth");
    expect(caught!.details.innerErrorCode).toBe(401);
    expect(caught!.details.command).toBeDefined();
    // The original message should mention authentication, not just exit code.
    expect(caught!.message).toMatch(/authenticate/i);
    expect(caught!.message).not.toMatch(/exited with code/);
  });

  it("upgrades exit-1 with non-auth API error JSON to LLM_CLI_API_ERROR", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 500,
      result: "Upstream model timed out",
    });
    const r = makeResult({ exitCode: 1, stdout, durationMs: 1000 });
    expect(() => assertCliSuccess(r, "t")).toThrow(/Upstream model/);
    try {
      assertCliSuccess(r, "t");
    } catch (e) {
      const ce = e as CliRunnerError;
      expect(ce.code).toBe("LLM_CLI_API_ERROR");
      expect(ce.details.phase).toBe("exit");
    }
  });

  it("passes on exit 0 without timeout or truncation", () => {
    const r = makeResult({ stdout: "{}" });
    expect(() => assertCliSuccess(r, "t")).not.toThrow();
  });
});
