"use client";

/**
 * ErrorDisplay — reusable error component for the Dashboard App.
 *
 * Shows:
 *   - A clear Spanish user-facing message (always visible)
 *   - An expandable "Detalles técnicos" section (collapsed by default)
 *   - A "Copiar detalles" button that copies the full error JSON to clipboard
 *   - An optional "Reintentar" callback button
 */

import { useState, useRef, useEffect } from "react";
import type { ApiErrorResponse } from "@/lib/errors";
import AgenticErrorDetails from "@/components/AgenticErrorDetails";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ErrorDisplayProps {
  /** The structured error from the API, or a plain string message. */
  error: ApiErrorResponse | string;
  /** Optional context title shown before the error message (e.g. widget name). */
  title?: string;
  /** Optional retry callback — renders a "Reintentar" button when provided. */
  onRetry?: () => void;
  /** Extra Tailwind classes for the container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function buildCopyText(error: ApiErrorResponse | string): string {
  if (typeof error === "string") return error;
  return JSON.stringify(error, null, 2);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ErrorDisplay({ error, title, onRetry, className = "" }: ErrorDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending copy-reset timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const message = typeof error === "string" ? error : error.error;
  const isStructured = typeof error !== "string";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildCopyText(error));
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch {
      // Clipboard not available — silently ignore
    }
  };

  return (
    <div
      className={`rounded-lg border border-red-500/30 bg-red-500/10 p-4 ${className}`}
      role="alert"
      data-testid="error-display"
    >
      {/* Context title (e.g. widget name) */}
      {title && (
        <p className="mb-1 text-xs font-semibold text-red-400 uppercase tracking-wide">
          {title}
        </p>
      )}

      {/* User-facing message */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-red-400 flex-shrink-0" aria-hidden="true">
          &#9888;
        </span>
        <p className="text-sm font-medium text-red-400">{message}</p>
      </div>

      {/* Expandable technical details — only when we have structured info */}
      {isStructured && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
            aria-expanded={expanded}
            data-testid="toggle-details"
          >
            <span
              className="inline-block transition-transform"
              style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
              aria-hidden="true"
            >
              &#9656;
            </span>
            Detalles técnicos
          </button>

          {expanded && (
            <div className="mt-2" data-testid="technical-details">
              {/* Header (always shown) — code, timestamp, requestId, and the
                  optional `details` string. Rich diagnostic sections appear
                  below via AgenticErrorDetails. */}
              <div
                className="rounded bg-red-900/20 p-3 text-xs text-red-300 font-mono space-y-1"
              >
                <div>
                  <span className="font-semibold">Código:</span>{" "}
                  {(error as ApiErrorResponse).code}
                </div>
                <div>
                  <span className="font-semibold">Hora:</span>{" "}
                  {formatTimestamp((error as ApiErrorResponse).timestamp)}
                </div>
                <div>
                  <span className="font-semibold">ID:</span>{" "}
                  {(error as ApiErrorResponse).requestId}
                </div>
                {(error as ApiErrorResponse).details && (
                  <div>
                    <span className="font-semibold">Detalle:</span>{" "}
                    <span className="whitespace-pre-wrap">
                      {(error as ApiErrorResponse).details}
                    </span>
                  </div>
                )}
              </div>
              {/* Rich diagnostic sections (Contexto / CLI / Tool / Límites). */}
              <AgenticErrorDetails errorDetail={error as ApiErrorResponse} skipHeader />
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      {(isStructured || onRetry) && (
        <div className="mt-3 flex items-center gap-3">
          {isStructured && (
            <button
              type="button"
              onClick={handleCopy}
              className="text-xs font-medium text-red-400 hover:text-red-300 underline transition-colors"
              data-testid="copy-details"
            >
              {copied ? "Copiado!" : "Copiar como JSON"}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-xs font-medium text-red-400 hover:text-red-300 underline transition-colors"
              data-testid="retry-button"
            >
              Reintentar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ErrorDisplay;
