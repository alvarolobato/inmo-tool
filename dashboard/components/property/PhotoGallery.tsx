"use client";

import { useState } from "react";

/**
 * Photo gallery for the property detail page (task 2.8, #44, EC-2): the
 * union of photo_urls across every linked listing (lib/property-detail.ts
 * already de-duplicates), since a deduplicated property may have
 * better/different photos on different sites. Simple grid + click-to-enlarge
 * lightbox using local state — issue #44 explicitly says no carousel
 * library is needed for this.
 */
export function PhotoGallery({ photoUrls }: { photoUrls: string[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (photoUrls.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: "var(--fg-muted)" }}>
        No hay fotos disponibles para esta propiedad.
      </p>
    );
  }

  return (
    <div>
      <div
        data-testid="photo-gallery-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        {photoUrls.map((url, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain photo URLs from scraped listings; next/image's domain allowlist isn't a good fit here.
          <img
            key={url}
            src={url}
            alt={`Foto ${i + 1} de la propiedad`}
            data-testid="photo-gallery-thumb"
            onClick={() => setOpenIndex(i)}
            style={{
              width: "100%",
              aspectRatio: "4 / 3",
              objectFit: "cover",
              borderRadius: 6,
              cursor: "pointer",
              border: "1px solid var(--border)",
            }}
          />
        ))}
      </div>

      {openIndex !== null && (
        <div
          data-testid="photo-gallery-lightbox"
          onClick={() => setOpenIndex(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            cursor: "zoom-out",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- see thumbnail note above */}
          <img
            src={photoUrls[openIndex]}
            alt={`Foto ${openIndex + 1} ampliada`}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }}
          />
        </div>
      )}
    </div>
  );
}
