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
 *
 * #152 extends the lightbox with previous/next navigation (buttons +
 * ArrowLeft/ArrowRight), so reviewing a property's photos no longer means
 * close → click the next thumbnail → repeat. Navigation wraps: at the last
 * photo, "next" returns to the first. Closing returns focus to the thumbnail
 * of the photo you were *looking at*, not the one you originally opened —
 * otherwise arrowing through 20 photos dumps you back at the top of the grid.
 */
const navButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "none",
  background: "rgba(255,255,255,0.15)",
  color: "#fff",
  fontSize: 26,
  lineHeight: 1,
  cursor: "pointer",
  zIndex: 1001,
};

export function PhotoGallery({ photoUrls }: { photoUrls: string[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openIndexRef = useRef<number | null>(null);
  openIndexRef.current = openIndex;
  const isOpen = openIndex !== null;

  const step = (delta: number) => {
    setOpenIndex((current) =>
      current === null ? null : (current + delta + photoUrls.length) % photoUrls.length,
    );
  };

  const closeLightbox = () => {
    const returnTo = openIndexRef.current;
    setOpenIndex(null);
    if (returnTo !== null) thumbRefs.current[returnTo]?.focus();
  };

  useEffect(() => {
    // Keyed on `isOpen`, not `openIndex`: re-running on every index change
    // would yank focus back to the close button after each arrow press,
    // making a second click on "siguiente" impossible without re-aiming.
    if (!isOpen) return;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeLightbox();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeLightbox/step read the live index through openIndexRef and the functional setter; adding them would reintroduce the per-index re-run this effect exists to avoid.
  }, [isOpen, photoUrls.length]);

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
            onClick={() => setOpenIndex(i)}
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

          {photoUrls.length > 1 && (
            <>
              <button
                type="button"
                data-testid="photo-gallery-prev"
                onClick={(e) => {
                  e.stopPropagation();
                  step(-1);
                }}
                aria-label="Foto anterior"
                style={{ ...navButtonStyle, left: 16 }}
              >
                ‹
              </button>
              <button
                type="button"
                data-testid="photo-gallery-next"
                onClick={(e) => {
                  e.stopPropagation();
                  step(1);
                }}
                aria-label="Foto siguiente"
                style={{ ...navButtonStyle, right: 16 }}
              >
                ›
              </button>
              <p
                data-testid="photo-gallery-counter"
                aria-live="polite"
                style={{
                  position: "absolute",
                  bottom: 16,
                  left: "50%",
                  transform: "translateX(-50%)",
                  margin: 0,
                  padding: "4px 10px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.15)",
                  color: "#fff",
                  fontSize: 13,
                }}
              >
                {openIndex + 1} / {photoUrls.length}
              </p>
            </>
          )}

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
