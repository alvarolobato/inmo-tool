"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Recalcular" for the ETL-connectors section of "Validar filtros" (issue #478
 * P4). Reuses the existing manual-trigger endpoint (POST /api/etl/run): the ETL
 * poll loop runs a sweep and republishes `connector_search_preview` at the end
 * of it (etl.orchestrator.publish_search_previews). A 409 (a run already
 * pending) is reported as an informational message, not an error surface.
 */
export function RecalcularPreviewsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/etl/run", { method: "POST" });
      if (res.status === 409) {
        setMsg("Ya hay una ejecución pendiente; las previsualizaciones se actualizarán al terminar.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMsg(body?.error ?? "No se pudo lanzar el recálculo.");
        return;
      }
      setMsg("Recálculo lanzado; vuelve en unos minutos y refresca la página.");
      router.refresh();
    } catch {
      setMsg("No se pudo lanzar el recálculo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button
        type="button"
        data-testid="etl-recalcular"
        onClick={onClick}
        disabled={busy}
        style={{
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 500,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--fg)",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Lanzando…" : "Recalcular"}
      </button>
      {msg && (
        <span data-testid="etl-recalcular-msg" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          {msg}
        </span>
      )}
    </span>
  );
}
