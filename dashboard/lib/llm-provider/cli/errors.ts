/**
 * CLI runner failures mapped for callers (HTTP-style codes where useful).
 *
 * Carries the structured fields the API layer needs to populate a rich
 * "Detalles" modal: exit code, sanitized stdout/stderr tails, the argv
 * that was spawned, the phase the failure happened in, and the wall
 * time spent before the error surfaced.
 */

export type CliPhase =
  | "spawn"
  | "exit"
  | "timeout"
  | "truncated"
  | "auth"
  | "parse"
  | "empty";

export interface CliRunnerErrorDetails {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** argv[0] + argv[1..n] as the runner spawned it (already sanitized). */
  command?: readonly string[];
  /** Coarse-grained phase the failure occurred in. */
  phase?: CliPhase;
  /** Wall-clock duration in ms (spawn → exit/error). */
  durationMs?: number;
  /**
   * Inner CLI error code surfaced by the binary itself, e.g. the JSON
   * envelope's `api_error_status` from `claude --output-format json`.
   */
  innerErrorCode?: string | number | null;
}

export class CliRunnerError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  /** Short stderr snippet for legacy error-message use; full tail lives in `details`. */
  readonly stderrSnippet: string;
  readonly details: CliRunnerErrorDetails;

  constructor(code: string, message: string, opts?: CliRunnerErrorDetails) {
    super(message);
    this.name = "CliRunnerError";
    this.code = code;
    this.exitCode = opts?.exitCode ?? null;
    this.stderrSnippet = (opts?.stderr ?? "").slice(0, 2000);
    this.details = {
      exitCode: opts?.exitCode ?? null,
      stdout: opts?.stdout,
      stderr: opts?.stderr,
      command: opts?.command,
      phase: opts?.phase,
      durationMs: opts?.durationMs,
      innerErrorCode: opts?.innerErrorCode ?? null,
    };
  }
}
