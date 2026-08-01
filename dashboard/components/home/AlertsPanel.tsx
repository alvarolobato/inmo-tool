"use client";

import type { HomeAlert } from "@/lib/home-types";
import { SectionHeader } from "./SectionHeader";

type Alert = HomeAlert;

interface AlertsPanelProps {
  alerts: HomeAlert[];
  /** "revisado hace N min" label */
  reviewedAgo?: string;
}

function sevConfig(sev: Alert["sev"]) {
  if (sev === "crit")
    return { color: "var(--down)", bg: "var(--down-bg)", label: "CRÍTICO" };
  if (sev === "warn")
    return { color: "var(--warn)", bg: "var(--warn-bg)", label: "AVISO" };
  return { color: "var(--fg-muted)", bg: "var(--bg-2)", label: "INFO" };
}

export function AlertsPanel({ alerts, reviewedAgo = "12 min" }: AlertsPanelProps) {
  const activeCount = alerts.filter((a) => a.sev !== "info").length;

  const outlineBtn: React.CSSProperties = {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--fg)",
    fontSize: 11,
    fontWeight: 500,
    padding: "0 10px",
    borderRadius: 4,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="alerts-panel"
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <SectionHeader
          title="Alertas"
          subtitle={`${activeCount} activas · revisado hace ${reviewedAgo}`}
        />
        <button
          type="button"
          style={{ ...outlineBtn, opacity: 0.5, cursor: "not-allowed" }}
          aria-label="Configurar reglas de alertas (próximamente)"
          title="Próximamente"
          disabled
        >
          Configurar reglas
        </button>
      </div>

      {/* Alert list */}
      {alerts.length === 0 ? (
        <div
          style={{
            padding: "32px 16px",
            textAlign: "center",
            color: "var(--fg-subtle)",
            fontSize: 13,
          }}
          data-testid="alerts-empty"
        >
          <div style={{ fontSize: 20, marginBottom: 8 }}>✓</div>
          Todo bajo control · 0 alertas activas
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {alerts.map((alert, i) => {
            const { color, bg, label } = sevConfig(alert.sev);
            const hasAction = Boolean(alert.href);
            return (
              <li
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 1fr auto",
                  gap: 12,
                  padding: "12px 16px",
                  borderBottom:
                    i < alerts.length - 1 ? "1px solid var(--border)" : "none",
                  alignItems: "center",
                }}
                data-testid={`alert-item-${alert.sev}-${i}`}
              >
                {/* Severity pill */}
                <span
                  style={{
                    fontFamily: "var(--font-jetbrains, monospace)",
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    padding: "3px 6px",
                    borderRadius: 3,
                    background: bg,
                    color,
                    textAlign: "center",
                    display: "block",
                  }}
                  aria-label={`Severidad: ${label}`}
                >
                  {label}
                </span>

                {/* Store + reason */}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                    {alert.store}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                    {alert.reason}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 10,
                      color: "var(--fg-subtle)",
                      marginTop: 3,
                    }}
                  >
                    Esperado: {alert.expected} · {alert.since}
                  </div>
                </div>

                {/* Action button */}
                <button
                  type="button"
                  style={{
                    ...outlineBtn,
                    opacity: alert.sev === "info" || !hasAction ? 0.5 : 1,
                    cursor: hasAction ? "pointer" : "not-allowed",
                  }}
                  aria-label={alert.action}
                  disabled={!hasAction}
                  onClick={hasAction ? () => window.open(alert.href, "_blank") : undefined}
                >
                  {alert.action} →
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
