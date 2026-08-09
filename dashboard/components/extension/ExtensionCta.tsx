"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExtensionSetup } from "@/components/extension/ExtensionSetup";
import type { ExtensionStatus } from "@/lib/extension-status";

/**
 * Inline "instalar/vincular la extensión" CTA (issue #509).
 *
 * Replaces the removed Extensión admin tab: every surface where a working
 * browser extension is actually needed drops one of these where the old static
 * "¿Primera vez?" link used to be. It polls GET /api/extension/status (presence
 * is server-mediated — the extension pings a heartbeat, see #509) and:
 *   - LINKED (a recent heartbeat)  → renders nothing (no CTA noise);
 *   - UNLINKED (no/stale heartbeat, or the status read failed) → a button that
 *     opens a modal with the full setup steps ({@link ExtensionSetup}) plus a
 *     deep-link to the canonical `/etl/extension` full page.
 *
 * `context` only tweaks the one-line copy + the testid so each placement is
 * addressable in e2e; the setup content is identical everywhere.
 */

type CtaContext = "captura" | "filtros" | "worklist" | "connectors" | "captured-urls";

const CONTEXT_COPY: Record<CtaContext, string> = {
  captura: "Para capturar necesitas la extensión del navegador instalada y vinculada.",
  filtros: "«Abrir» y fijar filtros requieren la extensión del navegador vinculada.",
  worklist: "La captura asistida necesita la extensión del navegador vinculada.",
  connectors: "Los portales de solo captura necesitan la extensión del navegador vinculada.",
  "captured-urls": "Capturar URLs de búsqueda requiere la extensión del navegador vinculada.",
};

export function ExtensionCta({ context }: { context: CtaContext }) {
  // `null` = still loading (render nothing to avoid a flash); once resolved we
  // know whether to show the CTA. A failed read is treated as unlinked so a
  // capture surface never silently hides the setup path.
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/extension/status");
        if (!res.ok) {
          if (!cancelled) setStatus({ linked: false, lastSeenAt: null, version: null });
          return;
        }
        const body = (await res.json()) as ExtensionStatus;
        if (!cancelled) setStatus(body);
      } catch {
        if (!cancelled) setStatus({ linked: false, lastSeenAt: null, version: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Loading, or linked → nothing to show. The e2e asserts the CTA is absent
  // once a heartbeat lands.
  if (!status || status.linked) return null;

  return (
    <div data-testid="extension-cta" data-context={context}>
      <button
        type="button"
        data-testid="extension-cta-button"
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 8,
          border: "1px solid var(--accent)",
          background: "var(--accent)",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Instalar o vincular la extensión
      </button>
      <p
        data-testid="extension-cta-note"
        style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}
      >
        {CONTEXT_COPY[context]}
      </p>

      {open && (
        <div
          data-testid="extension-setup-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Configurar la extensión de captura"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)",
              height: "100%",
              overflowY: "auto",
              background: "var(--bg-0, #fff)",
              padding: 24,
              boxShadow: "-8px 0 24px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
                Configurar la extensión de captura
              </h2>
              <button
                type="button"
                data-testid="extension-setup-modal-close"
                onClick={close}
                aria-label="Cerrar"
                style={{
                  marginLeft: "auto",
                  fontSize: 20,
                  lineHeight: 1,
                  background: "none",
                  border: "none",
                  color: "var(--fg-muted)",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-muted)", margin: "0 0 16px", lineHeight: 1.5 }}>
              Descarga la extensión, cárgala en Chrome y pega la URL y la clave de abajo en sus
              opciones (una sola vez).{" "}
              <Link
                href="/etl/extension"
                data-testid="extension-cta-fullpage"
                style={{ color: "var(--accent)", textDecoration: "none" }}
              >
                Abrir en página completa →
              </Link>
            </p>
            <ExtensionSetup />
          </div>
        </div>
      )}
    </div>
  );
}
