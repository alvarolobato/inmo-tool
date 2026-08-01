"use client";

import type { RankedBarsWidget as RankedBarsWidgetSpec } from "@/lib/schema";

interface RankedBarsWidgetProps {
  widget: RankedBarsWidgetSpec;
}

export function RankedBarsWidget({ widget }: RankedBarsWidgetProps) {
  const { items, title } = widget;
  const maxValue =
    Math.max(...items.map((d) => d.maxValue ?? d.value), 1);

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
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            color: "var(--fg)",
          }}
        >
          {title}
        </h3>
      </div>

      {/* Scrollable body */}
      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          padding: "var(--pad, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {items.map((item, i) => {
          const effectiveMax = (item.maxValue != null && item.maxValue > 0) ? item.maxValue : (maxValue > 0 ? maxValue : 1);
          const pct = Math.min(100, Math.max(0, (item.value / effectiveMax) * 100));
          const barColor =
            item.flag === "low"
              ? "var(--down)"
              : item.flag === "top"
              ? "var(--up)"
              : "var(--accent)";

          const formattedValue = item.unit
            ? `${item.value.toLocaleString("es-ES")} ${item.unit}`
            : item.value.toLocaleString("es-ES");

          return (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "36px 1fr auto",
                alignItems: "center",
                gap: 10,
                height: 36,
              }}
            >
              {/* Label */}
              <span
                style={{
                  fontSize: 11,
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-jetbrains, monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </span>

              {/* Bar track */}
              <div
                style={{
                  height: 18,
                  background: "var(--bg-2)",
                  borderRadius: 3,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  data-testid="ranked-bar"
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: barColor,
                    borderRadius: 3,
                    transition: "width 0.5s cubic-bezier(.2,.8,.2,1)",
                  }}
                />
              </div>

              {/* Value */}
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-jetbrains, monospace)",
                  color: "var(--fg)",
                  minWidth: 60,
                  textAlign: "right",
                }}
              >
                {formattedValue}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
