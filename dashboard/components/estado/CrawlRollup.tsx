"use client";

/**
 * "Rastreo" — the three fleet-wide crawl numbers the Monitor ETL page owned
 * (issue #642 P2).
 *
 * `/etl`'s KPI row died with the page. Most of it was already said better
 * somewhere else and is not rebuilt here: "última sincronización", "duración"
 * and "anuncios guardados" were facts about ONE run, and Actividad (#706) now
 * renders every run's own facts on its own dated row, per connector, instead
 * of only the newest sweep's totals.
 *
 * These three are the ones that were NOT per-run and had nowhere left to go —
 * present-state rollups, which is Estado's job:
 *
 *   - **Tasa de éxito (últ. 30)** — `/etl` rendered this twice, once as a
 *     percentage KPI and once as a donut of the same three counts
 *     (`EvolutionCharts` chart 5). One tile carries both: the percentage as
 *     the headline, the ok/parcial/error split as its own line. The donut is
 *     not rebuilt — three numbers do not need a chart, and drawing them twice
 *     is the duplication this whole tracker exists to remove.
 *   - **Tasa de descarga** — guardados / encontrados on the last finished
 *     sweep. This is also what `EvolutionCharts` chart 2 (the 30-run
 *     encontrados-vs-guardados area chart) existed to make visible: a
 *     widening gap between the two series. The gap is preserved here as a
 *     number, and its per-source decomposition — which the fleet-wide chart
 *     could never give — is on Actividad, where every `crawl` row carries its
 *     own encontrados and guardados side by side.
 *   - **Errores (24 h)** — the rolling failure count, the one number here
 *     that is about a window rather than a single run.
 *
 * Crawl only, and labelled that way. `connector_runs` has no row for a
 * browser-captured portal (the #636 verdict: a run-centric view is
 * structurally blind to capture), so a tile claiming to speak for "la
 * ingesta" would be quietly wrong for the owner's primary source. The
 * per-source rows above this band are the ones that cover both paths.
 *
 * Reads `/api/etl/stats` on its own, fail-soft, like `<QueueBand/>`: it is a
 * summary, and a summary must never be able to blank the board it sits under.
 */

import { useCallback, useEffect, useState } from "react";
import type { EtlStatsResponse } from "@/app/api/etl/stats/route";

const POLL_INTERVAL_MS = 60 * 1000;

function pct(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("es-ES");
}

function Tile({
  label,
  value,
  detail,
  testId,
  emphasis,
}: {
  label: string;
  value: string;
  detail: string;
  testId: string;
  emphasis?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "10px 12px",
        minHeight: 44,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-1)",
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{label}</span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: emphasis ? "#dc2626" : "var(--fg)",
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{detail}</span>
    </div>
  );
}

export function CrawlRollup() {
  const [stats, setStats] = useState<EtlStatsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/etl/stats");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setStats((await res.json()) as EtlStatsResponse);
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

  const rate = stats?.success_rate;
  // total === 0 is "no runs recorded", NOT "0% success" — the same
  // never-render-a-fabricated-zero rule the rest of the board follows.
  const successFraction = rate && rate.total > 0 ? rate.success / rate.total : null;
  const errors = stats?.errors_24h;
  const anyError = !!errors && errors.runs_failed + errors.connectors_failed > 0;

  return (
    <section style={{ marginTop: 20 }} data-testid="estado-crawl-rollup">
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
        Rastreo{" "}
        <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          · solo conectores por API, no captura
        </span>
      </h2>
      {loadFailed ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }} data-testid="estado-crawl-unknown">
          Resumen de rastreo desconocido
        </p>
      ) : stats === null ? (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      ) : (
        <div className="queue-band-grid">
          <Tile
            testId="crawl-success-rate"
            label="Tasa de éxito (últ. 30)"
            value={pct(successFraction)}
            detail={
              rate && rate.total > 0
                ? `${rate.success} ok · ${rate.partial} parciales · ${rate.failed} con error`
                : "sin ejecuciones registradas"
            }
          />
          <Tile
            testId="crawl-fetch-rate"
            label="Tasa de descarga"
            value={pct(stats.last_run.fetch_rate)}
            detail={
              stats.last_run.run_id === null
                ? "sin ejecuciones registradas"
                : `${num(stats.last_run.total_fetched)} guardados de ${num(
                    stats.last_run.total_discovered,
                  )} encontrados`
            }
          />
          <Tile
            testId="crawl-errors-24h"
            label="Errores (24 h)"
            value={
              errors ? `${num(errors.runs_failed)} / ${num(errors.connectors_failed)}` : "—"
            }
            detail="ejecuciones / conectores"
            emphasis={anyError}
          />
        </div>
      )}
    </section>
  );
}
