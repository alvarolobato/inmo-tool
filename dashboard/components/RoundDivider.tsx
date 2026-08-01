"use client";

interface RoundDividerProps {
  round: number;
}

export function RoundDivider({ round }: RoundDividerProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "12px 0",
        color: "var(--fg-muted)",
      }}
      aria-label={`Inicio de ronda ${round}`}
    >
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-jetbrains, monospace)",
          whiteSpace: "nowrap",
        }}
      >
        Ronda {round}
      </span>
      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}
