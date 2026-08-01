/**
 * Translate an AgenticRunnerError into the public-facing AgenticErrorDiagnostic
 * that the API layer puts on the wire.
 *
 * The runner-side type is a structural superset; this helper applies the final
 * sanitization step (already done at capture time, but defense-in-depth) and
 * provider/driver/model labelling so the front-end can show a complete
 * "Detalles" section even when only a partial failure was captured.
 */

import type { AgenticErrorDiagnostic } from "@/lib/errors";
import type { DashboardLlmConfig } from "@/lib/llm-provider/types";
import { getEffectiveDashboardModel } from "@/lib/llm-provider/config";
import { getAgenticConfig } from "./config";
import { sanitize, sanitizeArgv, sanitizeTail } from "@/lib/llm-provider/sanitize";
import type { AgenticRunnerError, AgenticRunnerErrorDiagnostic } from "./runner";
import { logLlmError } from "./logging";

const STREAM_TAIL_BYTES = 4096;

export function buildAgenticErrorDiagnostic(
  err: AgenticRunnerError,
  cfg: DashboardLlmConfig,
): AgenticErrorDiagnostic {
  const limits = err.diagnostic?.limitsAtFailure ?? defaultLimits();
  const phase: AgenticErrorDiagnostic["phase"] = err.diagnostic?.phase ?? "tool_call";
  const lastTool = err.diagnostic?.lastToolCall;

  const cliFromRunner = err.diagnostic?.cli;
  const cli =
    cfg.provider === "cli" && cliFromRunner
      ? {
          exitCode: cliFromRunner.exitCode ?? null,
          command: cliFromRunner.command ? sanitizeArgv(cliFromRunner.command) : undefined,
          stderrTail: sanitizeTail(cliFromRunner.stderrTail, STREAM_TAIL_BYTES),
          stdoutTail: sanitizeTail(cliFromRunner.stdoutTail, STREAM_TAIL_BYTES),
          innerErrorCode: cliFromRunner.innerErrorCode ?? null,
        }
      : undefined;

  // Coerce e2e-stub → openrouter for both provider label and model derivation
  // so the two fields are always consistent in the diagnostic output.
  const effectiveCfg: typeof cfg =
    cfg.provider === "e2e-stub" ? { ...cfg, provider: "openrouter" } : cfg;
  // Narrowed separately so the return type matches Exclude<DashboardLlmProviderId, "e2e-stub">.
  const providerLabel = cfg.provider === "e2e-stub" ? ("openrouter" as const) : cfg.provider;

  return {
    subError: `${err.code}: ${sanitize(err.message)}`,
    provider: providerLabel,
    driver: cfg.provider === "cli" ? cfg.cliDriver : null,
    model: getEffectiveDashboardModel(effectiveCfg),
    phase,
    durationMs: err.diagnostic?.durationMs ?? 0,
    toolRoundsUsed: err.diagnostic?.toolRoundsUsed ?? 0,
    toolCallsUsed: err.diagnostic?.toolCallsUsed ?? 0,
    ...(lastTool
      ? {
          lastToolCall: {
            name: lastTool.name,
            argumentsTruncated: sanitize(lastTool.argumentsTruncated).slice(0, 300),
          },
        }
      : {}),
    ...(cli ? { cli } : {}),
    limitsAtFailure: limits,
  };
}

function defaultLimits(): AgenticErrorDiagnostic["limitsAtFailure"] {
  const c = getAgenticConfig();
  return {
    maxRounds: c.maxToolRounds,
    maxToolCalls: c.maxToolCalls,
    toolTimeoutMs: c.toolTimeoutMs,
    executeRowLimit: c.maxRows,
    payloadCharLimit: c.maxResultChars,
  };
}

// Local re-export for the runner type to avoid `import type` coupling at the
// top of consumers that already import the diagnostic builder.
export type { AgenticRunnerErrorDiagnostic };

/**
 * Persist an AgenticRunnerError to `llm_errors`. Fire-and-forget — the
 * underlying logger swallows DB failures so the API response is never blocked.
 *
 * The endpoint string MUST match the route's logical name (e.g. "analyze",
 * "modify", "generate") to keep the table consistent with `llm_interactions`.
 */
export function persistAgenticError(
  endpoint: string,
  err: AgenticRunnerError,
  diagnostic: AgenticErrorDiagnostic,
): void {
  void logLlmError({
    requestId: err.requestId,
    endpoint,
    code: err.code,
    subError: diagnostic.subError,
    provider: diagnostic.provider,
    driver: diagnostic.driver,
    model: diagnostic.model,
    phase: diagnostic.phase,
    durationMs: diagnostic.durationMs,
    toolRoundsUsed: diagnostic.toolRoundsUsed,
    toolCallsUsed: diagnostic.toolCallsUsed,
    lastToolName: diagnostic.lastToolCall?.name ?? null,
    lastToolArgs: diagnostic.lastToolCall?.argumentsTruncated ?? null,
    cliExitCode: diagnostic.cli?.exitCode ?? null,
    cliInnerCode: diagnostic.cli?.innerErrorCode ?? null,
    cliCommand: diagnostic.cli?.command ? diagnostic.cli.command.join(" ") : null,
    cliStdoutTail: diagnostic.cli?.stdoutTail ?? null,
    cliStderrTail: diagnostic.cli?.stderrTail ?? null,
    limits: diagnostic.limitsAtFailure,
  });
}
