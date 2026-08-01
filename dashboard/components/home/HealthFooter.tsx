"use client";

import Link from "next/link";
import type { HomeViewModel } from "@/lib/home-types";
import { fmtInt } from "@/components/widgets/format";

interface HealthFooterProps {
  health: HomeViewModel["health"];
}

export function HealthFooter({ health }: HealthFooterProps) {
  const hasAnomalies = health.anomalies > 0;

  return (
    <footer
      style={{
        margin: "0 24px 24px",
        padding: "10px 16px",
        background: "var(--bg-2)",
        borderRadius: 8,
        border: "1px solid var(--border)",
        display: "flex",
        gap: 24,
        alignItems: "center",
        flexWrap: "wrap",
      }}
      data-testid="health-footer"
    >
      {/* Label */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 10,
          color: "var(--fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Sistema
      </span>

      {/* Sync */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg-muted)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--up)",
            display: "inline-block",
            flexShrink: 0,
          }}
          aria-hidden="true"
        />
        Sync hace {health.syncAge}
      </span>

      {/* ETL */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg-muted)",
        }}
      >
        ETL: {health.lastEtl}
      </span>

      {/* Rows */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtInt(health.rows)} filas hoy
      </span>

      {/* Anomalies */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: hasAnomalies ? "var(--warn)" : "var(--fg-muted)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {hasAnomalies && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--warn)",
              display: "inline-block",
              flexShrink: 0,
            }}
            aria-hidden="true"
          />
        )}
        {hasAnomalies
          ? `${health.anomalies} anomalías detectadas`
          : "Sin anomalías"}
      </span>

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* Diagnostics link */}
      <Link
        href="/admin"
        style={{
          fontSize: 11,
          color: "var(--fg-muted)",
          textDecoration: "none",
        }}
        aria-label="Ver diagnóstico del sistema"
      >
        Diagnóstico →
      </Link>
    </footer>
  );
}
