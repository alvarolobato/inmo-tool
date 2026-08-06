"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Card, BarChart, Badge } from "@tremor/react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RunStatus = "success" | "partial" | "failed" | "running";
/** connector_run_results.status — 'skipped' and 'circuit_open' are #99/#11 additions. */
export type ConnectorStatus = "ok" | "failed" | "circuit_open" | "skipped";

export interface ConnectorRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: RunStatus;
  total_connectors: number | null;
  connectors_ok: number | null;
  connectors_failed: number | null;
  connectors_skipped: number | null;
  total_discovered: number | null;
  total_fetched: number | null;
  trigger: string;
}

/** Issue #109 (D-079): one resolved geography a run ran against, with outcome. */
export interface GeographyScopeEntry {
  scope_key: string | null;
  center: [number, number] | null;
  radius_km: number | null;
  rooms: number | null;
  outcome: string;
}

/** Issue #171 (D-086): run-over-run degradation trend for extraction quality. */
export interface ExtractionQualityTrend {
  baseline_mean: number | null;
  baseline_n_runs: number;
  delta: number | null;
  degraded: boolean;
}

/** Issue #171 (D-086): run-level aggregate of the per-listing quality grades. */
export interface ExtractionQualitySummary {
  n: number;
  mean_score: number;
  grade_histogram: { A: number; B: number; C: number; F: number };
  low_quality_count: number;
  weights_version: number | null;
  trend?: ExtractionQualityTrend;
}

export interface ConnectorRunResult {
  id: number;
  connector_name: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: ConnectorStatus;
  discovered_count: number;
  fetched_count: number;
  error_count: number;
  error_msg: string | null;
  /** Issue #242 (D-079): typed failure kind, or null on a clean run. */
  failure_classification: string | null;
  /** Issue #109 (D-079): the geographies this run actually ran against. */
  geography_scope: GeographyScopeEntry[] | null;
  /** Issue #171 (D-086): extraction-quality aggregate + trend, or null. */
  extraction_quality_summary: ExtractionQualitySummary | null;
}

export interface EtlRunDetailData {
  run: ConnectorRun;
  connectors: ConnectorRunResult[];
}

// ─── Format helpers ──────────────────────────────────────────────────────────

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatNumber(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("es-ES");
}

function formatDatetime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Badge helpers ───────────────────────────────────────────────────────────

type BadgeColor = "emerald" | "red" | "amber" | "blue" | "gray";

function statusBadgeColor(status: RunStatus | ConnectorStatus): BadgeColor {
  switch (status) {
    case "success": return "emerald";
    case "ok": return "emerald";
    case "failed": return "red";
    case "partial": return "amber";
    // A tripped breaker is amber, not red: the connector stopped itself on
    // purpose after too many errors. It's a real problem worth surfacing,
    // but distinct from an outright failure.
    case "circuit_open": return "amber";
    // Gray, deliberately not red/amber — an operator disabling a connector
    // is a normal state, not an alert (issue #99).
    case "skipped": return "gray";
    case "running": return "blue";
    default: return "gray";
  }
}

function statusLabel(status: RunStatus | ConnectorStatus): string {
  switch (status) {
    case "success": return "Completado";
    case "ok": return "OK";
    case "failed": return "Error";
    case "partial": return "Parcial";
    case "circuit_open": return "Circuito abierto";
    case "skipped": return "Omitido";
    case "running": return "En curso";
    default: return status;
  }
}

// Issue #242 (D-079): human-readable Spanish labels for the typed
// failure_classification enum. An operator scanning the monitor should see
// "Bloqueo temporal" not "soft_block". Unknown values fall through to the raw
// string so a future taxonomy value is never swallowed.
const FAILURE_CLASS_LABELS: Record<string, string> = {
  soft_block: "Bloqueo temporal",
  network: "Red / conexión",
  structure_change: "Cambio de estructura",
  unresolvable: "Geografía no resoluble",
  uncovered: "Sin cobertura",
  empty_result: "Sin resultados",
  other: "Otro",
};

function failureClassLabel(kind: string): string {
  return FAILURE_CLASS_LABELS[kind] ?? kind;
}

// Issue #242 (D-079): a soft-block/empty result is a clean-run signal (amber /
// gray), a genuine break is red — the badge colour must not cry wolf.
function failureClassColor(kind: string): BadgeColor {
  switch (kind) {
    case "soft_block":
    case "empty_result":
      return "amber";
    case "uncovered":
    case "unresolvable":
      return "gray";
    default:
      return "red";
  }
}

// Issue #109 (D-079): per-geography outcome labels for the coverage audit.
const GEO_OUTCOME_LABELS: Record<string, string> = {
  crawled: "Rastreada",
  empty: "Sin anuncios",
  uncovered: "Sin cobertura",
  unresolvable: "No resoluble",
  budget: "Sin presupuesto",
  soft_block: "Bloqueo temporal",
  fresh_this_cycle: "Ya actualizada",
  duplicate: "Duplicada",
  failed: "Error",
};

function geoOutcomeLabel(outcome: string): string {
  return GEO_OUTCOME_LABELS[outcome] ?? outcome;
}

// A crawled/fresh geography is a good outcome (emerald); a genuine failure is
// red; everything else (empty/uncovered/budget/etc.) is a neutral note.
function geoOutcomeColor(outcome: string): BadgeColor {
  switch (outcome) {
    case "crawled":
    case "fresh_this_cycle":
      return "emerald";
    case "failed":
      return "red";
    case "soft_block":
    case "budget":
      return "amber";
    default:
      return "gray";
  }
}

// ─── Extraction-quality helpers (issue #171, D-086) ──────────────────────────

// The same grade bands etl/extraction_quality.py uses, applied to the run's
// MEAN weighted-completeness fraction so a run gets a single at-a-glance letter.
function meanGrade(score: number): "A" | "B" | "C" | "F" {
  if (score >= 0.85) return "A";
  if (score >= 0.65) return "B";
  if (score >= 0.45) return "C";
  return "F";
}

function qualityGradeColor(grade: "A" | "B" | "C" | "F"): BadgeColor {
  switch (grade) {
    case "A":
      return "emerald";
    case "B":
      return "blue";
    case "C":
      return "amber";
    default:
      return "red";
  }
}

/** A 0..1 completeness fraction as a percent, e.g. 0.782 → "78 %". */
function formatQualityPct(score: number): string {
  return `${Math.round(score * 100)} %`;
}

/** A signed delta (0..1 fraction) as percentage points, e.g. -0.12 → "−12 pp". */
function formatDeltaPp(delta: number): string {
  const pp = Math.round(delta * 100);
  const sign = pp > 0 ? "+" : pp < 0 ? "−" : "±";
  return `${sign}${Math.abs(pp)} pp`;
}

/** A [lat, lon] centre as a short label when a scope has no site-specific key. */
function formatCenter(center: [number, number] | null): string {
  if (!center) return "—";
  return `${center[0].toFixed(3)}, ${center[1].toFixed(3)}`;
}

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: "Programado",
  startup: "Arranque",
  manual: "Manual",
  cli: "CLI",
};

function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps { label: string; value: string; sub?: string; }

function KpiCard({ label, value, sub }: KpiCardProps) {
  return (
    <Card className="p-4">
      <p className="text-xs text-tremor-content dark:text-dark-tremor-content">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          {sub}
        </p>
      )}
    </Card>
  );
}

// ─── Duration Bar Chart ───────────────────────────────────────────────────────

interface DurationChartProps { connectors: ConnectorRunResult[]; }

function DurationChart({ connectors }: DurationChartProps) {
  const sorted = [...connectors]
    .filter((c) => c.duration_ms !== null && c.duration_ms > 0)
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0));

  if (sorted.length === 0) {
    return (
      <Card className="p-4">
        <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
          Tiempo por conector
        </h3>
        <p className="text-center text-sm text-tremor-content dark:text-dark-tremor-content">
          Sin datos de duración
        </p>
      </Card>
    );
  }

  // Every status a row can carry must appear here, or a row with a real
  // duration renders as an empty bar (a skipped connector can still record
  // one — #99).
  const chartData = sorted.map((c) => ({
    name: c.connector_name,
    OK: c.status === "ok" ? (c.duration_ms ?? 0) : 0,
    Error: c.status === "failed" ? (c.duration_ms ?? 0) : 0,
    "Circuito abierto": c.status === "circuit_open" ? (c.duration_ms ?? 0) : 0,
    Omitido: c.status === "skipped" ? (c.duration_ms ?? 0) : 0,
  }));

  return (
    <Card className="p-4">
      <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
        Tiempo por conector
      </h3>
      <BarChart
        data={chartData}
        index="name"
        categories={["OK", "Error", "Circuito abierto", "Omitido"]}
        colors={["emerald", "red", "amber", "gray"]}
        valueFormatter={(v: number) => formatDuration(v)}
        stack={true}
        showLegend={true}
        yAxisWidth={70}
        className="h-64"
      />
    </Card>
  );
}

// ─── Extraction-quality cell (issue #171, D-086) ─────────────────────────────

interface QualityCellProps {
  summary: ExtractionQualitySummary | null;
  connectorName: string;
}

// The run-level extraction-quality signal: a single grade + mean-completeness
// percent, plus a run-over-run trend indicator. The trend is the whole point of
// issue #171 — a connector can keep reporting status='ok' while its average
// extraction completeness silently drifts down (a partial markup change), and
// the degraded badge here is what makes that visible before anyone reads a
// single listing's badge.
function QualityCell({ summary, connectorName }: QualityCellProps) {
  if (!summary || summary.n === 0) {
    // A run that produced no scored listings (failed/empty/all-skipped) has no
    // quality to show — an em dash, never a fabricated 0 %.
    return (
      <span
        className="text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
        data-testid={`connector-quality-${connectorName}`}
      >
        —
      </span>
    );
  }

  const grade = meanGrade(summary.mean_score);
  const trend = summary.trend;
  const hasBaseline = trend != null && trend.delta != null;

  return (
    <div
      className="flex flex-col items-end gap-1"
      data-testid={`connector-quality-${connectorName}`}
    >
      <div className="flex items-center gap-1.5">
        <Badge color={qualityGradeColor(grade)} size="xs">
          {grade}
        </Badge>
        <span
          className="tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis"
          title={`${summary.n} anuncio${summary.n === 1 ? "" : "s"} · A ${summary.grade_histogram.A} · B ${summary.grade_histogram.B} · C ${summary.grade_histogram.C} · F ${summary.grade_histogram.F}`}
        >
          {formatQualityPct(summary.mean_score)}
        </span>
      </div>
      {trend?.degraded ? (
        // A meaningful drop vs the connector's trailing baseline — the silent-
        // degradation alarm. Red, and it must show even on a status='ok' run.
        <Badge
          color="red"
          size="xs"
          data-testid={`connector-quality-trend-${connectorName}`}
        >
          ▼ Calidad {trend.delta != null ? formatDeltaPp(trend.delta) : ""}
        </Badge>
      ) : hasBaseline ? (
        // Has history and is stable/improving — a muted delta, not an alarm.
        <span
          className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle"
          data-testid={`connector-quality-trend-${connectorName}`}
          title={
            trend?.baseline_mean != null
              ? `Media reciente: ${formatQualityPct(trend.baseline_mean)} (${trend.baseline_n_runs} ejec.)`
              : undefined
          }
        >
          {trend?.delta != null ? formatDeltaPp(trend.delta) : ""}
        </span>
      ) : null}
    </div>
  );
}

// ─── Per-table stats table ────────────────────────────────────────────────────

interface ConnectorStatsTableProps { connectors: ConnectorRunResult[]; }

function ConnectorStatsTable({ connectors }: ConnectorStatsTableProps) {
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());

  const toggleError = (id: number) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
        Detalle por conector
      </h3>
      <p className="mb-4 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
        Encontrados → guardados es el embudo de ingesta: una diferencia grande
        suele indicar que el sitio ha cambiado su HTML o está bloqueando.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="connector-stats">
          <thead>
            <tr className="border-b border-tremor-border dark:border-dark-tremor-border">
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Conector</th>
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Estado</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content" title="Anuncios localizados en la fase de descubrimiento">Encontrados</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content" title="Anuncios descargados, normalizados y guardados">Guardados</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content" title="Anuncios que fallaron al descargar o parsear">Errores</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content" title="Calidad media de extracción de los anuncios de esta ejecución y su tendencia frente a ejecuciones recientes (issue #171)">Calidad</th>
              <th className="pb-2 text-right font-medium text-tremor-content dark:text-dark-tremor-content">Duración</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((c) => (
              <React.Fragment key={c.id}>
                <tr
                  className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50 hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle"
                  data-testid={`connector-row-${c.connector_name}`}
                >
                  <td className="py-2 pr-3 font-mono text-tremor-content-strong dark:text-dark-tremor-content-strong">{c.connector_name}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1">
                      <Badge color={statusBadgeColor(c.status)} size="xs">{statusLabel(c.status)}</Badge>
                      {c.failure_classification && (
                        <Badge
                          color={failureClassColor(c.failure_classification)}
                          size="xs"
                          data-testid={`connector-failure-${c.connector_name}`}
                        >
                          {failureClassLabel(c.failure_classification)}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-tremor-content dark:text-dark-tremor-content">{formatNumber(c.discovered_count)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">{formatNumber(c.fetched_count)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${c.error_count > 0 ? "text-red-500 dark:text-red-400" : "text-tremor-content dark:text-dark-tremor-content"}`}>{formatNumber(c.error_count)}</td>
                  <td className="py-2 pr-3 text-right">
                    <QualityCell summary={c.extraction_quality_summary} connectorName={c.connector_name} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">{formatDuration(c.duration_ms)}</td>
                </tr>
                {c.geography_scope && c.geography_scope.length > 0 && (
                  <tr
                    key={`${c.id}-geo`}
                    className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50"
                    data-testid={`connector-row-${c.connector_name}-geo`}
                  >
                    {/*
                      Issue #109 (D-079): which geographies this run actually ran
                      against, and what happened to each. The queryable audit
                      trail that used to survive only as free text inside
                      error_msg — now an operator can confirm the exact
                      city/radius a run used, and tell "uncovered" from
                      "unresolvable" for the same place at a glance.
                    */}
                    <td colSpan={7} className="pb-2 pt-0 pl-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                          Ámbito:
                        </span>
                        {c.geography_scope.map((g, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle px-1.5 py-0.5 font-mono text-tremor-content dark:text-dark-tremor-content"
                          >
                            <span>{g.scope_key ?? formatCenter(g.center)}</span>
                            {g.rooms != null && <span>· {g.rooms}h</span>}
                            <Badge color={geoOutcomeColor(g.outcome)} size="xs">
                              {geoOutcomeLabel(g.outcome)}
                            </Badge>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
                {c.error_msg && (
                  <tr key={`${c.id}-error`} className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50" data-testid={`connector-row-${c.connector_name}-error`}>
                    <td colSpan={7} className="pb-2 pt-0 pl-2">
                      {/*
                        On a 'skipped' row this is the reason (e.g. "disabled
                        via connector_config") — informational, not an error,
                        so it must not render in alarm-red. On failed/
                        circuit_open it's the orchestrator's per-scope detail,
                        currently the only record of which geography a
                        connector actually ran against.
                      */}
                      <button
                        type="button"
                        onClick={() => toggleError(c.id)}
                        aria-expanded={expandedErrors.has(c.id)}
                        aria-label={`Ver detalle de ${c.connector_name}`}
                        className={`text-left hover:underline ${c.status === "skipped" ? "text-tremor-content dark:text-dark-tremor-content" : "text-red-500 dark:text-red-400"}`}
                      >
                        {expandedErrors.has(c.id) ? c.error_msg : c.error_msg.length > 120 ? `${c.error_msg.slice(0, 120)}… (ver más)` : c.error_msg}
                      </button>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Main RunDetail component ─────────────────────────────────────────────────

interface RunDetailProps { runId: string; }

export function RunDetail({ runId }: RunDetailProps) {
  const [data, setData] = useState<EtlRunDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRun = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/etl/runs/${encodeURIComponent(runId)}`);
      if (res.status === 404) { setNotFound(true); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError((body?.error as string) ?? "Error al cargar la ejecución");
        return;
      }
      const json: EtlRunDetailData = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar la ejecución");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setData(null);
    void fetchRun();
  }, [fetchRun]);

  useEffect(() => {
    if (autoRefreshRef.current) { clearInterval(autoRefreshRef.current); autoRefreshRef.current = null; }
    if (data?.run.status === "running") {
      autoRefreshRef.current = setInterval(() => { fetchRun(); }, 30_000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [data?.run.status, fetchRun]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" role="status" aria-label="Cargando" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4" data-testid="not-found">
        <Link href="/etl" className="text-sm text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis">&larr; Volver al monitor</Link>
        <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">Ejecución no encontrada</h1>
        <p className="text-sm text-tremor-content dark:text-dark-tremor-content">La ejecución con ID {runId} no existe.</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4" data-testid="error-state">
        <Link href="/etl" className="text-sm text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis">&larr; Volver al monitor</Link>
        <p className="text-sm text-red-500 dark:text-red-400" data-testid="error-message">{error ?? "Error al cargar la ejecución"}</p>
        <button type="button" onClick={() => { setLoading(true); void fetchRun(); }} className="rounded-lg border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle">
          Reintentar
        </button>
      </div>
    );
  }

  const { run, connectors } = data;
  const skipped = run.connectors_skipped ?? 0;
  const failed = run.connectors_failed ?? 0;

  // "3 / 0 / 1" = ok / error / omitted. The skipped segment only appears
  // when there is one, so a normal run reads as a clean pair.
  const connectorsValue =
    run.connectors_ok === null
      ? "—"
      : skipped > 0
        ? `${run.connectors_ok} / ${failed} / ${skipped}`
        : `${run.connectors_ok} / ${failed}`;

  const connectorsSub =
    failed > 0
      ? `${failed} con error${skipped > 0 ? ` · ${skipped} omitido${skipped === 1 ? "" : "s"}` : ""}`
      : skipped > 0
        ? `${skipped} omitido${skipped === 1 ? "" : "s"}`
        : "Sin errores";

  return (
    <div className="space-y-6" data-testid="run-detail">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/etl" className="text-sm text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-emphasis dark:hover:text-dark-tremor-content-emphasis">&larr; Volver al monitor</Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">Ejecución #{run.id}</h1>
            <Badge color={statusBadgeColor(run.status)} data-testid="status-badge">
              {run.status === "running" ? (
                <span className="flex items-center gap-1"><span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)" }} />En progreso...</span>
              ) : statusLabel(run.status)}
            </Badge>
          </div>
          <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
            Iniciada: {formatDatetime(run.started_at)}{run.finished_at && ` · Finalizada: ${formatDatetime(run.finished_at)}`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5" data-testid="kpi-row">
        <KpiCard label="Duración total" value={formatDuration(run.duration_ms)} />
        <KpiCard
          label="Anuncios encontrados"
          value={formatNumber(run.total_discovered)}
          sub="Fase de descubrimiento"
        />
        <KpiCard
          label="Anuncios guardados"
          value={formatNumber(run.total_fetched)}
          sub="Descargados y almacenados"
        />
        <KpiCard
          label="Conectores"
          value={connectorsValue}
          sub={connectorsSub}
        />
        <KpiCard label="Disparado por" value={triggerLabel(run.trigger)} />
      </div>
      {connectors.length > 0 && <DurationChart connectors={connectors} />}
      {connectors.length > 0 && <ConnectorStatsTable connectors={connectors} />}
      {connectors.length === 0 && (
        <Card className="p-4">
          <p className="text-center text-sm text-tremor-content dark:text-dark-tremor-content">Sin resultados de conectores para esta ejecución</p>
        </Card>
      )}
    </div>
  );
}
