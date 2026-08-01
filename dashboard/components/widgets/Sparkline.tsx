"use client";

import { useMemo } from "react";

export interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

/**
 * 90×24 SVG sparkline — single stroke, area fill at 0.15 alpha.
 * No axes, no labels — pure signal line.
 */
export function Sparkline({
  data,
  color = "var(--accent)",
  width = 90,
  height = 24,
}: SparklineProps) {
  const { pathD, areaD } = useMemo(() => {
    if (!data || data.length === 0) {
      return { pathD: "", areaD: "" };
    }
    if (data.length === 1) {
      // Flat line across the middle
      const y = height / 2;
      return {
        pathD: `M0,${y} L${width},${y}`,
        areaD: `M0,${y} L${width},${y} L${width},${height} L0,${height} Z`,
      };
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min;
    const pad = 2;

    const pts = data.map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = range === 0
        ? height / 2
        : height - pad - ((v - min) / range) * (height - pad * 2);
      return [x, y] as [number, number];
    });

    const lineParts = pts.map(([x, y], i) =>
      i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`
    );
    const pathD = lineParts.join(" ");
    const lastX = pts[pts.length - 1][0];
    const areaD = `${pathD} L${lastX.toFixed(1)},${height} L0,${height} Z`;

    return { pathD, areaD };
  }, [data, width, height]);

  if (!pathD) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
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
