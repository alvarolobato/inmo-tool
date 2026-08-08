"use client";

import { toDisplayScore } from "@/lib/display-score";

/**
 * #452 — the compact investor-score chip on a candidate card: the 0–100 score
 * with its colour band (A "Oportunidad" … D "Flojo", "Sin puntuar" for a
 * never-scored property). A monotone re-expression of the same `effective_score`
 * the feed sorts on, so the chip never disagrees with the card's position.
 *
 * The tooltip is the `ranking_boost_reason` the row ALREADY carries (#309) —
 * previously computed but never rendered, so surfacing it here is a free win:
 * one glance at the score, one hover for "why".
 */
export function InvestorScoreChip({
  effectiveScore,
  baseScore,
  reason,
}: {
  effectiveScore: number | null;
  /** Base learned/cold-start score; null ⇒ never scored ⇒ "Sin puntuar". */
  baseScore: number | null;
  reason: string | null;
}) {
  // A never-scored property (base score NULL) is always "Sin puntuar", even if a
  // boost nudged its sentinel effective_score — toDisplayScore also guards the
  // sentinel, so this is belt-and-braces.
  const display =
    baseScore === null ? toDisplayScore(null) : toDisplayScore(effectiveScore);

  const title =
    reason ??
    (display.unscored
      ? "Aún sin puntuar para este perfil."
      : "Puntuación inversora (combina precio, señales de oportunidad y timing).");

  return (
    <span
      data-testid="investor-score-chip"
      data-score={display.value ?? ""}
      data-grade={display.band.grade ?? "none"}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        fontSize: 11,
        lineHeight: "16px",
        fontWeight: 700,
        letterSpacing: 0.2,
        padding: "1px 7px",
        borderRadius: 4,
        whiteSpace: "nowrap",
        background: display.band.bg,
        color: display.band.color,
        border: "1px solid currentColor",
      }}
    >
      {display.unscored ? (
        <span>Sin puntuar</span>
      ) : (
        <>
          <span style={{ fontSize: 13 }}>{display.value}</span>
          <span style={{ fontWeight: 600, textTransform: "uppercase", fontSize: 10 }}>
            {display.band.label}
          </span>
        </>
      )}
    </span>
  );
}
