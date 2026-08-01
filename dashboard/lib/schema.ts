/**
 * Dashboard JSON spec format: TypeScript types + Zod validation.
 *
 * The LLM generates a dashboard spec (JSON) that the frontend renders.
 * This module defines the canonical shape and validates untrusted input.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const KPI_FORMAT_ALIASES: Record<string, "currency" | "number" | "percent" | "decimal"> = {
  euro: "currency", euros: "currency", money: "currency", importe: "currency",
  cantidad: "number", integer: "number", count: "number", entero: "number",
  // "decimal" / "float" are routed to the new decimal format (up to 2 decimals).
  // This preserves precision for ratios such as Unidades por Ticket (1,69),
  // which "number" would round to 2.
  decimales: "decimal", float: "decimal",
  percentage: "percent", pct: "percent", porcentaje: "percent", ratio: "percent",
};

const KpiFormatSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const lv = v.toLowerCase().trim();
    return KPI_FORMAT_ALIASES[lv] ?? lv;
  },
  z.enum(["currency", "number", "percent", "decimal"]),
);

/** Optional string that must be non-empty when provided. */
const optStr = z.string().min(1).optional();

/**
 * Widget SQL must not contain positional params ($1, $2, …). DashboardRenderer
 * executes saved widget SQL after inlining the :curr_ and :comp_ date tokens
 * and __gf_<id>__ filter tokens — it never binds positional params, so a
 * leftover `$1` reaches Postgres unbound and fails with "there is no parameter
 * $1" (the review-semanal dashboards shipped this bug — see review-dashboard-seed).
 * Reject it at the spec boundary so it can never be saved or seeded again.
 */
const POSITIONAL_PARAM_MSG =
  "widget SQL must not use positional params ($1, $2, …); use :curr_from/:curr_to date tokens or __gf_<id>__ filter tokens";
const hasNoPositionalParam = (s: string) => !/\$\d/.test(s);
const widgetSql = z.string().min(1).refine(hasNoPositionalParam, { message: POSITIONAL_PARAM_MSG });
const optWidgetSql = widgetSql.optional();

const KpiItemSchema = z.object({
  label: z.string().min(1),
  sql: widgetSql,
  format: KpiFormatSchema,
  prefix: optStr,
  /** Optional SQL for trend/comparison period. Returns a single numeric value.
   *  The trend percentage is computed as (current - comparison) / abs(comparison) * 100. */
  trend_sql: optWidgetSql,
  /** Optional SQL for anomaly detection. Returns N rows of historical values for
   *  the same metric. The first row is the current period value; remaining rows
   *  are historical values in descending chronological order.
   *  The frontend computes a z-score client-side to detect unusual values. */
  anomaly_sql: optWidgetSql,
  /** Optional delta ratio (e.g. 0.083 = +8.3%). Overrides computed trend if provided. */
  delta: z.number().optional(),
  /** Optional absolute comparison value for display. */
  comparison: z.number().optional(),
  /** Optional 12–14 point sparkline data series. */
  spark: z.array(z.number()).optional(),
  /** Explicit anomaly flag (overrides computed anomaly when present). */
  anomaly: z.boolean().optional(),
  /** Warning flag — shows warn color instead of up/down. */
  warn: z.boolean().optional(),
  /** Inverted polarity: rising is bad (e.g. Devoluciones). */
  inverted: z.boolean().optional(),
}).strict();

const KpiRowWidgetSchema = z.object({
  id: optStr,
  type: z.literal("kpi_row"),
  items: z.array(KpiItemSchema).min(1),
}).strict();

const BarChartWidgetSchema = z.object({
  id: optStr,
  type: z.literal("bar_chart"),
  title: z.string().min(1),
  sql: widgetSql,
  x: z.string().min(1),
  y: z.string().min(1),
  comparison_sql: optWidgetSql,
}).strict();

const LineChartWidgetSchema = z.object({
  id: optStr,
  type: z.literal("line_chart"),
  title: z.string().min(1),
  sql: widgetSql,
  x: optStr,
  y: optStr,
  comparison_sql: optWidgetSql,
}).strict();

const AreaChartWidgetSchema = z.object({
  id: optStr,
  type: z.literal("area_chart"),
  title: z.string().min(1),
  sql: widgetSql,
  x: optStr,
  y: optStr,
  comparison_sql: optWidgetSql,
}).strict();

const DonutChartWidgetSchema = z.object({
  id: optStr,
  type: z.literal("donut_chart"),
  title: z.string().min(1),
  sql: widgetSql,
  x: optStr,
  y: optStr,
  comparison_sql: optWidgetSql,
}).strict();

const TableWidgetSchema = z.object({
  id: optStr,
  type: z.literal("table"),
  title: z.string().min(1),
  sql: widgetSql,
}).strict();

const NumberWidgetSchema = z.object({
  id: optStr,
  type: z.literal("number"),
  title: z.string().min(1),
  sql: widgetSql,
  format: KpiFormatSchema,
  prefix: optStr,
}).strict();

const InsightsItemSchema = z.object({
  kind: z.enum(["up", "down", "warn"]),
  title: z.string().min(1),
  body: z.string().min(1),
}).strict();

const InsightsStripWidgetSchema = z.object({
  id: optStr,
  type: z.literal("insights_strip"),
  items: z.array(InsightsItemSchema).min(1),
}).strict();

const RankedBarsItemSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
  maxValue: z.number().optional(),
  flag: z.enum(["top", "low"]).optional(),
  unit: optStr,
}).strict();

const RankedBarsWidgetSchema = z.object({
  id: optStr,
  type: z.literal("ranked_bars"),
  title: z.string().min(1),
  items: z.array(RankedBarsItemSchema).min(1),
}).strict();

export const WidgetSchema = z.discriminatedUnion("type", [
  KpiRowWidgetSchema,
  BarChartWidgetSchema,
  LineChartWidgetSchema,
  AreaChartWidgetSchema,
  DonutChartWidgetSchema,
  TableWidgetSchema,
  NumberWidgetSchema,
  InsightsStripWidgetSchema,
  RankedBarsWidgetSchema,
]);

/**
 * Optional tab section for multi-section dashboards.
 * When `sections` is present, the renderer groups widgets under tabs.
 * Backwards compatible: dashboards without `sections` use the flat layout.
 *
 * **Note**: `widget_ids` must reference `id` values set on individual widgets.
 * Widget `id` is optional in the widget schemas, but when `sections` is used,
 * every widget that should appear in a section must have an `id` set.
 * Widgets without `id`, or with `id` not listed in any section, will not render
 * in the tabbed layout. The LLM should always set `id` on all widgets when
 * generating a spec with sections.
 */
const DashboardSectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Ids of widgets that belong to this section. Must match widget `id` fields. */
  widget_ids: z.array(z.string().min(1)).min(1),
}).strict();

/**
 * A single glossary entry with a term and its plain-Spanish definition.
 * Follows the `.strict()` convention of all other schemas in this file.
 */
export const GlossaryItemSchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
}).strict();

export const TimeRangePresetSchema = z.enum([
  "today",
  "last_7_days",
  "last_30_days",
  "current_month",
  "last_month",
  "year_to_date",
]);

export const DefaultTimeRangeSchema = z.object({
  preset: TimeRangePresetSchema,
}).strict();

const GlobalFilterIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, "filter id must be a snake_case slug (a-z, digits, underscore)");

const GlobalFilterBaseSchema = z
  .object({
    id: GlobalFilterIdSchema,
    label: z.string().min(1),
    /**
     * SQL expression compared to the selected value(s), e.g. `v."tienda"` or
     * `fm."fami_grup_marc"`. Widget SQL must include the token `__gf_<id>__`
     * (this filter's id) where the predicate should apply.
     */
    bind_expr: z.string().min(1),
    /** How bound parameters are cast in PostgreSQL. */
    value_type: z.enum(["text", "numeric"]).default("text"),
    /**
     * Read-only SELECT that returns exactly two columns aliased as `value`
     * and `label` (order does not matter). May include date tokens and other
     * `__gf_*__` tokens for cascading option lists.
     */
    options_sql: z.string().min(1),
  })
  .strict();

export const SingleSelectGlobalFilterSchema = GlobalFilterBaseSchema.extend({
  type: z.literal("single_select"),
}).strict();

export const MultiSelectGlobalFilterSchema = GlobalFilterBaseSchema.extend({
  type: z.literal("multi_select"),
}).strict();

export const GlobalFilterSchema = z.discriminatedUnion("type", [
  SingleSelectGlobalFilterSchema,
  MultiSelectGlobalFilterSchema,
]);

export const DashboardSpecSchema = z
  .object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  /**
   * Optional breadcrumb path shown in the page header (e.g. ["Retail", "Ventas"]).
   * Falls back to ["Retail", "Ventas"] when not provided.
   */
  breadcrumbs: z.array(z.string().min(1)).optional(),
  widgets: z.array(WidgetSchema).min(1),
  /** Optional: group widgets into named tabs. Backwards compatible. */
  sections: z.array(DashboardSectionSchema).min(1).optional(),
  /**
   * Optional glossary of key business terms used in the dashboard.
   * When present, matching terms in widget titles and KPI labels will show
   * contextual tooltips. Backwards compatible: existing dashboards without
   * this field render unchanged.
   */
  glossary: z.array(GlossaryItemSchema).min(1).optional(),
  /**
   * Optional default time range preset applied when the dashboard is first opened.
   * Backwards compatible: existing dashboards without this field fall back to
   * last_30_days in the dashboard view.
   * Nullish (accepts null or undefined): LLMs and JSON APIs commonly emit null
   * for absent optional fields, so we treat null the same as undefined here.
   */
  default_time_range: DefaultTimeRangeSchema.nullish(),
  /**
   * Global business filters (tienda, familia, proveedor, etc.) shown in the
   * dashboard chrome. Widget SQL should reference them with `__gf_<id>__`
   * tokens; values are bound as PostgreSQL parameters at query time.
   */
  filters: z.array(GlobalFilterSchema).optional(),
})
  .strict()
  .superRefine((spec, ctx) => {
    const ids = spec.filters?.map((f) => f.id) ?? [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate global filter id: ${id}`,
          path: ["filters"],
        });
        return;
      }
      seen.add(id);
    }
  });

// ---------------------------------------------------------------------------
// TypeScript types (inferred from Zod — single source of truth)
// ---------------------------------------------------------------------------

export type KpiFormat = z.infer<typeof KpiFormatSchema>;
export type KpiItem = z.infer<typeof KpiItemSchema>;
export type InsightsItem = z.infer<typeof InsightsItemSchema>;
export type InsightsStripWidget = z.infer<typeof InsightsStripWidgetSchema>;
export type RankedBarsItem = z.infer<typeof RankedBarsItemSchema>;
export type RankedBarsWidget = z.infer<typeof RankedBarsWidgetSchema>;
export type KpiRowWidget = z.infer<typeof KpiRowWidgetSchema>;
export type BarChartWidget = z.infer<typeof BarChartWidgetSchema>;
export type LineChartWidget = z.infer<typeof LineChartWidgetSchema>;
export type AreaChartWidget = z.infer<typeof AreaChartWidgetSchema>;
export type DonutChartWidget = z.infer<typeof DonutChartWidgetSchema>;
export type TableWidget = z.infer<typeof TableWidgetSchema>;
export type NumberWidget = z.infer<typeof NumberWidgetSchema>;
export type Widget = z.infer<typeof WidgetSchema>;
export type DashboardSection = z.infer<typeof DashboardSectionSchema>;
export type GlossaryItem = z.infer<typeof GlossaryItemSchema>;
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;
export type TimeRangePreset = z.infer<typeof TimeRangePresetSchema>;
export type DefaultTimeRange = z.infer<typeof DefaultTimeRangeSchema>;
export type GlobalFilter = z.infer<typeof GlobalFilterSchema>;
export type SingleSelectGlobalFilter = z.infer<typeof SingleSelectGlobalFilterSchema>;
export type MultiSelectGlobalFilter = z.infer<typeof MultiSelectGlobalFilterSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate and parse an unknown JSON value into a DashboardSpec.
 * Throws a ZodError with detailed messages if validation fails.
 */
export function validateSpec(json: unknown): DashboardSpec {
  return DashboardSpecSchema.parse(json);
}
