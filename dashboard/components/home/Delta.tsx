"use client";

/**
 * Delta — coloured percentage chip with arrow indicator.
 *
 * Sizes: sm (10px) | md (11px) | lg (13px)
 * Pass `inverted={true}` for "lower is better" metrics (e.g. Devoluciones)
 * so that a negative delta renders as "up" (good).
 */

export interface DeltaProps {
  /** Signed fraction: 0.082 = +8.2%, -0.114 = -11.4% */
  value: number | null | undefined;
  size?: "sm" | "md" | "lg";
  inverted?: boolean;
  /** "pp" renders as percentage-point difference (e.g. -0.03 → "-3.0 pp")
   *  instead of the default relative-percent format ("-3.0%"). Use for
   *  margin deltas where the value is already an absolute pp difference. */
  unit?: "pp";
}

export function Delta({ value, size = "md", inverted = false, unit }: DeltaProps) {
  if (value === null || value === undefined) {
    return (
      <span
        style={{
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: size === "lg" ? 13 : size === "sm" ? 10 : 11,
          color: "var(--fg-subtle)",
        }}
      >
        —
      </span>
    );
  }

  const isFlat = Math.abs(value) < 0.005;
  const rawUp = value > 0;
  // For inverted metrics (lower=better), flip colour logic only
  const isUp = isFlat ? false : inverted ? !rawUp : rawUp;

  const color = isFlat ? "var(--fg-muted)" : isUp ? "var(--up)" : "var(--down)";
  const bg = isFlat ? "transparent" : isUp ? "var(--up-bg)" : "var(--down-bg)";
  const arrow = isFlat ? "·" : rawUp ? "▲" : "▼";

  const fontSize = size === "lg" ? 13 : size === "sm" ? 10 : 11;
  const arrowSize = fontSize - 2;
  const padding = size === "lg" ? "4px 10px" : size === "sm" ? "1px 6px" : "3px 8px";

  const pct = `${value > 0 ? "+" : ""}${(value * 100).toLocaleString("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}${unit === "pp" ? " pp" : "%"}`;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding,
        borderRadius: 4,
        fontSize,
        fontWeight: 600,
        background: bg,
        color,
        fontFamily: "var(--font-jetbrains, monospace)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
      aria-label={`delta ${pct}`}
    >
      <span style={{ fontSize: arrowSize }}>{arrow}</span>
      <span>{pct}</span>
    </span>
  );
}
