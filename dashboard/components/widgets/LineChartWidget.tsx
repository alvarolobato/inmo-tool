"use client";

import { useState, useRef, useMemo, useId } from "react";
import type { LineChartWidget as LineChartWidgetSpec, GlossaryItem } from "@/lib/schema";
import type { OnDataPointClick, WidgetData } from "./types";
import { EMPTY_MESSAGE, resolveXY, safeNumber } from "./types";
import { applyGlossary } from "@/lib/glossary";
import { WidgetSkeleton } from "./WidgetSkeleton";

interface LineChartWidgetProps {
  widget: LineChartWidgetSpec;
  data: WidgetData | null;
  comparisonData?: WidgetData | null;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
}

const CHART_HEIGHT = 280;
const PAD = { t: 10, r: 12, b: 28, l: 48 };

function yTicks(min: number, max: number, count = 5): number[] {
  const range = max - min || 1;
  const step = range / (count - 1);
  return Array.from({ length: count }, (_, i) => max - step * i);
}

function formatYLabel(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return n.toFixed(0);
}

interface HoverState {
  idx: number;
  x: number;
  actualY: number;
  prevY: number | null;
  actualVal: number;
  prevVal: number | null;
  label: string;
}

export function LineChartWidget({
  widget,
  data,
  comparisonData,
  glossary,
  onDataPointClick,
}: LineChartWidgetProps) {
  const titleNode = applyGlossary(widget.title, glossary);
  const gradientId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<HoverState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Internal viewBox width (logical SVG units)
  const VW = 800;
  const VH = CHART_HEIGHT;

  const chartData = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    const resolved = resolveXY(data, widget.x, widget.y);
    if (!resolved) return null;
    const { xIdx, yIdx, xCol } = resolved;

    const primary = data.rows
      .filter((r) => safeNumber(r[yIdx]) !== null)
      .map((r) => ({
        label: String(r[xIdx] ?? ""),
        actual: safeNumber(r[yIdx])!,
      }));

    // Build comparison lookup
    const compMap = new Map<string, number>();
    if (comparisonData && comparisonData.rows.length > 0) {
      const compResolved = resolveXY(comparisonData, widget.x, widget.y);
      if (compResolved) {
        for (const r of comparisonData.rows) {
          const v = safeNumber(r[compResolved.yIdx]);
          if (v !== null) compMap.set(String(r[compResolved.xIdx] ?? ""), v);
        }
      }
    }

    const rows = primary.map((p) => ({
      label: p.label,
      actual: p.actual,
      previous: compMap.get(p.label) ?? null,
    }));

    return { rows, xCol };
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

  if (!chartData || chartData.rows.length === 0) {
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

  const { rows } = chartData;
  const n = rows.length;

  const allVals = [
    ...rows.map((r) => r.actual),
    ...rows.flatMap((r) => (r.previous !== null ? [r.previous] : [])),
  ];
  const dataMax = Math.max(...allVals) * 1.1;
  const dataMin = 0;

  const plotW = VW - PAD.l - PAD.r;
  const plotH = VH - PAD.t - PAD.b;

  const xStep = n > 1 ? plotW / (n - 1) : plotW;
  // Guard against all-zero data: use 1 as minimum range to avoid Infinity/NaN
  const yRange = (dataMax - dataMin) || 1;
  const yScale = (v: number) =>
    PAD.t + (1 - (v - dataMin) / yRange) * plotH;

  const xFor = (i: number) => PAD.l + i * xStep;

  const actualPath = rows
    .map((r, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yScale(r.actual).toFixed(1)}`)
    .join(" ");
  const actualArea = `${actualPath} L${xFor(n - 1).toFixed(1)},${(PAD.t + plotH).toFixed(1)} L${PAD.l.toFixed(1)},${(PAD.t + plotH).toFixed(1)} Z`;

  const prevPath = rows.some((r) => r.previous !== null)
    ? rows
        .map((r, i) => {
          const y = r.previous !== null ? yScale(r.previous).toFixed(1) : yScale(dataMin).toFixed(1);
          return `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${y}`;
        })
        .join(" ")
    : null;

  const ticks = yTicks(dataMin, dataMax);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = ((e.clientX - rect.left) / rect.width) * VW;
    const idx = Math.max(0, Math.min(n - 1, Math.round((rawX - PAD.l) / xStep)));
    const r = rows[idx];
    setHover({
      idx,
      x: xFor(idx),
      actualY: yScale(r.actual),
      prevY: r.previous !== null ? yScale(r.previous) : null,
      actualVal: r.actual,
      prevVal: r.previous,
      label: r.label,
    });
  };

  const xLabelStep = Math.ceil(n / 6);

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
        aria-label={`Gráfico de líneas: ${widget.title}. ${n} puntos.`}
      >
        <span className="sr-only">Gráfico de líneas con {n} puntos.</span>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VW} ${VH}`}
          style={{
            width: "100%",
            height: CHART_HEIGHT,
            display: "block",
            cursor: onDataPointClick ? "pointer" : "default",
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          onClick={
            onDataPointClick && hover
              ? () =>
                  onDataPointClick({
                    label: hover.label,
                    value: String(hover.actualVal),
                    widgetTitle: widget.title,
                    widgetType: "line_chart",
                  })
              : undefined
          }
        >
          <defs>
            <linearGradient id={`lineGrad-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD.l}
                y1={yScale(t)}
                x2={VW - PAD.r}
                y2={yScale(t)}
                stroke="var(--grid, rgba(255,255,255,0.06))"
                strokeWidth="1"
              />
              <text
                x={PAD.l - 6}
                y={yScale(t) + 4}
                textAnchor="end"
                fontSize="10"
                fill="var(--fg-subtle)"
                fontFamily="var(--font-jetbrains, monospace)"
              >
                {formatYLabel(t)}
              </text>
            </g>
          ))}

          {/* Area fill */}
          <path d={actualArea} fill={`url(#lineGrad-${gradientId})`} />

          {/* Comparison/previous line */}
          {prevPath && (
            <path
              d={prevPath}
              fill="none"
              stroke="var(--accent-2, #8b9cf4)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              opacity="0.7"
            />
          )}

          {/* Actual line */}
          <path
            d={actualPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* X-axis labels */}
          {rows.map((r, i) =>
            i % xLabelStep === 0 ? (
              <text
                key={i}
                x={xFor(i)}
                y={VH - 6}
                textAnchor="middle"
                fontSize="10"
                fill="var(--fg-subtle)"
                fontFamily="var(--font-jetbrains, monospace)"
              >
                {(() => {
                  try {
                    const d = new Date(r.label);
                    if (!isNaN(d.getTime()) && r.label.includes("T")) {
                      return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
                    }
                  } catch {
                    // fallthrough
                  }
                  return r.label;
                })()}
              </text>
            ) : null
          )}

          {/* Crosshair + markers on hover */}
          {hover && (
            <>
              <line
                x1={hover.x}
                y1={PAD.t}
                x2={hover.x}
                y2={PAD.t + plotH}
                stroke="var(--fg-muted)"
                strokeDasharray="2 2"
                strokeWidth="1"
              />
              <circle
                cx={hover.x}
                cy={hover.actualY}
                r="4"
                fill="var(--accent)"
                stroke="var(--bg-1)"
                strokeWidth="2"
              />
              {hover.prevY !== null && (
                <circle
                  cx={hover.x}
                  cy={hover.prevY}
                  r="3"
                  fill="var(--accent-2, #8b9cf4)"
                  stroke="var(--bg-1)"
                  strokeWidth="2"
                />
              )}
            </>
          )}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            style={{
              position: "absolute",
              top: 4,
              right: 12,
              background: "var(--bg-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 11,
              minWidth: 150,
              pointerEvents: "none",
            }}
          >
            <div style={{ color: "var(--fg-muted)", fontSize: 10, marginBottom: 4 }}>
              {(() => {
                try {
                  const d = new Date(hover.label);
                  if (!isNaN(d.getTime())) {
                    return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
                  }
                } catch {
                  // fallthrough
                }
                return hover.label;
              })()}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ color: "var(--accent)" }}>● Actual</span>
              <span style={{ fontFamily: "var(--font-jetbrains, monospace)" }}>
                {hover.actualVal.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
              </span>
            </div>
            {hover.prevVal !== null && (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 2 }}>
                <span style={{ color: "var(--accent-2, #8b9cf4)", opacity: 0.7 }}>● Anterior</span>
                <span style={{ fontFamily: "var(--font-jetbrains, monospace)" }}>
                  {hover.prevVal.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                </span>
              </div>
            )}
            {hover.prevVal !== null && (
              <div
                style={{
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: "1px solid var(--border)",
                  fontSize: 10,
                }}
              >
                <span
                  style={{
                    color:
                      hover.actualVal < hover.prevVal ? "var(--down)" : "var(--up)",
                  }}
                >
                  {hover.prevVal !== 0
                    ? (() => {
                        const delta = (hover.actualVal - hover.prevVal) / Math.abs(hover.prevVal);
                        return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
                      })()
                    : "—"}
                </span>
                <span style={{ color: "var(--fg-subtle)", marginLeft: 6 }}>vs período anterior</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
