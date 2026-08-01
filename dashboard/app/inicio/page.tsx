"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { HomeViewModel } from "@/lib/home-types";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse, type ApiErrorResponse } from "@/lib/errors";
import { HeroToday } from "@/components/home/HeroToday";
import { PeriodGrid } from "@/components/home/PeriodGrid";
import { DailyTrendChart } from "@/components/home/DailyTrendChart";
import { OperationsRow } from "@/components/home/OperationsRow";
import { TopStoresTable } from "@/components/home/TopStoresTable";
import { HealthFooter } from "@/components/home/HealthFooter";
import { DateNavigator } from "@/components/home/DateNavigator";
import WeeklySummaryButton from "@/components/WeeklySummaryButton";

// ---------------------------------------------------------------------------
// Skeleton shimmer card
// ---------------------------------------------------------------------------
function SkeletonBlock({ height = 120 }: { height?: number }) {
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        height,
        animation: "shimmer 1.5s ease-in-out infinite",
        backgroundImage:
          "linear-gradient(90deg, var(--bg-1) 25%, var(--bg-2) 50%, var(--bg-1) 75%)",
        backgroundSize: "200% 100%",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Page button styles
// ---------------------------------------------------------------------------
const outlineBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-strong)",
  color: "var(--fg)",
  fontSize: 12,
  fontWeight: 500,
  padding: "0 12px",
  borderRadius: 6,
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryBtn: React.CSSProperties = {
  ...outlineBtn,
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  color: "#fff",
};

// ---------------------------------------------------------------------------
// InicioPage
// ---------------------------------------------------------------------------

export default function InicioPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dateParam = searchParams?.get("date") ?? null;

  const [data, setData] = useState<HomeViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  const load = useCallback(async (date: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const url = date ? `/api/home?date=${encodeURIComponent(date)}` : "/api/home";
      const res = await fetch(url);
      if (!res.ok) {
        // Prefer the structured ApiErrorResponse body so the UI can show the
        // technical details (code / id / detail) and "Copiar como JSON".
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON error body */
        }
        setError(isApiErrorResponse(body) ? body : `HTTP ${res.status}`);
        return;
      }
      const json: HomeViewModel = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar datos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(dateParam);
  }, [load, dateParam]);

  const handleDateChange = useCallback(
    (next: string) => {
      // Persist the selection in the URL so it survives refresh + sharing.
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("date", next);
      router.replace(`/inicio?${params.toString()}`);
    },
    [router, searchParams],
  );

  return (
    <div data-no-main-padding data-testid="inicio-page">
      {/* ──────────────────────────────────────────────────────────────── */}
      {/* Page header                                                       */}
      {/* ──────────────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "24px 24px 18px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 24,
          flexWrap: "wrap",
        }}
        data-testid="page-header"
      >
        {/* Left block */}
        <div style={{ flex: "1 1 480px" }}>
          {/* Breadcrumb + chip */}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 11,
                color: "var(--fg-muted)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Inicio
            </span>
            <span
              style={{
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 11,
                color: "var(--fg-subtle)",
              }}
            >
              /
            </span>
            <span
              style={{
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 11,
                color: "var(--fg-muted)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Estado del negocio (retail)
            </span>
            <span
              style={{
                fontFamily: "var(--font-jetbrains, monospace)",
                padding: "2px 6px",
                background: "var(--accent-soft)",
                color: "var(--accent)",
                borderRadius: 3,
                fontSize: 10,
                letterSpacing: "0.05em",
              }}
            >
              EN VIVO
            </span>
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              lineHeight: 1.1,
              fontFamily: "var(--font-inter, sans-serif)",
              color: "var(--fg)",
            }}
          >
            Hola
            <span style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
              {" "}— esto es lo que pasa hoy
            </span>
          </h1>

          <p
            style={{
              margin: "8px 0 0",
              color: "var(--fg-muted)",
              fontSize: 13,
              maxWidth: 680,
              lineHeight: 1.5,
            }}
          >
            Resumen retail: ventas hoy, comparativa multi-periodo, evolución
            diaria, operativa y ranking de tiendas.
          </p>
        </div>

        {/* Right block: date navigator + buttons */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {data && (
            <>
              <DateNavigator
                value={data.asOfDate}
                maxDate={data.maxAvailableDate}
                onChange={handleDateChange}
              />
              <span
                title={`Datos sincronizados ${data.asOf}`}
                style={{
                  fontFamily: "var(--font-jetbrains, monospace)",
                  fontSize: 11,
                  color: "var(--fg-subtle)",
                  marginLeft: 4,
                }}
              >
                {data.asOf}
              </span>
            </>
          )}
          <button
            type="button"
            style={outlineBtn}
            onClick={() => load(dateParam)}
            aria-label="Actualizar datos"
            data-testid="refresh-btn"
          >
            ⟳ Actualizar
          </button>
          <WeeklySummaryButton style={outlineBtn} />
          <button
            type="button"
            style={{ ...outlineBtn, opacity: 0.5, cursor: "not-allowed" }}
            aria-label="Exportar datos (próximamente)"
            title="Próximamente"
            disabled
          >
            Exportar
          </button>
          <Link
            href="/dashboard/new"
            style={primaryBtn}
            aria-label="Crear nuevo panel"
          >
            + Nuevo panel
          </Link>
        </div>
      </div>

      {/* ──────────────────────────────────────────────────────────────── */}
      {/* Loading skeleton                                                  */}
      {/* ──────────────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "column", gap: 18 }}>
          <SkeletonBlock height={200} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
            {[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} height={168} />)}
          </div>
          <SkeletonBlock height={120} />
          <SkeletonBlock height={300} />
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────── */}
      {/* Error state                                                       */}
      {/* ──────────────────────────────────────────────────────────────── */}
      {!loading && error && (
        <div style={{ margin: "24px" }}>
          <ErrorDisplay
            error={error}
            title="Error al cargar los datos"
            onRetry={() => load(dateParam)}
          />
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────── */}
      {/* Main content (retail-only)                                       */}
      {/* ──────────────────────────────────────────────────────────────── */}
      {!loading && !error && data && (
        <>
          {/* Hero */}
          <HeroToday hero={data.hero} asOf={data.asOf} />

          {/* Sales period grid */}
          <PeriodGrid periods={data.periods} />

          {/* Margin period grid */}
          <PeriodGrid
            periods={data.marginPeriods}
            title="Margen bruto"
            subtitle="Margen — actual vs periodo anterior y vs año pasado"
            format="pct"
          />

          {/* Daily trend (full width) */}
          <section
            style={{ padding: "0 24px 18px" }}
            data-testid="trend-row"
          >
            <DailyTrendChart dailyTrend={data.dailyTrend} asOf={data.asOf} />
          </section>

          {/* Retail ops */}
          <section
            style={{ padding: "0 24px 18px", display: "grid", gap: 18 }}
            data-testid="operations-section"
          >
            <OperationsRow
              sectionLabel="RETAIL"
              title="Operativa retail"
              subtitle="día seleccionado · margen del mes"
              metrics={data.opsRetail}
            />
          </section>

          {/* All stores */}
          <section style={{ padding: "0 24px 18px" }} data-testid="top-stores-section">
            <TopStoresTable
              stores={data.topStores}
              inactiveStores={data.inactiveStores}
              networkReturnRate={data.networkReturnRate30d}
            />
          </section>

          {/* Health footer */}
          <HealthFooter health={data.health} />
        </>
      )}
    </div>
  );
}
