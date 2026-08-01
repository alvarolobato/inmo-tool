/**
 * SQL/metadata tool handlers (read-only mirror).
 */

import { z } from "zod";
import {
  query,
  queryReadOnlyWithStatementTimeout,
  QueryTimeoutError,
  SqlValidationError,
  validateReadOnly,
} from "@/lib/db";
import { validateQueryCost, QueryTooExpensiveError } from "@/lib/query-validator";
import { lintWidgetSql } from "@/lib/sql-heuristics";
import type { LlmAgenticContext } from "../types";
import { toolError, toolOk, type ToolResponseBody } from "../tool-payload";
import { getAgenticConfig } from "../config";

const SqlSchema = z.object({
  sql: z.string().min(1),
});

const TableSchema = z.object({
  table: z
    .string()
    .min(1)
    .regex(/^ps_[a-z0-9_]+$/i, "table must be a ps_* identifier"),
});

/** Agentic SQL tools must not accept bare EXPLAIN / EXPLAIN ANALYZE (cost bypass + side effects). */
function agenticSelectOrWithReason(sql: string): string | null {
  const trimmed = sql.trimStart();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return "Only SELECT or WITH queries are allowed (no bare EXPLAIN or other statements).";
  }
  return null;
}

function clipRowsCols(
  columns: string[],
  rows: unknown[][],
  maxCols: number,
  maxRows: number,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const colCount = Math.min(columns.length, maxCols);
  const clippedCols = columns.slice(0, colCount);
  const rowSlice = rows.slice(0, maxRows);
  const clippedRows = rowSlice.map((r) => r.slice(0, colCount));
  const truncated =
    rows.length > maxRows || columns.length > maxCols;
  return { columns: clippedCols, rows: clippedRows, truncated };
}

export async function handleValidateQuery(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof SqlSchema>;
  try {
    args = SqlSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for validate_query.", ctx);
  }
  const agenticSqlErr = agenticSelectOrWithReason(args.sql);
  if (agenticSqlErr) {
    return toolOk({
      valid: false,
      lint_issues: lintWidgetSql(args.sql),
      reason: agenticSqlErr,
    });
  }
  try {
    validateReadOnly(args.sql);
  } catch (e) {
    if (e instanceof SqlValidationError) {
      return toolOk({
        valid: false,
        lint_issues: lintWidgetSql(args.sql),
        reason: e.message,
      });
    }
    return toolError("VALIDATION_FAILED", "SQL validation failed.", ctx);
  }
  const lint_issues = lintWidgetSql(args.sql);
  const { toolTimeoutMs } = getAgenticConfig();
  try {
    const cost = await validateQueryCost(args.sql, {
      statementTimeoutMs: toolTimeoutMs,
    });
    return toolOk({ valid: true, estimated_cost: cost, lint_issues });
  } catch (e) {
    if (e instanceof QueryTooExpensiveError) {
      return toolOk({
        valid: false,
        lint_issues,
        reason: "Query plan exceeds configured cost limit.",
        estimated_cost: e.cost,
        cost_limit: e.limit,
      });
    }
    return toolOk({
      valid: true,
      estimated_cost: 0,
      lint_issues,
      cost_check: "skipped",
    });
  }
}

export async function handleExplainQuery(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof SqlSchema>;
  try {
    args = SqlSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for explain_query.", ctx);
  }
  try {
    validateReadOnly(args.sql);
  } catch (e) {
    if (e instanceof SqlValidationError) {
      return toolOk({ explain: null, error: e.message });
    }
    return toolError("VALIDATION_FAILED", "SQL validation failed.", ctx);
  }
  if (!/^(SELECT|WITH)\b/i.test(args.sql.trimStart())) {
    return toolOk({
      explain: null,
      error: "explain_query only supports SELECT/WITH (not bare EXPLAIN).",
    });
  }
  try {
    const planSql = `EXPLAIN (FORMAT JSON) ${args.sql}`;
    validateReadOnly(planSql);
    const res = await queryReadOnlyWithStatementTimeout(
      planSql,
      undefined,
      getAgenticConfig().toolTimeoutMs,
    );
    const raw = res.rows[0]?.[0];
    return toolOk({ explain: raw });
  } catch {
    return toolOk({
      explain: null,
      error: "EXPLAIN could not be produced for this statement.",
    });
  }
}

export async function handleExecuteQuery(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  const { maxRows, maxColumns, toolTimeoutMs } = getAgenticConfig();
  let args: z.infer<typeof SqlSchema>;
  try {
    args = SqlSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for execute_query.", ctx);
  }
  const agenticSqlErr = agenticSelectOrWithReason(args.sql);
  if (agenticSqlErr) {
    return toolOk({
      rows: [],
      columns: [],
      error: agenticSqlErr,
    });
  }
  try {
    validateReadOnly(args.sql);
  } catch (e) {
    if (e instanceof SqlValidationError) {
      return toolOk({ rows: [], columns: [], error: e.message });
    }
    return toolError("VALIDATION_FAILED", "SQL validation failed.", ctx);
  }
  try {
    await validateQueryCost(args.sql, { statementTimeoutMs: toolTimeoutMs });
  } catch (e) {
    if (e instanceof QueryTooExpensiveError) {
      return toolOk({
        rows: [],
        columns: [],
        error: "Query exceeds configured cost limit.",
        estimated_cost: e.cost,
        cost_limit: e.limit,
      });
    }
  }
  try {
    const res = await queryReadOnlyWithStatementTimeout(
      args.sql,
      undefined,
      toolTimeoutMs,
    );
    const clipped = clipRowsCols(res.columns, res.rows, maxColumns, maxRows);
    return toolOk({
      columns: clipped.columns,
      rows: clipped.rows,
      truncated: clipped.truncated,
    });
  } catch (e) {
    if (e instanceof QueryTimeoutError) {
      return toolOk({
        rows: [],
        columns: [],
        error: "Query timed out (statement_timeout on mirror).",
      });
    }
    return toolOk({
      rows: [],
      columns: [],
      error: "Query execution failed.",
    });
  }
}

export async function handleListPsTables(
  _rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name ~ '^ps_'
    ORDER BY table_name
    LIMIT 500
  `;
  try {
    validateReadOnly(sql);
    const res = await query(sql);
    const names = res.rows.map((r) => String(r[0]));
    return toolOk({ tables: names });
  } catch {
    return toolError("DB_ERROR", "Could not list tables.", ctx);
  }
}

export async function handleDescribePsTable(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof TableSchema>;
  try {
    args = TableSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for describe_ps_table.", ctx);
  }
  try {
    const res = await query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [args.table],
    );
    const columns = res.rows.map((row) => ({
      column_name: String(row[0]),
      data_type: String(row[1]),
      is_nullable: String(row[2]),
    }));
    return toolOk({ table: args.table, columns });
  } catch {
    return toolError("DB_ERROR", "Could not describe table.", ctx);
  }
}
