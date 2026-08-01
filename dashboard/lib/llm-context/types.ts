/**
 * FlowVars — per-flow inputs for buildSystemPrompt() / assembleRequest().
 *
 * All fields are optional; each flow only uses the subset relevant to it.
 */

export interface FlowVars {
  // ── modify ─────────────────────────────────────────────────────────────────
  /** Serialised JSON of the current dashboard spec (modify flow). */
  currentSpec?: string;
  /** When true the modify prompt includes publish-tool workflow instructions. */
  agenticMode?: boolean;

  // ── analyze ────────────────────────────────────────────────────────────────
  /** Formatted widget data string from serializeWidgetData(). */
  serializedData?: string;
  /** Optional preset action that drives specific analysis instructions. */
  action?: string;
  /** When set the model may reference dashboard tools with this id. */
  dashboardId?: number;

  // ── suggest ────────────────────────────────────────────────────────────────
  /** User role (e.g. "Director de ventas"). */
  role?: string;
  /** Existing dashboards to avoid overlap in suggestions. */
  existingDashboards?: Array<{
    title: string;
    description: string;
    widgetTitles?: string[];
  }>;

  // ── weekly review ──────────────────────────────────────────────────────────
  /** Formatted SQL query results for the weekly review. */
  queryResults?: string;
  /** Spanish description of the reviewed week (e.g. "Semana 2026-01-01 a …"). */
  reviewedWeekDescription?: string;
  /** Controls the review generation angle. */
  generationMode?: "initial" | "refresh_data" | "alternate_angle";
}
