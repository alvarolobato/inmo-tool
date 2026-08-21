"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Card } from "@tremor/react";
import { RunList } from "@/components/etl/RunList";
import { EvolutionCharts } from "@/components/etl/EvolutionCharts";
import { RunNowButton } from "@/components/connectors/RunNowButton";
import type { ConnectorRun } from "@/components/etl/RunList";
import type { EtlStatsData } from "@/components/etl/EvolutionCharts";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { formatDuration, formatNumber } from "@/lib/etl-format";

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

/** fetch_rate arrives as a 0–1 fraction; render it as a percentage. */
function formatFetchRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
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
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
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

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setRuns(data.runs as ConnectorRun[]);
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

  // Poll the runs table so scheduler-triggered runs surface without a manual
  // refresh. Cadence: 3 s while a run is active, 8 s when idle. (There is no
  // longer a post-trigger "fast" tier — the dashboard can't start a run; see
  // the note by the CLI hint below.)
  useEffect(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    const intervalMs = isRunning ? 3_000 : 8_000;
    pollingRef.current = setInterval(() => {
      void fetchRuns(page, true);
    }, intervalMs);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [isRunning, fetchRuns, page]);

  // When a run finishes (running → not running), refresh the stats KPIs too
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      void fetchStats();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, fetchStats]);

  // Last non-running run for KPI row
  const lastRun = runs.find((r) => r.status !== "running") ?? null;
  const successRateStr = stats ? formatSuccessRate(stats.success_rate) : null;
  const fetchRate = stats?.last_run?.fetch_rate ?? null;
  const errors24h = stats?.errors_24h;

  return (
    <div className="space-y-6" data-testid="etl-monitor-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Monitor de conectores
          </h1>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Historial y estadísticas de las ejecuciones de ingesta
            {isRunning && (
              <span className="ml-2 inline-flex items-center gap-1 text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                <span
                  className="h-2 w-2 animate-pulse rounded-full"
                  style={{ background: "var(--accent)" }}
                  aria-hidden="true"
                />
                Ejecución en curso
              </span>
            )}
          </p>
        </div>
        {/*
          "Ejecutar todo ahora" (issue #244): revived now that the connector
          orchestrator actually polls `etl_manual_trigger` (etl/manual_trigger.py).
          This queues a full sweep of every enabled connector; the button polls
          the trigger's status and refreshes the run list when it finishes.
          A per-connector run lives on the connectors-management page.
        */}
        <div className="flex flex-col items-end gap-2 text-right">
          <RunNowButton
            label="Ejecutar todo ahora"
            testIdSuffix="all"
            onFinished={() => {
              void fetchRuns(1);
              void fetchStats();
            }}
          />
          {/* #642 P1: connector management merged into Fuentes
              (/etl/connectors itself still 301s here, but nothing should
              route through that extra hop). */}
          <Link
            href="/admin/fuentes"
            className="text-sm font-medium hover:underline"
            style={{ color: "var(--accent)" }}
          >
            Gestionar conectores →
          </Link>
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
              Anuncios guardados
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-last-fetched"
            >
              {lastRun ? formatNumber(lastRun.total_fetched) : "—"}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              de {lastRun ? formatNumber(lastRun.total_discovered) : "—"}{" "}
              encontrados
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
          {/*
            The watermark-age KPI that used to sit here is gone: it read
            `etl_watermarks`, a table the per-table delta sync populated and
            nothing writes anymore. It could only ever render "—". The
            fetch-rate below is the connector-era equivalent — a real
            health signal rather than a permanently-empty one.
          */}
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Tasa de descarga
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-fetch-rate"
            >
              {formatFetchRate(fetchRate)}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Guardados / encontrados (últ. ejecución)
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-tremor-content dark:text-dark-tremor-content">
              Anuncios encontrados
            </p>
            <p
              className="mt-1 text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
              data-testid="kpi-discovered"
            >
              {formatNumber(stats.last_run.total_discovered)}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              En la última ejecución completada
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
                  formatNumber(errors24h.connectors_failed)
                : "—"}
            </p>
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Ejecuciones / conectores con error
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
    </div>
  );
}
