"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Card, BarChart, Badge } from "@tremor/react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RunStatus = "success" | "partial" | "failed" | "running";
export type TableStatus = "success" | "failed" | "running";
export type SyncMethod = "full_refresh" | "upsert_delta" | "append";
export type Trigger = "scheduled" | "manual";
export type RunKind = "delta" | "full";

export interface EtlSyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: RunStatus;
  /** 'delta' for the hourly watermark sweep, 'full' for the nightly truncate-and-reinsert pass. */
  kind: RunKind;
  total_tables: number;
  tables_ok: number;
  tables_failed: number;
  total_rows_synced: number;
  trigger: Trigger;
}

export interface EtlSyncTableStat {
  id: number;
  table_name: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: TableStatus;
  rows_synced: number | null;
  rows_total_after: number | null;
  sync_method: SyncMethod;
  watermark_from: string | null;
  watermark_to: string | null;
  error_msg: string | null;
}

export interface EtlRunDetailData {
  run: EtlSyncRun;
  tables: EtlSyncTableStat[];
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

function formatWatermark(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Badge helpers ───────────────────────────────────────────────────────────

type BadgeColor = "emerald" | "red" | "amber" | "blue" | "gray";

function statusBadgeColor(status: RunStatus | TableStatus): BadgeColor {
  switch (status) {
    case "success": return "emerald";
    case "failed": return "red";
    case "partial": return "amber";
    case "running": return "blue";
    default: return "gray";
  }
}

function statusLabel(status: RunStatus | TableStatus): string {
  switch (status) {
    case "success": return "Completado";
    case "failed": return "Error";
    case "partial": return "Parcial";
    case "running": return "En curso";
    default: return status;
  }
}

function syncMethodLabel(method: SyncMethod): string {
  switch (method) {
    case "full_refresh": return "Recarga completa";
    case "upsert_delta": return "Upsert delta";
    case "append": return "Añadir";
    default: return method;
  }
}

function triggerLabel(trigger: Trigger): string {
  return trigger === "scheduled" ? "Programado" : "Manual";
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

interface DurationChartProps { tables: EtlSyncTableStat[]; }

function DurationChart({ tables }: DurationChartProps) {
  const sorted = [...tables]
    .filter((t) => t.duration_ms !== null && t.duration_ms > 0 && t.status !== "running")
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0));

  if (sorted.length === 0) {
    return (
      <Card className="p-4">
        <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
          Tiempo por tabla
        </h3>
        <p className="text-center text-sm text-tremor-content dark:text-dark-tremor-content">
          Sin datos de duración
        </p>
      </Card>
    );
  }

  const chartData = sorted.map((t) => ({
    name: t.table_name.replace(/^ps_/, ""),
    Completado: t.status === "success" ? (t.duration_ms ?? 0) : 0,
    Error: t.status === "failed" ? (t.duration_ms ?? 0) : 0,
  }));

  return (
    <Card className="p-4">
      <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
        Tiempo por tabla
      </h3>
      <BarChart
        data={chartData}
        index="name"
        categories={["Completado", "Error"]}
        colors={["emerald", "red"]}
        valueFormatter={(v: number) => formatDuration(v)}
        stack={true}
        showLegend={true}
        yAxisWidth={70}
        className="h-64"
      />
    </Card>
  );
}

// ─── Per-table stats table ────────────────────────────────────────────────────

interface TableStatsTableProps { tables: EtlSyncTableStat[]; }

function TableStatsTable({ tables }: TableStatsTableProps) {
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
      <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
        Detalle por tabla
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="table-stats">
          <thead>
            <tr className="border-b border-tremor-border dark:border-dark-tremor-border">
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Tabla</th>
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Estado</th>
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Método</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">Filas sync.</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">Total est.</th>
              <th className="pb-2 pr-3 text-right font-medium text-tremor-content dark:text-dark-tremor-content">Duración</th>
              <th className="pb-2 pr-3 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Marca desde</th>
              <th className="pb-2 text-left font-medium text-tremor-content dark:text-dark-tremor-content">Marca hasta</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <React.Fragment key={t.id}>
                <tr
                  className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50 hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle"
                  data-testid={`table-row-${t.table_name}`}
                >
                  <td className="py-2 pr-3 font-mono text-tremor-content-strong dark:text-dark-tremor-content-strong">{t.table_name}</td>
                  <td className="py-2 pr-3">
                    <Badge color={statusBadgeColor(t.status)} size="xs">{statusLabel(t.status)}</Badge>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle px-1.5 py-0.5 text-tremor-content dark:text-dark-tremor-content">
                      {syncMethodLabel(t.sync_method)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">{formatNumber(t.rows_synced)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-tremor-content dark:text-dark-tremor-content" title="Estimado basado en total tras la sincronización">{formatNumber(t.rows_total_after)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">{formatDuration(t.duration_ms)}</td>
                  <td className="py-2 pr-3 text-tremor-content dark:text-dark-tremor-content">{t.sync_method === "upsert_delta" ? formatWatermark(t.watermark_from) : "—"}</td>
                  <td className="py-2 text-tremor-content dark:text-dark-tremor-content">{t.sync_method === "upsert_delta" ? formatWatermark(t.watermark_to) : "—"}</td>
                </tr>
                {t.error_msg && (
                  <tr key={`${t.id}-error`} className="border-b border-tremor-border/50 dark:border-dark-tremor-border/50" data-testid={`table-row-${t.table_name}-error`}>
                    <td colSpan={8} className="pb-2 pt-0 pl-2">
                      <button
                        type="button"
                        onClick={() => toggleError(t.id)}
                        aria-expanded={expandedErrors.has(t.id)}
                        aria-label={`Ver error de ${t.table_name}`}
                        className="text-left text-red-500 dark:text-red-400 hover:underline"
                      >
                        {expandedErrors.has(t.id) ? t.error_msg : t.error_msg.length > 120 ? `${t.error_msg.slice(0, 120)}… (ver más)` : t.error_msg}
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

  const { run, tables } = data;

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
            <Badge color={run.kind === "delta" ? "blue" : "gray"} data-testid="kind-badge">
              {run.kind === "delta" ? "Delta" : "Completa"}
            </Badge>
          </div>
          <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
            Iniciada: {formatDatetime(run.started_at)}{run.finished_at && ` · Finalizada: ${formatDatetime(run.finished_at)}`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="kpi-row">
        <KpiCard label="Duración total" value={formatDuration(run.duration_ms)} />
        <KpiCard label="Filas sincronizadas" value={formatNumber(run.total_rows_synced)} />
        <KpiCard label="Tablas" value={`${run.tables_ok} / ${run.tables_failed}`} sub={run.tables_failed > 0 ? `${run.tables_failed} con error` : "Sin errores"} />
        <KpiCard label="Disparado por" value={triggerLabel(run.trigger)} />
      </div>
      {tables.length > 0 && <DurationChart tables={tables} />}
      {tables.length > 0 && <TableStatsTable tables={tables} />}
      {tables.length === 0 && (
        <Card className="p-4">
          <p className="text-center text-sm text-tremor-content dark:text-dark-tremor-content">Sin estadísticas de tablas disponibles</p>
        </Card>
      )}
    </div>
  );
}
