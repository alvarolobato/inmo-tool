import { describe, it, expect } from "vitest";
import { CliRunnerError, formatCliRunnerError, isCliRunnerError } from "@/lib/llm-client";

describe("formatCliRunnerError", () => {
  it("LLM_CLI_AUTH includes the sync-claude-token.sh remediation", () => {
    const err = new CliRunnerError("LLM_CLI_AUTH", "claude single-shot: 401", {
      exitCode: 1,
      stdout: '{"is_error":true,"api_error_status":401,"result":"Invalid credentials"}',
      stderr: "",
      phase: "auth",
      durationMs: 1234,
      command: ["claude", "-p", "...", "--model", "sonnet"],
      innerErrorCode: 401,
    });
    const out = formatCliRunnerError(err);
    expect(out.innerCode).toBe("LLM_CLI_AUTH");
    expect(out.error).toMatch(/sync-claude-token\.sh/);
    expect(out.error).toMatch(/claude \/login/);
    expect(out.details).toMatch(/Código interno: LLM_CLI_AUTH/);
    expect(out.details).toMatch(/Exit code: 1/);
    expect(out.details).toMatch(/API status interno: 401/);
    expect(out.details).toMatch(/Stdout/);
    expect(out.details).toMatch(/Invalid credentials/);
  });

  it("LLM_CLI_TIMEOUT mentions DASHBOARD_LLM_CLI_TIMEOUT_MS", () => {
    const err = new CliRunnerError("LLM_CLI_TIMEOUT", "claude single-shot: timeout", {
      exitCode: null,
      phase: "timeout",
      durationMs: 30000,
    });
    const out = formatCliRunnerError(err);
    expect(out.error).toMatch(/DASHBOARD_LLM_CLI_TIMEOUT_MS/);
    expect(out.details).toMatch(/Duración: 30000ms/);
  });

  it("LLM_CLI_EXIT (generic) preserves the fallback user message and includes stdout/stderr", () => {
    const err = new CliRunnerError("LLM_CLI_EXIT", "claude single-shot: CLI exited with code 1", {
      exitCode: 1,
      stdout: "Not logged in · Please run /login\n",
      stderr: "",
      phase: "exit",
      durationMs: 500,
    });
    const out = formatCliRunnerError(err, "Error al generar la revisión.");
    expect(out.error).toMatch(/^Error al generar la revisión\./);
    expect(out.error).toMatch(/stdout\/stderr/);
    expect(out.details).toMatch(/Not logged in/);
  });

  it("LLM_CLI_EMPTY tells the user to retry and check container logs", () => {
    const err = new CliRunnerError("LLM_CLI_EMPTY", "claude single-shot: empty stdout", {
      phase: "empty",
      durationMs: 100,
    });
    const out = formatCliRunnerError(err);
    expect(out.error).toMatch(/Reintenta/);
    expect(out.error).toMatch(/contenedor dashboard/);
  });

  it("technical detail block omits empty stdout/stderr cleanly", () => {
    const err = new CliRunnerError("LLM_CLI_AUTH", "auth", {
      exitCode: 1,
      stdout: "",
      stderr: "",
      phase: "auth",
    });
    const out = formatCliRunnerError(err);
    expect(out.details).not.toMatch(/Stdout/);
    expect(out.details).not.toMatch(/Stderr/);
  });
});

describe("isCliRunnerError", () => {
  it("recognizes a real CliRunnerError instance", () => {
    const err = new CliRunnerError("LLM_CLI_EXIT", "x", { exitCode: 1 });
    expect(isCliRunnerError(err)).toBe(true);
  });

  it("recognizes a duck-typed object across module boundaries", () => {
    // A CliRunnerError thrown from one module bundle and caught in another
    // can fail `instanceof` checks even when the structure is identical.
    const looksLikeError = {
      code: "LLM_CLI_AUTH",
      message: "x",
      details: { exitCode: 1, phase: "auth" },
    };
    expect(isCliRunnerError(looksLikeError)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isCliRunnerError(new Error("nope"))).toBe(false);
    expect(isCliRunnerError(null)).toBe(false);
    expect(isCliRunnerError("string")).toBe(false);
    expect(isCliRunnerError({ code: "X" })).toBe(false);
  });
});
