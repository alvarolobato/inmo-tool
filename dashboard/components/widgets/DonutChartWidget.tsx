"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DonutChartWidget as DonutChartWidgetSpec, GlossaryItem } from "@/lib/schema";
import type { OnDataPointClick, WidgetData } from "./types";
import { EMPTY_MESSAGE, resolveXY, safeNumber } from "./types";
import { resolveChartColor } from "./chart-colors";
import { applyGlossary } from "@/lib/glossary";
import { WidgetSkeleton } from "./WidgetSkeleton";

interface DonutChartWidgetProps {
  widget: DonutChartWidgetSpec;
  data: WidgetData | null;
  comparisonData?: WidgetData | null;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
}

const DONUT_SIZE = 160;
const STROKE_WIDTH = 22;

/**
 * Wide-panel mitigation thresholds (issue #420).
 * - WIDE_PANEL_MIN_WIDTH: above this px width the panel is rectangular/half-
 *   width on desktop and the legend uses space-between alignment so it fills
 *   the right side instead of clinging to the donut.
 * - MIN_TWO_COL_CATEGORIES: with this many or more categories on a wide panel,
 *   the legend switches to a 2-column grid for better density.
 */
const WIDE_PANEL_MIN_WIDTH = 420;
const MIN_TWO_COL_CATEGORIES = 4;

export function DonutChartWidget({
  widget,
  data,
  comparisonData,
  glossary,
  onDataPointClick,
}: DonutChartWidgetProps) {
  const titleNode = applyGlossary(widget.title, glossary);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Track container width so we can mitigate the wide-rectangular-panel
  // empty-space problem (issue #420) when the LLM still picks donut for a
  // half-width panel. See WIDE_PANEL_MIN_WIDTH for the breakpoint.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartData = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    const resolved = resolveXY(data, widget.x, widget.y);
    if (!resolved) return null;
    const { xIdx, yIdx } = resolved;
    return data.rows
      .filter((r) => r[xIdx] != null && r[xIdx] !== "" && safeNumber(r[yIdx]) !== null)
      .map((r, i) => ({
        label: String(r[xIdx]),
        value: safeNumber(r[yIdx])!,
        color: resolveChartColor(i),
      }));
  }, [data, widget.x, widget.y]);

  const comparisonTotal = useMemo(() => {
    if (!comparisonData || comparisonData.rows.length === 0) return null;
    const resolved = resolveXY(comparisonData, widget.x, widget.y);
    if (!resolved) return null;
    let sum = 0;
    for (const r of comparisonData.rows) {
      const v = safeNumber(r[resolved.yIdx]);
      if (v !== null) sum += v;
    }
    return sum;
  }, [comparisonData, widget.x, widget.y]);

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

  const total = chartData.reduce((s, d) => s + d.value, 0);
  const cx = DONUT_SIZE / 2;
  const cy = DONUT_SIZE / 2;
  const r = DONUT_SIZE / 2 - 4;
  const rMid = r - STROKE_WIDTH / 2;
  const circ = 2 * Math.PI * rMid;

  // Build arc segments
  let dashOffset = 0;
  const arcs = chartData.map((d, i) => {
    const frac = d.value / (total || 1);
    const dash = frac * circ;
    const arc = { ...d, i, dashOffset, dash };
    dashOffset += dash;
    return arc;
  });

  // Layout decision for the wide-rectangular-panel mitigation (issue #420).
  // Computed outside the JSX so the render output stays readable and we don't
  // reallocate an IIFE on every render.
  const isWidePanel = containerWidth > WIDE_PANEL_MIN_WIDTH;
  const useTwoColLegend = isWidePanel && chartData.length >= MIN_TWO_COL_CATEGORIES;

  // Center readout
  const display = hoverIdx !== null ? chartData[hoverIdx] : null;
  const centerPct = display
    ? total > 0 ? `${((display.value / total) * 100).toFixed(1)}%` : "0,0%"
    : total > 0 ? total.toLocaleString("es-ES", { maximumFractionDigits: 0 }) : "—";
  const centerLabel = display ? display.label : "Total";

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

      {/* Chart + legend */}
      <div
        ref={containerRef}
        style={{ padding: "var(--pad, 12px)" }}
        role="img"
        aria-label={`Gráfico de donut: ${widget.title}. ${chartData.length} categorías.`}
      >
        <span className="sr-only">Gráfico de donut con {chartData.length} categorías.</span>

        {/*
          Wide-panel mitigation (issue #420): when the panel is rectangular
          (width > WIDE_PANEL_MIN_WIDTH) the default flex layout leaves the
          right ~60% empty. Use space-between alignment + a 2-column legend
          grid so the legend fills the right side instead of clinging to the
          donut. Square / narrow panels keep the original behaviour.
        */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: isWidePanel ? "space-between" : "flex-start",
            gap: isWidePanel ? 32 : 20,
            flexWrap: "wrap",
          }}
        >
          {/* SVG donut */}
          <svg
            width={DONUT_SIZE}
            height={DONUT_SIZE}
            viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
            style={{ flexShrink: 0 }}
          >
            {/* Background ring */}
            <circle
              cx={cx}
              cy={cy}
              r={rMid}
              fill="none"
              stroke="var(--bg-2)"
              strokeWidth={STROKE_WIDTH}
            />

            {/* Segments */}
            {arcs.map((a) => (
              <circle
                key={a.i}
                cx={cx}
                cy={cy}
                r={rMid}
                fill="none"
                stroke={a.color}
                strokeWidth={hoverIdx === a.i ? STROKE_WIDTH + 3 : STROKE_WIDTH}
                strokeDasharray={`${a.dash} ${circ}`}
                strokeDashoffset={-a.dashOffset}
                transform={`rotate(-90 ${cx} ${cy})`}
                style={{ transition: "stroke-width 0.2s", cursor: onDataPointClick ? "pointer" : "default" }}
                onMouseEnter={() => setHoverIdx(a.i)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={
                  onDataPointClick
                    ? () =>
                        onDataPointClick({
                          label: a.label,
                          value: String(a.value),
                          widgetTitle: widget.title,
                          widgetType: "donut_chart",
                        })
                    : undefined
                }
              />
            ))}

            {/* Center text */}
            <text
              x={cx}
              y={cy - 4}
              textAnchor="middle"
              fontSize="22"
              fontWeight="600"
              fill="var(--fg)"
            >
              {centerPct}
            </text>
            <text
              x={cx}
              y={cy + 14}
              textAnchor="middle"
              fontSize="10"
              fill="var(--fg-subtle)"
              fontFamily="var(--font-jetbrains, monospace)"
              style={{ textTransform: "uppercase" as const, letterSpacing: "0.08em" }}
            >
              {centerLabel.length > 10 ? centerLabel.slice(0, 10) + "…" : centerLabel}
            </text>
          </svg>

          {/* Legend */}
          <div
            style={
              useTwoColLegend
                ? {
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    columnGap: 24,
                    rowGap: 8,
                    flex: 1,
                    minWidth: 200,
                  }
                : { display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 100 }
            }
          >
            {chartData.map((d, i) => (
              <div
                key={i}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "10px 1fr auto",
                  alignItems: "center",
                  gap: 10,
                  cursor: onDataPointClick ? "pointer" : "default",
                  opacity: hoverIdx !== null && hoverIdx !== i ? 0.5 : 1,
                  transition: "opacity 0.2s",
                }}
                onClick={
                  onDataPointClick
                    ? () =>
                        onDataPointClick({
                          label: d.label,
                          value: String(d.value),
                          widgetTitle: widget.title,
                          widgetType: "donut_chart",
                        })
                    : undefined
                }
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: d.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 12, color: "var(--fg)" }}>{d.label}</span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--fg-muted)",
                    fontFamily: "var(--font-jetbrains, monospace)",
                  }}
                >
                  {total > 0 ? `${((d.value / total) * 100).toFixed(1)}%` : "0%"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {comparisonTotal !== null && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              fontSize: 11,
              color: "var(--fg-muted)",
            }}
          >
            <span style={{ fontWeight: 500 }}>
              Actual: {total.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
            </span>
            <span style={{ color: "var(--border-strong)" }}>|</span>
            <span>
              Anterior: {comparisonTotal.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
