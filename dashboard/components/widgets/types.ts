/**
 * Shared types for widget components.
 */

/** Context passed when the user clicks a chart point or table row to explore further. */
export interface DrillDownContext {
  /** The clicked data point label (e.g. store name). */
  label: string;
  /** Display string for the clicked value (e.g. formatted number). */
  value: string;
  /** Parent widget title. */
  widgetTitle: string;
  /** Widget kind for prompt shaping upstream. */
  widgetType: "bar_chart" | "line_chart" | "area_chart" | "donut_chart" | "table" | "ranked_bars";
}

export type OnDataPointClick = (ctx: DrillDownContext) => void;

/** Query result format returned by the /api/query endpoint. */
export interface WidgetData {
  columns: string[];
  rows: unknown[][];
}

/** Standard empty-state message. */
export const EMPTY_MESSAGE = "Sin datos";

/**
 * Resolve column indices for x/y axes from a WidgetData.
 * Returns null if the required columns cannot be found or data has
 * fewer than 2 columns when falling back to defaults.
 */
export function resolveXY(
  data: WidgetData,
  xHint: string | undefined,
  yHint: string | undefined,
): { xIdx: number; yIdx: number; xCol: string; yCol: string } | null {
  const xCol = xHint ?? data.columns[0];
  const yCol = yHint ?? data.columns[1];
  if (!xCol || !yCol) return null;

  const xIdx = data.columns.indexOf(xCol);
  const yIdx = data.columns.indexOf(yCol);

  // If explicitly named columns are not found, treat as misconfigured
  if (xIdx < 0 || yIdx < 0) return null;

  return { xIdx, yIdx, xCol, yCol };
}

/**
 * Safely coerce a value to number, returning null for nullish/non-finite.
 * This prevents null/undefined/"" from silently becoming 0 in charts.
 */
export function safeNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
