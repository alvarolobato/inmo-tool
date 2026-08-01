export interface RunProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  /** Wall-clock duration in ms from spawn() to child close/error. */
  durationMs: number;
}
