"use client";

import type { PropertyInvestorScore } from "@/lib/candidates";
import { investorScoreBreakdown } from "@/lib/display-score";

/**
 * #452 — the property detail "Puntuación inversora" section (order 5 in
 * DetailSections). Renders the 0–100 score with its colour band and confidence
 * tier, a per-term breakdown whose points SUM EXACTLY to the score, "sin datos"
 * rows for signals with no data, and the property's risk flags as chips.
 *
 * Risk flags are shown as chips and are NEVER subtracted from the score (owner
 * decision, #452): for a value / REO buyer a distressed listing is the
 * opportunity, so distress already ADDS via its boost — the chips are the
 * qualitative read of the same signal, informational only.
 *
 * The score is a monotone re-expression of the feed's `effective_score`, so it
 * can never disagree with the card's position; all the math is the pure
 * `investorScoreBreakdown` (lib/display-score.ts).
 */
export function InvestorScoreSection({ score }: { score: PropertyInvestorScore }) {
  const { display, confidence, terms } = investorScoreBreakdown(score);

  return (
    <div
      data-testid="investor-score-section"
      data-score={display.value ?? ""}
      data-grade={display.band.grade ?? "none"}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      {/* Headline: the number + band + confidence. */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div
          data-testid="investor-score-value"
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 8,
            padding: "6px 14px",
            borderRadius: 10,
            background: display.band.bg,
            color: display.band.color,
            border: "1px solid currentColor",
          }}
        >
          <span style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>
            {display.unscored ? "—" : display.value}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>
            {display.band.label}
          </span>
        </div>
        {!display.unscored && (
          <span
            data-testid="investor-score-confidence"
            data-confidence={confidence}
            style={{ fontSize: 12, color: "var(--fg-muted)" }}
          >
            Confianza: <strong style={{ color: "var(--fg)" }}>{confidence}</strong>
          </span>
        )}
        <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>de 100</span>
      </div>

      {display.unscored ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--fg-muted)" }}>
          Esta propiedad todavía no tiene puntuación para este perfil (aún sin
          modelo entrenado o sin reevaluar). Se puntuará automáticamente cuando
          valores algún candidato.
        </p>
      ) : (
        <>
          {/* Breakdown — per-term points that sum to the score above. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <p style={{ margin: "0 0 2px", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)" }}>
              Cómo se compone
            </p>
            {terms.map((t) => (
              <div
                key={t.key}
                data-testid="investor-score-term"
                data-term={t.key}
                data-points={t.points}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  fontSize: 13,
                  color: t.hasData ? "var(--fg)" : "var(--fg-subtle)",
                }}
              >
                <span>
                  {t.label}
                  {!t.hasData && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: "var(--fg-subtle)" }}>
                      (sin datos)
                    </span>
                  )}
                  {/* #461: explain which comparison base drove the below-market
                      discount — a like-for-like segment vs the whole-profile
                      median — so the number is auditable, not a black box. */}
                  {t.key === "below_market" && t.hasData && score.below_market_base !== null && (
                    <span
                      data-testid="below-market-base-note"
                      data-base={score.below_market_base}
                      style={{ marginLeft: 6, fontSize: 11, color: "var(--fg-subtle)" }}
                    >
                      {score.below_market_base === "segment"
                        ? `(vs ${score.below_market_comparables ?? 0} similares)`
                        : "(vs mediana del perfil)"}
                    </span>
                  )}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  +{t.points}
                </span>
              </div>
            ))}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                marginTop: 4,
                paddingTop: 6,
                borderTop: "1px solid var(--border)",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              <span>Total</span>
              <span data-testid="investor-score-total" style={{ fontVariantNumeric: "tabular-nums" }}>
                {display.value}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Risk flags — chips only, never subtracted. Rendered whether scored or
          not, so a "Sin puntuar" property still shows its caveats. */}
      {score.risk_flags.length > 0 && (
        <div data-testid="investor-score-risks" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--fg-muted)" }}>
            Señales de riesgo{" "}
            <span style={{ fontWeight: 400, color: "var(--fg-subtle)" }}>
              (no restan puntos — para un comprador de oportunidad son parte de la tesis)
            </span>
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {score.risk_flags.map((f) => (
              <span
                key={f.kind}
                data-testid="investor-score-risk-chip"
                data-flag-kind={f.kind}
                style={{
                  fontSize: 11,
                  lineHeight: "16px",
                  padding: "1px 7px",
                  borderRadius: 4,
                  fontWeight: 600,
                  background: "var(--warn-bg)",
                  color: "var(--warn)",
                  border: "1px solid currentColor",
                }}
              >
                {f.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
