import type { ReactNode } from "react";

/**
 * Price adornments shown next to a property's price on BOTH the feed card
 * (compact, over the photo overlay) and the detail page header (#448 F).
 *
 * Two independent signals, each rendered only when its data is present:
 *
 *   1. Below-market RATING (`below_market_pct`, the #309/D-057 signed discount
 *      vs the profile pool's median price/m²): GREEN when the property is below
 *      market (a good price for a buyer), RED when above. Carries an explicit
 *      "rating" affordance (a 🏷 tag glyph + "bajo/sobre mercado" text + a
 *      descriptive `title`) so it reads as a price rating, not just a number.
 *   2. Price DIRECTION (the phase-2 BAJADA/SUBIDA move since the last visit):
 *      BAJADA (a drop) reuses the positive `--up` token, SUBIDA (a rise) the
 *      `--down` token — the exact same colour semantics the card's existing
 *      in-body price-change badge (#420) uses, kept consistent here.
 *
 * Colour semantics are deliberately the app-wide positive/negative tokens
 * (`--up`/`--up-bg`, `--down`/`--down-bg`) so "good for the buyer" is always
 * green and "bad for the buyer" always red, in both light and dark themes and
 * whether the badge sits on a light page (detail header) or the card's dark
 * photo-overlay gradient (the coloured text + border carry the signal even
 * where the low-opacity token background is barely visible).
 *
 * Returns null when neither signal is present, so callers render nothing
 * rather than an empty container — the same "no badge on every card" rule the
 * rest of the card follows.
 */

const badgeBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
  lineHeight: "16px",
  fontWeight: 700,
  letterSpacing: 0.2,
  padding: "1px 6px",
  borderRadius: 4,
  whiteSpace: "nowrap",
  // currentColor === the semantic --up/--down text colour, so the outline is
  // green/red too — keeps the chip legible on the card's dark photo overlay
  // where the 12%-opacity token background alone would nearly vanish.
  border: "1px solid currentColor",
};

/** GREEN when the property is priced below market (good), RED when above. */
export function BelowMarketRatingBadge({ belowMarketPct }: { belowMarketPct: number }) {
  const below = belowMarketPct >= 0;
  const absPct = Math.abs(Math.round(belowMarketPct * 100));
  return (
    <span
      data-testid="price-rating"
      data-rating={below ? "below" : "above"}
      title={`Rating de precio: ~${absPct}% ${
        below ? "por debajo" : "por encima"
      } de la mediana de precio/m² de tus candidatos.`}
      style={{
        ...badgeBase,
        background: below ? "var(--up-bg)" : "var(--down-bg)",
        color: below ? "var(--up)" : "var(--down)",
      }}
    >
      <span aria-hidden="true">🏷</span>
      {absPct}% {below ? "bajo mercado" : "sobre mercado"}
    </span>
  );
}

/** BAJADA (drop) green, SUBIDA (rise) red — mirrors the card's #420 badge. */
export function PriceDirectionBadge({
  direction,
  deltaPct,
}: {
  direction: "drop" | "up";
  deltaPct: number;
}) {
  const drop = direction === "drop";
  const absPct = Math.abs(deltaPct) * 100;
  return (
    <span
      data-testid="price-direction"
      data-direction={direction}
      title={
        drop
          ? "El precio ha bajado desde tu última visita a este perfil."
          : "El precio ha subido desde tu última visita a este perfil."
      }
      style={{
        ...badgeBase,
        background: drop ? "var(--up-bg)" : "var(--down-bg)",
        color: drop ? "var(--up)" : "var(--down)",
      }}
    >
      {drop ? "▼ BAJADA −" : "▲ SUBIDA +"}
      {absPct.toLocaleString("es-ES", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}
      {" %"}
    </span>
  );
}

export function PriceSignals({
  belowMarketPct,
  priceChanged,
  priceDirection,
  priceDeltaPct,
  style,
}: {
  belowMarketPct: number | null | undefined;
  priceChanged: boolean | null | undefined;
  priceDirection: "drop" | "up" | null | undefined;
  priceDeltaPct: number | null | undefined;
  style?: React.CSSProperties;
}): ReactNode {
  const showRating =
    belowMarketPct !== null &&
    belowMarketPct !== undefined &&
    Number.isFinite(belowMarketPct);
  const showDirection =
    priceChanged === true &&
    (priceDirection === "drop" || priceDirection === "up") &&
    priceDeltaPct !== null &&
    priceDeltaPct !== undefined &&
    Number.isFinite(priceDeltaPct);

  if (!showRating && !showDirection) return null;

  return (
    <span
      data-testid="price-signals"
      style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center", ...style }}
    >
      {showRating && <BelowMarketRatingBadge belowMarketPct={belowMarketPct} />}
      {showDirection && (
        <PriceDirectionBadge direction={priceDirection} deltaPct={priceDeltaPct} />
      )}
    </span>
  );
}
