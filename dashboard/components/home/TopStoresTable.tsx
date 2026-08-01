"use client";

import { useState } from "react";
import type { HomeViewModel } from "@/lib/home-types";
import { Delta } from "./Delta";
import { HomeSparkline } from "./Sparkline";
import { SectionHeader } from "./SectionHeader";
import { fmtEUR0, fmtInt, fmtPct } from "@/components/widgets/format";

type Store = HomeViewModel["topStores"][number];
type InactiveStore = HomeViewModel["inactiveStores"][number];

interface TopStoresTableProps {
  stores: HomeViewModel["topStores"];
  /** Stores hidden from the active list because they had no sales in the
   *  last 30 days. Surfaced under a "Ver tiendas inactivas" toggle. */
  inactiveStores?: HomeViewModel["inactiveStores"];
  /** Volume-weighted 30-day network return-rate baseline from the API.
   *  Used as the coloring threshold for the % Devol column. When absent
   *  or null, falls back to a volume-weighted mean computed from the
   *  current store list. */
  networkReturnRate?: number | null;
}

function statusDotColor(status: Store["status"]): string {
  if (status === "ok") return "var(--up)";
  if (status === "watch") return "var(--warn)";
  return "var(--down)";
}

function sparkColor(store: Store): string {
  if (store.status === "alert") return "var(--down)";
  if (store.status === "watch") return "var(--warn)";
  return store.delta >= 0 ? "var(--up)" : "var(--down)";
}

const COL_TEMPLATE = "32px 60px 1fr 110px 70px 80px 70px 80px 80px 70px 56px 100px";
const HEADER_COLS = ["#", "Cód", "Tienda", "Ventas hoy", "Tickets", "Tk medio", "% Devol", "vs media", "vs año ant", "Margen", "Racha", "Últ. 7 días"];

const outlineLink: React.CSSProperties = {
  fontSize: 11,
  color: "var(--fg-muted)",
  textDecoration: "none",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  padding: "3px 8px",
  cursor: "pointer",
  display: "inline-block",
};

export function TopStoresTable({ stores, inactiveStores, networkReturnRate }: TopStoresTableProps) {
  const maxSales = Math.max(...stores.map((s) => s.sales), 1);
  const [showInactive, setShowInactive] = useState(false);
  const inactiveCount = inactiveStores?.length ?? 0;

  // Use the API-provided 30-day volume-weighted baseline when available;
  // fall back to a volume-weighted mean from the current store list so that
  // outlier low-volume stores (e.g. 1 sale + 1 return = 100%) don't skew
  // the threshold the way the old equal-weight arithmetic mean did.
  const networkAvgRate: number | null = (() => {
    if (networkReturnRate != null) return networkReturnRate;
    const storesWithData = stores.filter(
      (s): s is typeof s & { returnsRate: number } => s.returnsRate !== null && s.sales > 0
    );
    if (storesWithData.length === 0) return null;
    const totalSales = storesWithData.reduce((sum, s) => sum + s.sales, 0);
    return storesWithData.reduce((sum, s) => sum + s.returnsRate * s.sales, 0) / totalSales;
  })();

  return (
    <div
      style={{ background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 10 }}
      data-testid="top-stores-table"
    >
      {/* Card header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <SectionHeader
          title={`Tiendas (${stores.length}) — ordenadas por ventas`}
          subtitle="Ventas del día seleccionado · comparativa interanual · evolución últimos 7 días"
        />
        <a href="/paneles" style={outlineLink} aria-label="Ver todos los paneles">
          Ver paneles →
        </a>
      </div>

      {/* Table headers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: COL_TEMPLATE,
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          gap: 12,
          alignItems: "center",
        }}
        role="row"
      >
        {HEADER_COLS.map((h, i) => (
          <div
            key={i}
            style={{
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 10,
              color: "var(--fg-subtle)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              textAlign: i >= 3 ? "right" : "left",
            }}
            role="columnheader"
          >
            {h}
          </div>
        ))}
      </div>

      {/* Table rows */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption style={{ display: "none" }}>Tiendas activas por ventas hoy</caption>
        <tbody>
          {stores.map((store, i) => {
            const pct = (store.sales / maxSales) * 100;
            const dotColor = statusDotColor(store.status);
            const sparkCol = sparkColor(store);

            return (
              <tr
                key={store.code}
                style={{
                  display: "grid",
                  gridTemplateColumns: COL_TEMPLATE,
                  padding: "10px 16px",
                  gap: 12,
                  alignItems: "center",
                  borderBottom:
                    i < stores.length - 1 ? "1px solid var(--border)" : "none",
                }}
                data-testid={`store-row-${store.code}`}
              >
                {/* Rank */}
                <td style={{ padding: 0 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 11,
                      color: "var(--fg-subtle)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </td>

                {/* Code */}
                <td style={{ padding: 0 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 11,
                      color: "var(--accent)",
                    }}
                  >
                    {store.code}
                  </span>
                </td>

                {/* Name + status dot */}
                <td style={{ padding: 0 }}>
                  <span
                    style={{
                      fontSize: 13,
                      color: "var(--fg)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: dotColor,
                        flexShrink: 0,
                      }}
                      title={`Estado: ${store.status}`}
                      aria-label={`Estado ${store.status}`}
                    />
                    {store.name || `Tienda ${store.code}`}
                  </span>
                </td>

                {/* Sales + heat bar */}
                <td style={{ padding: 0 }}>
                  <div style={{ position: "relative", textAlign: "right", paddingRight: 4 }}>
                    {/* Heat bar behind the value */}
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: `${Math.min(pct * 0.7, 90)}px`,
                        height: 18,
                        background: "var(--accent)",
                        opacity: 0.14,
                        borderRadius: 2,
                      }}
                      aria-hidden="true"
                      data-testid={`heat-bar-${store.code}`}
                    />
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 12,
                        fontWeight: 600,
                        position: "relative",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtEUR0(store.sales)}
                    </span>
                  </div>
                </td>

                {/* Tickets */}
                <td style={{ padding: 0, textAlign: "right" }} data-testid={`tickets-${store.code}`}>
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--fg-muted)",
                    }}
                  >
                    {fmtInt(store.tickets)}
                  </span>
                </td>

                {/* Ticket medio */}
                <td style={{ padding: 0, textAlign: "right" }} data-testid={`ticket-medio-${store.code}`}>
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--fg-muted)",
                    }}
                  >
                    {store.tickets > 0 ? fmtEUR0(store.ticketMedio) : "—"}
                  </span>
                </td>

                {/* Return rate % (vs network average) */}
                <td style={{ padding: 0, textAlign: "right" }} data-testid={`returns-rate-${store.code}`}>
                  {store.returnsRate !== null ? (
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 12,
                        fontVariantNumeric: "tabular-nums",
                        color:
                          networkAvgRate !== null &&
                          store.returnsRate > networkAvgRate + 0.01
                            ? "var(--down)"
                            : "var(--fg-muted)",
                      }}
                    >
                      {fmtPct(store.returnsRate)}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 12,
                        color: "var(--fg-subtle)",
                      }}
                    >
                      —
                    </span>
                  )}
                </td>

                {/* Δ vs media 7 días de la tienda */}
                <td style={{ padding: 0, textAlign: "right" }}>
                  <Delta value={store.delta} size="sm" />
                </td>

                {/* YoY delta */}
                <td style={{ padding: 0, textAlign: "right" }}>
                  <Delta value={store.deltaYoY} size="sm" />
                </td>

                {/* Margin % */}
                <td style={{ padding: 0, textAlign: "right" }}>
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--fg-muted)",
                    }}
                    data-testid={`margin-cell-${store.code}`}
                  >
                    {store.margin != null ? fmtPct(store.margin) : "—"}
                  </span>
                </td>

                {/* Racha — streak weeks below YoY */}
                <td style={{ padding: 0, textAlign: "right" }}>
                  {store.streakWeeks >= 3 ? (
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--down)",
                      }}
                      title={`${store.streakWeeks} semanas consecutivas por debajo del año anterior`}
                      data-testid={`racha-${store.code}`}
                    >
                      {store.streakWeeks}▼
                    </span>
                  ) : (
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 11,
                        color: "var(--fg-subtle)",
                      }}
                      data-testid={`racha-${store.code}`}
                    >
                      —
                    </span>
                  )}
                </td>

                {/* 7-day sparkline */}
                <td style={{ padding: 0 }}>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <HomeSparkline
                      data={store.spark}
                      color={sparkCol}
                      width={90}
                      height={22}
                      label={`Tendencia 7 días ${store.name || store.code}`}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* "Ver tiendas inactivas" toggle + collapsible list */}
      {inactiveCount > 0 && (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: 11,
          }}
          data-testid="inactive-stores-section"
        >
          <button
            type="button"
            onClick={() => setShowInactive((s) => !s)}
            aria-expanded={showInactive}
            aria-controls="inactive-stores-list"
            className="inactive-stores-toggle"
            style={{
              all: "unset",
              cursor: "pointer",
              color: "var(--fg-muted)",
              fontFamily: "var(--font-jetbrains, monospace)",
            }}
          >
            <span aria-hidden="true">{showInactive ? "▼" : "▶"}</span>{" "}
            Ver tiendas inactivas ({inactiveCount})
          </button>
          <style jsx>{`
            .inactive-stores-toggle:focus-visible {
              outline: 2px solid var(--accent);
              outline-offset: 2px;
              border-radius: 2px;
            }
          `}</style>
          {showInactive && (
            <div id="inactive-stores-list" style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--fg-subtle)",
                  marginBottom: 6,
                  fontFamily: "var(--font-jetbrains, monospace)",
                }}
              >
                Sin ventas en los últimos 30 días.
              </div>
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: "4px 16px",
                }}
              >
                {inactiveStores?.map((s: InactiveStore) => (
                  <li
                    key={s.code}
                    style={{
                      fontSize: 12,
                      color: "var(--fg-muted)",
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        color: "var(--fg-subtle)",
                        fontSize: 10,
                      }}
                    >
                      {s.code}
                    </span>
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span
                      style={{
                        fontFamily: "var(--font-jetbrains, monospace)",
                        fontSize: 10,
                        color: "var(--fg-subtle)",
                      }}
                    >
                      {s.lastSaleDate ? `últ. ${s.lastSaleDate}` : "sin historial"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
