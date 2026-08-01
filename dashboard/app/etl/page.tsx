"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card } from "@tremor/react";
import { RunList } from "@/components/etl/RunList";
import { EvolutionCharts } from "@/components/etl/EvolutionCharts";
import {
  ForceResyncDialog,
  type ForceResyncOptions,
} from "@/components/etl/ForceResyncDialog";
import type { EtlSyncRun } from "@/components/etl/RunList";
import type { EtlStatsData } from "@/components/etl/EvolutionCharts";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import {
  formatAgeSeconds,
  formatDuration,
  formatNumber,
  formatThroughput,
} from "@/lib/etl-format";

const PER_PAGE = 20;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(isoStr: string): string {
  try {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return "hace un momento";
    if (mins < 60) return `hace ${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)} días`;
  } catch {
    return isoStr;
  }
}

function formatSuccessRate(rate: EtlStatsData["success_rate"]): string {
  if (rate.total === 0) return "—";
  return `${Math.round((rate.success / rate.total) * 100)}%`;
}

// ─── Loading skeletons ────────────────────────────────────────────────────────

function KpiSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-4 animate-pulse"
      aria-busy="true"
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-4">
          <div className="h-3 w-24 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="mt-2 h-7 w-32 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        </Card>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 animate-pulse"
      aria-busy="true"
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i} className="p-4">
          <div className="h-4 w-40 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle mb-4" />
          <div className="h-40 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        </Card>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function EtlMonitorPage() {
  const [runs, setRuns] = useState<EtlSyncRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<ApiErrorResponse | string | null>(
    null,
  );

  const [stats, setStats] = useState<EtlStatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<ApiErrorResponse | string | null>(
    null,
  );

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [forceDialogOpen, setForceDialogOpen] = useState(false);
  // Biases the polling cadence to "fast" for ~15 s after a trigger so the new
  // run surfaces as soon as the ETL scheduler creates it (its trigger poll is
  // every 10 s, so we cover that window).
  const [awaitingTrigger, setAwaitingTrigger] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const awaitingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRuns = useCallback(async (p: number, silent = false) => {
    if (!silent) setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await fetch(`/api/etl/runs?page=${p}&per_page=${PER_PAGE}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunsError(
          isApiErrorResponse(body) ? body : "Error al cargar las ejecuciones",
        );
        return;
      }
      const data = await res.json();
      setRuns(data.runs as EtlSyncRun[]);
      setTotal(data.total as number);
    } catch (err) {
      setRunsError(
        err instanceof Error ? err.message : "Error al cargar las ejecuciones",
      );
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch("/api/etl/stats");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setStatsError(
          isApiErrorResponse(body) ? body : "Error al cargar estadísticas",
        );
        return;
      }
      const data: EtlStatsData = await res.json();
      setStats(data);
    } catch (err) {
      setStatsError(
        err instanceof Error ? err.message : "Error al cargar estadísticas",
      );
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns(1);
    fetchStats();
  }, [fetchRuns, fetchStats]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchRuns(newPage);
  };

  const isRunning = runs.some((r) => r.status === "running");
  const wasRunningRef = useRef(false);

  // Always poll the runs table so newly created or scheduler-triggered runs
  // surface without a manual refresh. Cadence: 2 s briefly after a trigger,
  // 3 s while a run is active, 8 s when idle.
  useEffect(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    const intervalMs = awaitingTrigger ? 2_000 : isRunning ? 3_000 : 8_000;
    pollingRef.current = setInterval(() => {
      void fetchRuns(page, true);
    }, intervalMs);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [awaitingTrigger, isRunning, fetchRuns, page]);

  // Clear the awaiting flag as soon as a running run shows up
  useEffect(() => {
    if (awaitingTrigger && isRunning) {
      setAwaitingTrigger(false);
      if (awaitingTimeoutRef.current) {
        clearTimeout(awaitingTimeoutRef.current);
        awaitingTimeoutRef.current = null;
      }
    }
  }, [awaitingTrigger, isRunning]);

  // Clean up the awaiting safety timeout on unmount
  useEffect(() => {
    return () => {
      if (awaitingTimeoutRef.current) {
        clearTimeout(awaitingTimeoutRef.current);
        awaitingTimeoutRef.current = null;
      }
    };
  }, []);

  // When a run finishes (running → not running), refresh the stats KPIs too
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      void fetchStats();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, fetchStats]);

  const triggerSync = useCallback(
    async (opts?: ForceResyncOptions) => {
      setTriggering(true);
      setTriggerError(null);
      try {
        const init: RequestInit = { method: "POST" };
        if (opts && (opts.forceFull || opts.tables.length > 0)) {
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify({
            force_full: opts.forceFull,
            tables: opts.tables,
          });
        }
        const res = await fetch("/api/etl/run", init);
        if (res.status === 409) {
          // already running — let polling pick it up
        } else if (res.status === 400) {
          const body = await res.json().catch(() => null);
          setTriggerError(
            typeof body?.detail === "string"
              ? body.detail
              : "Cuerpo de petición inválido",
          );
        } else if (!res.ok) {
          setTriggerError("Error al iniciar la sincronización");
        }
        // Bias polling to fast cadence until the new run is visible (covers the
        // ETL scheduler's 10 s trigger-poll). Cleared either by the effect that
        // detects isRunning or by this safety timeout.
        setAwaitingTrigger(true);
        if (awaitingTimeoutRef.current) clearTimeout(awaitingTimeoutRef.current);
        awaitingTimeoutRef.current = setTimeout(() => {
          setAwaitingTrigger(false);
          awaitingTimeoutRef.current = null;
        }, 15_000);
        await fetchRuns(page, true);
      } catch {
        setTriggerError("Error al iniciar la sincronización");
      } finally {
        setTriggering(false);
      }
    },
    [fetchRuns, page],
  );

  const handleIncrementalTrigger = useCallback(() => {
    void triggerSync();
  }, [triggerSync]);

  const handleForceConfirm = useCallback(
    (opts: ForceResyncOptions) => {
      setForceDialogOpen(false);
      void triggerSync(opts);
    },
    [triggerSync],
  );

  // Last non-running run for KPI row
  const lastRun = runs.find((r) => r.status !== "running") ?? null;
  const successRateStr = stats ? formatSuccessRate(stats.success_rate) : null;
  const throughput = stats?.last_run?.throughput_rows_per_sec ?? null;
  const maxWmAge = stats?.watermarks?.max_age_seconds ?? null;
  const errors24h = stats?.errors_24h;

  return (
    <div className="space-y-6" data-testid="etl-monitor-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Monitor ETL
          </h1>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Historial y estadísticas de sincronización de datos
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              onClick={handleIncrementalTrigger}
              disabled={triggering || isRunning}
              data-testid="sync-now-button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors hover:brightness-110"
              style={{ background: "var(--accent)" }}
            >
              {(triggering || isRunning) && (
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                  aria-hidden="true"
                />
              )}
              {triggering
                ? "Iniciando…"
                : isRunning
                  ? "Sincronizando…"
                  : "Sincronizar ahora"}
            </button>
            <button
              onClick={() => setForceDialogOpen(true)}
              disabled={triggering || isRunning}
              data-testid="force-resync-button"
              className="inline-flex items-center rounded-md border border-amber-600 bg-white px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors dark:bg-slate-900 dark:hover:bg-slate-800"
              title="Borrar watermarks y re-sincronizar"
            >
              Forzar re-sync
            </button>
          </div>
          {triggerError && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {triggerError}
            </p>
          )}
        </div>
      </div>

      {/* Primary KPI row — last completed run */}
      {runsLoading && !runs.length ? (
        <KpiSkeleton />
      ) : (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-4"
          data-testid="kpi-row"
        >
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Última sincronización
            </p>
            <p className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong truncate">
              {lastRun ? formatRelativeTime(lastRun.started_at) : "—"}
            </p>
            {lastRun && (
              <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                {new Date(lastRun.started_at).toLocaleDateString("es-ES", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                })}
              </p>
            )}
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Duración
            </p>
            <p className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
              {lastRun ? formatDuration(lastRun.duration_ms) : "—"}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Filas sincronizadas
            </p>
            <p className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
              {lastRun ? formatNumber(lastRun.total_rows_synced) : "—"}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Tasa de éxito (últ. 30)
            </p>
            <p className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
              {statsLoading ? "..." : (successRateStr ?? "—")}
            </p>
          </Card>
        </div>
      )}

      {/* Secondary KPI row — throughput / watermark / errors (issue #398) */}
      {!statsLoading && stats && (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3"
          data-testid="secondary-kpi-row"
        >
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Throughput última sync
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-throughput"
            >
              {formatThroughput(throughput)}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Filas por segundo
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Watermark más antiguo
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-watermark-age"
            >
              {formatAgeSeconds(maxWmAge)}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle truncate">
              {stats.watermarks.table_name ?? "—"}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Errores últimas 24h
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-errors-24h"
            >
              {errors24h
                ? formatNumber(errors24h.runs_failed) +
                  " / " +
                  formatNumber(errors24h.tables_failed)
                : "—"}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Runs / tablas con error
            </p>
          </Card>
        </div>
      )}

      {/* Errors */}
      {runsError && <ErrorDisplay error={runsError} onRetry={() => fetchRuns(page)} />}
      {statsError && <ErrorDisplay error={statsError} onRetry={fetchStats} />}

      {/* Evolution charts */}
      {statsLoading ? (
        <ChartSkeleton />
      ) : stats ? (
        <EvolutionCharts stats={stats} />
      ) : null}

      {/* Run list */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Historial de ejecuciones
        </h2>
        <RunList
          runs={runs}
          total={total}
          page={page}
          perPage={PER_PAGE}
          loading={runsLoading}
          onPageChange={handlePageChange}
        />
      </div>

      <ForceResyncDialog
        open={forceDialogOpen}
        onClose={() => setForceDialogOpen(false)}
        onConfirm={handleForceConfirm}
        disabled={triggering || isRunning}
      />
    </div>
  );
}
