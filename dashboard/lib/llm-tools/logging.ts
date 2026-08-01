/**
 * Persist tool-call telemetry to PostgreSQL (`llm_tool_calls`).
 */

import { sql } from "@/lib/db-write";

export interface LogToolCallInput {
  toolName: string;
  endpoint: string;
  requestId: string | null;
  status: "ok" | "error";
  latencyMs: number;
  payloadInBytes: number;
  payloadOutBytes: number;
  errorCode?: string | null;
  llmProvider?: string;
  llmDriver?: string | null;
}

export interface LogLlmErrorInput {
  requestId: string;
  endpoint: string;
  code: string;
  subError?: string | null;
  provider: string;
  driver?: string | null;
  model?: string | null;
  phase?: string | null;
  durationMs?: number | null;
  toolRoundsUsed?: number | null;
  toolCallsUsed?: number | null;
  lastToolName?: string | null;
  lastToolArgs?: string | null;
  cliExitCode?: number | null;
  cliInnerCode?: string | number | null;
  cliCommand?: string | null;
  cliStdoutTail?: string | null;
  cliStderrTail?: string | null;
  limits?: Record<string, number> | null;
}

/**
 * Persist a single AGENTIC_RUNNER failure to `llm_errors`. All free-form
 * fields are expected to be sanitized by the caller; this function does
 * not redact further. Insert failures are swallowed (we already logged
 * to console in the API layer).
 */
export async function logLlmError(row: LogLlmErrorInput): Promise<void> {
  try {
    await sql(
      `INSERT INTO llm_errors (
         request_id, endpoint, code, sub_error, provider, driver, model,
         phase, duration_ms, tool_rounds_used, tool_calls_used,
         last_tool_name, last_tool_args,
         cli_exit_code, cli_inner_code, cli_command, cli_stdout_tail, cli_stderr_tail,
         limits
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,
         $12,$13,
         $14,$15,$16,$17,$18,
         $19::jsonb
       )`,
      [
        row.requestId,
        row.endpoint,
        row.code,
        row.subError ?? null,
        row.provider,
        row.driver ?? null,
        row.model ?? null,
        row.phase ?? null,
        row.durationMs ?? null,
        row.toolRoundsUsed ?? null,
        row.toolCallsUsed ?? null,
        row.lastToolName ?? null,
        row.lastToolArgs ?? null,
        row.cliExitCode ?? null,
        row.cliInnerCode == null ? null : String(row.cliInnerCode),
        row.cliCommand ?? null,
        row.cliStdoutTail ?? null,
        row.cliStderrTail ?? null,
        row.limits ? JSON.stringify(row.limits) : null,
      ],
    );
  } catch (err) {
    if (process.env.VITEST !== "true") {
      console.error("[llm-errors] insert failed:", err);
    }
  }
}

export async function logLlmToolCall(row: LogToolCallInput): Promise<void> {
  try {
    await sql(
      `INSERT INTO llm_tool_calls (
         tool_name, endpoint, request_id, status, latency_ms,
         payload_in_bytes, payload_out_bytes, error_code,
         llm_provider, llm_driver
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.toolName,
        row.endpoint,
        row.requestId,
        row.status,
        row.latencyMs,
        row.payloadInBytes,
        row.payloadOutBytes,
        row.errorCode ?? null,
        row.llmProvider ?? "openrouter",
        row.llmDriver ?? null,
      ],
    );
  } catch (err) {
    if (process.env.VITEST !== "true") {
      console.error("[llm-tool-calls] insert failed:", err);
    }
  }
}

export interface ToolCallAggregateRow {
  endpoint: string;
  tool_name: string;
  status: string;
  calls: number;
  avg_latency_ms: number | null;
  /** Summed byte counts (may exceed JS safe integer; parsed as float from PG). */
  total_payload_in: number | null;
  total_payload_out: number | null;
}

/** Aggregated tool metrics for admin dashboards (last 30 days). */
export async function fetchToolCallAggregates(): Promise<ToolCallAggregateRow[]> {
  try {
    return await sql<ToolCallAggregateRow>(`
      SELECT
        endpoint,
        tool_name,
        status,
        COUNT(*)::integer AS calls,
        (AVG(latency_ms))::integer AS avg_latency_ms,
        SUM(payload_in_bytes)::float8 AS total_payload_in,
        SUM(payload_out_bytes)::float8 AS total_payload_out
      FROM llm_tool_calls
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY endpoint, tool_name, status
      ORDER BY calls DESC
    `);
  } catch (err) {
    if (process.env.VITEST !== "true") {
      console.error("[llm-tool-calls] aggregate query failed:", err);
    }
    return [];
  }
}
