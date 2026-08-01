/**
 * Chart color palette using CSS variable references.
 * Resolves to the current theme accent/semantic colors at render time.
 */

/**
 * Legacy string[] palette for Tremor components that require an array.
 * New custom SVG widgets should use resolveChartColor() instead.
 */
export const CHART_COLORS_ARRAY: string[] = [
  "violet",
  "cyan",
  "teal",
  "amber",
  "rose",
  "indigo",
  "emerald",
  "sky",
  "fuchsia",
  "orange",
];

export const CHART_COLORS = {
  primary: "var(--accent)",
  secondary: "var(--accent-2)",
  amber: "#f59e0b",
  pink: "#ec4899",
  emerald: "#34d399",
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
} as const;

/**
 * Categorical palette for multi-series and multi-category charts.
 * First two slots use accent CSS variables (theme-adaptive);
 * remaining slots use fixed accessible colors.
 */
export const categoricalColors: string[] = [
  "var(--accent)",
  "var(--accent-2)",
  "#14b8a6", // teal-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#6366f1", // indigo-500
  "#34d399", // emerald-400
  "#38bdf8", // sky-400
];

/** Default color for a single-series chart. */
export const singleSeriesColor = "var(--accent)";

/**
 * Resolve a chart color for a given series index and optional semantic kind.
 * kind overrides the index-based categorical palette.
 */
export function resolveChartColor(index: number, kind?: "up" | "down" | "warn"): string {
  if (kind === "up") return CHART_COLORS.up;
  if (kind === "down") return CHART_COLORS.down;
  if (kind === "warn") return CHART_COLORS.warn;
  return categoricalColors[index % categoricalColors.length];
}
