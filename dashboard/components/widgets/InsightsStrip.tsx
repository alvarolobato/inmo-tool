"use client";

import type { InsightsStripWidget } from "@/lib/schema";

interface InsightsStripProps {
  widget: InsightsStripWidget;
}

function iconFor(kind: "up" | "down" | "warn"): string {
  if (kind === "up") return "▲";
  if (kind === "down") return "▼";
  return "⚠";
}

function colorFor(kind: "up" | "down" | "warn"): string {
  if (kind === "up") return "var(--up)";
  if (kind === "down") return "var(--down)";
  return "var(--warn)";
}

function bgFor(kind: "up" | "down" | "warn"): string {
  if (kind === "up") return "var(--up-bg)";
  if (kind === "down") return "var(--down-bg)";
  return "var(--warn-bg)";
}

export function InsightsStrip({ widget }: InsightsStripProps) {
  const { items } = widget;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        gap: "var(--gap, 12px)",
      }}
    >
      {items.map((ins, i) => (
        <div
          key={i}
          style={{
            background: "var(--bg-1)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "14px 16px",
            display: "flex",
            gap: 12,
          }}
        >
          {/* Icon tile */}
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: bgFor(ins.kind),
              color: colorFor(ins.kind),
              display: "grid",
              placeItems: "center",
              fontSize: 12,
              flexShrink: 0,
              fontWeight: 700,
            }}
            aria-hidden="true"
          >
            {iconFor(ins.kind)}
          </div>

          {/* Text */}
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                color: "var(--fg)",
              }}
            >
              {ins.title}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-muted)",
                marginTop: 3,
                lineHeight: 1.45,
              }}
            >
              {ins.body}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
