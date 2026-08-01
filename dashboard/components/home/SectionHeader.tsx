"use client";

import type { ReactNode } from "react";

/**
 * SectionHeader — reusable title + mono subtitle row, with optional right slot.
 */

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export function SectionHeader({ title, subtitle, right }: SectionHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: 4,
      }}
    >
      <div>
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            color: "var(--fg)",
          }}
        >
          {title}
        </h3>
        {subtitle && (
          <div
            style={{
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 11,
              color: "var(--fg-muted)",
              marginTop: 4,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}
