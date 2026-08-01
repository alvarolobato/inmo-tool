"use client";

import { useEffect, useRef, useState } from "react";
import { SYNC_NAMES_WITH_WATERMARK } from "@/lib/etl-sync-names";

/**
 * Modal letting the user trigger an ETL sync with optional force-resync
 * semantics (issue #398). The caller owns the actual POST to /api/etl/run;
 * this component only collects the user's choices and returns them via
 * onConfirm.
 */
export interface ForceResyncOptions {
  forceFull: boolean;
  tables: string[];
}

const TABLE_LABELS: Record<string, string> = {
  articulos: "Artículos",
  clientes: "Clientes",
  ccstock: "Stock central (CCStock)",
  facturas: "Facturas",
  stock: "Stock (Exportaciones)",
  ventas: "Ventas",
  lineas_ventas: "Líneas de ventas",
  pagos_ventas: "Pagos de ventas",
  gc_albaranes: "Albaranes mayorista",
  gc_lin_albarane: "Líneas albaranes mayorista",
  gc_facturas: "Facturas mayorista",
  gc_lin_facturas: "Líneas facturas mayorista",
  traspasos: "Traspasos",
};

export const RESYNCABLE_TABLES: ReadonlyArray<{ name: string; label: string }> =
  SYNC_NAMES_WITH_WATERMARK.map((name) => ({
    name,
    label: TABLE_LABELS[name] ?? name,
  }));

const DEFAULT_SELECTED = new Set(["stock", "ventas", "lineas_ventas"]);

interface ForceResyncDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: ForceResyncOptions) => void;
  disabled?: boolean;
}

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ForceResyncDialog({
  open,
  onClose,
  onConfirm,
  disabled = false,
}: ForceResyncDialogProps) {
  const [forceFull, setForceFull] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(DEFAULT_SELECTED),
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Track the element that had focus before the dialog opened so we can
  // restore it when the dialog closes.
  const previousFocusRef = useRef<Element | null>(null);

  // Reset every time the dialog is (re)opened so stale state never leaks.
  // Also save/restore focus and move focus into the dialog on open.
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      setForceFull(false);
      setSelected(new Set(DEFAULT_SELECTED));
      // Move focus to the first focusable element inside the dialog.
      // rAF defers until after the browser has painted the newly opened dialog.
      const raf = requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>(
          FOCUSABLE_SELECTORS,
        );
        first?.focus();
      });
      return () => cancelAnimationFrame(raf);
    } else {
      // Restore focus to the previously focused element when dialog closes.
      if (
        previousFocusRef.current instanceof HTMLElement ||
        previousFocusRef.current instanceof SVGElement
      ) {
        previousFocusRef.current.focus();
      }
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Focus trap: keep Tab/Shift+Tab cycling within the dialog.
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const canConfirm = forceFull || selected.size > 0;

  const handleConfirm = () => {
    onConfirm({
      forceFull,
      tables: forceFull ? [] : Array.from(selected),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Forzar re-sincronización"
      data-testid="force-resync-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900"
      >
        <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Forzar re-sincronización
        </h2>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Borra los watermarks seleccionados para que la próxima ejecución
          vuelva a bajar todas las filas (no sólo el delta).
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={forceFull}
            onChange={(e) => setForceFull(e.target.checked)}
            data-testid="force-full-checkbox"
          />
          <span>
            Forzar re-sync completo (todas las tablas incrementales){" "}
            <span className="text-amber-600">— puede tardar &gt; 1h</span>
          </span>
        </label>

        <fieldset
          className="mt-4 space-y-1"
          disabled={forceFull}
          aria-label="Tablas a re-sincronizar"
        >
          <legend className="mb-2 text-xs uppercase tracking-wide text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
            ...o elige tablas individuales:
          </legend>
          {RESYNCABLE_TABLES.map((t) => (
            <label
              key={t.name}
              className={`flex items-center gap-2 text-sm ${
                forceFull
                  ? "opacity-50"
                  : "text-tremor-content-strong dark:text-dark-tremor-content-strong"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(t.name)}
                onChange={() => toggleTable(t.name)}
                data-testid={`force-table-${t.name}`}
                disabled={forceFull}
              />
              <span>{t.label}</span>
              <code className="ml-auto text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                {t.name}
              </code>
            </label>
          ))}
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={disabled}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-tremor-content hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={disabled || !canConfirm}
            data-testid="force-confirm-button"
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Forzar y sincronizar
          </button>
        </div>
      </div>
    </div>
  );
}
