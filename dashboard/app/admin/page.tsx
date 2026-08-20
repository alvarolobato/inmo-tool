"use client";

/**
 * Estado board (issue #638, part of #636) — the admin landing.
 *
 * Replaces the old card-grid index. Answers "what is broken right now"
 * without scrolling on a phone: one compact row per source — status dot,
 * name, nuevos-24h, a 7-day sparkline, one chip — problems ranked first,
 * disabled sources collapsed at the bottom. No prose, no `error_msg`
 * rendering (that stays on per-run drill-down, not built here — this board
 * links out to the existing `/etl/connectors` surface).
 *
 * Data: GET /api/etl/source-health, whose aggregation (lib/db/source-health.ts)
 * derives health from the `listing` table — the one ledger both the crawl and
 * capture ingest paths write — rather than from run/capture outcomes, which
 * lie by omission (see that module's header for the fotocasa/idealista
 * evidence). The pure status derivation is lib/source-health.ts.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { SourceHealthResponse } from "@/app/api/etl/source-health/route";
import {
  SOURCE_STATUS_LABEL,
  type SourceStatus,
} from "@/lib/source-health";

const POLL_INTERVAL_MS = 60 * 1000;

const STATUS_COLOR: Record<SourceStatus, string> = {
  fresco: "#16a34a", // green
  pendiente: "#d97706", // amber
  atascado: "#ea580c", // orange
  fallando: "#dc2626", // red
};

const REASON_CHIP: Record<string, string> = {
  fresh: "al día",
  due: "esperando ciclo",
  pendiente_de_captura: "tu acción: capturar",
  stale_2x_window: "sin datos nuevos",
  soft_block_stale: "bloqueo temporal + sin datos",
  run_failed: "última ejecución falló",
  circuit_open: "circuito abierto",
  capture_failure_rate: "capturas fallando",
  capture_partial_failures: "algunas capturas fallan",
  heartbeat_stale: "extensión sin actividad",
};

function formatAge(ageHours: number | null): string {
  if (ageHours === null) return "nunca";
  if (ageHours < 1) return `hace ${Math.max(1, Math.round(ageHours * 60))}m`;
  if (ageHours < 48) return `hace ${Math.round(ageHours)}h`;
  return `hace ${Math.round(ageHours / 24)}d`;
}

function Dot({ status }: { status: SourceStatus }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: STATUS_COLOR[status],
        flexShrink: 0,
      }}
    />
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 20 }}
      aria-hidden
    >
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            width: 6,
            height: Math.max(2, Math.round((v / max) * 20)),
            background: v > 0 ? "var(--fg-muted)" : "var(--border)",
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

function SourceRow({ row }: { row: SourceHealthResponse["sources"][number] }) {
  const chipText = row.disabled
    ? "desactivado"
    : (REASON_CHIP[row.reason] ?? SOURCE_STATUS_LABEL[row.status]);
  return (
    <Link
      href="/etl/connectors"
      data-testid={`source-row-${row.source}`}
      data-status={row.status}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        textDecoration: "none",
        opacity: row.disabled ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {!row.disabled && <Dot status={row.status} />}
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: "1 1 120px",
          }}
        >
          {row.source}
        </span>
        <span
          data-testid={`source-status-${row.source}`}
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: row.disabled ? "var(--fg-muted)" : STATUS_COLOR[row.status],
            background: row.disabled ? "var(--bg-2)" : `${STATUS_COLOR[row.status]}1a`,
            padding: "2px 8px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {chipText}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          data-testid={`source-new24h-${row.source}`}
          style={{ fontSize: 12, color: "var(--fg-muted)", whiteSpace: "nowrap" }}
        >
          +{row.new24h} en 24h · {formatAge(row.ageHours)}
        </span>
        <Sparkline values={row.sparkline7d} />
      </div>
    </Link>
  );
}

export default function AdminIndexPage() {
  const [health, setHealth] = useState<SourceHealthResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/source-health");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data = (await res.json()) as SourceHealthResponse;
      setHealth(data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const active = health?.sources.filter((s) => !s.disabled) ?? [];
  const disabled = health?.sources.filter((s) => s.disabled) ?? [];

  return (
    <div style={{ padding: "var(--pad)", maxWidth: 720 }} data-testid="estado-board">
      <h1
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--fg)",
          marginBottom: 4,
        }}
      >
        Estado
      </h1>
      <p style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 16 }}>
        {health?.rollupStatus
          ? `Estado general: ${SOURCE_STATUS_LABEL[health.rollupStatus]}`
          : loadFailed || health?.rollupStatus === null
            ? "Estado desconocido"
            : "Cargando…"}
      </p>

      {active.length === 0 && !loadFailed && health !== null && (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          No hay fuentes activas registradas.
        </p>
      )}

      <div
        data-testid="estado-active-sources"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        {active.map((row) => (
          <SourceRow key={row.source} row={row} />
        ))}
      </div>

      {disabled.length > 0 && (
        <div style={{ marginTop: 20 }} data-testid="estado-disabled-section">
          <h2
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--fg-muted)",
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            Desactivadas
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {disabled.map((row) => (
              <SourceRow key={row.source} row={row} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
