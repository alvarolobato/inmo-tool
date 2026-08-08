"use client";

import { useState } from "react";
import type { CandidateRow } from "@/lib/candidates";
import type { StateFeedbackType } from "@/lib/db/feedback";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { FeedbackControls } from "./FeedbackControls";
import { CandidatePhotoTicker } from "./CandidatePhotoTicker";
import { PriceSignals } from "@/components/property/PriceSignals";
import { StalenessBadge } from "@/components/StalenessBadge";
import { InvestorScoreChip } from "./InvestorScoreChip";

/**
 * One card per deduplicated property (issue #19) — never one per listing.
 * Multiple linked `listing` rows (post task-2.2 dedup) render as multiple
 * source badges on a single card, e.g. "Fotocasa + Milanuncios".
 *
 * Photo-first layout (#152): the image is the strongest triage signal, so it
 * leads, with price overlaid on it and the numeric facts a user actually
 * scans (zone, planta, hab., baños, m²) on one compact line beneath. #167
 * adds prev/next photo controls over that lead image (`CandidatePhotoTicker`)
 * so a user can flick through a property's photos without leaving the list.
 *
 * The informational content links to the property detail page (task 2.8,
 * #44), rendered inside `CandidatePhotoTicker`'s `<Link>`. Two overlay
 * control groups are *siblings* of that `<Link>`, never nested inside it —
 * see `FeedbackControls.tsx`'s and `CandidatePhotoTicker.tsx`'s docstrings
 * for why (invalid HTML nesting interactive content inside `<a>`, plus the
 * usual stopPropagation footguns). #152 moved the feedback bar to an
 * absolutely-positioned overlay so it costs no vertical space; #167 does the
 * same for the photo ticker. Both relationships are load-bearing and must
 * survive any future layout change — there are e2e assertions that acting on
 * either does not navigate.
 */
/**
 * `floor` is free text as the sites publish it: "3", "1ª", "Bajo",
 * "Entreplanta", "Ático". Only a bare number reads correctly with the
 * "Planta" prefix — "Planta Bajo" does not, so anything non-numeric is shown
 * as-is.
 */
function floorLabel(floor: string): string {
  const trimmed = floor.trim();
  return /^\d+$/.test(trimmed) ? `Planta ${trimmed}` : trimmed;
}

export function CandidateCard({
  candidate,
  profileId,
  includeRejected = false,
}: {
  candidate: CandidateRow;
  profileId: number;
  // #417: when the "Mostrar descartadas" toggle is on, carry the flag into the
  // detail link so the detail page's prev/next steps through rejected
  // candidates in the same order as this (show-rejected) list.
  includeRejected?: boolean;
}) {
  // #379: the verdict comes embedded on the row now. Held in local state so a
  // reject/un-reject click updates the card's "Descartada" treatment in place
  // — the card is NEVER removed on click; it stays marked until the next fetch
  // (deferred removal). FeedbackControls reports every change up through
  // onStateChange.
  const [feedbackState, setFeedbackState] = useState<StateFeedbackType | null>(
    candidate.feedback_state ?? null,
  );
  const isRejected = feedbackState === "reject";
  // #422: an accepted property is "en seguimiento" (tracked) — accept IS the
  // follow action now. Drives the EN SEGUIMIENTO mark and the `data-tracked`
  // hook below.
  const isTracked = feedbackState === "accept";

  const sources = [...new Set(candidate.listings.map((l) => l.source))].sort();
  const typeLabel =
    candidate.property_type !== null &&
    candidate.property_type in PROPERTY_TYPE_LABELS
      ? PROPERTY_TYPE_LABELS[candidate.property_type as (typeof PROPERTY_TYPES)[number]]
      : candidate.property_type;

  // Compact fact line: only what's known, so a sparse property doesn't render
  // a row of "no disponible" placeholders competing with the real values.
  const facts: string[] = [];
  if (typeLabel) facts.push(typeLabel);
  if (candidate.m2_built !== null) facts.push(`${fmtInt(candidate.m2_built)} m²`);
  if (candidate.rooms !== null) facts.push(`${candidate.rooms} hab.`);
  if (candidate.bathrooms !== null)
    facts.push(`${candidate.bathrooms} ${candidate.bathrooms === 1 ? "baño" : "baños"}`);
  if (candidate.floor !== null && candidate.floor.trim() !== "") facts.push(floorLabel(candidate.floor));

  // The cold-start explanation is identical on every candidate in the
  // profile, so repeating it per card was pure noise (#152) — CandidateList
  // renders it once as a page-level footer instead. A *real*, model-grounded
  // explanation differs per property and stays on the card.
  //
  // Detected via `score_kind`, the durable marker `profile_listing_state`
  // carries (task 3.4, #23) — not by comparing `rank_explanation` against
  // the cold-start constant (#152 review): that string is persisted at
  // scoring time, so a copy edit to the constant would silently stop
  // recognising every already-written cold-start row.
  const explanation =
    candidate.rank_explanation !== null && candidate.score_kind !== "cold_start"
      ? candidate.rank_explanation
      : null;

  const priceLabel = candidate.min_price !== null ? fmtEUR0(candidate.min_price) : "Precio no disponible";

  return (
    <div
      data-testid="candidate-card"
      data-property-id={candidate.property_id}
      data-rejected={isRejected}
      // #422: stable hook for the "en seguimiento" (tracked) working set —
      // mirrors data-rejected. Phase 3 reads this to EXEMPT a tracked property
      // from novelty-tier suppression (a property you're following must never
      // be hidden by a tier), and e2e uses it to assert the seguimiento view /
      // card mark. Presentation + hook only; feed order is unchanged here.
      data-tracked={isTracked}
      // #416/#420 novelty mark. Mirrors the data-rejected convention: a stable
      // hook for e2e and CSS. NUEVO leads (it is the stronger "look at this"
      // signal), so a card that is both new and price-changed reads "new" here;
      // the price-change badge below carries its own data-novelty hook for e2e.
      // Presentation only — the feed order is unchanged (fresh-first is phase 3).
      data-novelty={
        candidate.is_new
          ? "new"
          : candidate.price_direction === "drop"
            ? "price_drop"
            : candidate.price_direction === "up"
              ? "price_up"
              : undefined
      }
      className="candidate-card"
      style={{
        // A rejected card stays in the list (deferred removal / show-rejected
        // view) but reads unmistakably as discarded: a red-tinted border. A
        // tracked (en seguimiento) card gets a positive green-tinted border so
        // the working set reads at a glance (#422).
        border: isRejected
          ? "1px solid var(--down, #d33)"
          : isTracked
            ? "1px solid var(--up, #2e7d32)"
            : "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        // Anchors the absolutely-positioned action/ticker overlays below.
        position: "relative",
        overflow: "hidden",
      }}
    >
      {isRejected && (
        <span
          data-testid="candidate-rejected-badge"
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 2,
            fontSize: 10,
            lineHeight: "14px",
            fontWeight: 700,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--down, #d33)",
            color: "var(--bg, #fff)",
          }}
        >
          Descartada
        </span>
      )}
      {isTracked && (
        <span
          data-testid="candidate-tracked-badge"
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 2,
            fontSize: 10,
            lineHeight: "14px",
            fontWeight: 700,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--up, #2e7d32)",
            color: "var(--bg, #fff)",
          }}
        >
          En seguimiento
        </span>
      )}
      {/* Only the informational content dims when rejected — the feedback
          overlay (a sibling below) stays full-opacity and interactive so the
          card can be un-rejected. */}
      <div
        style={{
          opacity: isRejected ? 0.55 : 1,
          transition: "opacity 120ms ease",
          display: "flex",
          flexDirection: "column",
        }}
      >
      <CandidatePhotoTicker
        photos={candidate.photos}
        href={`/profiles/${profileId}/properties/${candidate.property_id}${
          includeRejected ? "?includeRejected=true" : ""
        }`}
        priceLabel={priceLabel}
        priceSignals={
          <PriceSignals
            // #460: the price lives INSIDE PriceSignals so the price and the
            // below-market chip form one non-wrapping unit and never split onto
            // separate lines at narrow card widths.
            price={
              <p
                data-testid="candidate-price"
                style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#fff", whiteSpace: "nowrap" }}
              >
                {priceLabel}
              </p>
            }
            belowMarketPct={candidate.below_market_pct}
            priceChanged={candidate.price_changed}
            priceDirection={candidate.price_direction}
            priceDeltaPct={candidate.price_delta_pct}
          />
        }
      >
        <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <p
            data-testid="candidate-zone"
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 500,
              color: "var(--fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={candidate.address ?? undefined}
          >
            {candidate.address ?? "Dirección no disponible"}
          </p>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <p data-testid="candidate-facts" style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)" }}>
              {facts.length > 0 ? facts.join(" · ") : "Sin datos estructurados"}
            </p>
            {/* #452 investor score — a monotone re-expression of effective_score,
                tooltip = the already-computed ranking_boost_reason. */}
            <InvestorScoreChip
              effectiveScore={candidate.effective_score}
              baseScore={candidate.score}
              reason={candidate.ranking_boost_reason}
            />
          </div>

          {(candidate.is_new ||
            candidate.price_changed ||
            candidate.flags.length > 0 ||
            sources.length > 0 ||
            candidate.last_seen_at !== null) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
              {/* #416 NUEVO mark — new since the profile's last visit. Leads the
                  badge row so it can't be missed while skimming. Follows the
                  house inline-badge pattern exactly (same 10px / lineHeight 14px
                  / padding 1px 5px / borderRadius 3 as StalenessBadge and
                  candidate-flag) — no shared <Badge> component (plan §3.6). Uses
                  the accent token so it reads as a positive attention mark, not
                  a warn/danger one. Static (no animation), so prefers-reduced-
                  motion needs no special handling. */}
              {candidate.is_new && (
                <span
                  data-testid="candidate-novelty"
                  data-novelty="new"
                  title="Nuevo desde tu última visita a este perfil."
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontWeight: 700,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                    background: "var(--accent-soft)",
                    color: "var(--accent)",
                  }}
                >
                  Nuevo
                </span>
              )}
              {/* #420 price-change mark — the property's price MOVED since the
                  profile's last visit and cleared the sanity band (1%–60% by
                  default). BAJADA (a drop) is good for a buyer, so it borrows the
                  positive --up token; SUBIDA (a rise) uses --down. Both are shown
                  in-feed (alerts are phase 5). Same inline-badge house pattern as
                  NUEVO/StalenessBadge (10px / lineHeight 14px / padding 1px 5px /
                  borderRadius 3), no shared <Badge> component (plan §3.6). Static,
                  so prefers-reduced-motion needs no handling. */}
              {candidate.price_changed && candidate.price_delta_pct !== null && (
                <span
                  data-testid="candidate-price-change"
                  data-novelty={candidate.price_direction === "drop" ? "price_drop" : "price_up"}
                  title={
                    candidate.price_direction === "drop"
                      ? "El precio ha bajado desde tu última visita a este perfil."
                      : "El precio ha subido desde tu última visita a este perfil."
                  }
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontWeight: 700,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                    background:
                      candidate.price_direction === "drop" ? "var(--up-bg)" : "var(--down-bg)",
                    color: candidate.price_direction === "drop" ? "var(--up)" : "var(--down)",
                  }}
                >
                  {candidate.price_direction === "drop" ? "BAJADA −" : "SUBIDA +"}
                  {(Math.abs(candidate.price_delta_pct) * 100).toLocaleString("es-ES", {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })}
                  {" %"}
                </span>
              )}
              {/* Listing staleness (#243): "visto hace N días", escalating by
                  band. Renders nothing when last_seen_at is unknown. */}
              <StalenessBadge lastSeenAt={candidate.last_seen_at} testId="candidate-staleness" />
              {candidate.flags.map((f) => (
                <span
                  key={f.kind}
                  data-testid="candidate-flag"
                  data-flag-kind={f.kind}
                  title={f.description}
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontWeight: 600,
                    background: f.tone === "warn" ? "var(--danger-bg, #4a1d1d)" : "var(--bg-2)",
                    color: f.tone === "warn" ? "var(--danger, #ff9b9b)" : "var(--fg-muted)",
                  }}
                >
                  {f.label}
                </span>
              ))}
              {sources.map((s) => (
                <span
                  key={s}
                  data-testid="candidate-source"
                  style={{
                    fontSize: 10,
                    lineHeight: "14px",
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "var(--bg-2)",
                    color: "var(--fg-subtle)",
                    textTransform: "capitalize",
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}

          {explanation !== null && (
            <p
              data-testid="rank-explanation"
              title={explanation}
              style={{
                margin: "2px 0 0",
                fontSize: 11,
                lineHeight: "15px",
                color: "var(--fg-subtle)",
                // Clamped so a long explanation can't stretch one card and
                // leave ragged holes across the grid; full text on hover.
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {explanation}
            </p>
          )}
        </div>
      </CandidatePhotoTicker>
      </div>

      {/*
        Sibling of CandidatePhotoTicker's <Link>, never a child — a feedback
        click must not navigate. Overlaid on the photo so it reclaims the
        vertical space the old inline bar occupied (#150). Visibility is
        CSS-driven (see .candidate-card-actions in globals.css): revealed on
        hover where the device supports hover, always visible on touch,
        always visible to keyboard users via :focus-within — and (#167) the
        one button matching the property's current feedback state, if any,
        stays visible unconditionally, so a marked card reads as marked while
        scanning the list. #379: on a rejected card this overlay is the
        un-reject control, so it stays full-opacity outside the dimmed content.
      */}
      <div className="candidate-card-actions" data-testid="candidate-card-actions">
        <FeedbackControls
          profileId={profileId}
          propertyId={candidate.property_id}
          initialState={candidate.feedback_state ?? null}
          onStateChange={setFeedbackState}
        />
      </div>
    </div>
  );
}
