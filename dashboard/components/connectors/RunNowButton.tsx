"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isApiErrorResponse } from "@/lib/errors";

/**
 * "Ejecutar ahora" control (issue #244). POSTs to /api/etl/run — either a full
 * sweep (`connectorName` omitted/null) or one connector — then polls
 * GET /api/etl/run?id= until the run finishes, surfacing pending/running/done/
 * failed inline.
 *
 * The button only *signals* a run: the ETL poll loop (etl/manual_trigger.py)
 * picks the queued row up within ~10s and runs it. So "running" here reflects
 * the trigger's DB status, not a synchronous request.
 */

type Phase = "idle" | "sending" | "running" | "done" | "failed";

const POLL_INTERVAL_MS = 2000;
// Cap polling so a wedged/never-claimed trigger doesn't poll forever in the
// user's tab. ~5 min is comfortably longer than a normal sweep; past it we
// tell the user to check the run list rather than keep spinning.
const MAX_POLLS = 150;

export function RunNowButton({
  connectorName = null,
  label = "Ejecutar ahora",
  disabled = false,
  testIdSuffix,
  onFinished,
  style,
}: {
  connectorName?: string | null;
  label?: string;
  disabled?: boolean;
  /** Appended to data-testid: `run-now-<suffix>` / `run-status-<suffix>`. */
  testIdSuffix: string;
  /** Called when a run reaches a terminal state, so a parent can refresh. */
  onFinished?: () => void;
  style?: React.CSSProperties;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const pollsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Stop any in-flight poll if the component unmounts.
  useEffect(() => clearTimer, [clearTimer]);

  const poll = useCallback(
    async (triggerId: number) => {
      pollsRef.current += 1;
      if (pollsRef.current > MAX_POLLS) {
        setPhase("failed");
        setMessage("La ejecución tarda demasiado. Revisa el historial de ejecuciones.");
        return;
      }
      try {
        const res = await fetch(`/api/etl/run?id=${triggerId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setPhase("failed");
          setMessage(
            isApiErrorResponse(body) ? body.error : "No se pudo consultar el estado.",
          );
          return;
        }
        const row = await res.json();
        if (row.status === "done") {
          setPhase("done");
          setMessage("Ejecución completada.");
          onFinished?.();
          return;
        }
        if (row.status === "failed") {
          setPhase("failed");
          setMessage(row.error_msg ?? "La ejecución falló.");
          onFinished?.();
          return;
        }
        // pending / picked_up / running — keep polling.
        setPhase("running");
        timerRef.current = setTimeout(() => poll(triggerId), POLL_INTERVAL_MS);
      } catch (err) {
        setPhase("failed");
        setMessage(err instanceof Error ? err.message : "Error de red al consultar el estado.");
      }
    },
    [onFinished],
  );

  const start = useCallback(async () => {
    clearTimer();
    pollsRef.current = 0;
    setPhase("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/etl/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectorName ? { connector_name: connectorName } : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase("failed");
        setMessage(
          isApiErrorResponse(body) ? body.error : "No se pudo lanzar la ejecución.",
        );
        return;
      }
      setPhase("running");
      setMessage("Ejecución en cola…");
      void poll(body.trigger_id);
    } catch (err) {
      setPhase("failed");
      setMessage(err instanceof Error ? err.message : "Error de red al lanzar la ejecución.");
    }
  }, [clearTimer, connectorName, poll]);

  const busy = phase === "sending" || phase === "running";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}>
      <button
        type="button"
        onClick={start}
        disabled={disabled || busy}
        data-testid={`run-now-${testIdSuffix}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          minHeight: 44,
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-2)",
          color: "var(--fg)",
          fontSize: 13,
          cursor: disabled || busy ? "not-allowed" : "pointer",
          opacity: disabled || busy ? 0.6 : 1,
        }}
      >
        {busy ? "Ejecutando…" : label}
      </button>
      {message !== null && (
        <span
          data-testid={`run-status-${testIdSuffix}`}
          style={{
            fontSize: 12,
            color: phase === "failed" ? "var(--danger, #d33)" : "var(--fg-muted)",
          }}
        >
          {message}
        </span>
      )}
    </span>
  );
}
