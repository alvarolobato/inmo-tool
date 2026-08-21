"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExtensionSetup } from "@/components/extension/ExtensionSetup";
import { updateAvailable, type ExtensionStatusResponse } from "@/lib/extension-status";

/**
 * Inline extension install / update CTA (issues #509, #527).
 *
 * The Extensión admin tab is gone, so this inline CTA is the ONLY discoverable
 * path to install, reinstall, or update the browser extension — it therefore
 * must never fully disappear (the #527 regression: it hid whenever `linked`, so
 * after one capture the operator had no way to reinstall/update). It polls
 * GET /api/extension/status (presence is server-mediated via a heartbeat, #509)
 * and renders one of three states, all of which reach the same setup modal:
 *   - UNLINKED (no/stale heartbeat, or the read failed) → a prominent
 *     "Instalar o vincular la extensión" button;
 *   - LINKED but the installed version is older than the served one → an
 *     "Actualización disponible (vX → vY)" prompt with an update link;
 *   - LINKED and up to date → a DISCREET "Extensión vinculada (vX)" chip with a
 *     "Gestionar / actualizar" link, so reinstall/update is always reachable.
 * Only the brief initial load (before the first status resolves) renders nothing.
 *
 * `context` only tweaks the one-line copy + the testid so each placement is
 * addressable in e2e; the setup content is identical everywhere.
 */

type CtaContext = "captura" | "filtros" | "worklist" | "connectors";

const CONTEXT_COPY: Record<CtaContext, string> = {
  captura: "Para capturar necesitas la extensión del navegador instalada y vinculada.",
  filtros: "«Abrir» y fijar filtros requieren la extensión del navegador vinculada.",
  worklist: "La captura asistida necesita la extensión del navegador vinculada.",
  connectors: "Los portales de solo captura necesitan la extensión del navegador vinculada.",
};

export function ExtensionCta({ context }: { context: CtaContext }) {
  // `null` = still loading (render nothing to avoid a flash); once resolved we
  // always render some state. A failed read is treated as unlinked so a
  // capture surface never silently hides the setup path.
  const [status, setStatus] = useState<ExtensionStatusResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/extension/status");
        if (!res.ok) {
          if (!cancelled)
            setStatus({ linked: false, lastSeenAt: null, version: null, servedVersion: null });
          return;
        }
        const body = (await res.json()) as ExtensionStatusResponse;
        if (!cancelled) setStatus(body);
      } catch {
        if (!cancelled)
          setStatus({ linked: false, lastSeenAt: null, version: null, servedVersion: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Only the initial load renders nothing (avoid a flash). Every resolved state
  // below keeps install/update reachable — the #527 fix (never fully hide).
  if (!status) return null;

  const linkStyle = {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    color: "var(--accent)",
    cursor: "pointer",
    textDecoration: "underline",
  } as const;

  const canUpdate = status.linked && updateAvailable(status.version, status.servedVersion);

  return (
    <div data-testid="extension-cta" data-context={context} data-linked={String(status.linked)}>
      {!status.linked ? (
        // ── UNLINKED: prominent install/link button ──────────────────────────
        <>
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
        </>
      ) : canUpdate ? (
        // ── LINKED, outdated: update-available prompt ────────────────────────
        <div
          data-testid="extension-cta-update"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 8,
            border: "1px solid var(--warn, #b45309)",
            background: "var(--warn-bg, rgba(180,83,9,0.08))",
            color: "var(--warn, #b45309)",
            lineHeight: 1.4,
          }}
        >
          <span>
            Actualización disponible (v{status.version} → v{status.servedVersion})
          </span>
          <button
            type="button"
            data-testid="extension-cta-manage"
            onClick={() => setOpen(true)}
            style={{ ...linkStyle, color: "var(--warn, #b45309)", fontWeight: 600 }}
          >
            Actualizar
          </button>
        </div>
      ) : (
        // ── LINKED, up to date: discreet chip + manage/update link ───────────
        <div
          data-testid="extension-cta-linked"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--fg-muted)",
            lineHeight: 1.4,
          }}
        >
          <span aria-hidden="true">●</span>
          <span>Extensión vinculada{status.version ? ` (v${status.version})` : ""}</span>
          <button
            type="button"
            data-testid="extension-cta-manage"
            onClick={() => setOpen(true)}
            style={linkStyle}
          >
            Gestionar / actualizar
          </button>
        </div>
      )}

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
