/**
 * Widget data serializer for the AI analyst chat.
 *
 * Converts live widget data (from DashboardRenderer) into a compact
 * markdown-formatted string suitable for inclusion in an LLM prompt.
 * Truncates large datasets to stay within token limits.
 */

import type { DashboardSpec, Widget } from "./schema";
import type { WidgetData } from "@/components/widgets/types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_CHART_ROWS = 100;
export const MAX_TABLE_ROWS = 50;

// ─── WidgetState shape (mirrors DashboardRenderer export) ────────────────────

export interface WidgetStateData {
  data: WidgetData | null | (WidgetData | null)[];
  trendData?: (WidgetData | null)[];
  loading: boolean;
  error: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a value for display — numbers get locale formatting, everything else is string. */
function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "number") {
    return val.toLocaleString("es-ES");
  }
  return String(val);
}

/** Escape a string for use in a markdown table cell. */
function escapeMdCell(val: string): string {
  // Replace literal pipe characters to avoid breaking markdown table structure
  // Replace newlines to keep each row on a single line
  return val.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Extract a single scalar value from a WidgetData result (first row, first column). */
function extractScalar(data: WidgetData | null): string {
  if (!data || data.rows.length === 0) return "[sin datos]";
  const val = data.rows[0]?.[0];
  return formatValue(val);
}

/** Render a WidgetData as a markdown table, truncating to maxRows. */
function renderMarkdownTable(data: WidgetData, maxRows: number): string {
  if (!data || data.rows.length === 0) return "[sin datos]";

  const cols = data.columns;
  const headerRow = `| ${cols.map(escapeMdCell).join(" | ")} |`;
  const separatorRow = `| ${cols.map(() => "---").join(" | ")} |`;

  const rowsToShow = data.rows.slice(0, maxRows);
  const dataRows = rowsToShow.map(
    (row) => `| ${row.map((v) => escapeMdCell(formatValue(v))).join(" | ")} |`
  );

  const lines = [headerRow, separatorRow, ...dataRows];

  if (data.rows.length > maxRows) {
    lines.push(`... (${data.rows.length - maxRows} filas más)`);
  }

  return lines.join("\n");
}

/** Find a column index by name (case-insensitive). Returns -1 if not found. */
function findColumnIndex(columns: string[], name: string | undefined): number {
  if (!name) return -1;
  const lower = name.toLowerCase();
  return columns.findIndex((c) => c.toLowerCase() === lower);
}

/** Serialize a single widget into a markdown section string. */
function serializeWidget(
  widget: Widget,
  state: WidgetStateData | undefined
): string {
  // Helper: unavailable data message
  const unavailable = "[datos no disponibles]";

  if (widget.type === "kpi_row") {
    const lines: string[] = [`### KPIs`];
    const dataArr = Array.isArray(state?.data)
      ? (state!.data as (WidgetData | null)[])
      : null;
    const trendArr = state?.trendData;

    for (let i = 0; i < widget.items.length; i++) {
      const item = widget.items[i];
      if (!state || state.loading) {
        lines.push(`- ${item.label}: ${unavailable}`);
        continue;
      }
      const itemData = dataArr?.[i] ?? null;
      const value = extractScalar(itemData);

      let line = `- ${item.label}: ${value}`;

      // Include trend/previous period if available
      const trendData = trendArr?.[i];
      if (trendData) {
        const prevValue = extractScalar(trendData);
        line += ` (período anterior: ${prevValue})`;
      }

      lines.push(line);
    }

    return lines.join("\n");
  }

  if (widget.type === "number") {
    const title = widget.title;
    if (!state || state.loading) {
      return `### ${title}\n${unavailable}`;
    }
    const value = extractScalar(state.data as WidgetData | null);
    return `### ${title}\n- Valor: ${value}`;
  }

  if (
    widget.type === "bar_chart" ||
    widget.type === "line_chart" ||
    widget.type === "area_chart"
  ) {
    const title = widget.title;
    if (!state || state.loading) {
      return `### ${title}\n${unavailable}`;
    }
    const data = state.data as WidgetData | null;
    if (!data || data.rows.length === 0) {
      return `### ${title}\n[sin datos]`;
    }

    // Find x and y columns
    const xIdx = findColumnIndex(data.columns, widget.x ?? "x");
    const yIdx = findColumnIndex(data.columns, widget.y ?? "y");

    // Build a focused two-column table if we found the columns, otherwise use all
    let tableData: WidgetData;
    if (xIdx >= 0 && yIdx >= 0) {
      tableData = {
        columns: [data.columns[xIdx], data.columns[yIdx]],
        rows: data.rows.map((r) => [r[xIdx], r[yIdx]]),
      };
    } else {
      tableData = data;
    }

    const table = renderMarkdownTable(tableData, MAX_CHART_ROWS);
    return `### ${title}\n${table}`;
  }

  if (widget.type === "donut_chart") {
    const title = widget.title;
    if (!state || state.loading) {
      return `### ${title}\n${unavailable}`;
    }
    const data = state.data as WidgetData | null;
    if (!data || data.rows.length === 0) {
      return `### ${title}\n[sin datos]`;
    }

    // Try to find category/value columns
    const catIdx = findColumnIndex(data.columns, "category");
    const valIdx = findColumnIndex(data.columns, "value");

    let tableData: WidgetData;
    if (catIdx >= 0 && valIdx >= 0) {
      tableData = {
        columns: [data.columns[catIdx], data.columns[valIdx]],
        rows: data.rows.map((r) => [r[catIdx], r[valIdx]]),
      };
    } else {
      tableData = data;
    }

    const table = renderMarkdownTable(tableData, MAX_TABLE_ROWS);
    return `### ${title}\n${table}`;
  }

  if (widget.type === "table") {
    const title = widget.title;
    if (!state || state.loading) {
      return `### ${title}\n${unavailable}`;
    }
    const data = state.data as WidgetData | null;
    if (!data || data.rows.length === 0) {
      return `### ${title}\n[sin datos]`;
    }

    const table = renderMarkdownTable(data, MAX_TABLE_ROWS);
    return `### ${title}\n${table}`;
  }

  return "";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Serialize all widget data into a compact markdown string for LLM context.
 *
 * @param spec         — Dashboard specification (widgets, titles)
 * @param widgetDataMap — Map from widget index to WidgetStateData
 * @returns Formatted string with one section per widget
 */
export function serializeWidgetData(
  spec: DashboardSpec,
  widgetDataMap: Map<number, WidgetStateData>
): string {
  const sections: string[] = [
    `## Dashboard: ${spec.title}`,
  ];

  if (spec.description) {
    sections.push(spec.description);
  }

  sections.push("");

  for (let i = 0; i < spec.widgets.length; i++) {
    const widget = spec.widgets[i];
    const state = widgetDataMap.get(i);
    const section = serializeWidget(widget, state);
    if (section) {
      sections.push(section);
      sections.push("");
    }
  }

  return sections.join("\n").trim();
}
