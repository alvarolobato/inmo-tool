"use client";

import { useState } from "react";
import type { CandidateRow } from "@/lib/candidates";
import type { StateFeedbackType } from "@/lib/db/feedback";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { FeedbackControls } from "./FeedbackControls";
import { CandidatePhotoTicker } from "./CandidatePhotoTicker";
import { StalenessBadge } from "@/components/StalenessBadge";

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
      // #416 novelty mark. Mirrors the data-rejected convention: a stable hook
      // for e2e ("marked → survives reload/filter/Cargar más → gone next
      // visit") and CSS, set only when the property is new since the profile's
      // last visit. Presentation only — the feed order is unchanged in phase 1.
      data-novelty={candidate.is_new ? "new" : undefined}
      className="candidate-card"
      style={{
        // A rejected card stays in the list (deferred removal / show-rejected
        // view) but reads unmistakably as discarded: a red-tinted border.
        border: isRejected ? "1px solid var(--down, #d33)" : "1px solid var(--border)",
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

          <p data-testid="candidate-facts" style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)" }}>
            {facts.length > 0 ? facts.join(" · ") : "Sin datos estructurados"}
          </p>

          {(candidate.is_new ||
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
