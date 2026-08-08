import type { ReactNode } from "react";

/**
 * Price adornments shown next to a property's price on BOTH the feed card
 * (over the photo overlay) and the detail page header — on the SAME line as the
 * price (#460), never below it.
 *
 * Two independent signals, each rendered only when its data is present:
 *
 *   1. Below-market RATING (`below_market_pct`, the #309/D-057 signed discount
 *      vs the comparison median price/m²): GREEN when the property is below
 *      market (a good price for a buyer), RED when above. #460 makes it SHORT
 *      and readable — a 🏷 tag glyph + the SIGNED % ONLY (no "bajo/sobre
 *      mercado" words); the colour + sign carry the meaning, the `title` spells
 *      it out on hover.
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
 * Compact by design (#460 owner feedback: the old "🏷 20% bajo mercado" chip was
 * too big / hard to read next to the price and the #452 score chip) — 10px, tight
 * padding, so the price line stays uncluttered.
 *
 * Returns null when neither signal is present, so callers render nothing
 * rather than an empty container — the same "no badge on every card" rule the
 * rest of the card follows.
 */

/**
 * #461-forward: the comparison base behind a below-market rating. Optional here
 * (the backend field lands with #461); when present the tooltip names it, when
 * absent it falls back to the generic wording — so this component is ready for
 * the like-for-like segmentation without a second edit.
 */
export type BelowMarketBase = "segment" | "pool" | null | undefined;

const badgeBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  // #460: smaller than the old 11px chip — the price + score chip already carry
  // most of the visual weight on this line.
  fontSize: 10,
  lineHeight: "14px",
  fontWeight: 700,
  letterSpacing: 0.2,
  padding: "1px 5px",
  borderRadius: 4,
  whiteSpace: "nowrap",
  // currentColor === the semantic --up/--down text colour, so the outline is
  // green/red too — keeps the chip legible on the card's dark photo overlay
  // where the 12%-opacity token background alone would nearly vanish.
  border: "1px solid currentColor",
};

/**
 * GREEN when the property is priced below market (good), RED when above.
 *
 * #460: short form — a 🏷 glyph + the SIGNED percent only (e.g. "🏷 −12%" green
 * = 12% below, "🏷 +9%" red = 9% above). No "bajo/sobre mercado" words; colour +
 * sign carry it.
 */
export function BelowMarketRatingBadge({
  belowMarketPct,
  base,
  comparables,
}: {
  belowMarketPct: number;
  /** #461-forward: names the comparison base in the tooltip when known. */
  base?: BelowMarketBase;
  /** #461-forward: comparable count named in the tooltip for a segment base. */
  comparables?: number | null;
}) {
  const below = belowMarketPct >= 0;
  const absPct = Math.abs(Math.round(belowMarketPct * 100));
  // Tooltip names the comparison base when the (optional) #461 signal is present,
  // else the generic whole-pool wording this feature shipped with.
  const baseNote =
    base === "segment"
      ? `comparado con ${comparables ?? 0} inmuebles similares (habitaciones, m² y planta)`
      : "comparado con la mediana de precio/m² de tus candidatos";
  return (
    <span
      data-testid="price-rating"
      data-rating={below ? "below" : "above"}
      data-base={base ?? ""}
      title={`Rating de precio: ~${absPct}% ${
        below ? "por debajo" : "por encima"
      } de mercado — ${baseNote}.`}
      style={{
        ...badgeBase,
        background: below ? "var(--up-bg)" : "var(--down-bg)",
        color: below ? "var(--up)" : "var(--down)",
      }}
    >
      <span aria-hidden="true">🏷</span>
      {below ? "−" : "+"}
      {absPct}%
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
  price,
  align = "center",
  belowMarketPct,
  belowMarketBase,
  belowMarketComparables,
  priceChanged,
  priceDirection,
  priceDeltaPct,
  style,
}: {
  /**
   * #460 wrap fix: when the price element is passed in, PriceSignals owns the
   * whole `[price][below-market chip]  [direction chip]` layout and guarantees
   * the price and the below-market rating stay on ONE line — they live in an
   * inner `flex-wrap: nowrap` group so they can never separate onto different
   * lines at narrow card widths. Only the less-critical BAJADA/SUBIDA direction
   * chip is allowed to wrap below when space is truly tight.
   *
   * When omitted (legacy signals-only usage, e.g. unit tests), the component
   * behaves exactly as before: it renders just the badges and returns `null`
   * when there is no signal at all.
   */
  price?: ReactNode;
  /** Cross-axis alignment of the price+rating group (h1 detail header wants "baseline"). */
  align?: "center" | "baseline";
  belowMarketPct: number | null | undefined;
  /** #461-forward: comparison base behind the rating, for the tooltip. */
  belowMarketBase?: BelowMarketBase;
  /** #461-forward: comparable count behind the rating, for the tooltip. */
  belowMarketComparables?: number | null;
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

  const rating = showRating ? (
    <BelowMarketRatingBadge
      belowMarketPct={belowMarketPct}
      base={belowMarketBase}
      comparables={belowMarketComparables}
    />
  ) : null;
  const direction = showDirection ? (
    <PriceDirectionBadge direction={priceDirection} deltaPct={priceDeltaPct} />
  ) : null;

  // Legacy signals-only mode: caller renders the price itself, we render only
  // the badges (and nothing when there is no signal — the "no badge" rule).
  if (price === undefined) {
    if (!rating && !direction) return null;
    return (
      <span
        data-testid="price-signals"
        style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, alignItems: "center", ...style }}
      >
        {rating}
        {direction}
      </span>
    );
  }

  // Price mode (#460): the price + below-market chip are ONE non-wrapping unit,
  // sitting immediately next to each other on the same line at every width.
  // Only the direction chip may wrap to the next line when space runs out.
  return (
    <div
      data-testid="price-signals"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: align,
        columnGap: 8,
        rowGap: 4,
        minWidth: 0,
        ...style,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          flexWrap: "nowrap",
          alignItems: align === "baseline" ? "baseline" : "center",
          columnGap: 8,
        }}
      >
        {price}
        {rating}
      </span>
      {direction}
    </div>
  );
}
