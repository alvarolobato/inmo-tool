"use client";

import Link from "next/link";
import type { PropertyDetail } from "@/lib/property-detail";
import type { StateFeedbackType } from "@/lib/db/feedback";
import { FeedbackControls } from "@/components/candidates/FeedbackControls";
import { toDisplayScore } from "@/lib/display-score";
import { summarizePropertyPrice } from "@/lib/property-price";
import { fmtEUR0 } from "@/components/widgets/format";

/**
 * The property-detail triage bar (#585). The owner's own framing: *"lo que
 * busco es una forma fácil de categorizar todo"* — he is triaging a long
 * queue on a phone, with his thumb. Four separate asks (prev/next more
 * prominent, prev/next always visible, vote controls in that header, advance
 * on vote) are fragments of ONE feature — a triage loop: see price+score →
 * vote → land on the next candidate, with zero scrolling and zero hunting.
 *
 * ONE sticky control surface, ONE row (review of the first version:
 * price/score in a second row cost 99px of a 664px phone viewport
 * permanently, and duplicated the `<h1>` ~100px below). Nav (←/→) sits at
 * one end, the vote toggles (✓/✗ — ✎ demoted, see FeedbackControls.tsx) at
 * the other, the compact price+score summary between them with a real
 * divider on each side — the control that writes training signal must not
 * read as interchangeable with the one that just pages.
 *
 * `position: sticky` under the 56px TopBar — see globals.css's
 * `.triage-bar` rule for why `top` is `calc(-1 * var(--pad, 20px))`, not
 * `56px` or `0` (both look right and are both wrong — measured). `z-index`
 * stays below TopBar's `z-20` and its fixed mobile-menu panels
 * (`TopBar.tsx:338-354`); the property-detail gallery's Leaflet map is
 * separately contained (`globals.css`'s `.leaflet-container { isolation:
 * isolate }`, #585 review B1) so it can never paint over this bar either,
 * without this bar needing a z-index that beats Leaflet's own 400+ panes.
 *
 * Ships on desktop too — not a mobile-only component behind a display
 * toggle (D-121's "never duplicate markup behind a Tailwind hidden/md:flex
 * toggle" applies here too, even though there is no breakpoint divergence
 * to hide: the same markup renders at every width).
 *
 * `property` may be null while the page's own fetch is still in flight —
 * this renders regardless (prev/next + vote controls need only `profileId`/
 * `propertyId`, already known from the route), with the price/score summary
 * simply absent until `property` arrives — the same best-effort "absent, not
 * a placeholder" rule the rest of the detail page already follows.
 *
 * Price + `isHistorical` come from `lib/property-price.ts` (#585 review
 * N8) — shared with `PropertyHeader.tsx` rather than duplicated, so a
 * withdrawn property's last-known price can't render here as if it were a
 * live current asking price (the first version dropped the historical flag
 * entirely). The score uses `toDisplayScore` directly from
 * `lib/display-score.ts` — the same derive-once function `InvestorScoreChip`
 * and the detail body's "Puntuación inversora" section both call (D-100) —
 * rather than rendering the full chip component, so it can sit inline with
 * the price as one compact string instead of a second visual unit.
 */
export function TriageBar({
  profileId,
  propertyId,
  property,
  prevPropertyId,
  nextPropertyId,
  includeRejected,
  endOfQueue,
  onVoted,
}: {
  profileId: number;
  propertyId: number;
  property: PropertyDetail | null;
  prevPropertyId: number | null;
  nextPropertyId: number | null;
  /**
   * #417: carried into both neighbour links so the show-rejected order
   * survives the whole prev/next chain — same contract `AdjacentLink` in
   * `page.tsx` used to own before it moved here.
   */
  includeRejected: boolean;
  /**
   * #585 EC-5: true once a vote was confirmed while `nextPropertyId` was
   * KNOWN to be null (the last candidate in the queue) — the page sets this
   * instead of navigating. Replaces only the "next" slot in the nav (#585
   * review N4 — "← Anterior" stays live, the last card is exactly where you
   * want to step back from) with "Fin de la lista" + a working "Volver" link.
   */
  endOfQueue: boolean;
  /**
   * #585: fired by `FeedbackControls` once per server-confirmed accept/
   * reject (never clear/note) — the page decides whether to navigate or set
   * `endOfQueue`, since only it knows `nextPropertyId` at vote time.
   */
  onVoted: (state: StateFeedbackType) => void;
}) {
  const { minPrice, isHistorical } = summarizePropertyPrice(property?.listings ?? []);
  const scoreDisplay = property?.investor_score
    ? property.investor_score.base_score === null
      ? // Belt-and-braces, same guard InvestorScoreChip applies: a never-
        // scored property is always "Sin puntuar" even if a boost nudged
        // its sentinel effective_score.
        toDisplayScore(null)
      : toDisplayScore(property.investor_score.effective_score)
    : null;

  return (
    <div data-testid="triage-bar" className="triage-bar">
      <nav aria-label="Navegación entre candidatos" className="triage-bar-nav">
        <TriageAdjacentLink
          profileId={profileId}
          propertyId={prevPropertyId}
          testId="candidate-prev"
          glyph="←"
          label="Anterior"
          includeRejected={includeRejected}
        />
        {endOfQueue ? (
          <span data-testid="triage-end-of-queue" className="triage-bar-end">
            <span className="triage-bar-end-label">Fin de la lista</span>
            <Link
              href={`/profiles/${profileId}`}
              data-testid="triage-back-to-profile"
              className="triage-bar-back-link"
            >
              Volver
            </Link>
          </span>
        ) : (
          <TriageAdjacentLink
            profileId={profileId}
            propertyId={nextPropertyId}
            testId="candidate-next"
            glyph="→"
            label="Siguiente"
            includeRejected={includeRejected}
          />
        )}
      </nav>

      {minPrice !== null && (
        <>
          <div className="triage-bar-divider" aria-hidden="true" />
          <div className="triage-bar-summary">
            <span data-testid="triage-bar-price" className="triage-bar-price">
              {fmtEUR0(minPrice)}
            </span>
            {isHistorical && (
              <span
                className="triage-bar-historical"
                title="Último precio conocido — ningún anuncio vinculado está activo actualmente."
              >
                (hist.)
              </span>
            )}
            {scoreDisplay && !scoreDisplay.unscored && (
              <span
                data-testid="triage-bar-score"
                data-score={scoreDisplay.value ?? ""}
                data-grade={scoreDisplay.band.grade ?? "none"}
                className="triage-bar-score"
                style={{ color: scoreDisplay.band.color }}
              >
                · {scoreDisplay.value}
              </span>
            )}
          </div>
          <div className="triage-bar-divider" aria-hidden="true" />
        </>
      )}

      <div data-testid="detail-feedback-controls" className="detail-feedback-controls triage-bar-vote">
        <FeedbackControls profileId={profileId} propertyId={propertyId} size="detail" onVoted={onVoted} />
      </div>
    </div>
  );
}

/**
 * Prev/next through the profile's ranking (#152, reworked for #585): now
 * ≥44px tap targets living in the sticky bar instead of a 12px in-flow text
 * link. Rendered as a disabled <span> at either end rather than hidden, so
 * the bar's contents don't jump position as you move through the queue —
 * same rendered-disabled convention the old `page.tsx` AdjacentLink used.
 */
function TriageAdjacentLink({
  profileId,
  propertyId,
  testId,
  glyph,
  label,
  includeRejected,
}: {
  profileId: number;
  propertyId: number | null;
  testId: string;
  glyph: string;
  label: string;
  includeRejected: boolean;
}) {
  if (propertyId === null) {
    return (
      <span data-testid={testId} aria-disabled="true" aria-label={label} className="triage-bar-nav-link">
        {glyph}
      </span>
    );
  }
  return (
    <Link
      data-testid={testId}
      href={`/profiles/${profileId}/properties/${propertyId}${
        includeRejected ? "?includeRejected=true" : ""
      }`}
      aria-label={label}
      title={label}
      className="triage-bar-nav-link"
    >
      {glyph}
    </Link>
  );
}
