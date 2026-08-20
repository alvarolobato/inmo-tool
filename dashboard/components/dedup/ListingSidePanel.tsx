"use client";

import { useState } from "react";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import type { DedupListingSide, OrderedPhoto } from "@/lib/dedup-shared";

// Issue #615, direct owner instruction: "me muestras 4 fotos como máximo
// ... necesito ver el resto". A cap IS the default view — the ask is that
// the 4 shown are the ones that actually MATCHED (never index-order), and
// that the rest stay reachable with a visible "how many more" count.
const DEFAULT_VISIBLE_PHOTOS = 4;

/**
 * The single-listing comparison panel — extracted out of the old
 * per-listing-pair `SuggestionCard` (issue #605 Part 2, which regrouped the
 * review queue by PROPERTY pair) so both the grouped queue's primary
 * comparison panel and any future consumer share one implementation
 * instead of two drifting copies. Pure presentation: no dedup-action state,
 * no data fetching.
 */

export function typeLabel(propertyType: string | null): string | null {
  if (propertyType === null) return null;
  return propertyType in PROPERTY_TYPE_LABELS
    ? PROPERTY_TYPE_LABELS[propertyType as (typeof PROPERTY_TYPES)[number]]
    : propertyType;
}

export function factsLine(side: DedupListingSide): string {
  const facts: string[] = [];
  const t = typeLabel(side.property_type);
  if (t) facts.push(t);
  if (side.m2_built !== null) facts.push(`${fmtInt(side.m2_built)} m²`);
  if (side.rooms !== null) facts.push(`${side.rooms} hab.`);
  if (side.bathrooms !== null) facts.push(`${side.bathrooms} ${side.bathrooms === 1 ? "baño" : "baños"}`);
  return facts.length > 0 ? facts.join(" · ") : "Sin datos estructurados";
}

export function ListingSidePanel({
  side,
  photos: orderedPhotos,
}: {
  side: DedupListingSide;
  /** Photos ALREADY ordered matched-first (issue #615) — build with
   * `resolveMatchedPhotos` + `orderPhotosMatchedFirst` (lib/dedup-shared),
   * never re-derived here. Falls back to `side.photo_urls` in original
   * order (all unmatched) when omitted, for any future non-photo_hash
   * caller that has no matched-pair evidence to give. */
  photos?: OrderedPhoto[];
}) {
  const [expanded, setExpanded] = useState(false);
  const photos = orderedPhotos ?? side.photo_urls.map((url) => ({ url, matched: false }));
  // Default view: the strongest DEFAULT_VISIBLE_PHOTOS photos (matched
  // ones first, per `photos`' own ordering) — never all of them, and
  // never a naive first-N-in-storage-order slice. The rest stay ONE tap
  // away via "+N más" (never a hard truncation — issue #615's second,
  // lower-priority requirement, after "show the right 4").
  const visible = expanded ? photos : photos.slice(0, DEFAULT_VISIBLE_PHOTOS);
  const hiddenCount = photos.length - visible.length;
  return (
    // flexBasis 280 (not the shorthand `flex: 1`, which is `1 1 0%`) is
    // load-bearing: a 0% basis is what made the parent's flexWrap inert
    // (#576) — the panel always "fit" by shrinking to nothing instead of
    // wrapping. With equal basis + equal grow on both panels, the resolved
    // width above the wrap threshold is provably identical to the old
    // basis-0 behaviour (both converge to half the available space), so
    // desktop (>=768px, where the row never wraps) is unaffected; below the
    // threshold the row wraps and each panel grows to fill its own line.
    <div className="dedup-side-panel" style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        data-testid="dedup-side-source"
        style={{
          alignSelf: "flex-start",
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.02em",
          padding: "1px 6px",
          borderRadius: 3,
          background: "var(--bg-2)",
          color: "var(--fg-muted)",
        }}
      >
        {side.source}
      </span>

      {photos.length > 0 ? (
        <>
          {/* Issue #615: names the total up front — the owner knows at a
              glance whether he's looking at all of a listing's evidence or
              a capped subset, without counting thumbnails himself. */}
          <span data-testid="dedup-side-photo-count" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
            {photos.length} {photos.length === 1 ? "foto" : "fotos"}
          </span>
          {/* 4 across is fine once the panel itself is full desktop width, but
              at a stacked mobile panel width (~300-350px) that's ~70px-wide,
              ~55px-tall thumbnails — too small for "are these the same flat?"
              comparison. .dedup-photo-grid switches to 2 columns below 768px
              (globals.css) so each thumbnail roughly doubles in both
              dimensions; desktop keeps repeat(4, 1fr) unchanged. Issue #615:
              `visible` (computed above) is `photos` in MATCHED-FIRST order,
              capped to DEFAULT_VISIBLE_PHOTOS unless expanded — never a
              naive first-N-in-storage-order slice; matched thumbnails get a
              highlighted ring + badge so they're visibly distinguished from
              an unmatched photo sharing the same grid, per the owner's
              "no las primeras que te salen" and "que se note cuáles
              coinciden". The class's max-height + overflow-y still applies
              when expanded, so a 20-photo listing scrolls internally
              instead of blowing the card out to full-page height. */}
          <div className="dedup-photo-grid" style={{ display: "grid", gap: 4 }}>
            {visible.map((photo, i) => (
              <div key={photo.url} style={{ position: "relative" }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain listing photos */}
                <img
                  src={photo.url}
                  alt={
                    photo.matched
                      ? `Foto ${i + 1} de ${side.source} — coincide con una foto del otro anuncio`
                      : `Foto ${i + 1} de ${side.source}`
                  }
                  data-testid={photo.matched ? "dedup-photo-matched" : "dedup-photo-unmatched"}
                  style={{
                    width: "100%",
                    aspectRatio: "4 / 3",
                    objectFit: "cover",
                    borderRadius: 4,
                    display: "block",
                    // Matched photos are the actual evidence behind this
                    // suggestion — a distinct ring makes them stand out
                    // from an unmatched photo the listing merely happens
                    // to have. Never implies pixel-identical: two
                    // matched photos routinely differ (each portal stamps
                    // its own watermark), so this is a "this is the
                    // evidence" marker, not a diff/equality indicator.
                    outline: photo.matched ? "2px solid var(--accent)" : "none",
                    outlineOffset: -2,
                  }}
                />
                {photo.matched && (
                  <span
                    aria-hidden="true"
                    title="Esta foto coincide con una del otro anuncio"
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      fontSize: 10,
                      lineHeight: 1,
                      padding: "2px 4px",
                      borderRadius: 3,
                      background: "var(--accent)",
                      color: "var(--bg)",
                      fontWeight: 700,
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            // Issue #615: "necesito ver el resto" — a cap of 4 is fine as
            // the DEFAULT view, but the rest must stay reachable and the
            // hidden count must be visible up front, not just implied.
            <button
              type="button"
              data-testid="dedup-photos-expand"
              className="dedup-action-btn"
              onClick={() => setExpanded(true)}
              style={{
                alignSelf: "flex-start",
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--accent)",
              }}
            >
              +{hiddenCount} más
            </button>
          )}
        </>
      ) : (
        <div
          style={{
            aspectRatio: "16 / 9",
            borderRadius: 4,
            background: "var(--bg-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--fg-subtle)",
          }}
        >
          Sin fotos
        </div>
      )}

      <p
        data-testid="dedup-side-price"
        style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--fg)" }}
      >
        {side.current_price !== null ? fmtEUR0(side.current_price) : "Precio no disponible"}
      </p>
      <p
        data-testid="dedup-side-address"
        title={side.address ?? undefined}
        style={{
          margin: 0,
          fontSize: 12,
          color: "var(--fg-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {[side.address, side.city].filter(Boolean).join(", ") || "Dirección no disponible"}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "var(--fg-subtle)" }}>{factsLine(side)}</p>
      {side.url && (
        <a
          href={side.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: "var(--accent)" }}
        >
          Ver anuncio original ↗
        </a>
      )}
    </div>
  );
}
