/**
 * Handler for the `start_dashboard_generation` tool.
 *
 * Generates a new dashboard from a natural-language prompt, saves it to the
 * database, and (if a conversation is active) migrates the conversation to
 * dashboard context (mode='modify', context_kind/ref/url) so follow-up turns
 * run on the modify path with the apply_dashboard_modification tool available.
 *
 * Returns { dashboard_id, redirect_url, summary } on success.
 */

import { generateDashboard } from "@/lib/llm";
import { validateSpec } from "@/lib/schema";
import { lintDashboardSpec } from "@/lib/sql-heuristics";
import { ZodError } from "zod";
import { sql } from "@/lib/db-write";
import { migrateConversationToDashboard } from "@/lib/conversations";
import { toolOk, toolError, type ToolResponseBody } from "@/lib/llm-tools/tool-payload";
import type { LlmAgenticContext } from "@/lib/llm-tools/types";

interface StartDashboardGenerationArgs {
  prompt: string;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

export async function handleStartDashboardGeneration(
  rawArgs: string,
  ctx: LlmAgenticContext,
): Promise<ToolResponseBody> {
  let args: StartDashboardGenerationArgs;
  try {
    args = JSON.parse(rawArgs) as StartDashboardGenerationArgs;
  } catch {
    return toolError("INVALID_ARGS", "Invalid JSON arguments.", ctx);
  }

  if (!args.prompt || typeof args.prompt !== "string" || !args.prompt.trim()) {
    return toolError("INVALID_ARGS", "The 'prompt' field is required and must be a non-empty string.", ctx);
  }

  // Generate the dashboard spec via the LLM
  let rawResponse: string;
  try {
    rawResponse = await generateDashboard(args.prompt.trim(), {
      requestId: ctx.requestId,
      endpoint: "start_dashboard_generation",
      llmProvider: ctx.llmProvider,
      llmDriver: ctx.llmDriver,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Dashboard generation failed.";
    console.error(`[${ctx.requestId}] start_dashboard_generation: generateDashboard failed:`, err);
    return toolError("GENERATE_FAILED", msg, ctx);
  }

  // Parse and validate the spec
  const jsonStr = extractJson(rawResponse);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return toolError("INVALID_SPEC", "The LLM returned an invalid JSON spec.", ctx);
  }

  let spec;
  try {
    spec = validateSpec(parsed);
  } catch (err) {
    const details =
      err instanceof ZodError
        ? err.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Spec validation failed";
    return toolError("INVALID_SPEC", `Dashboard spec is invalid: ${details}`, ctx);
  }

  const sqlLint = lintDashboardSpec(spec);
  if (sqlLint.length > 0) {
    return toolError(
      "SQL_LINT",
      `Generated dashboard contains invalid SQL patterns: ${sqlLint.join(" | ")}`,
      ctx,
    );
  }

  // Persist to the database
  const title = spec.title;
  const description = spec.description ?? null;
  let dashboardId: number;
  try {
    const rows = await sql<{ id: number }>(
      `INSERT INTO dashboards (name, description, spec)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [title, description, JSON.stringify(spec)],
    );
    const row = rows[0];
    if (!row?.id) throw new Error("INSERT dashboards did not return an id");
    dashboardId = row.id;
  } catch (err) {
    console.error(`[${ctx.requestId}] start_dashboard_generation: DB insert failed:`, err);
    return toolError("DB_ERROR", "Failed to save the dashboard.", ctx);
  }

  const redirectUrl = ctx.conversationId
    ? `/dashboard/${dashboardId}?tab=modify&continue=${encodeURIComponent(ctx.conversationId)}`
    : `/dashboard/${dashboardId}?tab=modify`;

  // Migrate the conversation to dashboard context (mode='modify', context_kind,
  // context_ref AND context_url — same semantics as the D-032 handoff endpoint).
  // Without the mode change, follow-up turns would still dispatch as free chat,
  // which has no apply_dashboard_modification tool.
  // Best-effort: if it fails the dashboard was still created successfully.
  if (ctx.conversationId) {
    try {
      await migrateConversationToDashboard(ctx.conversationId, String(dashboardId));
    } catch (err) {
      console.warn(`[${ctx.requestId}] start_dashboard_generation: migrateConversationToDashboard failed:`, err);
    }
  }

  return toolOk({
    dashboard_id: String(dashboardId),
    redirect_url: redirectUrl,
    summary: `Panel "${title}" creado con ${spec.widgets.length} widget(s). Visita ${redirectUrl} para revisarlo y modificarlo.`,
  });
}
