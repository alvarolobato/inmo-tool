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
  formatSourceAge,
  type SourceStatus,
} from "@/lib/source-health";

const POLL_INTERVAL_MS = 60 * 1000;

// Issue #638 review: pendiente (amber-600) and atascado (orange-600) were
// near-indistinguishable at the 10px dot size on a phone. atascado moves to
// a darker, more saturated amber-800 — the chip text still carries the
// distinction, this just keeps the dot itself from degrading further.
const STATUS_COLOR: Record<SourceStatus, string> = {
  fresco: "#16a34a", // green-600
  pendiente: "#d97706", // amber-600
  atascado: "#92400e", // amber-800 — deliberately far from pendiente's amber-600
  fallando: "#dc2626", // red-600
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
          +{row.new24h} en 24h · {formatSourceAge(row.ageHours)}
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

  // Issue #638 review: `sources: []` alone can't tell "genuinely nothing
  // registered" apart from "the query failed" — `health.ok` (set false only
  // by the API route's catch branch) resolves that. `isUnknown` covers BOTH
  // a network/HTTP-level failure (loadFailed) and a degraded-but-200 server
  // response (`health.ok === false`) — either way the state is unknown, not
  // "zero sources", and the two headline messages below must never render
  // together (they did before this fix: a DB error produced `sources: []`,
  // which read as "no hay fuentes activas registradas" — a specific, false
  // claim about a state that was actually unknown).
  const isUnknown = loadFailed || (health !== null && !health.ok);
  const genuinelyNoSources = health !== null && health.ok && health.sources.length === 0;

  return (
    <div
      className="route-shell"
      style={{ maxWidth: 720 }}
      data-testid="estado-board"
    >
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
        {isUnknown
          ? "Estado desconocido"
          : health === null
            ? "Cargando…"
            : health.rollupStatus
              ? `Estado general: ${SOURCE_STATUS_LABEL[health.rollupStatus]}`
              : health.sources.length > 0
                ? "Sin fuentes activas (todas desactivadas)"
                : "Sin fuentes registradas"}
      </p>

      {genuinelyNoSources && (
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
