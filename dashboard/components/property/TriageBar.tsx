"use client";

import Link from "next/link";
import type { PropertyDetail } from "@/lib/property-detail";
import type { StateFeedbackType } from "@/lib/db/feedback";
import { FeedbackControls } from "@/components/candidates/FeedbackControls";
import { InvestorScoreChip } from "@/components/candidates/InvestorScoreChip";
import { fmtEUR0 } from "@/components/widgets/format";

/**
 * The property-detail triage bar (#585). The owner's own framing: *"lo que
 * busco es una forma fácil de categorizar todo"* — he is triaging a long
 * queue on a phone, with his thumb. Four separate asks (prev/next more
 * prominent, prev/next always visible, vote controls in that header, advance
 * on vote) are fragments of ONE feature — a triage loop: see price+score →
 * vote → land on the next candidate, with zero scrolling and zero hunting.
 *
 * ONE sticky control surface — the mid-page "Tu valoración" box this used to
 * be split across (`page.tsx`) is gone; everything a triage decision needs
 * (prev/next, vote, price, score) lives here, `position: sticky; top: 56px`
 * (directly under the 56px TopBar, `TopBar.tsx:112`), `z-index` below
 * TopBar's `z-20` and its fixed mobile-menu panels (`TopBar.tsx:338-354`) so
 * this never fights either. Ships on desktop too — not a mobile-only
 * component behind a display toggle (D-121's "never duplicate markup behind
 * a Tailwind hidden/md:flex toggle" applies here too, even though there is
 * no breakpoint divergence to hide: the same markup renders at every width).
 *
 * `property` may be null while the page's own fetch is still in flight —
 * this renders regardless (prev/next + vote controls need only `profileId`/
 * `propertyId`, already known from the route), with the price/score chip
 * simply absent until `property` arrives — the same best-effort "absent, not
 * a placeholder" rule the rest of the detail page already follows.
 *
 * Price uses the identical "min across active listings, else min across all"
 * convention as `PropertyHeader.tsx` — duplicated rather than shared,
 * deliberately: `PropertyHeader.tsx` is owned by the in-flight #584/PR#589
 * (phone-width containment), out of this issue's scope per its own
 * touchpoint list, so this component computes its own compact figure rather
 * than risk a conflicting edit to a file #584 is mid-review on.
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
   * null (the last candidate in the queue) — the page sets this instead of
   * navigating. Replaces the prev/next controls with "Fin de la lista" + a
   * working "Volver al perfil" link, so a vote here never dead-ends silently.
   */
  endOfQueue: boolean;
  /**
   * #585: fired by `FeedbackControls` once per server-confirmed accept/
   * reject (never clear/note) — the page decides whether to navigate or set
   * `endOfQueue`, since only it knows `nextPropertyId` at vote time.
   */
  onVoted: (state: StateFeedbackType) => void;
}) {
  const activePrices = (property?.listings ?? [])
    .filter((l) => l.status === "active" && l.current_price !== null)
    .map((l) => l.current_price as number);
  const allPrices = (property?.listings ?? [])
    .filter((l) => l.current_price !== null)
    .map((l) => l.current_price as number);
  const pricesUsed = activePrices.length > 0 ? activePrices : allPrices;
  const minPrice = pricesUsed.length > 0 ? Math.min(...pricesUsed) : null;

  return (
    <div data-testid="triage-bar" className="triage-bar">
      <nav aria-label="Navegación entre candidatos" className="triage-bar-nav">
        {endOfQueue ? (
          <div data-testid="triage-end-of-queue" className="triage-bar-end">
            <span className="triage-bar-end-label">Fin de la lista</span>
            <Link
              href={`/profiles/${profileId}`}
              data-testid="triage-back-to-profile"
              className="triage-bar-back-link"
            >
              Volver al perfil
            </Link>
          </div>
        ) : (
          <>
            <TriageAdjacentLink
              profileId={profileId}
              propertyId={prevPropertyId}
              testId="candidate-prev"
              glyph="←"
              label="Anterior"
              includeRejected={includeRejected}
            />
            <TriageAdjacentLink
              profileId={profileId}
              propertyId={nextPropertyId}
              testId="candidate-next"
              glyph="→"
              label="Siguiente"
              includeRejected={includeRejected}
            />
          </>
        )}
      </nav>

      <div data-testid="detail-feedback-controls" className="detail-feedback-controls triage-bar-vote">
        <FeedbackControls profileId={profileId} propertyId={propertyId} size="detail" onVoted={onVoted} />
      </div>

      <div className="triage-bar-summary">
        <span data-testid="triage-bar-price" className="triage-bar-price">
          {minPrice !== null ? fmtEUR0(minPrice) : null}
        </span>
        {property?.investor_score && (
          <InvestorScoreChip
            effectiveScore={property.investor_score.effective_score}
            baseScore={property.investor_score.base_score}
            reason={null}
          />
        )}
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
