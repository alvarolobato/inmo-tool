"use client";

import type { Metric } from "@/lib/home-types";
import { Delta } from "./Delta";
import { fmtEUR0, fmtEUR2, fmtInt, fmtX, fmtPct } from "@/components/widgets/format";

interface OperationsRowProps {
  sectionLabel: "RETAIL" | "MAYORISTA";
  title: string;
  subtitle: string;
  metrics: Metric[];
}

function formatValue(value: number, format: Metric["format"]): string {
  switch (format) {
    case "eur":  return fmtEUR0(value);
    case "eur2": return fmtEUR2(value);
    case "int":  return fmtInt(value);
    case "pct":  return fmtPct(value);
    case "x":    return fmtX(value);
    default:     return String(value);
  }
}

function formatMetricValue(metric: Metric): string {
  return formatValue(metric.value, metric.format);
}

interface MetricCellProps {
  metric: Metric;
  isLast: boolean;
}

function MetricCell({ metric, isLast }: MetricCellProps) {
  return (
    <div
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderRight: isLast ? "none" : "1px solid var(--border)",
      }}
      data-testid={`metric-cell-${metric.id}`}
    >
      {/* Label */}
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 10,
          color: "var(--fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {metric.label}
      </span>

      {/* Value + suffix */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            fontVariantNumeric: "tabular-nums",
            color: "var(--fg)",
          }}
        >
          {formatMetricValue(metric)}
          {metric.suffix && (
            <span
              style={{
                color: "var(--fg-muted)",
                fontSize: 12,
                fontWeight: 400,
                marginLeft: 2,
              }}
            >
              {metric.suffix}
            </span>
          )}
        </span>
      </div>

      {/* Delta + sub-text */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Delta value={metric.delta} inverted={metric.inverted} size="sm" unit={metric.deltaUnit} />
        {metric.sub && (
          <span
            style={{
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 10,
              color: "var(--fg-subtle)",
            }}
          >
            {metric.sub}
          </span>
        )}
      </div>

      {/* Baseline reference (e.g. 30-day rolling average) */}
      {metric.baseline && (
        <div
          data-testid={`metric-baseline-${metric.id}`}
          style={{
            fontFamily: "var(--font-jetbrains, monospace)",
            fontSize: 10,
            color:
              metric.inverted &&
              metric.format === "pct" &&
              metric.value > metric.baseline.value + 0.01
                ? "var(--down)"
                : "var(--fg-subtle)",
          }}
        >
          {metric.baseline.label}: {formatValue(metric.baseline.value, metric.format)}
        </div>
      )}
    </div>
  );
}

export function OperationsRow({
  sectionLabel,
  title,
  subtitle,
  metrics,
}: OperationsRowProps) {
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
      data-testid={`operations-row-${sectionLabel.toLowerCase()}`}
    >
      {/* Section header */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-2)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-jetbrains, monospace)",
            fontSize: 9,
            color: "var(--accent)",
            background: "var(--accent-soft)",
            padding: "2px 6px",
            borderRadius: 3,
            letterSpacing: "0.08em",
            fontWeight: 600,
          }}
        >
          {sectionLabel}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
        <span
          style={{
            fontFamily: "var(--font-jetbrains, monospace)",
            fontSize: 11,
            color: "var(--fg-muted)",
          }}
        >
          {subtitle}
        </span>
      </div>

      {/* Metrics grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${metrics.length}, 1fr)`,
        }}
      >
        {metrics.map((m, i) => (
          <MetricCell key={m.id} metric={m} isLast={i === metrics.length - 1} />
        ))}
      </div>
    </div>
  );
}
