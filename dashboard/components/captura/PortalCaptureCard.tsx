"use client";

import { portalLabel, type PortalCaptureView } from "@/lib/captura-view";

/**
 * One capture portal on the top-level `/captura` execution page (issue #268).
 *
 * Read-mostly + a single launch action. The card shows:
 *   - the portal name + its worklist progress (captured/total, a bar, and the
 *     pending/skipped/failed breakdown — all from the GLOBAL worklist roll-up);
 *   - any loosened-constraint notes for the profile's pre-filtered search
 *     ("búsqueda ampliada: …") so the operator knows the URL is BROADER than
 *     the profile asked for (issue #267 — the URLs are reverse-engineered and
 *     unverified, so we surface them, never hide them);
 *   - "Abrir búsqueda", which opens the pre-filtered portal search in a new tab.
 *     From there the browser extension's batch capture (issue #262) takes over.
 *
 * The card never captures or navigates the operator itself — capturing happens
 * in the extension. This is the launch pad + progress mirror.
 */
export function PortalCaptureCard({ view }: { view: PortalCaptureView }) {
  const { portal, tasks, summary, capturedPct } = view;
  const label = portalLabel(portal);

  return (
    <div
      data-testid={`captura-portal-${portal}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header: portal name */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15, color: "var(--fg)" }}>{label}</strong>
      </div>

      {/* One openable pre-filtered search per task (idealista/aliseda search one
          section at a time), each with its own loosened-constraint notes. */}
      <ul
        data-testid={`captura-tasks-${portal}`}
        style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}
      >
        {tasks.map((task) => (
          <li key={task.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "var(--fg)" }}>{task.label}</span>
              <a
                data-testid={`captura-open-${task.id}`}
                href={task.url}
                target="_blank"
                rel="noopener noreferrer"
                title={task.url}
                style={{
                  marginLeft: "auto",
                  padding: "6px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 8,
                  background: "var(--accent)",
                  color: "#fff",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Abrir búsqueda ↗
              </a>
            </div>
            {task.loosened.length > 0 && (
              <ul
                data-testid={`captura-loosened-${task.id}`}
                style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}
              >
                {task.loosened.map((l) => (
                  <li
                    key={l.constraint + l.reason}
                    style={{
                      fontSize: 12,
                      color: "var(--warn)",
                      background: "var(--warn-bg)",
                      borderRadius: 6,
                      padding: "4px 8px",
                    }}
                  >
                    <strong>búsqueda ampliada:</strong> {l.reason}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {/* Worklist progress for this portal (global roll-up). */}
      {summary ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", fontSize: 13 }}>
            <span data-testid={`captura-captured-${portal}`} style={{ color: "var(--fg)" }}>
              {summary.captured}/{summary.total} capturadas
            </span>
            <span style={{ color: "var(--fg-muted)" }}>{summary.pending} pendientes</span>
            {summary.failed > 0 && <span style={{ color: "var(--down)" }}>{summary.failed} fallidas</span>}
            {summary.skipped > 0 && (
              <span style={{ color: "var(--fg-muted)" }}>{summary.skipped} omitidas</span>
            )}
            <span style={{ color: "var(--fg-muted)", marginLeft: "auto" }}>{capturedPct}%</span>
          </div>
          <div
            data-testid={`captura-progress-${portal}`}
            role="progressbar"
            aria-valuenow={capturedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label}: ${capturedPct}% capturadas`}
            style={{ height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}
          >
            <div
              style={{ width: `${capturedPct}%`, height: "100%", background: "var(--up)", transition: "width 0.2s" }}
            />
          </div>
        </div>
      ) : (
        <p
          data-testid={`captura-nolist-${portal}`}
          style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}
        >
          Aún sin lista de captura para {label}. Abre la búsqueda y captura desde la extensión: las
          URLs aparecerán aquí a medida que lleguen.
        </p>
      )}
    </div>
  );
}
