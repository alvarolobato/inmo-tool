"use client";

import { useState, useMemo } from "react";
import type { BarChartWidget as BarChartWidgetSpec, GlossaryItem } from "@/lib/schema";
import type { OnDataPointClick, WidgetData } from "./types";
import { EMPTY_MESSAGE, resolveXY, safeNumber } from "./types";
import { applyGlossary } from "@/lib/glossary";
import { resolveChartColor } from "./chart-colors";
import { WidgetSkeleton } from "./WidgetSkeleton";

interface BarChartWidgetProps {
  widget: BarChartWidgetSpec;
  data: WidgetData | null;
  comparisonData?: WidgetData | null;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
}

/** Merge primary and comparison datasets — kept for external consumers. */
export function mergeComparisonSeries(
  primary: WidgetData,
  comparison: WidgetData,
  xIdx: number,
  yIdx: number,
  xCol: string,
): Record<string, string | number | null>[] {
  const compMap = new Map<string, number | null>();
  for (const row of comparison.rows) {
    const xVal = String(row[xIdx] ?? "");
    compMap.set(xVal, safeNumber(row[yIdx]));
  }
  return primary.rows
    .filter((row) => safeNumber(row[yIdx]) !== null)
    .map((row) => ({
      [xCol]: String(row[xIdx] ?? ""),
      Actual: safeNumber(row[yIdx])!,
      Anterior: compMap.get(String(row[xIdx] ?? "")) ?? null,
    }));
}

const CHART_HEIGHT = 240;
const PAD_T = 10;
const PAD_B = 24;

interface HoverState {
  i: number;
  label: string;
  actual: number;
  previous: number | null;
}

export function BarChartWidget({
  widget,
  data,
  comparisonData,
  glossary,
  onDataPointClick,
}: BarChartWidgetProps) {
  const titleNode = applyGlossary(widget.title, glossary);
  const [hover, setHover] = useState<HoverState | null>(null);

  const chartData = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    const resolved = resolveXY(data, widget.x, widget.y);
    if (!resolved) return null;
    const { xIdx, yIdx } = resolved;

    const hasComp = comparisonData != null && comparisonData.rows.length > 0;
    const compResolved = hasComp ? resolveXY(comparisonData!, widget.x, widget.y) : null;
    const compMap = new Map<string, number>();
    if (hasComp && compResolved) {
      for (const r of comparisonData!.rows) {
        const v = safeNumber(r[compResolved.yIdx]);
        if (v !== null) compMap.set(String(r[compResolved.xIdx] ?? ""), v);
      }
    }

    return data.rows
      .filter((r) => safeNumber(r[yIdx]) !== null)
      .map((r) => ({
        label: String(r[xIdx] ?? ""),
        actual: safeNumber(r[yIdx])!,
        previous: compMap.get(String(r[xIdx] ?? "")) ?? null,
      }));
  }, [data, comparisonData, widget.x, widget.y]);

  if (data === null) {
    return (
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          padding: 16,
        }}
        aria-live="polite"
        aria-busy={true}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
          {titleNode}
        </h3>
        <WidgetSkeleton type="chart" />
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          padding: 16,
        }}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
          {titleNode}
        </h3>
        <p style={{ textAlign: "center", fontSize: 13, color: "var(--fg-muted)" }}>
          {EMPTY_MESSAGE}
        </p>
      </div>
    );
  }

  const n = chartData.length;
  const hasComparison = chartData.some((d) => d.previous !== null);
  const maxVal = Math.max(...chartData.flatMap((d) => [d.actual, d.previous ?? 0])) * 1.1 || 1;

  // SVG viewBox: 800 wide units for crisp text rendering
  const VW = 800;
  const VH = CHART_HEIGHT;
  const plotH = VH - PAD_T - PAD_B;

  const bw = VW / n;
  const barW = bw * 0.38;
  const xLabelStep = Math.ceil(n / 12);

  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)", letterSpacing: "-0.005em" }}>
          {titleNode}
        </h3>
      </div>

      {/* Chart body */}
      <div
        style={{ padding: "var(--pad, 12px)", position: "relative" }}
        role="img"
        aria-label={`Gráfico de barras: ${widget.title}. ${n} categorías.`}
      >
        <span className="sr-only">Gráfico de barras con {n} categorías.</span>

        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          style={{ width: "100%", height: CHART_HEIGHT, display: "block" }}
        >
          {/* Gridlines at 0%, 25%, 50%, 75%, 100% */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <line
              key={t}
              x1="0"
              y1={PAD_T + plotH * t}
              x2={VW}
              y2={PAD_T + plotH * t}
              stroke="var(--grid, rgba(255,255,255,0.06))"
              strokeWidth="1"
            />
          ))}

          {chartData.map((d, i) => {
            const x = i * bw + bw * 0.08;
            const hActual = (d.actual / maxVal) * plotH;
            const hPrev = d.previous !== null ? (d.previous / maxVal) * plotH : 0;

            const actualColor = resolveChartColor(i);

            return (
              <g
                key={i}
                onMouseEnter={() =>
                  setHover({ i, label: d.label, actual: d.actual, previous: d.previous })
                }
                onMouseLeave={() => setHover(null)}
                onClick={
                  onDataPointClick
                    ? () =>
                        onDataPointClick({
                          label: d.label,
                          value: String(d.actual),
                          widgetTitle: widget.title,
                          widgetType: "bar_chart",
                        })
                    : undefined
                }
                style={{ cursor: onDataPointClick ? "pointer" : "default" }}
              >
                {/* Hover hit area */}
                <rect x={i * bw} y={PAD_T} width={bw} height={plotH} fill="transparent" />

                {/* Previous bar */}
                {hasComparison && d.previous !== null && (
                  <rect
                    x={x}
                    y={PAD_T + plotH - hPrev}
                    width={barW}
                    height={hPrev}
                    fill="var(--accent-2, #8b9cf4)"
                    opacity="0.55"
                    rx="1"
                  />
                )}

                {/* Actual bar */}
                <rect
                  x={x + (hasComparison ? barW + bw * 0.04 : 0)}
                  y={PAD_T + plotH - hActual}
                  width={barW}
                  height={hActual}
                  fill={actualColor}
                  rx="1"
                />

                {/* X label */}
                {i % xLabelStep === 0 && (
                  <text
                    x={i * bw + bw / 2}
                    y={VH - 4}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--fg-subtle)"
                    fontFamily="var(--font-jetbrains, monospace)"
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "var(--bg-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 11,
              pointerEvents: "none",
              minWidth: 140,
            }}
          >
            <div style={{ color: "var(--fg-muted)", fontSize: 10, marginBottom: 4 }}>
              {hover.label}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ color: "var(--accent)" }}>● Actual</span>
              <span style={{ fontFamily: "var(--font-jetbrains, monospace)" }}>
                {hover.actual.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
              </span>
            </div>
            {hover.previous !== null && (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 2 }}>
                <span style={{ color: "var(--accent-2, #8b9cf4)", opacity: 0.7 }}>● Anterior</span>
                <span style={{ fontFamily: "var(--font-jetbrains, monospace)" }}>
                  {hover.previous.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
