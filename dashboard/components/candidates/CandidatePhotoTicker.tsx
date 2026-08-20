"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { wrapIndex } from "@/lib/photo-cycle";

/**
 * Photo-first lead image (#152) + in-place photo ticker (#44's card follow-up,
 * #167): prev/next controls that cycle a property's photos *without leaving
 * the list*.
 *
 * Client component wrapping the card's `<Link>` (not the whole card) because
 * cycling the displayed photo needs `useState`, and that state has to be
 * visible to two things that must nonetheless render in different places in
 * the DOM:
 *
 *   - the `<img>` itself, informational content that belongs *inside* the
 *     `<Link>` (clicking the photo navigates to the detail page, same as
 *     every other bit of card content) — passed the same way #152's info
 *     block is, i.e. `children` rendered inside this component's `<Link>`.
 *   - the ticker's prev/next buttons, which must be a *sibling* of the
 *     `<Link>`, never a descendant. `FeedbackControls.tsx` already
 *     establishes why for a different pair of controls: interactive content
 *     nested inside an `<a>` is invalid HTML and “stopPropagation” alone is a
 *     common source of subtle bugs (keyboard activation, middle-click). The
 *     same reasoning applies here, so both controls do it the same way.
 *
 * Positioning trick: `.candidate-photo-ticker` (globals.css) is absolutely
 * positioned at `top: 0; left: 0; width: 100%; aspect-ratio: 4/3` relative to
 * `.candidate-card` — the same box the photo occupies, computed the same way
 * (full width, 4:3), since both are the first thing rendered in their
 * respective (sibling) subtrees with no offset above them. That reproduces
 * the photo's exact footprint without any JS measurement/ResizeObserver.
 *
 * Keyboard: ArrowLeft/ArrowRight cycle the photo, but the listener is
 * attached locally (`onKeyDown` on the ticker's own wrapper), not on
 * `document` the way the detail-page lightbox
 * (`components/property/PhotoGallery.tsx`) binds its arrow keys. The
 * lightbox is a modal that owns all keyboard input while open, so a global
 * capture is safe there. This ticker lives inside a *list* of many cards —
 * a document-level ArrowLeft/Right handler would fight with native cursor
 * movement in any text input on the page (e.g. a future filter box, or the
 * feedback note textarea) and would need extra bookkeeping to know which
 * card the arrows are "for". Scoping the handler to the ticker's own
 * subtree means it only ever fires while a ticker button already has
 * focus, so it can't intercept anything else.
 *
 * #594 (owner scope cut, mobile report): a numeric `N / M` position counter,
 * overlaid ON the photo rather than sitting in flow beneath it — the owner's
 * explicit reason was "para maximizar espacio": an in-flow counter eats card
 * height, and card height is what determines how many candidates fit on a
 * phone screen at once. Reuses the lightbox's translucent-pill *treatment*
 * (small rounded pill, always legible over a photo) rather than its exact
 * colours — the lightbox pill sits on a permanent near-black backdrop
 * (`rgba(255,255,255,0.15)` reads fine there), but this counter sits directly
 * on an arbitrary scraped photo with no such backdrop, so it borrows the
 * ticker buttons' own already-proven-over-arbitrary-photos treatment instead
 * (`rgba(0,0,0,0.55)` + a blur, same as `.candidate-photo-ticker button`).
 * Lives in the SAME sibling ticker wrapper as the prev/next buttons — never
 * inside the card's `<Link>` — for the identical reason those buttons do
 * (see above): it's not interactive, but keeping every ticker control in one
 * non-`<a>`-nested subtree avoids re-litigating the question per control.
 * Unlike the buttons it is not hover/touch-gated — it's informational, not
 * an affordance, the same always-visible treatment the price line gets.
 *
 * Corner is `top: 6, left: 6` — NOT top-right (review B1, PR #598). The
 * counter first shipped top-right and was 100% occluded on a phone: the
 * feedback overlay (`FeedbackControls.tsx`, `.candidate-card-actions` in
 * globals.css) sits at the SAME `top: 6px; right: 6px; z-index: 2` on the
 * same card, renders LATER in DOM order (a sibling below this one in
 * `CandidateCard.tsx`), and under `@media (hover: none)` its background pill
 * is forced permanently visible — so on touch this counter was never
 * reachable, not merely hover-clashing. Bottom is the full-width price
 * gradient (above); top-left is the only free corner (the prev button sits
 * vertically centered in the ticker's flex row, not in a top corner, so it
 * doesn't reach up here either). If a future control wants this corner,
 * check for a collision the same way — don't assume a corner is free.
 *
 * Explicitly OUT of scope for this pass (owner scope cut after the initial
 * #594 plan): swipe-to-step and dot indicators on this ticker. Prev/next
 * buttons remain the only way to cycle a card's photos; do not reintroduce
 * touch-swipe here without re-solving the vertical-scroll-safety problem the
 * original plan flagged (a photo occupies most of a card's height, so a
 * naive touch handler would make the feed unscrollable over every photo).
 */
export function CandidatePhotoTicker({
  photos,
  href,
  priceLabel,
  priceSignals,
  children,
}: {
  photos: string[];
  href: string;
  priceLabel: string;
  /**
   * #448 F / #460: the price line over the photo — a `<PriceSignals price=… />`
   * that renders the price together with the below-market/direction chips and
   * keeps the price + below-market chip on one line. Omitted → just the
   * `priceLabel` price.
   */
  priceSignals?: ReactNode;
  children: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const hasTicker = photos.length > 1;
  // Issue #167: "A property with one photo should not show ticker controls
  // at all; zero photos keeps the existing placeholder" — `photos[0]` (or
  // the placeholder) is exactly what a 0- or 1-photo property already
  // rendered before this feature existed.
  const current = photos.length > 0 ? photos[index] : null;

  const go = (delta: number) => (e: React.MouseEvent | React.KeyboardEvent) => {
    // Belt-and-suspenders on top of the sibling-not-child DOM layout: this
    // component's own <Link> only wraps the photo/info content, never these
    // buttons, so nothing here can actually bubble into a navigation — but
    // guarding against it directly (rather than relying purely on layout)
    // is what the card-detail-ux review asked future overlay controls to do.
    e.preventDefault();
    e.stopPropagation();
    setIndex((i) => wrapIndex(i, delta, photos.length));
  };

  const onTickerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") go(1)(e);
    else if (e.key === "ArrowLeft") go(-1)(e);
  };

  return (
    <>
      <Link
        href={href}
        style={{
          display: "flex",
          flexDirection: "column",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <div
          data-testid="candidate-photo"
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "4 / 3",
            background: "var(--bg-2)",
          }}
        >
          {current !== null ? (
            /* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain photo URLs from scraped listings; next/image's domain allowlist isn't a good fit here. */
            <img
              src={current}
              data-testid="candidate-photo-img"
              // Decorative: the address, price and facts beside it already
              // carry every fact a screen-reader user needs, and scraped
              // listings give us no meaningful alt text to use.
              alt=""
              loading="lazy"
              // Absolutely fill the aspect-ratio box (position:absolute; inset:0)
              // rather than sit in-flow with height:100%. An in-flow child's
              // `height: 100%` resolves against the *content* height of a box
              // whose own height comes only from `aspect-ratio` (an indefinite
              // height for percentage resolution), so it collapses to `auto` —
              // the image then renders at its intrinsic size and STRETCHES the
              // box to its own aspect ratio (a portrait photo made the card
              // tall, a landscape one short), defeating object-fit:cover
              // entirely. Taking the image out of flow makes the box height a
              // pure function of its width (4:3), identical for every card
              // regardless of the photo's orientation.
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <div
              data-testid="candidate-photo-placeholder"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: "var(--fg-subtle)",
              }}
            >
              Sin foto
            </div>
          )}

          <div
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              width: "100%",
              padding: "12px 10px 6px",
              background: "linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))",
            }}
          >
            {/* #460: `priceSignals` (a <PriceSignals price=… />) now owns the
                whole price line — it keeps the price and the below-market chip
                as one non-wrapping unit so the chip stays NEXT to the price,
                never below it, at every card width. Fallback (no signals node
                passed): just the price. */}
            {priceSignals ?? (
              <p
                data-testid="candidate-price"
                style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#fff", whiteSpace: "nowrap" }}
              >
                {priceLabel}
              </p>
            )}
          </div>
        </div>

        {children}
      </Link>

      {hasTicker && (
        <div
          className="candidate-photo-ticker"
          data-testid="candidate-photo-ticker"
          onKeyDown={onTickerKeyDown}
        >
          <button
            type="button"
            data-testid="candidate-photo-prev"
            aria-label="Foto anterior"
            title="Foto anterior"
            onClick={go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            data-testid="candidate-photo-next"
            aria-label="Foto siguiente"
            title="Foto siguiente"
            onClick={go(1)}
          >
            ›
          </button>

          <p
            data-testid="candidate-photo-counter"
            aria-live="polite"
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              margin: 0,
              padding: "2px 8px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(2px)",
              color: "#fff",
              fontSize: 12,
              lineHeight: 1.6,
              pointerEvents: "none",
            }}
          >
            {index + 1} / {photos.length}
          </p>
        </div>
      )}
    </>
  );
}
