/**
 * Static checks on widget SQL strings to catch common LLM mistakes against
 * PostgreSQL (date arithmetic, EXTRACT field names, COALESCE typing).
 * Does not execute SQL — complements EXPLAIN cost checks at query time.
 */
import type { DashboardSpec, Widget } from "@/lib/schema";

function pushSqlFromWidget(widget: Widget, out: string[]): void {
  if (widget.type === "kpi_row") {
    for (const item of widget.items) {
      out.push(item.sql);
      if (item.trend_sql) out.push(item.trend_sql);
      if (item.anomaly_sql) out.push(item.anomaly_sql);
    }
    return;
  }
  // Static widgets with no SQL
  if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
    return;
  }
  out.push(widget.sql);
  if ("comparison_sql" in widget && widget.comparison_sql) {
    out.push(widget.comparison_sql);
  }
}

/** All executable SQL strings embedded in a dashboard spec. */
export function collectWidgetSqlStrings(spec: DashboardSpec): string[] {
  const out: string[] = [];
  for (const w of spec.widgets) {
    pushSqlFromWidget(w, out);
  }
  return out;
}

/**
 * Returns human-readable issues for one SQL string (Spanish, for API errors).
 * Empty array means no known anti-patterns matched.
 */
export function lintWidgetSql(sql: string): string[] {
  const issues: string[] = [];

  // LLMs often write EXTRACT(days FROM ...). PostgreSQL uses singular fields
  // (e.g. day from interval). Worse: (date - date) is already an integer (days),
  // so EXTRACT(day FROM integer) fails — prefer (CURRENT_DATE - fecha).
  if (/EXTRACT\s*\(\s*days\s+/i.test(sql)) {
    issues.push(
      "Evita EXTRACT(days FROM …): en PostgreSQL no existe el campo 'days'. " +
        "Si restas dos fechas (date), el resultado ya son días (entero): usa (CURRENT_DATE - columna_fecha) o (fecha_fin::date - fecha_ini::date). " +
        "Si trabajas con interval, usa EXTRACT(day FROM intervalo) (singular 'day').",
    );
  }

  // COALESCE(date_expr, 'text literal') forces a common type and PG tries to cast the string to date.
  if (
    /COALESCE\s*\(\s*MAX\s*\([^)]*(?:\bfecha\b|_fecha|fecha_)[^)]*\)\s*,\s*['"]/i.test(
      sql,
    )
  ) {
    issues.push(
      "No uses COALESCE(MAX(fecha…), 'texto'): mezcla fecha y texto y PostgreSQL falla al castear. " +
        "Usa COALESCE(MAX(fecha…)::text, 'texto') o TO_CHAR(MAX(fecha…), 'YYYY-MM-DD').",
    );
  }

  return issues;
}

/** Lint every widget SQL in a spec; aggregates unique messages with widget paths. */
export function lintDashboardSpec(spec: DashboardSpec): string[] {
  const seenMessages = new Set<string>();
  const messages: string[] = [];
  const pushUniqueMessage = (message: string): void => {
    if (!seenMessages.has(message)) {
      seenMessages.add(message);
      messages.push(message);
    }
  };
  spec.widgets.forEach((widget, idx) => {
    const wid = widget.id ?? `index ${idx}`;
    if (widget.type === "kpi_row") {
      widget.items.forEach((item) => {
        for (const msg of lintWidgetSql(item.sql)) {
          pushUniqueMessage(`Widget ${wid} (KPI «${item.label}»): ${msg}`);
        }
        if (item.trend_sql) {
          for (const msg of lintWidgetSql(item.trend_sql)) {
            pushUniqueMessage(`Widget ${wid} (KPI «${item.label}», trend_sql): ${msg}`);
          }
        }
        if (item.anomaly_sql) {
          for (const msg of lintWidgetSql(item.anomaly_sql)) {
            pushUniqueMessage(`Widget ${wid} (KPI «${item.label}», anomaly_sql): ${msg}`);
          }
        }
      });
    } else if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
      // No SQL to lint
    } else {
      const title = "title" in widget ? (widget as { title: string }).title : wid;
      const widgetWithSql = widget as { sql: string; comparison_sql?: string };
      for (const msg of lintWidgetSql(widgetWithSql.sql)) {
        pushUniqueMessage(`Widget ${wid} («${title}»): ${msg}`);
      }
      if (widgetWithSql.comparison_sql) {
        for (const msg of lintWidgetSql(widgetWithSql.comparison_sql)) {
          pushUniqueMessage(`Widget ${wid} («${title}», comparison_sql): ${msg}`);
        }
      }
    }
  });
  return messages;
}
