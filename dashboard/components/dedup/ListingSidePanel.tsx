"use client";

import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import type { DedupListingSide } from "@/lib/dedup-shared";

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

export function ListingSidePanel({ side }: { side: DedupListingSide }) {
  const photos = side.photo_urls.slice(0, 4);
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
        // 4 across is fine once the panel itself is full desktop width, but
        // at a stacked mobile panel width (~300-350px) that's ~70px-wide,
        // ~55px-tall thumbnails — too small for "are these the same flat?"
        // comparison. .dedup-photo-grid switches to 2 columns below 768px
        // (globals.css) so each thumbnail roughly doubles in both
        // dimensions; desktop keeps repeat(4, 1fr) unchanged.
        <div className="dedup-photo-grid" style={{ display: "grid", gap: 4 }}>
          {photos.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain listing photos
            <img
              key={url}
              src={url}
              alt={`Foto ${i + 1} de ${side.source}`}
              style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 4, display: "block" }}
            />
          ))}
        </div>
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
