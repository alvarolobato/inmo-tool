"use client";

import { Card, LineChart, AreaChart, BarChart, DonutChart } from "@tremor/react";

// ─── Types (matching /api/etl/stats response) ───────────────────────────────────────────

export interface DurationTrendPoint {
  started_at: string;
  duration_ms: number | null;
  status: string;
}

export interface ListingsTrendPoint {
  started_at: string;
  discovered: number | null;
  fetched: number | null;
}

export interface ConnectorDuration {
  connector_name: string;
  avg_duration_ms: number;
  last_duration_ms: number | null;
}

export interface ConnectorListings {
  connector_name: string;
  fetched_count: number;
}

export interface SuccessRate {
  total: number;
  success: number;
  partial: number;
  failed: number;
}

export interface LastRunSummary {
  run_id: number | null;
  duration_ms: number | null;
  total_discovered: number | null;
  total_fetched: number | null;
  /** fetched / discovered, 0–1. NULL when nothing was discovered. */
  fetch_rate: number | null;
}

export interface Errors24h {
  runs_failed: number;
  connectors_failed: number;
}

export interface EtlStatsData {
  duration_trend: DurationTrendPoint[];
  listings_trend: ListingsTrendPoint[];
  connector_durations: ConnectorDuration[];
  top_connectors_by_listings: ConnectorListings[];
  success_rate: SuccessRate;
  last_run: LastRunSummary;
  errors_24h: Errors24h;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-ES", {
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Empty state placeholder ───────────────────────────────────────────────────────────

function EmptyChart({ title }: { title: string }) {
  return (
    <Card className="p-4">
      <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
        {title}
      </h3>
      <p className="py-8 text-center text-sm text-tremor-content dark:text-dark-tremor-content">
        Sin datos disponibles
      </p>
    </Card>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────────────────────

interface EvolutionChartsProps {
  stats: EtlStatsData;
}

export function EvolutionCharts({ stats }: EvolutionChartsProps) {
  // 1. Duration trend
  const durationData = stats.duration_trend
    .filter((p) => p.duration_ms !== null)
    .map((p) => ({
      Fecha: formatShortDate(p.started_at),
      "Duración (min)": Math.round((p.duration_ms ?? 0) / 60000),
    }));

  // 2. Ingestion funnel per run — two series, not one. Plotting discovered
  // alongside fetched is the point: a widening gap is the early warning
  // that a site changed its markup or started soft-blocking, visible well
  // before a run's status turns red.
  const listingsData = stats.listings_trend
    .filter((p) => p.discovered !== null || p.fetched !== null)
    .map((p) => ({
      Fecha: formatShortDate(p.started_at),
      Encontrados: p.discovered ?? 0,
      Guardados: p.fetched ?? 0,
    }));

  // 3. Top 10 slowest connectors by avg duration
  const topConnectors = [...stats.connector_durations]
    .sort((a, b) => b.avg_duration_ms - a.avg_duration_ms)
    .slice(0, 10)
    .map((c) => ({
      Conector: c.connector_name,
      "Duración media (seg)": Math.round(c.avg_duration_ms / 1000),
    }));

  // 4. Listings stored per connector in the latest finished run.
  const topByListings = [...stats.top_connectors_by_listings]
    .sort((a, b) => b.fetched_count - a.fetched_count)
    .map((c) => ({
      Conector: c.connector_name,
      Guardados: c.fetched_count,
    }));

  // 5. Run outcomes donut
  const outcomeData = [
    { name: "Exitoso", value: stats.success_rate.success },
    { name: "Parcial", value: stats.success_rate.partial },
    { name: "Error", value: stats.success_rate.failed },
  ].filter((d) => d.value > 0);

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      data-testid="evolution-charts"
    >
      {/* Chart 1: Duration trend */}
      {durationData.length === 0 ? (
        <EmptyChart title="Tendencia de duración (últimas 30 ejecuciones)" />
      ) : (
        <Card className="p-4">
          <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
            Tendencia de duración (últimas 30 ejecuciones)
          </h3>
          <LineChart
            data={durationData}
            index="Fecha"
            categories={["Duración (min)"]}
            colors={["indigo"]}
            valueFormatter={(v: number) => `${v}m`}
            yAxisWidth={55}
            showLegend={false}
          />
        </Card>
      )}

      {/* Chart 2: ingestion funnel per run (discovered vs. stored) */}
      {listingsData.length === 0 ? (
        <EmptyChart title="Anuncios por ejecución (encontrados vs. guardados)" />
      ) : (
        <Card className="p-4" data-testid="listings-funnel-chart">
          <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
            Anuncios por ejecución (encontrados vs. guardados)
          </h3>
          <AreaChart
            data={listingsData}
            index="Fecha"
            categories={["Encontrados", "Guardados"]}
            colors={["slate", "cyan"]}
            valueFormatter={(v: number) => v.toLocaleString("es-ES")}
            yAxisWidth={65}
            showLegend={true}
          />
        </Card>
      )}

      {/* Chart 3: Top 10 slowest connectors */}
      {topConnectors.length === 0 ? (
        <EmptyChart title="Conectores más lentos (duración media)" />
      ) : (
        <Card className="p-4">
          <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
            Conectores más lentos (duración media)
          </h3>
          <BarChart
            data={topConnectors}
            index="Conector"
            categories={["Duración media (seg)"]}
            colors={["amber"]}
            valueFormatter={(v: number) => v + "s"}
            yAxisWidth={55}
            showLegend={false}
          />
        </Card>
      )}

      {/* Chart 4: listings stored per connector, latest finished run */}
      {topByListings.length === 0 ? (
        <EmptyChart title="Anuncios guardados por conector (última ejecución)" />
      ) : (
        <Card className="p-4" data-testid="top-connectors-by-listings">
          <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
            Anuncios guardados por conector (última ejecución)
          </h3>
          <BarChart
            data={topByListings}
            index="Conector"
            categories={["Guardados"]}
            colors={["cyan"]}
            valueFormatter={(v: number) => v.toLocaleString("es-ES")}
            yAxisWidth={70}
            showLegend={false}
          />
        </Card>
      )}

      {/* Chart 5: Run outcomes donut */}
      {outcomeData.length === 0 || stats.success_rate.total === 0 ? (
        <EmptyChart title="Resultados de ejecuciones (últimas 30)" />
      ) : (
        <Card className="p-4">
          <h3 className="mb-4 text-sm font-medium text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
            Resultados de ejecuciones (últimas 30)
          </h3>
          <DonutChart
            data={outcomeData}
            category="value"
            index="name"
            colors={["emerald", "amber", "red"]}
            showLabel
            showAnimation
            valueFormatter={(v: number) => String(v)}
          />
        </Card>
      )}
    </div>
  );
}
