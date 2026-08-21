"use client";

/**
 * "Borrar" button on /admin/diagnostics (issue #671) — the no-SQL delete path
 * the exit criterion asks for. Same pattern as
 * app/admin/clasificacion/DismissButton.tsx: same-origin fetch riding the
 * `ps_admin` cookie (no raw admin key in the client bundle), then
 * router.refresh() so the deleted row disappears from the server-rendered list.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteDiagnosticButton({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (busy) return;
    if (!window.confirm(`¿Borrar el diagnóstico #${id}? No se puede deshacer.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/diagnostics/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al borrar");
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        data-testid={`delete-diagnostic-${id}`}
        onClick={onDelete}
        disabled={busy}
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--warn, #f59e0b)",
          background: "transparent",
          border: "1px solid var(--warn, #f59e0b)",
          borderRadius: 6,
          padding: "4px 12px",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "Borrando…" : "Borrar"}
      </button>
      {error && (
        <span style={{ fontSize: 12, color: "var(--warn, #f59e0b)" }}>{error}</span>
      )}
    </div>
  );
}
