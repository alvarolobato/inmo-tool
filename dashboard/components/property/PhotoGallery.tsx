"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

/**
 * Leaflet touches `window` at import time — the location-map tile (#448 I)
 * must be loaded client-only, exactly like the profile candidate map
 * (components/map/MapView.tsx). Rendering it in an SSR pass throws.
 */
const PropertyLocationMap = dynamic(
  () => import("./PropertyLocationMap").then((mod) => mod.PropertyLocationMap),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          color: "var(--fg-subtle)",
          background: "var(--bg-2)",
        }}
      >
        Cargando mapa…
      </div>
    ),
  },
);

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
 *
 * #575 adds pinch/double-tap zoom on the lightbox image, pointer-events-based
 * (no external library — matches the file's existing "simple grid, local
 * state" philosophy). Gestures are gated to `pointerType === "touch"` so
 * desktop mouse behaviour is byte-for-byte unchanged (a mouse can't pinch
 * anyway, and gating out double-click avoids inventing new desktop UX this
 * issue never asked for). While zoomed (scale > 1) a single-finger drag pans;
 * at 1x a horizontal drag steps photos instead, so pan and swipe-navigation
 * never fight over the same gesture. `document.body`'s `touchAction` is
 * forced to `none` for the lifetime of the lightbox — the issue's root
 * complaint about the fixed overlay is that *native* page pinch-zoom
 * re-anchors to the visual viewport and fights our own overlay; disabling it
 * while the lightbox is open removes that fight entirely, independent of the
 * zoom gesture logic below.
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

type ZoomState = { scale: number; x: number; y: number };

const ZOOM_INITIAL: ZoomState = { scale: 1, x: 0, y: 0 };
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const DOUBLE_TAP_ZOOM_SCALE = 2.5;
const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;
const SWIPE_THRESHOLD_PX = 50;
const SNAP_BACK_SCALE = 1.05;

/** Clamp scale to [ZOOM_MIN, ZOOM_MAX] and translate so the image can't be
 * panned past roughly half its own zoomed overhang — an approximation (it
 * doesn't account for `objectFit: contain` letterboxing) that's good enough
 * for "doesn't fly off screen", not pixel-perfect bounds. */
function clampZoom(scale: number, x: number, y: number, rect: DOMRect): ZoomState {
  const clampedScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
  const maxX = (clampedScale - 1) * (rect.width / 2);
  const maxY = (clampedScale - 1) * (rect.height / 2);
  return {
    scale: clampedScale,
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

export function PhotoGallery({
  photoUrls,
  lat = null,
  lon = null,
}: {
  photoUrls: string[];
  /** #448 I: property coordinates for the leading map tile. Omitted/null → no map tile (rendered cleanly, never a broken cell). */
  lat?: number | null;
  lon?: number | null;
}) {
  const hasCoords = lat !== null && lon !== null;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openIndexRef = useRef<number | null>(null);
  openIndexRef.current = openIndex;
  const isOpen = openIndex !== null;

  // #575: pinch/double-tap zoom state for the lightbox image. Reset whenever
  // the open photo changes (including on open) so navigating never carries a
  // stale zoom/pan onto the next photo.
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_INITIAL);
  const zoomAreaRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    midX: number;
    midY: number;
  } | null>(null);
  const panRef = useRef<{
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const gesturingRef = useRef(false);

  useEffect(() => {
    setZoom(ZOOM_INITIAL);
  }, [openIndex]);

  // Native page pinch-zoom on a `position: fixed` overlay re-anchors to the
  // visual viewport and fights our own overlay/gesture handling (the root
  // cause named in #575) — suppressed for the lifetime of the lightbox only.
  useEffect(() => {
    if (!isOpen) return;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.touchAction = "none";
    return () => {
      document.body.style.touchAction = previousTouchAction;
    };
  }, [isOpen]);

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

  // #575 pinch/double-tap zoom. Pointer Events (not Touch Events) so pinch
  // (2 simultaneous pointers) and single-finger pan/tap share one code path;
  // gated to `pointerType === "touch"` throughout so mouse pointers are a
  // total no-op here — desktop keeps exactly today's click-to-close /
  // stopPropagation behaviour.
  const handleZoomPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    const el = zoomAreaRef.current;
    if (!el) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const rect = el.getBoundingClientRect();
      pinchRef.current = {
        startDist: dist,
        startScale: zoom.scale,
        startX: zoom.x,
        startY: zoom.y,
        midX: (pts[0].x + pts[1].x) / 2 - (rect.left + rect.width / 2),
        midY: (pts[0].y + pts[1].y) / 2 - (rect.top + rect.height / 2),
      };
      swipeRef.current = null;
      panRef.current = null;
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;
    const isDoubleTap =
      last !== null &&
      now - last.time < DOUBLE_TAP_WINDOW_MS &&
      Math.abs(e.clientX - last.x) < DOUBLE_TAP_SLOP_PX &&
      Math.abs(e.clientY - last.y) < DOUBLE_TAP_SLOP_PX;

    if (isDoubleTap) {
      lastTapRef.current = null;
      gesturingRef.current = false; // animate this jump, unlike a live drag
      if (zoom.scale > 1) {
        setZoom(ZOOM_INITIAL);
      } else {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - (rect.left + rect.width / 2);
        const my = e.clientY - (rect.top + rect.height / 2);
        setZoom(
          clampZoom(
            DOUBLE_TAP_ZOOM_SCALE,
            -mx * (DOUBLE_TAP_ZOOM_SCALE - 1),
            -my * (DOUBLE_TAP_ZOOM_SCALE - 1),
            rect,
          ),
        );
      }
      return;
    }
    lastTapRef.current = { time: now, x: e.clientX, y: e.clientY };

    if (zoom.scale > 1) {
      panRef.current = {
        startPointerX: e.clientX,
        startPointerY: e.clientY,
        startX: zoom.x,
        startY: zoom.y,
      };
    } else {
      swipeRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleZoomPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = zoomAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    if (pointersRef.current.size === 2 && pinchRef.current) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const { startDist, startScale, startX, startY, midX, midY } = pinchRef.current;
      if (startDist === 0) return;
      gesturingRef.current = true;
      const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, startScale * (dist / startDist)));
      const scaleRatio = newScale / startScale;
      setZoom(
        clampZoom(newScale, midX - (midX - startX) * scaleRatio, midY - (midY - startY) * scaleRatio, rect),
      );
      return;
    }

    if (pointersRef.current.size === 1 && panRef.current) {
      const { startPointerX, startPointerY, startX, startY } = panRef.current;
      gesturingRef.current = true;
      setZoom((current) =>
        clampZoom(current.scale, startX + (e.clientX - startPointerX), startY + (e.clientY - startPointerY), rect),
      );
    }
  };

  const handleZoomPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }

    if (pointersRef.current.size === 0) {
      if (panRef.current) {
        panRef.current = null;
      } else if (swipeRef.current && zoom.scale === 1) {
        const dx = e.clientX - swipeRef.current.x;
        const dy = e.clientY - swipeRef.current.y;
        // Only at 1x, and only once nothing is actively pinching/panning —
        // otherwise a drag-to-pan on a zoomed photo would also step photos.
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) && photoUrls.length > 1) {
          step(dx < 0 ? 1 : -1);
        }
      }
      swipeRef.current = null;
      gesturingRef.current = false;
      // A pinch released just below 1x snaps back cleanly instead of
      // stranding the photo at e.g. 0.97x with no affordance to fix it.
      setZoom((current) => (current.scale < SNAP_BACK_SCALE ? ZOOM_INITIAL : current));
    }
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

  // With neither photos nor coordinates there is nothing to show — the map
  // tile is omitted cleanly (#448 I) rather than rendered as a broken cell.
  if (photoUrls.length === 0 && !hasCoords) {
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
        {hasCoords && (
          // #448 I: the map is the FIRST tile of the gallery — a "where is
          // this" glance before the photos. Not a <button> (it opens no
          // lightbox) and outside `thumbRefs`, so photo indices/lightbox
          // navigation are unaffected.
          <div
            data-testid="photo-gallery-map-tile"
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflow: "hidden",
              aspectRatio: "4 / 3",
              position: "relative",
            }}
          >
            <PropertyLocationMap lat={lat as number} lon={lon as number} />
          </div>
        )}
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
              // #575: bumped 40px -> 44px (WCAG-minimum touch target,
              // matching navButtonStyle's prev/next buttons above).
              width: 44,
              height: 44,
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

          {/* #575: pinch/double-tap zoom area. Sized like the old bare <img>
              (maxWidth/maxHeight 90vw/90vh) so the touch target and the
              visible photo stay the same footprint; the <img> inside carries
              the live zoom/pan transform. touchAction: "none" so the browser
              never intercepts a gesture started here as native scroll/zoom —
              our own pointer handlers own it entirely. */}
          <div
            ref={zoomAreaRef}
            data-testid="photo-gallery-zoom-area"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={handleZoomPointerDown}
            onPointerMove={handleZoomPointerMove}
            onPointerUp={handleZoomPointerEnd}
            onPointerCancel={handleZoomPointerEnd}
            onPointerLeave={handleZoomPointerEnd}
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- see thumbnail note above */}
            <img
              data-testid="photo-gallery-lightbox-image"
              src={photoUrls[openIndex]}
              alt={`Foto ${openIndex + 1} ampliada`}
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                transition: gesturingRef.current ? "none" : "transform 150ms ease-out",
                touchAction: "none",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
