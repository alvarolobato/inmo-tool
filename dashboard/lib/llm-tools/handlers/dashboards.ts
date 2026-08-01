/**
 * Dashboard context tools (saved specs in PostgreSQL).
 */

import { z } from "zod";
import { sql } from "@/lib/db-write";
import { DashboardSpecSchema, type DashboardSpec } from "@/lib/schema";
import { substituteDateParams, type DateParamRanges } from "@/lib/date-params";
import { validateReadOnly, query, SqlValidationError } from "@/lib/db";
import { validateQueryCost, QueryTooExpensiveError } from "@/lib/query-validator";
import { lintDashboardSpec, lintWidgetSql } from "@/lib/sql-heuristics";
import { extractDashboardSqlRefs } from "../dashboard-query-extractor";
import type { LlmAgenticContext } from "../types";
import { toolError, toolOk, type ToolResponseBody } from "../tool-payload";
import { getAgenticConfig } from "../config";
import { ReviewLlmOutputSchema } from "@/lib/review-schema";
import { sanitize } from "@/lib/llm-provider/sanitize";

const LimitSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

const IdSchema = z.object({
  dashboard_id: z.number().int().positive(),
});

const WidgetRawSchema = z.object({
  dashboard_id: z.number().int().positive(),
  widget_index: z.number().int().min(0),
  kpi_item_index: z.number().int().min(0).optional(),
  date_range: z
    .object({
      curr_from: z.string().optional(),
      curr_to: z.string().optional(),
      comp_from: z.string().optional(),
      comp_to: z.string().optional(),
    })
    .optional(),
});

function parseDayStartUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) throw new Error("bad date");
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function parseDayEndUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) throw new Error("bad date");
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
}

function defaultRanges(): DateParamRanges {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { curr: { from, to } };
}

function rangesFromTool(
  dr: z.infer<typeof WidgetRawSchema>["date_range"],
): DateParamRanges {
  if (dr?.curr_from && dr?.curr_to) {
    try {
      const curr = {
        from: parseDayStartUtc(dr.curr_from),
        to: parseDayEndUtc(dr.curr_to),
      };
      const comp =
        dr.comp_from && dr.comp_to
          ? {
              from: parseDayStartUtc(dr.comp_from),
              to: parseDayEndUtc(dr.comp_to),
            }
          : undefined;
      return { curr, comp };
    } catch {
      return defaultRanges();
    }
  }
  return defaultRanges();
}

async function loadSpecRow(
  dashboardId: number,
  ctx: LlmAgenticContext,
): Promise<{ spec: DashboardSpec } | ToolResponseBody> {
  const result = await query(
    `SELECT spec FROM dashboards WHERE id = $1`,
    [dashboardId],
  );
  if (!result.rows.length) {
    return toolError("NOT_FOUND", `Dashboard ${dashboardId} not found.`, ctx);
  }
  const parsed = DashboardSpecSchema.safeParse(result.rows[0][0]);
  if (!parsed.success) {
    return toolError("INVALID_SPEC", "Stored dashboard spec failed validation.", ctx);
  }
  return { spec: parsed.data };
}

export async function handleListDashboards(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let limit = 30;
  try {
    const j = JSON.parse(rawArgs || "{}");
    const p = LimitSchema.safeParse(j);
    if (p.success && p.data.limit) limit = p.data.limit;
  } catch {
    /* default */
  }
  try {
    const rows = await sql<{
      id: number;
      name: string;
      description: string | null;
      updated_at: Date;
    }>(
      `SELECT id, name, description, updated_at
       FROM dashboards
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit],
    );
    return toolOk({
      dashboards: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        updated_at: r.updated_at,
      })),
    });
  } catch {
    return toolError("DB_ERROR", "Could not list dashboards.", ctx);
  }
}

export async function handleGetDashboardSpec(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof IdSchema>;
  try {
    args = IdSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for get_dashboard_spec.", ctx);
  }
  const row = await loadSpecRow(args.dashboard_id, ctx);
  if (!("spec" in row)) return row;
  return toolOk({ dashboard_id: args.dashboard_id, spec: row.spec });
}

export async function handleGetDashboardQueries(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof IdSchema>;
  try {
    args = IdSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError("INVALID_ARGS", "Invalid arguments for get_dashboard_queries.", ctx);
  }
  const row = await loadSpecRow(args.dashboard_id, ctx);
  if (!("spec" in row)) return row;
  const refs = extractDashboardSqlRefs(row.spec);
  return toolOk({
    dashboard_id: args.dashboard_id,
    queries: refs.map((r) => ({
      widget_index: r.widgetIndex,
      widget_id: r.widgetId ?? null,
      label: r.label,
      kind: r.kind,
      kpi_item_index: r.kpiItemIndex ?? null,
      sql: r.sql,
    })),
  });
}

export async function handleGetDashboardWidgetRawValues(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  const { maxRows, maxColumns } = getAgenticConfig();
  let args: z.infer<typeof WidgetRawSchema>;
  try {
    args = WidgetRawSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError(
      "INVALID_ARGS",
      "Invalid arguments for get_dashboard_widget_raw_values.",
      ctx,
    );
  }
  const row = await loadSpecRow(args.dashboard_id, ctx);
  if (!("spec" in row)) return row;
  const spec = row.spec;
  const widget = spec.widgets[args.widget_index];
  if (!widget) {
    return toolOk({
      error: `widget_index ${args.widget_index} out of range`,
      rows: [],
      columns: [],
    });
  }

  let sqlText: string;
  let label: string;
  if (widget.type === "kpi_row") {
    if (args.kpi_item_index === undefined) {
      return toolOk({
        error: "kpi_item_index is required for kpi_row widgets.",
        rows: [],
        columns: [],
      });
    }
    const item = widget.items[args.kpi_item_index];
    if (!item) {
      return toolOk({
        error: `kpi_item_index ${args.kpi_item_index} out of range`,
        rows: [],
        columns: [],
      });
    }
    sqlText = item.sql;
    label = item.label;
  } else if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
    return toolOk({
      error: `Widget type "${widget.type}" has no SQL to execute.`,
      rows: [],
      columns: [],
    });
  } else {
    const w = widget as { sql: string; title: string };
    sqlText = w.sql;
    label = w.title;
  }

  const ranges = rangesFromTool(args.date_range);
  const filled = substituteDateParams(sqlText, ranges);

  try {
    validateReadOnly(filled);
  } catch (e) {
    if (e instanceof SqlValidationError) {
      return toolOk({
        error: e.message,
        label,
        rows: [],
        columns: [],
      });
    }
    return toolError("VALIDATION_FAILED", "SQL validation failed.", ctx);
  }

  try {
    await validateQueryCost(filled);
  } catch (e) {
    if (e instanceof QueryTooExpensiveError) {
      return toolOk({
        error: "Query exceeds configured cost limit.",
        label,
        estimated_cost: e.cost,
        cost_limit: e.limit,
        rows: [],
        columns: [],
      });
    }
  }

  try {
    const res = await query(filled);
    const colCount = Math.min(res.columns.length, maxColumns);
    const clippedCols = res.columns.slice(0, colCount);
    const clippedRows = res.rows.slice(0, maxRows).map((r) => r.slice(0, colCount));
    return toolOk({
      label,
      columns: clippedCols,
      rows: clippedRows,
      truncated: res.rows.length > maxRows || res.columns.length > maxColumns,
    });
  } catch {
    return toolOk({
      error: "Query execution failed.",
      label,
      rows: [],
      columns: [],
    });
  }
}

/**
 * Validate a candidate dashboard JSON spec **before** the model emits its
 * final answer. Runs (1) Zod schema validation on the structure and (2) the
 * SQL heuristic lint on every widget query. Returns a structured result so
 * the model can self-correct mistakes (missing widgets[], wrong widget type,
 * duplicate ids, mismatched kpi_row items, bad SQL patterns) inside the
 * tool loop instead of emitting a broken final spec that the route then
 * rejects with LLM_INVALID_RESPONSE.
 */
export async function handleValidateDashboardSpec(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: { spec?: unknown };
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return toolError(
      "INVALID_ARGS",
      "validate_dashboard_spec: arguments must be a JSON object with a 'spec' field.",
      ctx,
    );
  }
  if (typeof args.spec !== "object" || args.spec === null || Array.isArray(args.spec)) {
    return toolError(
      "INVALID_ARGS",
      "validate_dashboard_spec: 'spec' must be a JSON object.",
      ctx,
    );
  }

  const parsed = DashboardSpecSchema.safeParse(args.spec);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return toolOk({
      ok: false,
      errors,
      warnings: [],
      hint:
        "Fix the structural errors above and call validate_dashboard_spec again. " +
        "Do not emit a final answer until ok=true.",
    });
  }

  const warnings = lintDashboardSpec(parsed.data);
  // ok reflects "safe to emit final JSON". Per the prompt contract, only
  // structural errors block emission — SQL lint warnings are surfaced for
  // the model to consider but do NOT flip ok to false. Keeping the two
  // signals aligned with the prompt prevents the model from looping
  // indefinitely on an unfixable lint warning.
  return toolOk({
    ok: true,
    errors: [],
    warnings,
    hint:
      warnings.length === 0
        ? "Spec is valid. You may emit the final JSON now."
        : "Spec is structurally valid but has SQL lint warnings — review each one. Warnings do not block emission; emit the final JSON when you are satisfied.",
  });
}

// ── Publish-tool handlers ────────────────────────────────────────────────────
// These handlers stage results into the request-scoped `ctx` side-channel.
// They MUST NOT write to PostgreSQL directly — persistence is the route's job.

const CHANGE_SUMMARY_MAX = 1000;
const BRIEF_SUMMARY_MAX = 500;
const MARKDOWN_MAX_BYTES = 30 * 1024; // 30 KB

/**
 * `apply_dashboard_modification` — validate spec + stage modify result.
 *
 * The model calls this once at the end of a modify task with the full updated
 * spec and a 2–4 sentence Spanish change_summary. The tool validates the spec
 * with Zod and runs the SQL heuristic lint. On success it stages the result in
 * ctx.modifyResult and returns `{ ok: true, applied: true }`. The LAST call
 * wins — intentional double-calls are accepted (latest spec overwrites).
 */
export async function handleApplyDashboardModification(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: { spec?: unknown; change_summary?: unknown };
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return toolError(
      "INVALID_ARGS",
      "apply_dashboard_modification: arguments must be a JSON object.",
      ctx,
    );
  }

  if (typeof args.spec !== "object" || args.spec === null || Array.isArray(args.spec)) {
    return toolError(
      "INVALID_ARGS",
      "apply_dashboard_modification: 'spec' must be a JSON object.",
      ctx,
    );
  }

  if (typeof args.change_summary !== "string" || args.change_summary.trim().length === 0) {
    return toolError(
      "INVALID_ARGS",
      "apply_dashboard_modification: 'change_summary' must be a non-empty string.",
      ctx,
    );
  }

  if (args.change_summary.length > CHANGE_SUMMARY_MAX) {
    return toolError(
      "INVALID_ARGS",
      `apply_dashboard_modification: 'change_summary' must be ≤ ${CHANGE_SUMMARY_MAX} characters.`,
      ctx,
    );
  }

  // Validate the spec with Zod — same logic as handleValidateDashboardSpec so
  // the two tools stay consistent. NOTE: if validation logic changes, update
  // both handlers (or extract a shared helper).
  const parsed = DashboardSpecSchema.safeParse(args.spec);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return toolOk({
      ok: false,
      errors,
      warnings: [],
      hint:
        "Fix the structural errors above and call apply_dashboard_modification again with the corrected spec.",
    });
  }

  // Run SQL heuristic lint (non-blocking — surfaced as warnings).
  const warnings = lintDashboardSpec(parsed.data);

  // Sanitize the summary before staging.
  const sanitizedSummary = sanitize(args.change_summary.trim());

  const wasAlreadySet = ctx.modifyResult != null;
  ctx.modifyResult = { spec: parsed.data, summary: sanitizedSummary };

  return toolOk({
    ok: true,
    applied: true,
    warnings,
    ...(wasAlreadySet
      ? {
          note: "Previous staged result overwritten. The LAST call to apply_dashboard_modification wins.",
        }
      : {}),
  });
}

/**
 * `submit_dashboard_analysis` — stage analysis markdown result.
 *
 * The model calls this once at the end of an analyze task with the full
 * markdown analysis and a brief_summary (≤ 500 chars). Stages the result in
 * ctx.analyzeResult.
 */
export async function handleSubmitDashboardAnalysis(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: { analysis_markdown?: unknown; brief_summary?: unknown };
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return toolError(
      "INVALID_ARGS",
      "submit_dashboard_analysis: arguments must be a JSON object.",
      ctx,
    );
  }

  if (typeof args.analysis_markdown !== "string" || args.analysis_markdown.trim().length === 0) {
    return toolError(
      "INVALID_ARGS",
      "submit_dashboard_analysis: 'analysis_markdown' must be a non-empty string.",
      ctx,
    );
  }

  // Check size (~30 KB limit to avoid oversized payloads).
  if (Buffer.byteLength(args.analysis_markdown, "utf8") > MARKDOWN_MAX_BYTES) {
    return toolError(
      "INVALID_ARGS",
      `submit_dashboard_analysis: 'analysis_markdown' must be ≤ ${MARKDOWN_MAX_BYTES} bytes.`,
      ctx,
    );
  }

  if (typeof args.brief_summary !== "string" || args.brief_summary.trim().length === 0) {
    return toolError(
      "INVALID_ARGS",
      "submit_dashboard_analysis: 'brief_summary' must be a non-empty string.",
      ctx,
    );
  }

  if (args.brief_summary.length > BRIEF_SUMMARY_MAX) {
    return toolError(
      "INVALID_ARGS",
      `submit_dashboard_analysis: 'brief_summary' must be ≤ ${BRIEF_SUMMARY_MAX} characters.`,
      ctx,
    );
  }

  // Do NOT run sanitize() on the full analysis markdown — the secret-redaction
  // patterns could corrupt legitimate business content (IDs, tokens matching
  // the regex patterns). Store the analysis body as-is. Only the brief_summary
  // (displayed in the chat chip and logged) requires sanitization.
  const sanitizedSummary = sanitize(args.brief_summary.trim());

  ctx.analyzeResult = { markdown: args.analysis_markdown.trim(), summary: sanitizedSummary };

  return toolOk({ ok: true, applied: true });
}

/**
 * `submit_weekly_review` — validate review JSON + stage review result.
 *
 * The model calls this once at the end of a weekly review task with the full
 * review JSON object and a brief_summary. Validates against ReviewLlmOutputSchema,
 * then stages in ctx.reviewResult.
 */
export async function handleSubmitWeeklyReview(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: { review?: unknown; brief_summary?: unknown };
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return toolError(
      "INVALID_ARGS",
      "submit_weekly_review: arguments must be a JSON object.",
      ctx,
    );
  }

  if (typeof args.review !== "object" || args.review === null || Array.isArray(args.review)) {
    return toolError(
      "INVALID_ARGS",
      "submit_weekly_review: 'review' must be a JSON object.",
      ctx,
    );
  }

  if (typeof args.brief_summary !== "string" || args.brief_summary.trim().length === 0) {
    return toolError(
      "INVALID_ARGS",
      "submit_weekly_review: 'brief_summary' must be a non-empty string.",
      ctx,
    );
  }

  if (args.brief_summary.length > BRIEF_SUMMARY_MAX) {
    return toolError(
      "INVALID_ARGS",
      `submit_weekly_review: 'brief_summary' must be ≤ ${BRIEF_SUMMARY_MAX} characters.`,
      ctx,
    );
  }

  // Validate review against ReviewLlmOutputSchema.
  const parsed = ReviewLlmOutputSchema.safeParse(args.review);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return toolOk({
      ok: false,
      errors,
      hint: "Fix the validation errors above and call submit_weekly_review again with the corrected review JSON.",
    });
  }

  const sanitizedSummary = sanitize(args.brief_summary.trim());

  ctx.reviewResult = { content: parsed.data, summary: sanitizedSummary };

  return toolOk({ ok: true, applied: true });
}

export async function handleGetDashboardAllWidgetStatus(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: z.infer<typeof IdSchema>;
  try {
    args = IdSchema.parse(JSON.parse(rawArgs || "{}"));
  } catch {
    return toolError(
      "INVALID_ARGS",
      "Invalid arguments for get_dashboard_all_widget_status.",
      ctx,
    );
  }
  const row = await loadSpecRow(args.dashboard_id, ctx);
  if (!("spec" in row)) return row;
  const refs = extractDashboardSqlRefs(row.spec);
  const statuses: {
    widget_index: number;
    label: string;
    kind: string;
    ok: boolean;
    lint_issues: string[];
    cost?: number;
    error?: string;
  }[] = [];

  for (const r of refs) {
    const lint_issues = lintWidgetSql(r.sql);
    try {
      validateReadOnly(r.sql);
    } catch (e) {
      statuses.push({
        widget_index: r.widgetIndex,
        label: r.label,
        kind: r.kind,
        ok: false,
        lint_issues,
        error: e instanceof SqlValidationError ? e.message : "read-only violation",
      });
      continue;
    }
    try {
      const cost = await validateQueryCost(r.sql);
      statuses.push({
        widget_index: r.widgetIndex,
        label: r.label,
        kind: r.kind,
        ok: lint_issues.length === 0,
        lint_issues,
        cost,
      });
    } catch (e) {
      if (e instanceof QueryTooExpensiveError) {
        statuses.push({
          widget_index: r.widgetIndex,
          label: r.label,
          kind: r.kind,
          ok: false,
          lint_issues,
          cost: e.cost,
          error: "cost limit exceeded",
        });
      } else {
        statuses.push({
          widget_index: r.widgetIndex,
          label: r.label,
          kind: r.kind,
          ok: lint_issues.length === 0,
          lint_issues,
        });
      }
    }
  }

  return toolOk({ dashboard_id: args.dashboard_id, widgets: statuses });
}
