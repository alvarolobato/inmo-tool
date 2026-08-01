"use client";

/**
 * GlossaryPanel — slide-out panel listing glossary terms alphabetically.
 *
 * Opened via a "Glosario" toolbar button (rendered by the parent page).
 * Terms are sorted A-Z. Clicking the backdrop or the close button dismisses
 * the panel. All UI text is in Spanish.
 */

import { useEffect, useCallback } from "react";
import type { GlossaryItem } from "@/lib/schema";

export interface GlossaryPanelProps {
  glossary: GlossaryItem[];
  isOpen: boolean;
  onClose: () => void;
}

export function GlossaryPanel({ glossary, isOpen, onClose }: GlossaryPanelProps) {
  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const sorted = [...glossary].sort((a, b) =>
    a.term.localeCompare(b.term, "es", { sensitivity: "base" }),
  );

  return (
    <>
      {/* Semi-transparent backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        aria-hidden="true"
        onClick={onClose}
        data-testid="glossary-backdrop"
      />

      {/* Slide-out panel — non-modal: no focus trapping, background remains interactive */}
      <div
        role="dialog"
        aria-label="Glosario de Métricas"
        className={[
          "fixed right-0 top-0 h-full w-80 z-50",
          "bg-tremor-background dark:bg-dark-tremor-background",
          "border-l border-tremor-border dark:border-dark-tremor-border",
          "shadow-xl flex flex-col",
        ].join(" ")}
        data-testid="glossary-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-tremor-border dark:border-dark-tremor-border px-4 py-3">
          <h2 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Glosario de Métricas
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar glosario"
            className="rounded p-1 text-tremor-content dark:text-dark-tremor-content hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors"
          >
            {/* X icon */}
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

        {/* Term list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {sorted.length === 0 ? (
            <p className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              No hay términos en el glosario.
            </p>
          ) : (
            sorted.map((entry, i) => (
              <div key={i} data-testid="glossary-entry">
                <p className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                  {entry.term}
                </p>
                <p className="mt-0.5 text-xs text-tremor-content dark:text-dark-tremor-content leading-relaxed">
                  {entry.definition}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
