"use client";

/**
 * #407 — per-candidate "descartar" (dismiss) button on /admin/candidatos.
 *
 * POSTs the slug (with an optional reason) to /api/admin/candidatos/dismiss.
 * Auth rides on the same-origin `ps_admin` cookie (set by /admin/login), so the
 * raw admin key is never embedded in the client bundle — same pattern the rest
 * of the admin UI uses. On success it calls `router.refresh()` so the server
 * component re-queries and the now-dismissed candidate disappears (it is
 * excluded by `getPromotionCandidates`).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DismissButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDismiss() {
    if (busy) return;
    const reason = window.prompt(
      `Descartar "${slug}" como candidato (revisado y rechazado).\n` +
        `Motivo (opcional):`,
      "",
    );
    // A null return means the user cancelled the prompt — do nothing.
    if (reason === null) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/candidatos/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al descartar");
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        data-testid={`dismiss-${slug}`}
        onClick={onDismiss}
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
        {busy ? "Descartando…" : "Descartar"}
      </button>
      {error && (
        <span data-testid={`dismiss-error-${slug}`} style={{ fontSize: 12, color: "var(--warn, #f59e0b)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
