"use client";

/**
 * VersionHistory — slide-out listing dashboard spec versions with restore.
 */

import { useEffect, useCallback, useState, useRef } from "react";
import type { DashboardSpec } from "@/lib/schema";
import { isApiErrorResponse } from "@/lib/errors";

export interface VersionHistoryProps {
  dashboardId: number;
  isOpen: boolean;
  onClose: () => void;
  onRestore: (spec: DashboardSpec) => void;
}

interface VersionRow {
  id: number;
  version_number: number;
  prompt: string | null;
  widget_count: number;
  created_at: string;
}

function formatRelativePast(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return rtf.format(diffSec, "second");
  if (absSec < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (absSec < 604800) return rtf.format(Math.round(diffSec / 86400), "day");
  if (absSec < 2_592_000) return rtf.format(Math.round(diffSec / 604800), "week");
  if (absSec < 31_536_000) return rtf.format(Math.round(diffSec / 2_592_000), "month");
  return rtf.format(Math.round(diffSec / 31_536_000), "year");
}

function truncatePrompt(text: string | null, max = 80): string {
  const s = (text ?? "").trim();
  if (s.length <= max) return s || "—";
  return `${s.slice(0, max)}…`;
}

export function VersionHistory({
  dashboardId,
  isOpen,
  onClose,
  onRestore,
}: VersionHistoryProps) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const restoreBusy = restoringId !== null;

  const safeClose = useCallback(() => {
    if (restoreBusy) return;
    onClose();
  }, [onClose, restoreBusy]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") safeClose();
    },
    [safeClose],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows(null);

    (async () => {
      try {
        const res = await fetch(`/api/dashboard/${dashboardId}/versions`);
        const data: unknown = await res.json();
        if (!res.ok) {
          const msg =
            isApiErrorResponse(data) && typeof data.error === "string"
              ? data.error
              : "No se pudo cargar el historial.";
          if (!cancelled) setError(msg);
          return;
        }
        if (!Array.isArray(data)) {
          if (!cancelled) setError("Respuesta del servidor no válida.");
          return;
        }
        if (!cancelled) setRows(data as VersionRow[]);
      } catch {
        if (!cancelled) setError("Error de red al cargar el historial.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, dashboardId]);

  async function handleRestore(versionId: number) {
    if (!isMountedRef.current) return;
    setRestoringId(versionId);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${dashboardId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: versionId }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          isApiErrorResponse(data) && typeof data.error === "string"
            ? data.error
            : "No se pudo restaurar la versión.";
        if (isMountedRef.current) setError(msg);
        return;
      }
      if (
        !data ||
        typeof data !== "object" ||
        !("spec" in data) ||
        !data.spec ||
        typeof data.spec !== "object"
      ) {
        if (isMountedRef.current) setError("Respuesta del servidor no válida.");
        return;
      }
      if (isMountedRef.current) onRestore(data.spec as DashboardSpec);
    } catch {
      if (isMountedRef.current) setError("Error de red al restaurar.");
    } finally {
      if (isMountedRef.current) setRestoringId(null);
    }
  }

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30"
        aria-hidden="true"
        onClick={safeClose}
        data-testid="version-history-backdrop"
      />

      <div
        role="dialog"
        aria-label="Historial de versiones"
        className={[
          "fixed right-0 top-0 h-full w-80 z-50",
          "bg-tremor-background dark:bg-dark-tremor-background",
          "border-l border-tremor-border dark:border-dark-tremor-border",
          "shadow-xl flex flex-col",
        ].join(" ")}
        data-testid="version-history-panel"
      >
        <div className="flex items-center justify-between border-b border-tremor-border dark:border-dark-tremor-border px-4 py-3">
          <h2 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Historial de versiones
          </h2>
          <button
            type="button"
            onClick={safeClose}
            disabled={restoreBusy}
            aria-label="Cerrar historial"
            className="rounded p-1 text-tremor-content dark:text-dark-tremor-content hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <p className="text-sm text-red-500" data-testid="version-history-error">
              {error}
            </p>
          )}

          {loading && (
            <div className="space-y-3 animate-pulse" data-testid="version-history-skeleton">
              <div className="h-4 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
              <div className="h-16 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
              <div className="h-16 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
            </div>
          )}

          {!loading && rows && rows.length === 0 && (
            <p className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              Sin historial de versiones.
            </p>
          )}

          {!loading &&
            rows &&
            rows.map((v) => (
              <div
                key={v.id}
                className="rounded-lg border border-tremor-border dark:border-dark-tremor-border p-3 space-y-2"
                data-testid="version-history-entry"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                    v{v.version_number}
                  </span>
                  <span className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle shrink-0">
                    {formatRelativePast(v.created_at)}
                  </span>
                </div>
                <p className="text-xs text-tremor-content dark:text-dark-tremor-content leading-snug">
                  {truncatePrompt(v.prompt)}
                </p>
                <p className="text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                  {v.widget_count === 1 ? "1 widget" : `${v.widget_count} widgets`}
                </p>
                <button
                  type="button"
                  disabled={restoringId !== null}
                  onClick={() => void handleRestore(v.id)}
                  className="w-full rounded-md border border-tremor-border dark:border-dark-tremor-border px-2 py-1.5 text-xs font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle disabled:opacity-50 transition-colors"
                >
                  {restoringId === v.id ? "Restaurando…" : "Restaurar"}
                </button>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
