"use client";

import { useState, useEffect } from "react";
import { useFreshness } from "@/components/FreshnessContext";

const DISMISSED_KEY = "data-health-dismissed";

/** Format an ISO date string as "DD/MM/YYYY a las HH:MM" in Spanish. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} a las ${time}`;
}

export function DataFreshnessBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { health } = useFreshness();

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISSED_KEY) === "1") setDismissed(true);
    } catch {
      // sessionStorage not available (e.g. in tests without jsdom)
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // ignore
    }
  };

  // No health data yet, no stale tables, or dismissed → don't render
  if (!health || !health.overallStale) return null;
  if (dismissed) return null;

  const stalest = health.stalestTable;
  const staleCount = health.tables.filter((t) => t.isStale).length;

  return (
    <div
      role="alert"
      data-testid="data-freshness-banner"
      className="mb-4 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/20"
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Warning icon */}
          <svg
            className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {stalest
              ? `Los datos de ${stalest.name} se actualizaron por última vez el ${formatDate(stalest.lastSync)}. Pueden no reflejar las operaciones más recientes.`
              : `${staleCount} tabla${staleCount !== 1 ? "s" : ""} con datos desactualizados.`}
          </span>
        </div>

        <div className="flex items-center gap-1 ml-3 shrink-0">
          {/* Collapse/expand toggle */}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expandir detalles" : "Contraer detalles"}
            className="rounded p-1 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-800/40 transition-colors"
            data-testid="banner-collapse-toggle"
          >
            <svg
              className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m19.5 8.25-7.5 7.5-7.5-7.5"
              />
            </svg>
          </button>

          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            aria-label="Cerrar aviso"
            className="rounded p-1 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-800/40 transition-colors"
            data-testid="banner-dismiss"
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
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Collapsible detail list */}
      {!collapsed && health.tables.some((t) => t.isStale) && (
        <div className="border-t border-amber-200 dark:border-amber-800/40 px-4 py-2">
          <ul className="space-y-1">
            {health.tables
              .filter((t) => t.isStale)
              .map((t) => (
                <li
                  key={t.name}
                  className="text-xs text-amber-700 dark:text-amber-400"
                >
                  <span className="font-medium">{t.name}</span>
                  {" — "}última sincronización: {formatDate(t.lastSync)}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
