"use client";

import { useMemo } from "react";

/**
 * Reusable SVG sparkline for the home page.
 * Width: 70 / 80 / 90 (via props). Height: any.
 * Color follows direction: pass `color` explicitly (usually --up or --down).
 * Stroke 1.5, round joins.
 */

export interface SparklineProps {
  data: number[];
  /** Stroke + fill color. Use CSS variable strings or hex. */
  color?: string;
  width?: number;
  height?: number;
  /** Accessible label for screen readers */
  label?: string;
  /** When set, renders a directional arrow at the end of the sparkline. */
  trendDirection?: "up" | "flat" | "down";
}

export function HomeSparkline({
  data,
  color = "var(--accent)",
  width = 80,
  height = 24,
  label = "Sparkline",
  trendDirection,
}: SparklineProps) {
  const { pathD, areaD } = useMemo(() => {
    if (!data || data.length === 0) return { pathD: "", areaD: "" };
    if (data.length === 1) {
      const y = height / 2;
      return {
        pathD: `M0,${y} L${width},${y}`,
        areaD: `M0,${y} L${width},${y} L${width},${height} L0,${height} Z`,
      };
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 2;
    const pts = data.map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y =
        range === 0
          ? height / 2
          : height - pad - ((v - min) / range) * (height - pad * 2);
      return [x, y] as [number, number];
    });
    const lineParts = pts.map(([x, y], i) =>
      i === 0
        ? `M${x.toFixed(1)},${y.toFixed(1)}`
        : `L${x.toFixed(1)},${y.toFixed(1)}`
    );
    const pathD = lineParts.join(" ");
    const lastX = pts[pts.length - 1][0];
    const areaD = `${pathD} L${lastX.toFixed(1)},${height} L0,${height} Z`;
    return { pathD, areaD };
  }, [data, width, height]);

  if (!pathD) return null;

  // Directional arrow rendered to the right of the sparkline when trendDirection is set.
  const arrowChar = trendDirection === "up" ? "▲" : trendDirection === "down" ? "▼" : null;
  const arrowColor =
    trendDirection === "up" ? "var(--up)" : trendDirection === "down" ? "var(--down)" : undefined;

  if (arrowChar) {
    return (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}
        data-testid="sparkline-with-trend"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: "block", overflow: "visible", flexShrink: 0 }}
          role="img"
          aria-label={label}
        >
          <title>{label}</title>
          <path d={areaD} fill={color} opacity={0.15} />
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          style={{
            fontSize: 9,
            color: arrowColor,
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
          aria-label={trendDirection === "up" ? "tendencia al alza" : "tendencia a la baja"}
          data-testid={`trend-indicator-${trendDirection}`}
        >
          {arrowChar}
        </span>
      </span>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", overflow: "visible", flexShrink: 0 }}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path d={areaD} fill={color} opacity={0.15} />
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
