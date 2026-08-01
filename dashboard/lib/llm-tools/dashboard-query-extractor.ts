/**
 * Extract executable SQL strings from a dashboard spec for agentic tools.
 */

import type { DashboardSpec, Widget } from "@/lib/schema";

export type DashboardSqlKind =
  | "chart_sql"
  | "comparison_sql"
  | "kpi_sql"
  | "kpi_trend"
  | "kpi_anomaly";

export interface DashboardSqlRef {
  widgetIndex: number;
  widgetId: string | undefined;
  /** Human label for tool responses */
  label: string;
  kind: DashboardSqlKind;
  kpiItemIndex?: number;
  sql: string;
}

function pushSqlFromWidget(
  widget: Widget,
  widgetIndex: number,
  out: DashboardSqlRef[],
): void {
  const wid = widget.id;
  if (widget.type === "kpi_row") {
    widget.items.forEach((item, kpiItemIndex) => {
      out.push({
        widgetIndex,
        widgetId: wid,
        label: item.label,
        kind: "kpi_sql",
        kpiItemIndex,
        sql: item.sql,
      });
      if (item.trend_sql) {
        out.push({
          widgetIndex,
          widgetId: wid,
          label: `${item.label} (trend_sql)`,
          kind: "kpi_trend",
          kpiItemIndex,
          sql: item.trend_sql,
        });
      }
      if (item.anomaly_sql) {
        out.push({
          widgetIndex,
          widgetId: wid,
          label: `${item.label} (anomaly_sql)`,
          kind: "kpi_anomaly",
          kpiItemIndex,
          sql: item.anomaly_sql,
        });
      }
    });
    return;
  }
  // Static widgets with no SQL
  if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
    return;
  }
  const title = "title" in widget ? (widget as { title: string }).title : "?";
  const widgetWithSql = widget as { sql: string; comparison_sql?: string };
  out.push({
    widgetIndex,
    widgetId: wid,
    label: title,
    kind: "chart_sql",
    sql: widgetWithSql.sql,
  });
  if (widgetWithSql.comparison_sql) {
    out.push({
      widgetIndex,
      widgetId: wid,
      label: `${title} (comparison_sql)`,
      kind: "comparison_sql",
      sql: widgetWithSql.comparison_sql,
    });
  }
}

export function extractDashboardSqlRefs(spec: DashboardSpec): DashboardSqlRef[] {
  const out: DashboardSqlRef[] = [];
  spec.widgets.forEach((w, i) => pushSqlFromWidget(w, i, out));
  return out;
}

export function findSqlRefByIndices(
  refs: DashboardSqlRef[],
  widgetIndex: number,
  kpiItemIndex?: number,
): DashboardSqlRef | undefined {
  return refs.find((r) => {
    if (r.widgetIndex !== widgetIndex) return false;
    if (kpiItemIndex === undefined) {
      return r.kind === "chart_sql" || r.kind === "comparison_sql";
    }
    return r.kpiItemIndex === kpiItemIndex && r.kind === "kpi_sql";
  });
}
