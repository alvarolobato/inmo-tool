"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Photo gallery for the property detail page (task 2.8, #44, EC-2): the
 * union of photo_urls across every linked listing (lib/property-detail.ts
 * already de-duplicates), since a deduplicated property may have
 * better/different photos on different sites. Simple grid + click-to-enlarge
 * lightbox using local state — issue #44 explicitly says no carousel
 * library is needed for this.
 *
 * Accessibility (fixed in #73 review): thumbnails are real <button>s (not
 * bare <img onClick>) so they're keyboard-focusable/activatable for free;
 * Escape closes the open lightbox; focus moves to the lightbox's close
 * button on open and returns to the triggering thumbnail on close.
 */
export function PhotoGallery({ photoUrls }: { photoUrls: string[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastOpenedFromRef = useRef<number | null>(null);

  useEffect(() => {
    if (openIndex === null) return;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenIndex(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openIndex]);

  const closeLightbox = () => {
    const returnTo = lastOpenedFromRef.current;
    setOpenIndex(null);
    if (returnTo !== null) thumbRefs.current[returnTo]?.focus();
  };

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
          <button
            key={url}
            ref={(el) => {
              thumbRefs.current[i] = el;
            }}
            type="button"
            data-testid="photo-gallery-thumb"
            onClick={() => {
              lastOpenedFromRef.current = i;
              setOpenIndex(i);
            }}
            aria-label={`Ampliar foto ${i + 1} de la propiedad`}
            style={{
              padding: 0,
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
              background: "none",
              display: "block",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain photo URLs from scraped listings; next/image's domain allowlist isn't a good fit here. */}
            <img
              src={url}
              alt={`Foto ${i + 1} de la propiedad`}
              style={{
                width: "100%",
                aspectRatio: "4 / 3",
                objectFit: "cover",
                borderRadius: 5,
                display: "block",
              }}
            />
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <div
          data-testid="photo-gallery-lightbox"
          onClick={closeLightbox}
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
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="photo-gallery-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            aria-label="Cerrar foto ampliada"
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              width: 40,
              height: 40,
              borderRadius: "50%",
              border: "none",
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              fontSize: 20,
              cursor: "pointer",
              zIndex: 1001,
            }}
          >
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- see thumbnail note above */}
          <img
            src={photoUrls[openIndex]}
            alt={`Foto ${openIndex + 1} ampliada`}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
