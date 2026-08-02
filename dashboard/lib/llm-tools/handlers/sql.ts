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
    .regex(/^[a-z_][a-z0-9_]*$/i, "table must be a plain identifier"),
});

/**
 * Domain tables the LLM may see, describe, and query.
 *
 * An allowlist, not a denylist: `public` also holds the app's own operational
 * tables — `conversations`/`conversation_messages`/`turn_events` (the chat's
 * own transcripts), `llm_errors`/`llm_usage`/`llm_interactions` (prompt text
 * and spend), `connector_config`/`extension_capture` — none of which are ever
 * a legitimate answer to a question about properties, and all of which the
 * chat could otherwise read back to a user or feed into its own context.
 *
 * The pre-port code got this incidentally right via a `^ps_` prefix filter on
 * the mirrored source tables; this schema names its tables plainly, so the
 * restriction has to be explicit. Adding a table here is a deliberate act.
 */
export const LLM_VISIBLE_TABLES: readonly string[] = [
  "property",
  "listing",
  "listing_price_history",
  "listing_status_event",
  "search_profile",
  "profile_listing_state",
  "feedback_event",
  "ai_assessment",
  "property_merge_log",
  "suggested_merge",
] as const;

const LLM_VISIBLE_TABLE_SET = new Set<string>(LLM_VISIBLE_TABLES);

export function isLlmVisibleTable(table: string): boolean {
  return LLM_VISIBLE_TABLE_SET.has(table.toLowerCase());
}

/**
 * Table identifiers referenced by a SQL statement, lower-cased.
 *
 * Deliberately over-collects (it matches after FROM/JOIN/UPDATE/INTO, including
 * inside comments or strings) because this feeds a *deny* decision: an extra
 * candidate can only cause a safe rejection, whereas a missed one would let a
 * non-visible table through. `validateReadOnly` already blocks DML/DDL, so the
 * realistic bypass to close is a SELECT reaching a table it shouldn't.
 */
export function referencedTables(sql: string): string[] {
  const found = new Set<string>();
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1]?.toLowerCase();
    if (name) found.add(name);
  }
  return [...found];
}

/**
 * Reject a query touching anything outside {@link LLM_VISIBLE_TABLES}.
 *
 * `information_schema`/`pg_catalog` lookups are allowed through: they expose
 * only metadata, and `describe_table` is itself built on one. Returns a message
 * for the caller to surface, or null when the query is acceptable.
 */
export function disallowedTableReason(sql: string): string | null {
  const referenced = referencedTables(sql).filter(
    (t) => !t.startsWith("pg_") && t !== "columns" && t !== "tables",
  );
  const blocked = referenced.filter((t) => !isLlmVisibleTable(t));
  if (blocked.length === 0) return null;
  return (
    `Query references table(s) not available to this assistant: ${blocked.join(", ")}. ` +
    `Available tables: ${LLM_VISIBLE_TABLES.join(", ")}.`
  );
}

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
  const tableErr = disallowedTableReason(args.sql);
  if (tableErr) {
    return toolOk({
      valid: false,
      lint_issues: lintWidgetSql(args.sql),
      reason: tableErr,
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
  const explainTableErr = disallowedTableReason(args.sql);
  if (explainTableErr) {
    return toolOk({ explain: null, error: explainTableErr });
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
  const executeTableErr = disallowedTableReason(args.sql);
  if (executeTableErr) {
    return toolOk({ rows: [], columns: [], error: executeTableErr });
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

export async function handleListTables(
  _rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  // Only the domain tables in LLM_VISIBLE_TABLES, intersected with what the
  // database actually has (so a table not yet migrated in is simply absent
  // rather than advertised and then failing on describe). The allowlist is
  // applied in SQL rather than filtering afterwards so the operational tables
  // never leave the database.
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = ANY($1)
    ORDER BY table_name
  `;
  try {
    const res = await query(sql, [LLM_VISIBLE_TABLES as unknown as string[]]);
    const names = res.rows.map((r) => String(r[0]));
    return toolOk({ tables: names });
  } catch {
    return toolError("DB_ERROR", "Could not list tables.", ctx);
  }
}

export async function handleDescribeTable(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof TableSchema>;
  try {
    args = TableSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for describe_table.", ctx);
  }
  if (!isLlmVisibleTable(args.table)) {
    // Not DB_ERROR: the table may well exist. It is simply not one this
    // assistant is allowed to introspect (see LLM_VISIBLE_TABLES).
    return toolError(
      "INVALID_ARGS",
      `Table "${args.table}" is not available to this assistant. ` +
        `Available tables: ${LLM_VISIBLE_TABLES.join(", ")}.`,
      ctx,
    );
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
