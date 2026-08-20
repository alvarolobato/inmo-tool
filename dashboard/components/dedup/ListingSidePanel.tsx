"use client";

import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import type { DedupListingSide, OrderedPhoto } from "@/lib/dedup-shared";

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
  internalHref,
}: {
  side: DedupListingSide;
  /** Photos ALREADY ordered matched-first (issue #615) — build with
   * `resolveMatchedPhotos` + `orderPhotosMatchedFirst` (lib/dedup-shared),
   * never re-derived here. Falls back to `side.photo_urls` in original
   * order (all unmatched) when omitted, for any future non-photo_hash
   * caller that has no matched-pair evidence to give. */
  photos?: OrderedPhoto[];
  /** Issue #626: the internal `/profiles/[id]/properties/[propertyId]`
   * link for this side, from `internalPropertyHref` (lib/dedup-shared) —
   * `null` when this property matches no active search profile, in which
   * case no internal link renders (there is nothing to link to; the route
   * would 404). Built by the caller, never re-derived here — same
   * never-re-derive-it-twice pattern as `photos`. */
  internalHref?: string | null;
}) {
  // Issue #626, direct owner instruction repeated after #615's "cap at 4
  // with an expander" was read as a misunderstanding: "no las primeras 4,
  // TODAS" — the cap is gone. Matched-first ordering (issue #615) stays:
  // `photos` is already ordered that way, so a matched photo is still the
  // first thing the eye lands on even though every photo now renders.
  // Usability at 390px comes from `.dedup-photo-grid`'s own fixed
  // max-height + `overflow-y: auto` (globals.css) — a bounded, internally
  // scrolling box regardless of photo count, which is what keeps the
  // confirm/reject buttons below it reachable without scrolling past the
  // gallery, on a 3-photo listing exactly as on a 27-photo one.
  const photos = orderedPhotos ?? side.photo_urls.map((url) => ({ url, matched: false }));
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
          {/* Issue #615: names the total up front. Issue #626: this is now
              also the count of thumbnails actually rendered below — no
              cap, so "N fotos" and the grid's own image count always
              agree. */}
          <span data-testid="dedup-side-photo-count" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
            {photos.length} {photos.length === 1 ? "foto" : "fotos"}
          </span>
          {/* 4 across is fine once the panel itself is full desktop width, but
              at a stacked mobile panel width (~300-350px) that's ~70px-wide,
              ~55px-tall thumbnails — too small for "are these the same flat?"
              comparison. .dedup-photo-grid switches to 2 columns below 768px
              (globals.css) so each thumbnail roughly doubles in both
              dimensions; desktop keeps repeat(4, 1fr) unchanged.

              Issue #626: EVERY photo in `photos` renders — #615 shipped a
              4-photo default cap with a "+N más" expander, which the owner
              then clarified was a misreading of his original ask ("todas
              las fotos", not "4 con un botón"). Matched-first ordering
              (issue #615) is untouched: `photos` still puts the actual
              evidence first, so it's the first thumbnail the eye lands on
              even in the full, unbounded grid — matched thumbnails still
              get a highlighted ring + badge so they stay visually
              distinguished from an unmatched photo sharing the grid.
              `.dedup-photo-grid`'s max-height + overflow-y (globals.css)
              is what keeps this usable: a fixed-height, internally
              scrolling box independent of photo count, so a 27-photo
              fotocasa gallery scrolls INSIDE the grid instead of pushing
              the confirm/reject buttons below it off screen. */}
          <div className="dedup-photo-grid" style={{ display: "grid", gap: 4 }}>
            {photos.map((photo, i) => (
              <div key={photo.url} style={{ position: "relative" }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain listing photos */}
                <img
                  src={photo.url}
                  // `i` indexes into `photos` (already matched-first) — the
                  // alt text's "Foto N" numbers by DISPLAY position, which
                  // is also storage order for the unmatched tail now that
                  // nothing is capped.
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
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
        {/* Issue #626: the card only ever linked OUT to the portal advert —
            no route into the app's own detail page (price history,
            assessments, the other adverts on this property, the map). A
            distinct label ("ficha interna" vs. "anuncio original") makes
            it visually obvious which link goes where, since both sit next
            to each other and neither can lean on an icon alone to carry
            that distinction. Opens in a new tab — direct owner decision,
            not an interim workaround: comparing two properties works
            better with the detail page open NEXT TO the card, and it
            keeps the dedup queue's in-memory state (#595's unsolved
            problem for the candidate feed) untouched, since the /admin/dedup
            tab is never unmounted. `null` (no matched active profile for
            this side) renders a muted note instead of a broken link — the
            route genuinely 404s without a real profile id
            (isPropertyMatchedForProfile). */}
        {internalHref ? (
          <a
            href={internalHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="dedup-internal-link"
            style={{ fontSize: 11, color: "var(--fg)", fontWeight: 600 }}
          >
            Ver ficha interna (inmo-tool) ↗
          </a>
        ) : (
          <span
            data-testid="dedup-internal-link-unavailable"
            style={{ fontSize: 11, color: "var(--fg-subtle)" }}
          >
            Sin ficha interna (ningún perfil activo coincide)
          </span>
        )}
      </div>
    </div>
  );
}
