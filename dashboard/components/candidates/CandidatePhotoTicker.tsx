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
 */
export function CandidatePhotoTicker({
  photos,
  href,
  priceLabel,
  children,
}: {
  photos: string[];
  href: string;
  priceLabel: string;
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

          <p
            data-testid="candidate-price"
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              margin: 0,
              padding: "10px 10px 6px",
              width: "100%",
              fontSize: 17,
              fontWeight: 700,
              color: "#fff",
              background: "linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))",
            }}
          >
            {priceLabel}
          </p>
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
        </div>
      )}
    </>
  );
}
