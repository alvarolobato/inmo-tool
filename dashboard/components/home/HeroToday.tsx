"use client";

import { useState } from "react";
import type { HomeViewModel } from "@/lib/home-types";
import { Delta } from "./Delta";
import { fmtEUR0 } from "@/components/widgets/format";

interface HeroTodayProps {
  hero: HomeViewModel["hero"];
  asOf: string;
}

function statusConfig(status: HomeViewModel["hero"]["status"]) {
  if (status === "on-pace")
    return { color: "var(--up)", bg: "var(--up-bg)", label: "En ritmo previsto" };
  if (status === "above")
    return {
      color: "var(--accent-2)",
      bg: "rgba(34,211,238,0.12)",
      label: "Por encima del previsto",
    };
  return { color: "var(--down)", bg: "var(--down-bg)", label: "Por debajo del previsto" };
}

/**
 * Builds an SVG path from an array of [x, y] points (skipping nulls).
 * Returns empty string if no points.
 */
function buildPath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
}

export function HeroToday({ hero, asOf }: HeroTodayProps) {
  const { color: statusColor, bg: statusBg, label: statusLabel } = statusConfig(hero.status);

  // Chart geometry
  const W = 600;
  const H = 120;
  const padT = 8;
  const padB = 18;

  const allComparison = hero.hourlyComparison.filter((v) => typeof v === "number" && v > 0);
  const maxVal =
    Math.max(
      ...(allComparison.length > 0 ? allComparison : [0]),
      ...hero.hourly.filter((v): v is number => v !== null),
      hero.forecastEOD > 0 ? hero.forecastEOD : 0
    ) * 1.1 || 1;

  const xForHour = (hour: number) => (hour / 23) * W;
  const yForVal = (val: number) =>
    padT + (1 - val / maxVal) * (H - padT - padB);

  // Comparison line (same weekday last week — see hero.comparisonLabel)
  const lyPts: [number, number][] = hero.hourlyComparison.map((v, i) => [
    xForHour(i),
    yForVal(v),
  ]);
  const lyPath = buildPath(lyPts);

  // Today line (only non-null points)
  const todayPts: [number, number][] = hero.hourly
    .map((v, i): [number, number] | null =>
      v !== null ? [xForHour(i), yForVal(v)] : null
    )
    .filter((p): p is [number, number] => p !== null);
  const todayPath = buildPath(todayPts);
  const todayArea =
    todayPts.length > 0
      ? `${todayPath} L${todayPts[todayPts.length - 1][0]},${H - padB} L${todayPts[0][0]},${H - padB} Z`
      : "";
  const lastPt = todayPts.length > 0 ? todayPts[todayPts.length - 1] : null;

  // Current hour index (last non-null hour, or -1 if none)
  const currentHourIdx: number = hero.hourly.reduce<number>(
    (acc, v, i) => (v !== null ? i : acc),
    -1
  );

  // Forecast line
  const forecastEnd: [number, number] | null =
    hero.forecastEOD > 0 && lastPt
      ? [xForHour(23), yForVal(hero.forecastEOD)]
      : null;

  // Hour ticks
  const hourTicks = [0, 4, 8, 12, 16, 20, 23];

  // Hover tooltip state — index into the 0..23 hour array, or null when
  // the cursor is not over the chart.
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  // Whether intraday granularity is available at all. When the API returns
  // an empty array (mirror only has date granularity), we show today's
  // value as a single-day total instead of the hourly chart.
  const hasIntraday = hero.hourly.length > 0;

  // Pre-open state: only meaningful when we DO have hourly data and the
  // store hasn't opened yet. With no intraday data, we just show today's
  // total alongside its deltas.
  const isPreOpen = hasIntraday && (currentHourIdx < 0 || currentHourIdx < 8);

  return (
    <div
      style={{
        margin: "0 24px 18px",
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 24,
        display: "grid",
        gridTemplateColumns: "minmax(280px,1fr) 2.4fr",
        gap: 32,
        alignItems: "stretch",
      }}
      data-testid="hero-today"
    >
      {/* ── Left: number block ── */}
      <div
        style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
      >
        <div>
          {/* Micro header */}
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
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
              Ventas hoy
            </span>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--up)",
                animation: "pulse-dot 2s ease-in-out infinite",
                display: "inline-block",
              }}
              aria-hidden="true"
            />
            <span
              style={{
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 10,
                color: "var(--fg-subtle)",
              }}
            >
              EN VIVO
            </span>
          </div>

          {/* Hero number */}
          <div
            style={{
              fontSize: 56,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
            }}
            data-testid="hero-value"
          >
            {isPreOpen ? "0 €" : fmtEUR0(hero.todayValue)}
          </div>

          {/* Status badge */}
          <div
            style={{
              marginTop: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 4,
              background: isPreOpen ? "var(--bg-3)" : statusBg,
              color: isPreOpen ? "var(--fg-muted)" : statusColor,
              fontSize: 12,
              fontWeight: 600,
            }}
            data-testid="hero-status"
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: isPreOpen ? "var(--fg-muted)" : statusColor,
              }}
              aria-hidden="true"
            />
            {isPreOpen ? "Sin actividad" : statusLabel}
          </div>
        </div>

        {/* Delta pair */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginTop: 24,
          }}
        >
          <DeltaCell
            label="VS AYER"
            value={isPreOpen ? null : hero.vsYesterday}
            cutoffHour={hero.comparisonCutoffHour}
            cutoffValue={hero.yesterdayCutoff}
            fullValue={hero.yesterday}
          />
          <DeltaCell
            label="VS AÑO PASADO"
            value={hero.vsLY !== undefined && hero.vsLY !== null ? hero.vsLY : null}
            cutoffHour={hero.comparisonCutoffHour}
            cutoffValue={hero.lastYearCutoff}
            fullValue={hero.lastYear}
          />
        </div>
      </div>

      {/* ── Right: hourly chart (when intraday data exists) ── */}
      {!hasIntraday ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            color: "var(--fg-muted)",
            fontSize: 12,
            fontFamily: "var(--font-jetbrains, monospace)",
            textAlign: "center",
            gap: 8,
          }}
          data-testid="hero-no-intraday"
        >
          <span style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10 }}>
            Sin granularidad horaria
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
            Ver evolución diaria abajo
          </span>
        </div>
      ) : (
      <div style={{ position: "relative" }}>
        {/* Chart header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 4,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 10,
              color: "var(--fg-subtle)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Ventas por hora · proyección cierre
          </span>
          <div style={{ display: "flex", gap: 14, fontSize: 11, flexWrap: "wrap" }}>
            <LegendItem
              lineStyle="solid"
              color="var(--accent)"
              label="Hoy"
            />
            <LegendItem
              lineStyle="dashed"
              color="var(--accent-2)"
              label={hero.comparisonLabel}
            />
            <LegendItem
              lineStyle="dotted"
              color="var(--fg-muted)"
              label="Proyección"
            />
          </div>
        </div>

        {/* SVG fills the column horizontally and is fixed at 160px tall.
            preserveAspectRatio="none" stretches the geometry to fill, but
            every stroke uses vector-effect="non-scaling-stroke" so line
            widths render at the declared CSS pixel width regardless of the
            stretch. Text labels are NOT in SVG (they would distort) — they
            are rendered as HTML elements positioned by % over the chart. */}
        <div
          style={{ position: "relative", width: "100%", height: 160 }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const idx = Math.round(ratio * 23);
            if (idx >= 0 && idx <= 23) setHoverHour(idx);
          }}
          onMouseLeave={() => setHoverHour(null)}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ width: "100%", height: "100%", display: "block" }}
            role="img"
            aria-label="Gráfico de ventas por hora con proyección de cierre"
          >
            <title>Ventas por hora con proyección de cierre</title>
            <defs>
              <linearGradient id="todayGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Gridlines */}
            {[0, 0.5, 1].map((t) => (
              <line
                key={t}
                x1={0}
                y1={padT + t * (H - padT - padB)}
                x2={W}
                y2={padT + t * (H - padT - padB)}
                stroke="var(--grid)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* Last year line */}
            {lyPath && (
              <path
                d={lyPath}
                fill="none"
                stroke="var(--accent-2)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                opacity="0.65"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Today area + line */}
            {todayArea && <path d={todayArea} fill="url(#todayGrad)" />}
            {todayPath && (
              <path
                d={todayPath}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Forecast line */}
            {lastPt && forecastEnd && !isPreOpen && (
              <line
                x1={lastPt[0]}
                y1={lastPt[1]}
                x2={forecastEnd[0]}
                y2={forecastEnd[1]}
                stroke="var(--fg-muted)"
                strokeWidth="1.5"
                strokeDasharray="2 4"
                opacity="0.6"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* "Ahora" marker — vertical line only. The dot is an HTML
                overlay because <circle> fills are scaled non-uniformly
                by preserveAspectRatio="none" and would render as an
                elongated ellipse. */}
            {lastPt && !isPreOpen && (
              <line
                x1={lastPt[0]}
                y1={padT}
                x2={lastPt[0]}
                y2={H - padB}
                stroke="var(--accent)"
                strokeWidth="1"
                strokeDasharray="2 2"
                opacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Hover crosshair */}
            {hoverHour !== null && (
              <line
                x1={xForHour(hoverHour)}
                y1={padT}
                x2={xForHour(hoverHour)}
                y2={H - padB}
                stroke="var(--fg-muted)"
                strokeWidth="1"
                strokeDasharray="2 3"
                opacity="0.55"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* HTML overlays: text labels and circular markers positioned
              by viewBox-percent. HTML elements aren't subject to the SVG
              stretch transform, so glyphs stay readable and dots stay
              circular at every viewport width. */}
          {lastPt && !isPreOpen && (
            <span
              data-testid="ahora-marker"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${(lastPt[0] / W) * 100}%`,
                top: `${(lastPt[1] / H) * 100}%`,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                border: "2px solid var(--bg-1)",
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
            />
          )}
          {forecastEnd && !isPreOpen && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${(forecastEnd[0] / W) * 100}%`,
                top: `${(forecastEnd[1] / H) * 100}%`,
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--fg-muted)",
                border: "1.5px solid var(--bg-1)",
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
            />
          )}
          {lastPt && !isPreOpen && (
            <span
              data-testid="ahora-label"
              style={{
                position: "absolute",
                left: `${(lastPt[0] / W) * 100}%`,
                top: 0,
                transform: "translate(-50%, 0)",
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 9,
                color: "var(--accent)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              AHORA
            </span>
          )}
          {hourTicks.map((hr) => (
            <span
              key={hr}
              style={{
                position: "absolute",
                left: `${(xForHour(hr) / W) * 100}%`,
                bottom: 0,
                transform: "translate(-50%, 0)",
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 10,
                color: "var(--fg-subtle)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {String(hr).padStart(2, "0")}:00
            </span>
          ))}

          {/* Hover tooltip */}
          {hoverHour !== null && (() => {
            const tx = (xForHour(hoverHour) / W) * 100;
            const todayVal = hero.hourly[hoverHour];
            const lyVal = hero.hourlyComparison[hoverHour];
            const flipLeft = tx > 75;
            return (
              <div
                style={{
                  position: "absolute",
                  left: `${tx}%`,
                  top: 8,
                  transform: flipLeft ? "translate(-100%, 0)" : "translate(8px, 0)",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontFamily: "var(--font-jetbrains, monospace)",
                  fontSize: 11,
                  color: "var(--fg)",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                  zIndex: 2,
                }}
              >
                <div style={{ color: "var(--fg-subtle)", marginBottom: 2 }}>
                  {String(hoverHour).padStart(2, "0")}:00
                </div>
                <div style={{ color: "var(--accent)" }}>
                  Hoy: {todayVal !== null && todayVal !== undefined ? fmtEUR0(todayVal) : "—"}
                </div>
                <div style={{ color: "var(--accent-2)", opacity: 0.85 }}>
                  {hero.comparisonLabel}: {typeof lyVal === "number" ? fmtEUR0(lyVal) : "—"}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Chart footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 4,
            fontSize: 11,
          }}
        >
          <span
            style={{
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-jetbrains, monospace)",
            }}
          >
            {asOf} actual
          </span>
          {!isPreOpen && (
            <span style={{ color: "var(--fg-muted)" }}>
              Proyección cierre{" "}
              <span
                style={{
                  fontFamily: "var(--font-jetbrains, monospace)",
                  color: "var(--fg)",
                  fontWeight: 600,
                  marginLeft: 4,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmtEUR0(hero.forecastEOD)}
              </span>
              <span style={{ marginLeft: 8 }}>
                <Delta value={hero.todayPace} size="sm" />
              </span>
            </span>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// ─── Delta cell ──────────────────────────────────────────────────────────────

/**
 * One of the two delta blocks under the hero number ("VS AYER" / "VS AÑO
 * PASADO"). When `cutoffHour` is set we surface the same-hour-cutoff total
 * as the primary supporting line (since that's what the delta is computed
 * against) and the full-day total in lighter grey beneath it.
 */
function DeltaCell({
  label,
  value,
  cutoffHour,
  cutoffValue,
  fullValue,
}: {
  label: string;
  value: number | null;
  cutoffHour: number | null;
  cutoffValue: number | null;
  fullValue: number;
}) {
  const cutoffActive = cutoffHour !== null && cutoffValue !== null;
  const hh = cutoffHour !== null ? String(cutoffHour).padStart(2, "0") : null;
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 10,
          color: "var(--fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 4,
        }}
      >
        {label}
        {cutoffActive ? (
          <span style={{ color: "var(--fg-muted)", marginLeft: 6 }}>
            (hasta las {hh}:00)
          </span>
        ) : null}
      </div>
      <Delta value={value} size="lg" />
      <div
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg-subtle)",
          marginTop: 4,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {cutoffActive ? fmtEUR0(cutoffValue!) : fmtEUR0(fullValue)}
      </div>
      {cutoffActive ? (
        <div
          style={{
            fontFamily: "var(--font-jetbrains, monospace)",
            fontSize: 10,
            color: "var(--fg-muted)",
            marginTop: 2,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          día completo: {fmtEUR0(fullValue)}
        </div>
      ) : null}
    </div>
  );
}

// ─── Legend item ─────────────────────────────────────────────────────────────

interface LegendItemProps {
  lineStyle: "solid" | "dashed" | "dotted";
  color: string;
  label: string;
}

function LegendItem({ lineStyle, color, label }: LegendItemProps) {
  const borderTop =
    lineStyle === "dashed"
      ? `1.5px dashed ${color}`
      : lineStyle === "dotted"
        ? `1.5px dotted ${color}`
        : undefined;
  const background = lineStyle === "solid" ? color : undefined;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--fg-muted)",
        fontSize: 11,
      }}
    >
      <span
        style={{
          width: 16,
          height: lineStyle === "solid" ? 2 : 0,
          background,
          borderTop,
          borderRadius: lineStyle === "solid" ? 2 : undefined,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
