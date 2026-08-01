"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import type { DashboardSpec, Widget, GlossaryItem } from "@/lib/schema";
import type { OnDataPointClick, WidgetData } from "./widgets/types";
import type { DateRange, ComparisonRange } from "./DateRangePicker";
import { substituteDateParams } from "@/lib/date-params";
import { compileGlobalFilterSql } from "@/lib/sql-filters";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { ErrorDisplay } from "./ErrorDisplay";
import {
  KpiRow,
  BarChartWidget,
  LineChartWidget,
  AreaChartWidget,
  DonutChartWidget,
  TableWidget,
  NumberWidget,
} from "./widgets";
import { InsightsStrip } from "./widgets/InsightsStrip";
import { RankedBarsWidget } from "./widgets/RankedBarsWidget";
import type { GlobalFilterValues } from "@/lib/sql-filters";
import { useKpiStyle } from "@/components/TweaksPanel";
import type { KpiStyle } from "@/components/widgets/KpiRow";

const EMPTY_GLOBAL_FILTERS: GlobalFilterValues = Object.freeze({});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DashboardRendererProps {
  /** The dashboard specification to render. Callers may pass a new object
   *  on each render -- the component uses a stable JSON key internally to
   *  avoid unnecessary refetches. */
  spec: DashboardSpec;
  /** When this value changes, all widget queries are re-executed.
   *  Increment it to trigger a manual or auto-refresh. */
  refreshKey?: number;
  /**
   * Optional date range selected in the dashboard toolbar. This prop is
   * accepted for forwards compatibility — the page component increments
   * `refreshKey` when the date range changes, which re-runs all queries.
   *
   * NOTE: The date range does NOT automatically inject WHERE clauses into
   * widget SQL. For date filtering to work, the widget's SQL queries must
   * either already contain appropriate date expressions or be regenerated
   * by the LLM with the selected range in mind. Use `injectDateRange()`
   * from `DateRangePicker` for simple row-level queries only.
   */
  dateRange?: DateRange;
  /**
   * Optional comparison date range. When set alongside a widget that has
   * `comparison_sql`, the renderer fetches comparison data by substituting
   * :comp_from/:comp_to tokens in the comparison SQL. The fetched data is
   * passed to chart widgets so they can render two series side by side.
   */
  comparisonRange?: ComparisonRange;
  /** Active global dashboard filter values (bound as SQL parameters). */
  globalFilterValues?: GlobalFilterValues;
  /**
   * Optional callback fired whenever widget states change (e.g. a widget
   * finishes loading).  Use this to expose live widget data to the parent
   * (e.g. for the AI analyst chat).
   *
   * Only called after at least one widget has finished loading to avoid
   * unnecessary calls during the initial empty state.
   */
  onWidgetDataChange?: (data: Map<number, WidgetState>) => void;
  /** Drill-down: invoked when the user clicks a chart point or table row (widgets pass context up). */
  onDataPointClick?: OnDataPointClick;
}

// ---------------------------------------------------------------------------
// Per-widget state
// ---------------------------------------------------------------------------

export interface WidgetState {
  /** For most widgets: single WidgetData. For kpi_row: array of WidgetData|null. */
  data: WidgetData | null | (WidgetData | null)[];
  /** Trend data for kpi_row items (indexed per item, only when trend_sql is set). */
  trendData?: (WidgetData | null)[];
  /** Anomaly data for kpi_row items (indexed per item, only when anomaly_sql is set). */
  anomalyData?: (WidgetData | null)[];
  /** Comparison period data for chart widgets (bar/line/area/donut) when comparison_sql is set and a comparison range is active. */
  comparisonData?: WidgetData | null;
  loading: boolean;
  /** Structured error from the API (preferred) or plain string fallback. */
  error: ApiErrorResponse | string | null;
}

// ---------------------------------------------------------------------------
// Comp-token detection
// ---------------------------------------------------------------------------

/** Returns true if sql contains any :comp_* date tokens. */
function hasCompTokens(sql: string): boolean {
  return (
    sql.includes(":comp_from") ||
    sql.includes(":comp_to") ||
    sql.includes(":comp_mes_from") ||
    sql.includes(":comp_mes_to")
  );
}

/** Collects the MAIN SQL strings from a widget (item.sql for kpi_row, widget.sql otherwise).
 *  trend_sql and anomaly_sql are deliberately excluded: the fetch pipeline skips them
 *  gracefully when comparisonRange is unset, so they must not gate the main widget fetch. */
function collectWidgetSqls(widget: Widget): string[] {
  if (widget.type === "kpi_row") {
    return widget.items
      .map((item) => item.sql)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  // insights_strip and ranked_bars have no SQL
  if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
    return [];
  }
  return [widget.sql];
}

/** User-facing error shown when a widget requires a comparison range that isn't set. */
const COMP_MISSING_ERROR = "Este panel requiere seleccionar un período de comparación";

// ---------------------------------------------------------------------------
// Data fetching helper
// ---------------------------------------------------------------------------

async function fetchWidgetData(
  sql: string,
  signal?: AbortSignal,
  params?: unknown[],
): Promise<WidgetData> {
  const body: { sql: string; params?: unknown[] } = { sql };
  if (params && params.length > 0) body.params = params;
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let errorPayload: ApiErrorResponse | null = null;
    let fallbackMessage = "Error al obtener datos del widget";
    try {
      const body = await res.json();
      if (body && typeof body === "object") {
        // Use the shared type guard for a precise check (all required fields)
        if (isApiErrorResponse(body)) {
          errorPayload = body;
        } else if ("error" in body && typeof body.error === "string") {
          // Non-structured error with a message
          fallbackMessage = body.error as string;
        }
      }
    } catch {
      // JSON parse failed (e.g. HTML error page from a 502 gateway)
      // Include the HTTP status to help with debugging
      fallbackMessage = `Error al obtener datos del widget (HTTP ${res.status})`;
    }
    if (errorPayload) {
      const err = new Error(errorPayload.error) as Error & { structured?: ApiErrorResponse };
      err.structured = errorPayload;
      throw err;
    }
    throw new Error(fallbackMessage);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DashboardRenderer({
  spec,
  refreshKey = 0,
  dateRange,
  comparisonRange,
  globalFilterValues,
  onWidgetDataChange,
  onDataPointClick,
}: DashboardRendererProps) {
  const kpiStyle = useKpiStyle();
  const [widgetStates, setWidgetStates] = useState<Map<number, WidgetState>>(
    new Map()
  );
  // Separate abort controllers: fetchAll (global reload) vs retryWidget (per-widget)
  // retryAbortMap is keyed by widget index so retrying widget A never cancels widget B.
  const fetchAllAbortRef = useRef<AbortController | null>(null);
  const retryAbortMap = useRef<Map<number, AbortController>>(new Map());
  // Stable key derived from spec content (not referential identity) so
  // parent re-renders that recreate the same spec object don't trigger refetches.
  // Intentionally exclude globalFilterValues: parents should bump `refreshKey`
  // when filter values change (avoids double-stringifying huge specs each render).
  const specKey = useMemo(() => JSON.stringify(spec), [spec]);
  // Track the specKey that widgetStates corresponds to, so we show skeletons
  // (not stale data) when spec changes before the effect runs.
  const renderedKeyRef = useRef<string>(specKey);
  const specChanged = renderedKeyRef.current !== specKey;

  // Substitute date tokens in a main widget SQL string.
  // Substitutes :curr_* always when dateRange is set; also substitutes :comp_*
  // when comparisonRange is set (so main SQL that references comp tokens works).
  // Returns sql unchanged when dateRange is not set (backwards compatible).
  const buildMainSql = useCallback(
    (sql: string): string => {
      if (!dateRange) return sql;
      return substituteDateParams(sql, {
        curr: { from: dateRange.from, to: dateRange.to },
        ...(comparisonRange ? { comp: { from: comparisonRange.from, to: comparisonRange.to } } : {}),
      });
    },
    [dateRange, comparisonRange],
  );

  // Build substituted comparison SQL for a chart widget, or null if not applicable.
  const buildComparisonSql = useCallback(
    (comparisonSql: string | undefined): string | null => {
      if (!comparisonSql || !comparisonRange) return null;
      const ranges = {
        curr: dateRange ? { from: dateRange.from, to: dateRange.to } : { from: new Date(), to: new Date() },
        comp: { from: comparisonRange.from, to: comparisonRange.to },
      };
      return substituteDateParams(comparisonSql, ranges);
    },
    [dateRange, comparisonRange],
  );

  // Use a ref so parent re-renders with inline `globalFilterValues={{...}}` objects
  // do not recreate fetch pipelines every frame (would re-trigger effects / OOM).
  const globalFilterValuesRef = useRef<GlobalFilterValues>(EMPTY_GLOBAL_FILTERS);
  globalFilterValuesRef.current = globalFilterValues ?? EMPTY_GLOBAL_FILTERS;

  // Key off `specKey` (serialized spec) so a parent that recreates `spec.filters`
  // with identical content does not recreate `bindGlobalFilters` / `fetchAll` / refetch.
  const bindGlobalFilters = useCallback(
    (sqlAfterDates: string): { sql: string; params: unknown[] } =>
      compileGlobalFilterSql(
        sqlAfterDates,
        spec.filters,
        globalFilterValuesRef.current,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally `specKey` only; `spec` is read from the same render as this key
    [specKey],
  );

  // Fetch all widgets for a given spec
  const fetchAll = useCallback(async (widgets: Widget[]) => {
    // Abort any in-flight global load from a previous spec
    fetchAllAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAllAbortRef.current = controller;
    const { signal } = controller;

    // Initialize all widgets to loading state
    const initial = new Map<number, WidgetState>();
    widgets.forEach((_, idx) => {
      initial.set(idx, { data: null, loading: true, error: null });
    });
    setWidgetStates(new Map(initial));

    // Fetch data for each widget in parallel
    const promises = widgets.map(async (widget, idx) => {
      try {
        // Static widgets with no SQL — immediately mark as done
        if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
          if (!signal.aborted) {
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data: null, loading: false, error: null });
              return next;
            });
          }
          return;
        }
        if (widget.type === "kpi_row") {
          // Pre-flight: guard kpi_row items that use comp tokens without a comparison range.
          if (collectWidgetSqls(widget).some(hasCompTokens) && !comparisonRange) {
            if (!signal.aborted) {
              setWidgetStates((prev) => {
                const next = new Map(prev);
                next.set(idx, { data: null, loading: false, error: COMP_MISSING_ERROR });
                return next;
              });
            }
            return;
          }
          // Kick off main KPI values, trend values, and anomaly data concurrently
          const [settled, trendResults, anomalyResults] = await Promise.all([
            // Fetch each KPI item in parallel; capture per-item errors
            Promise.all(
              widget.items.map(async (item) => {
                try {
                  const q = bindGlobalFilters(buildMainSql(item.sql));
                  const data = await fetchWidgetData(q.sql, signal, q.params);
                  return { data, error: null as ApiErrorResponse | string | null };
                } catch (err) {
                  const structured =
                    err instanceof Error && "structured" in err
                      ? (err as Error & { structured?: ApiErrorResponse }).structured
                      : undefined;
                  const errorValue: ApiErrorResponse | string = structured
                    ? structured
                    : err instanceof Error
                    ? err.message
                    : "Error al ejecutar la consulta";
                  return { data: null, error: errorValue };
                }
              })
            ),
            // Fetch trend values (for items that have trend_sql).
            // trend_sql contains :comp_from/:comp_to tokens — only fetch when comparisonRange is active,
            // otherwise skip to avoid sending literal colon-tokens to PostgreSQL.
            Promise.all(
              widget.items.map(async (item): Promise<WidgetData | null> => {
                if (!item.trend_sql || !comparisonRange) return null;
                const trendSql = buildComparisonSql(item.trend_sql);
                if (!trendSql) return null;
                try {
                  const q = bindGlobalFilters(trendSql);
                  return await fetchWidgetData(q.sql, signal, q.params);
                } catch {
                  return null;
                }
              })
            ),
            // Fetch anomaly data (for items that have anomaly_sql)
            Promise.all(
              widget.items.map(async (item): Promise<WidgetData | null> => {
                if (!item.anomaly_sql) return null;
                try {
                  const q = bindGlobalFilters(buildMainSql(item.anomaly_sql));
                  return await fetchWidgetData(q.sql, signal, q.params);
                } catch {
                  return null;
                }
              })
            ),
          ]);

          if (!signal.aborted) {
            const itemData = settled.map((s) => s.data);
            const firstError = settled.find((s) => s.error !== null)?.error ?? null;
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data: itemData, trendData: trendResults, anomalyData: anomalyResults, loading: false, error: firstError });
              return next;
            });
          }
        } else {
          // Pre-flight: if main SQL uses comp tokens but no comparisonRange is set,
          // show a friendly error instead of letting PostgreSQL reject literal `:comp_*`.
          if (collectWidgetSqls(widget).some(hasCompTokens) && !comparisonRange) {
            if (!signal.aborted) {
              setWidgetStates((prev) => {
                const next = new Map(prev);
                next.set(idx, { data: null, loading: false, error: COMP_MISSING_ERROR });
                return next;
              });
            }
            return;
          }
          const compSql = "comparison_sql" in widget ? buildComparisonSql(widget.comparison_sql) : null;
          const mainQ = bindGlobalFilters(buildMainSql(widget.sql));
          const compQ = compSql ? bindGlobalFilters(compSql) : null;
          const [data, comparisonData] = await Promise.all([
            fetchWidgetData(mainQ.sql, signal, mainQ.params),
            compQ
              ? fetchWidgetData(compQ.sql, signal, compQ.params).catch(() => null)
              : Promise.resolve(null),
          ]);
          if (!signal.aborted) {
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data, comparisonData, loading: false, error: null });
              return next;
            });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        const structured =
          err instanceof Error && "structured" in err
            ? (err as Error & { structured?: ApiErrorResponse }).structured
            : undefined;
        const errorValue: ApiErrorResponse | string = structured
          ? structured
          : err instanceof Error
          ? err.message
          : "Error al ejecutar la consulta";
        setWidgetStates((prev) => {
          const next = new Map(prev);
          next.set(idx, { data: null, loading: false, error: errorValue });
          return next;
        });
      }
    });

    await Promise.all(promises);
  }, [buildMainSql, buildComparisonSql, comparisonRange, bindGlobalFilters]);

  // Retry a single widget by re-fetching it.
  // Uses a per-widget AbortController so retrying one widget never cancels another.
  const retryWidget = useCallback(
    async (widget: Widget, idx: number) => {
      // Abort any previous retry for this specific widget only
      retryAbortMap.current.get(idx)?.abort();
      const controller = new AbortController();
      retryAbortMap.current.set(idx, controller);
      const { signal } = controller;

      setWidgetStates((prev) => {
        const next = new Map(prev);
        next.set(idx, { data: null, loading: true, error: null });
        return next;
      });

      try {
        // Static widgets with no SQL — immediately mark as done
        if (widget.type === "insights_strip" || widget.type === "ranked_bars") {
          if (!signal.aborted) {
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data: null, loading: false, error: null });
              return next;
            });
          }
          return;
        }
        if (widget.type === "kpi_row") {
          // Pre-flight: same guard as fetchAll — kpi_row items can reference comp tokens.
          if (collectWidgetSqls(widget).some(hasCompTokens) && !comparisonRange) {
            if (!signal.aborted) {
              setWidgetStates((prev) => {
                const next = new Map(prev);
                next.set(idx, { data: null, loading: false, error: COMP_MISSING_ERROR });
                return next;
              });
            }
            return;
          }
          const [settled, trendResults, anomalyResults] = await Promise.all([
            Promise.all(
              widget.items.map(async (item) => {
                try {
                  const q = bindGlobalFilters(buildMainSql(item.sql));
                  const data = await fetchWidgetData(q.sql, signal, q.params);
                  return { data, error: null as ApiErrorResponse | string | null };
                } catch (err) {
                  const structured =
                    err instanceof Error && "structured" in err
                      ? (err as Error & { structured?: ApiErrorResponse }).structured
                      : undefined;
                  const errorValue: ApiErrorResponse | string = structured
                    ? structured
                    : err instanceof Error
                    ? err.message
                    : "Error al ejecutar la consulta";
                  return { data: null, error: errorValue };
                }
              })
            ),
            Promise.all(
              widget.items.map(async (item): Promise<WidgetData | null> => {
                if (!item.trend_sql || !comparisonRange) return null;
                const trendSql = buildComparisonSql(item.trend_sql);
                if (!trendSql) return null;
                try {
                  const q = bindGlobalFilters(trendSql);
                  return await fetchWidgetData(q.sql, signal, q.params);
                } catch {
                  return null;
                }
              })
            ),
            Promise.all(
              widget.items.map(async (item): Promise<WidgetData | null> => {
                if (!item.anomaly_sql) return null;
                try {
                  const q = bindGlobalFilters(buildMainSql(item.anomaly_sql));
                  return await fetchWidgetData(q.sql, signal, q.params);
                } catch {
                  return null;
                }
              })
            ),
          ]);
          if (!signal.aborted) {
            const itemData = settled.map((s) => s.data);
            const firstError = settled.find((s) => s.error !== null)?.error ?? null;
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data: itemData, trendData: trendResults, anomalyData: anomalyResults, loading: false, error: firstError });
              return next;
            });
          }
        } else {
          // Pre-flight: if main SQL uses comp tokens but no comparisonRange is set,
          // show a friendly error instead of letting PostgreSQL reject literal `:comp_*`.
          if (collectWidgetSqls(widget).some(hasCompTokens) && !comparisonRange) {
            if (!signal.aborted) {
              setWidgetStates((prev) => {
                const next = new Map(prev);
                next.set(idx, { data: null, loading: false, error: COMP_MISSING_ERROR });
                return next;
              });
            }
            return;
          }
          const compSql = "comparison_sql" in widget ? buildComparisonSql(widget.comparison_sql) : null;
          const mainQ = bindGlobalFilters(buildMainSql(widget.sql));
          const compQ = compSql ? bindGlobalFilters(compSql) : null;
          const [data, comparisonData] = await Promise.all([
            fetchWidgetData(mainQ.sql, signal, mainQ.params),
            compQ
              ? fetchWidgetData(compQ.sql, signal, compQ.params).catch(() => null)
              : Promise.resolve(null),
          ]);
          if (!signal.aborted) {
            setWidgetStates((prev) => {
              const next = new Map(prev);
              next.set(idx, { data, comparisonData, loading: false, error: null });
              return next;
            });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        const structured =
          err instanceof Error && "structured" in err
            ? (err as Error & { structured?: ApiErrorResponse }).structured
            : undefined;
        const errorValue: ApiErrorResponse | string = structured
          ? structured
          : err instanceof Error
          ? err.message
          : "Error al ejecutar la consulta";
        setWidgetStates((prev) => {
          const next = new Map(prev);
          next.set(idx, { data: null, loading: false, error: errorValue });
          return next;
        });
      } finally {
        // Remove the completed controller from the map
        retryAbortMap.current.delete(idx);
      }
    },
    [buildMainSql, buildComparisonSql, comparisonRange, bindGlobalFilters],
  );

  useEffect(() => {
    renderedKeyRef.current = specKey;
    if (spec.widgets.length > 0) {
      fetchAll(spec.widgets);
    }
    const retryMap = retryAbortMap.current;
    return () => {
      fetchAllAbortRef.current?.abort();
      retryMap.forEach((ctrl) => ctrl.abort());
      retryMap.clear();
    };
    // specKey captures the entire spec (including widgets) so we don't need
    // spec.widgets as a separate dependency — doing so would cause spurious
    // refetches when a parent recreates the array with identical content.
    // refreshKey is included so incrementing it re-runs all queries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, fetchAll, refreshKey]);

  // Notify parent when widget data changes (for AI analyst chat).
  // Only fires after at least one widget has finished loading.
  const onWidgetDataChangeRef = useRef(onWidgetDataChange);
  onWidgetDataChangeRef.current = onWidgetDataChange;

  useEffect(() => {
    if (!onWidgetDataChangeRef.current) return;
    // Only fire when at least one widget has completed (loading=false)
    const hasAnyComplete = Array.from(widgetStates.values()).some(
      (s) => !s.loading
    );
    if (!hasAnyComplete) return;
    onWidgetDataChangeRef.current(widgetStates);
  }, [widgetStates]);

  // Build widget index map for section-based rendering.
  // First occurrence of a given id wins; duplicates are ignored (and logged in dev)
  // to keep rendering deterministic even if the spec contains duplicate widget ids.
  const widgetIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    spec.widgets.forEach((w, idx) => {
      if (!w.id) return;
      if (map.has(w.id)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`DashboardRenderer: duplicate widget id "${w.id}" at index ${idx} — first occurrence used.`);
        }
        return;
      }
      map.set(w.id, idx);
    });
    return map;
  }, [spec.widgets]);

  return (
    <div
      style={{
        // Top padding gives breathing room between the global filters bar
        // (or page header when no filters are configured) and the first
        // widget row. Token-driven so density variants scale it.
        paddingTop: "var(--gap-section, 1.5rem)",
        paddingLeft: 20,
        paddingRight: 20,
        paddingBottom: 24,
      }}
    >
      {/* Tabbed layout (when sections are defined) */}
      {spec.sections && spec.sections.length > 0 ? (
        <TabGroup>
          <TabList className="mb-6 flex space-x-1 border-b border-tremor-border dark:border-dark-tremor-border">
            {spec.sections.map((section) => (
              <Tab
                key={section.id}
                className={({ selected }: { selected: boolean }) =>
                  "px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-tremor-brand dark:focus-visible:ring-dark-tremor-brand focus-visible:ring-offset-1 " +
                  (selected
                    ? "border-b-2 border-tremor-brand dark:border-dark-tremor-brand text-tremor-brand dark:text-dark-tremor-brand -mb-px"
                    : "text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis")
                }
              >
                {section.label}
              </Tab>
            ))}
          </TabList>

          <TabPanels>
            {spec.sections.map((section) => {
              // Resolve widget indices for this section; deduplicate to prevent duplicate React keys
              const sectionWidgetIndices = Array.from(new Set(
                section.widget_ids
                  .map((wid) => widgetIndexMap.get(wid))
                  .filter((idx): idx is number => idx !== undefined)
              ));

              return (
                <TabPanel key={section.id}>
                  <WidgetGrid
                    widgets={spec.widgets}
                    widgetIndices={sectionWidgetIndices}
                    widgetStates={widgetStates}
                    specChanged={specChanged}
                    onRetry={retryWidget}
                    glossary={spec.glossary}
                    onDataPointClick={onDataPointClick}
                    kpiStyle={kpiStyle}
                  />
                </TabPanel>
              );
            })}
          </TabPanels>
        </TabGroup>
      ) : (
        /* Flat layout (default, backwards compatible) */
        <WidgetGrid
          widgets={spec.widgets}
          widgetIndices={spec.widgets.map((_, i) => i)}
          widgetStates={widgetStates}
          specChanged={specChanged}
          onRetry={retryWidget}
          glossary={spec.glossary}
          onDataPointClick={onDataPointClick}
          kpiStyle={kpiStyle}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget grid
// ---------------------------------------------------------------------------

interface WidgetGridProps {
  widgets: Widget[];
  widgetIndices: number[];
  widgetStates: Map<number, WidgetState>;
  specChanged: boolean;
  onRetry: (widget: Widget, idx: number) => void;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
  kpiStyle?: KpiStyle;
}

function WidgetGrid({
  widgets,
  widgetIndices,
  widgetStates,
  specChanged,
  onRetry,
  glossary,
  onDataPointClick,
  kpiStyle,
}: WidgetGridProps) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {widgetIndices.map((idx) => {
        const widget = widgets[idx];
        if (!widget) return null;

        // When spec has changed but the effect hasn't run yet,
        // treat all widgets as loading to avoid stale data flash.
        const state = specChanged ? undefined : widgetStates.get(idx);
        const isFullWidth =
          widget.type === "kpi_row" ||
          widget.type === "table" ||
          widget.type === "insights_strip" ||
          widget.type === "ranked_bars";

        return (
          <div
            key={widget.id ?? `widget-${idx}`}
            className={isFullWidth ? "lg:col-span-2" : ""}
          >
            {/* Loading skeleton */}
            {(!state || state.loading) && (
              <RendererSkeleton type={widget.type} />
            )}

            {/* Error state */}
            {state && !state.loading && state.error && (
              <ErrorDisplay
                error={state.error}
                title={
                  widget.type !== "kpi_row" && "title" in widget
                    ? (widget.title as string)
                    : undefined
                }
                onRetry={() => onRetry(widget, idx)}
                className="w-full"
              />
            )}

            {/* Success state */}
            {state && !state.loading && !state.error && (
              <WidgetSwitch
                widget={widget}
                state={state}
                glossary={glossary}
                onDataPointClick={onDataPointClick}
                kpiStyle={kpiStyle}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shaped skeleton placeholders (Task 4)
// ---------------------------------------------------------------------------

type WidgetType = Widget["type"];

// Extend the WidgetType used in RendererSkeleton — new static types won't show a skeleton

function RendererSkeleton({ type }: { type: WidgetType }) {
  switch (type) {
    case "kpi_row":
      return (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          data-testid="widget-skeleton"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
            >
              <div className="mb-2 h-3 w-2/3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
              <div className="h-8 w-1/2 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
            </div>
          ))}
        </div>
      );

    case "bar_chart":
      return (
        <div
          className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
          data-testid="widget-skeleton"
        >
          <div className="mb-4 h-4 w-1/3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="flex items-end gap-2 h-40">
            {[60, 85, 45, 70, 55, 90, 40].map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="flex-1 h-3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle"
              />
            ))}
          </div>
        </div>
      );

    case "line_chart":
    case "area_chart":
      return (
        <div
          className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
          data-testid="widget-skeleton"
        >
          <div className="mb-4 h-4 w-1/3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="relative h-40">
            {/* Simulate a line chart wave */}
            <svg
              viewBox="0 0 300 100"
              className="h-full w-full opacity-20"
              preserveAspectRatio="none"
            >
              <polyline
                points="0,70 50,50 100,60 150,30 200,45 250,20 300,40"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className="text-tremor-brand dark:text-dark-tremor-brand"
              />
            </svg>
          </div>
        </div>
      );

    case "donut_chart":
      return (
        <div
          className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
          data-testid="widget-skeleton"
        >
          <div className="mb-4 h-4 w-1/3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="flex items-center justify-center">
            <div className="h-40 w-40 rounded-full border-[20px] border-tremor-background-subtle dark:border-dark-tremor-background-subtle" />
          </div>
        </div>
      );

    case "table":
      return (
        <div
          className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
          data-testid="widget-skeleton"
        >
          <div className="mb-4 h-4 w-1/4 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          {/* Header row */}
          <div className="mb-3 grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle"
              />
            ))}
          </div>
          {/* Data rows */}
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="mb-2 grid grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((col) => (
                <div
                  key={col}
                  className="h-3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle opacity-60"
                  style={{ opacity: 0.4 + (4 - row) * 0.1 }}
                />
              ))}
            </div>
          ))}
        </div>
      );

    case "number":
    default:
      return (
        <div
          className="animate-pulse rounded-xl border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4"
          data-testid="widget-skeleton"
        >
          <div className="mb-3 h-4 w-1/3 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="h-12 w-1/2 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Panel chrome (Phase D7)
// ---------------------------------------------------------------------------

export interface PanelProps {
  title?: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  padded?: boolean;
  tall?: boolean;
  children: React.ReactNode;
}

export function Panel({ title, subtitle, rightSlot, padded = true, tall, children }: PanelProps) {
  return (
    <section
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: tall ? 380 : undefined,
      }}
    >
      {title && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em" }}>
              {title}
            </h3>
            {subtitle && (
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--fg-muted)" }}>
                {subtitle}
              </p>
            )}
          </div>
          {rightSlot}
        </header>
      )}
      <div style={{ padding: padded ? "var(--pad, 12px)" : 0, flex: 1 }}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Widget type switch
// ---------------------------------------------------------------------------

function WidgetSwitch({
  widget,
  state,
  glossary,
  onDataPointClick,
  kpiStyle,
}: {
  widget: Widget;
  state: WidgetState;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
  kpiStyle?: KpiStyle;
}) {
  switch (widget.type) {
    case "kpi_row":
      return (
        <KpiRow
          widget={widget}
          data={state.data as (WidgetData | null)[]}
          trendData={state.trendData}
          glossary={glossary}
          anomalyData={state.anomalyData}
          kpiStyle={kpiStyle}
        />
      );
    case "bar_chart":
      return (
        <BarChartWidget
          widget={widget}
          data={state.data as WidgetData | null}
          comparisonData={state.comparisonData}
          glossary={glossary}
          onDataPointClick={onDataPointClick}
        />
      );
    case "line_chart":
      return (
        <LineChartWidget
          widget={widget}
          data={state.data as WidgetData | null}
          comparisonData={state.comparisonData}
          glossary={glossary}
          onDataPointClick={onDataPointClick}
        />
      );
    case "area_chart":
      return (
        <AreaChartWidget
          widget={widget}
          data={state.data as WidgetData | null}
          comparisonData={state.comparisonData}
          glossary={glossary}
          onDataPointClick={onDataPointClick}
        />
      );
    case "donut_chart":
      return (
        <DonutChartWidget
          widget={widget}
          data={state.data as WidgetData | null}
          comparisonData={state.comparisonData}
          glossary={glossary}
          onDataPointClick={onDataPointClick}
        />
      );
    case "table":
      return (
        <TableWidget
          widget={widget}
          data={state.data as WidgetData | null}
          glossary={glossary}
          onDataPointClick={onDataPointClick}
          padded={false}
        />
      );
    case "number":
      return (
        <NumberWidget widget={widget} data={state.data as WidgetData | null} glossary={glossary} />
      );
    case "insights_strip":
      return <InsightsStrip widget={widget} />;
    case "ranked_bars":
      return <RankedBarsWidget widget={widget} />;
    default:
      return null;
  }
}
