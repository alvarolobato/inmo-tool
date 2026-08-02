"use client";

import Link from "next/link";
import { Badge } from "@tremor/react";
import { formatDuration, formatNumber } from "@/lib/etl-format";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: string;
  total_connectors: number | null;
  connectors_ok: number | null;
  connectors_failed: number | null;
  /** Issue #99 — NULL on runs recorded before that column existed. */
  connectors_skipped: number | null;
  total_discovered: number | null;
  total_fetched: number | null;
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
  startup: "Arranque",
  manual: "Manual",
  cli: "CLI",
};

function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

/**
 * "3 / 0 / 1" = ok / failed / skipped. Skipped is only rendered when the
 * column has a value (it's NULL on pre-#99 runs) AND is non-zero, so the
 * common case stays a clean two-number cell — but a run where an operator
 * disabled something never looks identical to a healthy empty one, which
 * is the whole reason #99 added the counter.
 */
function connectorCounts(run: ConnectorRun): string {
  if (run.connectors_ok === null) return "—";
  const base = `${run.connectors_ok} / ${run.connectors_failed ?? 0}`;
  if (run.connectors_skipped) return `${base} / ${run.connectors_skipped}`;
  return base;
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
  runs: ConnectorRun[];
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
          Las ejecuciones aparecerán aquí cuando el orquestador de conectores
          complete su primer barrido.
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
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Iniciada</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider">Duración</th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider"
                title="Conectores OK / con error / omitidos"
              >
                Conectores
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider" title="Anuncios encontrados en la fase de descubrimiento">Encontrados</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-tremor-content dark:text-dark-tremor-content uppercase tracking-wider" title="Anuncios descargados y guardados">Guardados</th>
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
                <td
                  className="px-4 py-3 tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis"
                  data-testid={`run-connectors-${run.id}`}
                >
                  <Link href={`/etl/${run.id}`} className="block">
                    {connectorCounts(run)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-tremor-content dark:text-dark-tremor-content">
                  <Link href={`/etl/${run.id}`} className="block">
                    {formatNumber(run.total_discovered)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  <Link href={`/etl/${run.id}`} className="block">
                    {formatNumber(run.total_fetched)}
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
