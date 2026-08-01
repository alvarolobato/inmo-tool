"use client";

import { useState } from "react";
import type { HomeViewModel } from "@/lib/home-types";
import { SectionHeader } from "./SectionHeader";
import { fmtEUR0 } from "@/components/widgets/format";

interface DailyTrendChartProps {
  dailyTrend: HomeViewModel["dailyTrend"];
  /** ISO date or display string ("lun 04 may · 11:42") for the chart's "as of" moment.
   *  Used to derive the legend labels ("Mayo 2026" / "Mayo 2025"). */
  asOf?: string;
}

const MONTH_NAMES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function deriveLegendLabels(asOf?: string): { current: string; previous: string } {
  // Try to parse asOf as a Date first; fall back to current real time.
  let date: Date;
  if (asOf) {
    const maybe = new Date(asOf);
    date = isNaN(maybe.getTime()) ? new Date() : maybe;
  } else {
    date = new Date();
  }
  const month = MONTH_NAMES_ES[date.getMonth()] ?? "";
  const year = date.getFullYear();
  return { current: `${month} ${year}`, previous: `${month} ${year - 1}` };
}

export function DailyTrendChart({ dailyTrend, asOf }: DailyTrendChartProps) {
  const { current: currentLabel, previous: previousLabel } = deriveLegendLabels(asOf);

  const W = 1000;
  const H = 220;
  const padL = 44;
  const padR = 16;
  const padT = 14;
  const padB = 24;

  const allValues = dailyTrend.flatMap((d) =>
    [d.actual, d.ly].filter((v): v is number => v !== null && v !== undefined)
  );
  const maxVal = allValues.length > 0 ? Math.max(...allValues) * 1.1 : 1;

  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const xStep = dailyTrend.length > 1 ? chartW / (dailyTrend.length - 1) : chartW;
  const xForIdx = (i: number) => padL + i * xStep;
  const yForVal = (v: number) => padT + (1 - v / maxVal) * chartH;

  // LY path
  const lyPts = dailyTrend.map((d, i) => [xForIdx(i), yForVal(d.ly)] as [number, number]);
  const lyPath = lyPts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Actual path (only non-null days)
  const actualPts = dailyTrend
    .map((d, i): [number, number, number] | null =>
      d.actual !== null && d.actual !== undefined
        ? [xForIdx(i), yForVal(d.actual), d.day]
        : null
    )
    .filter((p): p is [number, number, number] => p !== null);
  const actualPath = actualPts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const actualArea =
    actualPts.length > 0
      ? `${actualPath} L${actualPts[actualPts.length - 1][0].toFixed(1)},${H - padB} L${actualPts[0][0].toFixed(1)},${H - padB} Z`
      : "";

  // Grid ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    val: maxVal * (1 - t),
    y: yForVal(maxVal * (1 - t)),
  }));

  // X axis ticks every 5 days
  const xTicks = dailyTrend.filter((_, i) => i % 5 === 0);

  const lastActual = actualPts.length > 0 ? actualPts[actualPts.length - 1] : null;

  return (
    <div
      style={{ background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 10 }}
      data-testid="daily-trend-chart"
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <SectionHeader
          title="Tendencia mes en curso"
          subtitle="Ventas diarias — actual vs mismo mes 2025"
        />
        <div style={{ display: "flex", gap: 14, fontSize: 11, flexWrap: "wrap" }}>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-muted)" }}
          >
            <span
              style={{ width: 16, height: 2, background: "var(--accent)", borderRadius: 2 }}
              aria-hidden="true"
            />
            {currentLabel}
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-muted)" }}
          >
            <span
              style={{ width: 16, height: 0, borderTop: "1.5px dashed var(--accent-2)" }}
              aria-hidden="true"
            />
            {previousLabel}
          </span>
        </div>
      </div>

      {/* Chart body */}
      <ChartBody
        W={W}
        H={H}
        padL={padL}
        padR={padR}
        padT={padT}
        padB={padB}
        chartW={chartW}
        yTicks={yTicks}
        lyPath={lyPath}
        actualPath={actualPath}
        actualArea={actualArea}
        lastActual={lastActual}
        xTicks={xTicks}
        xForIdx={xForIdx}
        yForVal={yForVal}
        dailyTrend={dailyTrend}
        currentLabel={currentLabel}
        previousLabel={previousLabel}
      />
    </div>
  );
}

// ─── Chart body (extracted so we can use hooks) ───────────────────────────────

interface ChartBodyProps {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  chartW: number;
  yTicks: Array<{ val: number; y: number }>;
  lyPath: string;
  actualPath: string;
  actualArea: string;
  lastActual: [number, number, number] | null;
  xTicks: HomeViewModel["dailyTrend"];
  xForIdx: (i: number) => number;
  yForVal: (v: number) => number;
  dailyTrend: HomeViewModel["dailyTrend"];
  currentLabel: string;
  previousLabel: string;
}

function ChartBody(props: ChartBodyProps) {
  const {
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    chartW,
    yTicks,
    lyPath,
    actualPath,
    actualArea,
    lastActual,
    xTicks,
    xForIdx,
    dailyTrend,
    currentLabel,
    previousLabel,
  } = props;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  return (
    <div style={{ padding: 16 }}>
      {/* SVG fills the column horizontally and is fixed at 220px tall.
          preserveAspectRatio="none" keeps the geometry filling the box;
          vector-effect="non-scaling-stroke" stops strokes from inflating.
          Text labels are HTML overlays so glyphs aren't stretched. */}
      <div
        style={{ position: "relative", width: "100%", height: 220 }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // Compute X within the chart area only (excluding left padding).
          const px = e.clientX - rect.left;
          const chartLeftPx = (padL / W) * rect.width;
          const chartWPx = (chartW / W) * rect.width;
          if (px < chartLeftPx || px > chartLeftPx + chartWPx) {
            setHoverIdx(null);
            return;
          }
          const ratio = (px - chartLeftPx) / chartWPx;
          const idx = Math.round(ratio * (dailyTrend.length - 1));
          if (idx >= 0 && idx < dailyTrend.length) setHoverIdx(idx);
        }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%", display: "block" }}
          role="img"
          aria-label="Tendencia de ventas diarias: mes actual vs mismo mes del año anterior"
        >
          <title>Tendencia de ventas diarias</title>
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Horizontal gridlines */}
          {yTicks.map(({ y }, i) => (
            <line
              key={i}
              x1={padL}
              y1={y}
              x2={W - padR}
              y2={y}
              stroke="var(--grid)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* LY line */}
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

          {/* Actual area + line */}
          {actualArea && <path d={actualArea} fill="url(#trendGrad)" />}
          {actualPath && (
            <path
              d={actualPath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* "HOY · DÍA N" crosshair line. The dot is an HTML overlay
              because circle fills get stretched into an ellipse under
              preserveAspectRatio="none". */}
          {lastActual && (
            <line
              x1={lastActual[0]}
              y1={padT}
              x2={lastActual[0]}
              y2={H - padB}
              stroke="var(--accent)"
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.35"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Hover crosshair */}
          {hoverIdx !== null && (
            <line
              x1={xForIdx(hoverIdx)}
              y1={padT}
              x2={xForIdx(hoverIdx)}
              y2={H - padB}
              stroke="var(--fg-muted)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.55"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* HTML label overlays */}
        {yTicks.map(({ val, y }, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: `${((padL - 6) / W) * 100}%`,
              top: `${(y / H) * 100}%`,
              transform: "translate(-100%, -50%)",
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 10,
              color: "var(--fg-subtle)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            {(val / 1000).toFixed(0)}k€
          </span>
        ))}
        {lastActual && (
          <>
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${(lastActual[0] / W) * 100}%`,
                top: `${(lastActual[1] / H) * 100}%`,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                border: "2px solid var(--bg-1)",
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
            />
            <span
              style={{
                position: "absolute",
                left: `${(lastActual[0] / W) * 100}%`,
                top: 0,
                transform: "translate(-50%, 0)",
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 9,
                color: "var(--accent)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              HOY · DÍA {lastActual[2]}
            </span>
          </>
        )}
        {xTicks.map((d, idx) => {
          const origIdx = dailyTrend.indexOf(d);
          return (
            <span
              key={idx}
              style={{
                position: "absolute",
                left: `${(xForIdx(origIdx) / W) * 100}%`,
                bottom: 0,
                transform: "translate(-50%, 0)",
                fontFamily: "var(--font-jetbrains, monospace)",
                fontSize: 10,
                color: "var(--fg-subtle)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {d.day}
            </span>
          );
        })}

        {/* Hover tooltip */}
        {hoverIdx !== null && (() => {
          const tx = (xForIdx(hoverIdx) / W) * 100;
          const day = dailyTrend[hoverIdx];
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
                Día {day.day}
              </div>
              <div style={{ color: "var(--accent)" }}>
                {currentLabel}:{" "}
                {day.actual !== null && day.actual !== undefined ? fmtEUR0(day.actual) : "—"}
              </div>
              <div style={{ color: "var(--accent-2)", opacity: 0.85 }}>
                {previousLabel}:{" "}
                {typeof day.ly === "number" ? fmtEUR0(day.ly) : "—"}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
