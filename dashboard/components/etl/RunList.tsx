"use client";

import Link from "next/link";
import { Badge } from "@tremor/react";
import { formatDuration, formatNumber } from "@/lib/etl-format";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EtlSyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: string;
  /** 'delta' (hourly watermark sweep) or 'full' (nightly truncate-and-reinsert). */
  kind: "delta" | "full";
  total_tables: number | null;
  tables_ok: number | null;
  tables_failed: number | null;
  total_rows_synced: number | null;
  trigger: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type BadgeColor = "emerald" | "amber" | "red" | "blue" | "gray";

function statusBadgeColor(status: string): BadgeColor {
  switch (status) {
    case "success": return "emerald";
    case "partial": return "amber";
    case "failed": return "red";
    case "running": return "blue";
    default: return "gray";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "success": return "Completado";
    case "partial": return "Parcial";
    case "failed": return "Error";
    case "running": return "En curso";
    default: return status;
  }
}

function formatDatetime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: "Programado",
  manual: "Manual",
};

function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

function kindLabel(kind: "delta" | "full"): string {
  return kind === "delta" ? "Delta" : "Completa";
}

function kindBadgeColor(kind: "delta" | "full"): BadgeColor {
  // Delta = blue (cheap, frequent, watermark sweep).
  // Full  = gray (heavy nightly job; not an alert state, just denser).
  return kind === "delta" ? "blue" : "gray";
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function RunListSkeleton() {
  return (
    <div className="animate-pulse space-y-2" aria-busy="true" role="status" aria-label="Cargando">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-md bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle"
        />
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface RunListProps {
  runs: EtlSyncRun[];
  total: number;
  page: number;
  perPage: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export function RunList({ runs, total, page, perPage, loading, onPageChange }: RunListProps) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  if (loading) {
    return <RunListSkeleton />;
  }

  if (runs.length === 0) {
    return (
      <div
        className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-8 text-center"
        data-testid="run-list-empty"
      >
        <p className="text-sm font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
          No hay ejecuciones registradas
        </p>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Las ejecuciones de ETL aparecerán aquí una vez que el pipeline esté instrumentado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="run-list">
      <div className="overflow-x-auto rounded-lg border border-tremor-border dark:border-dark-tremor-border">
        <table className="w-full text-sm">
          <thead className="bg-tremor-background-muted dark:bg-dark-tremor-background-muted">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Estado</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Tipo</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Iniciada</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Duración</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Tablas OK / Error</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Filas sync.</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Disparado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-tremor-border dark:divide-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background">
            {runs.map((run) => (
              <tr
                key={run.id}
                className="hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors"
                data-testid={`run-row-${run.id}`}
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/etl/${run.id}`}
                    className="flex items-center"
                    aria-label={`Ver ejecución ${run.id}`}
                  >
                    <Badge color={statusBadgeColor(run.status)} size="xs">
                      {statusLabel(run.status)}
                    </Badge>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/etl/${run.id}`} className="block">
                    <Badge color={kindBadgeColor(run.kind)} size="xs">
                      {kindLabel(run.kind)}
                    </Badge>
                  </Link>
                </td>
                <td className="px-4 py-3 text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  <Link href={`/etl/${run.id}`} className="block">
                    {formatDatetime(run.started_at)}
                  </Link>
                </td>
                <td className="px-4 py-3 tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  <Link href={`/etl/${run.id}`} className="block">
                    {formatDuration(run.duration_ms)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  <Link href={`/etl/${run.id}`} className="block">
                    {run.tables_ok !== null
                      ? `${run.tables_ok} / ${run.tables_failed ?? 0}`
                      : "—"}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  <Link href={`/etl/${run.id}`} className="block">
                    {formatNumber(run.total_rows_synced)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-tremor-content dark:text-dark-tremor-content">
                  <Link href={`/etl/${run.id}`} className="block">
                    {triggerLabel(run.trigger)}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between" data-testid="pagination">
        <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
          {total} ejecución{total !== 1 ? "es" : ""} · página {page} de {totalPages}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="rounded-md border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="prev-page"
          >
            Anterior
          </button>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="rounded-md border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="next-page"
          >
            Siguiente
          </button>
        </div>
      </div>
    </div>
  );
}
