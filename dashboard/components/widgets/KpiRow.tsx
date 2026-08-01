"use client";

import type { KpiRowWidget, GlossaryItem } from "@/lib/schema";
import type { WidgetData } from "./types";
import { formatValue, fmtDelta } from "./format";
import { applyGlossary } from "@/lib/glossary";
import { Sparkline } from "./Sparkline";

// ---------------------------------------------------------------------------
// KPI style type
// ---------------------------------------------------------------------------
export type KpiStyle = "editorial" | "bold" | "minimal";

interface KpiRowProps {
  widget: KpiRowWidget;
  data: (WidgetData | null)[];
  trendData?: (WidgetData | null)[];
  glossary?: GlossaryItem[];
  anomalyData?: (WidgetData | null)[];
  kpiStyle?: KpiStyle;
}

// ---------------------------------------------------------------------------
// Z-score anomaly computation (preserved from original)
// ---------------------------------------------------------------------------

const ANOMALY_Z_THRESHOLD = 2.0;
const MIN_HISTORICAL_VALUES = 4;

interface AnomalyInfo {
  isAnomaly: boolean;
  direction: "high" | "low" | "normal";
  explanation: string;
}

function computeAnomaly(data: WidgetData | null): AnomalyInfo | null {
  if (!data || data.rows.length === 0) return null;

  const currentRaw = data.rows[0]?.[0];
  if (currentRaw === null || currentRaw === undefined) return null;
  const currentValue = Number(currentRaw);
  if (isNaN(currentValue)) return null;

  const historical: number[] = [];
  for (const row of data.rows.slice(1)) {
    const raw = row[0];
    if (raw !== null && raw !== undefined) {
      const num = Number(raw);
      if (!isNaN(num)) historical.push(num);
    }
  }

  if (historical.length < MIN_HISTORICAL_VALUES) return null;
  const n = historical.length;
  const mean = historical.reduce((sum, v) => sum + v, 0) / n;
  const variance = historical.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return null;

  const zScore = (currentValue - mean) / stddev;
  const isAnomaly = Math.abs(zScore) > ANOMALY_Z_THRESHOLD;
  if (!isAnomaly) return null;

  const direction: "high" | "low" = zScore > ANOMALY_Z_THRESHOLD ? "high" : "low";
  const pctChange = mean !== 0 ? ((currentValue - mean) / Math.abs(mean)) * 100 : null;
  const dirText = direction === "high" ? "por encima" : "por debajo";
  const fmt = (v: number) => v.toLocaleString("es-ES", { maximumFractionDigits: 2 });
  const absDifference = Math.abs(currentValue - mean);
  const explanation =
    pctChange !== null
      ? `El valor actual (${fmt(currentValue)}) está un ${Math.abs(pctChange).toFixed(0)}% ${dirText} de la media de los últimos ${n} períodos (${fmt(mean)}).`
      : `El valor actual (${fmt(currentValue)}) está ${fmt(absDifference)} ${dirText} de la media de los últimos ${n} períodos (${fmt(mean)}).`;

  return { isAnomaly: true, direction, explanation };
}

// ---------------------------------------------------------------------------
// KpiCard
// ---------------------------------------------------------------------------

interface KpiCardProps {
  item: KpiRowWidget["items"][number];
  currentValue: number | null;
  comparisonValue: number | null;
  anomaly: AnomalyInfo | null;
  kpiStyle: KpiStyle;
  glossary?: GlossaryItem[];
}

function KpiCard({ item, currentValue, comparisonValue, anomaly: computedAnomaly, kpiStyle, glossary }: KpiCardProps) {
  // Spec-level anomaly overrides computed when explicitly set
  const isAnomaly = item.anomaly !== undefined ? item.anomaly : (computedAnomaly?.isAnomaly ?? false);

  // Formatted main value
  const displayValue = formatValue(currentValue, item.format, item.prefix);

  // Delta chip — prefer spec delta, fall back to computed from trend data
  let deltaRatio: number | null = null;
  if (item.delta !== undefined) {
    deltaRatio = item.delta;
  } else if (currentValue !== null && comparisonValue !== null && comparisonValue !== 0) {
    deltaRatio = (currentValue - comparisonValue) / Math.abs(comparisonValue);
  }

  // Comparison display value — use formatValue to respect prefix and format consistently
  const compDisplay =
    item.comparison !== undefined
      ? formatValue(item.comparison, item.format, item.prefix)
      : comparisonValue !== null
        ? formatValue(comparisonValue, item.format, item.prefix)
        : null;

  // Delta chip polarity
  let chipColor = "var(--fg-subtle)";
  let chipBg = "var(--bg-2)";
  if (deltaRatio !== null) {
    const positive = deltaRatio >= 0;
    const isWarn = item.warn ?? false;
    const effectivePositive = item.inverted ? !positive : positive;
    if (isWarn) {
      chipColor = "var(--warn)";
      chipBg = "var(--warn-bg)";
    } else if (effectivePositive) {
      chipColor = "var(--up)";
      chipBg = "var(--up-bg)";
    } else {
      chipColor = "var(--down)";
      chipBg = "var(--down-bg)";
    }
  }

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-1)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "var(--kpi-pad, 16px)",
    position: "relative",
    overflow: "hidden",
    transition: "all 0.2s",
  };

  const chipStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 4,
    color: chipColor,
    background: chipBg,
    fontFamily: "var(--font-jetbrains, monospace)",
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    whiteSpace: "nowrap" as const,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: "var(--fg-muted)",
    fontFamily: "var(--font-jetbrains, monospace)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };

  if (kpiStyle === "editorial") {
    return (
      <div style={cardStyle} data-testid="kpi-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={labelStyle}>{applyGlossary(item.label, glossary)}</div>
            {isAnomaly && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--down)",
                  marginTop: 4,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
                data-testid="anomaly-badge"
                title={computedAnomaly?.explanation}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--down)",
                    animation: "pulse-dot 2s ease-in-out infinite",
                    display: "inline-block",
                  }}
                />
                ANOMALÍA DETECTADA
              </div>
            )}
          </div>
          {deltaRatio !== null && (
            <span style={chipStyle}>
              {fmtDelta(deltaRatio).arrow} {fmtDelta(deltaRatio).text.replace(/^[+−]/, "")}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            marginTop: 12,
            lineHeight: 1.05,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {displayValue}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 10,
            gap: 10,
          }}
        >
          {compDisplay && (
            <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
              vs {compDisplay}
            </div>
          )}
          {item.spark && item.spark.length > 0 && (
            <div style={{ color: chipColor }}>
              <Sparkline data={item.spark} color={chipColor} width={90} height={24} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kpiStyle === "bold") {
    return (
      <div style={cardStyle} data-testid="kpi-card">
        <div style={labelStyle}>{applyGlossary(item.label, glossary)}</div>
        <div
          style={{
            fontSize: 42,
            fontWeight: 700,
            marginTop: 8,
            letterSpacing: "-0.03em",
            color: "var(--fg)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {displayValue}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          {deltaRatio !== null && (
            <span style={chipStyle}>
              {fmtDelta(deltaRatio).arrow} {fmtDelta(deltaRatio).text.replace(/^[+−]/, "")}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>vs anterior</span>
        </div>
      </div>
    );
  }

  // minimal
  return (
    <div style={cardStyle} data-testid="kpi-card">
      <div style={{ ...labelStyle, fontSize: 11 }}>{applyGlossary(item.label, glossary)}</div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {displayValue}
      </div>
      {deltaRatio !== null && (
        <div style={{ fontSize: 11, color: chipColor, marginTop: 2 }}>
          {fmtDelta(deltaRatio).arrow} {fmtDelta(deltaRatio).text.replace(/^[+−]/, "")}
          {compDisplay && ` (${compDisplay})`}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KpiRow — public component
// ---------------------------------------------------------------------------

export function KpiRow({
  widget,
  data,
  trendData,
  glossary,
  anomalyData,
  kpiStyle = "editorial",
}: KpiRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {widget.items.map((item, idx) => {
        const entry = data[idx];
        const rawValue =
          entry && entry.rows.length > 0 ? entry.rows[0][0] : null;
        const currentNum =
          rawValue !== null && rawValue !== undefined ? Number(rawValue) : null;

        // Trend/comparison
        const trendEntry = trendData?.[idx];
        const trendRawValue =
          trendEntry && trendEntry.rows.length > 0 ? trendEntry.rows[0][0] : null;
        const comparisonNum =
          trendRawValue !== null && trendRawValue !== undefined
            ? Number(trendRawValue)
            : null;

        // Anomaly
        const anomalyEntry = anomalyData?.[idx] ?? null;
        const computedAnomaly = item.anomaly_sql ? computeAnomaly(anomalyEntry) : null;

        return (
          <KpiCard
            key={idx}
            item={item}
            currentValue={currentNum !== null && !isNaN(currentNum) ? currentNum : null}
            comparisonValue={comparisonNum !== null && !isNaN(comparisonNum) ? comparisonNum : null}
            anomaly={computedAnomaly}
            kpiStyle={kpiStyle}
            glossary={glossary}
          />
        );
      })}
    </div>
  );
}
