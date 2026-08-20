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
 * #575: the owner's actual complaint was the lightbox not FITTING the phone
 * screen ("no se adapta al tamaño del móvil") — the `photo-gallery-zoom-area`
 * div below gives the image a definite box (`width/height: "100%"` of the
 * outer lightbox's own `100dvh`-based size, not `maxWidth/maxHeight`, which
 * would be indefinite here and silently fail to bound a portrait photo's
 * height — see the block comment above that div) so `objectFit: "contain"`
 * correctly letterboxes both landscape and portrait photos. This sizing
 * change affects EVERY viewer, desktop included, not just touch devices —
 * see D-123.
 *
 * Separately, this also adds pinch/double-tap zoom on the lightbox image,
 * pointer-events-based (no external library — matches the file's existing
 * "simple grid, local state" philosophy). Gestures are gated to
 * `pointerType === "touch"` so desktop mouse *interaction* is unchanged (a
 * mouse can't pinch anyway, and gating out double-click avoids inventing new
 * desktop UX this issue never asked for) — this gating claim is specifically
 * about gesture handling, not about the sizing change above, which applies
 * everywhere. While zoomed (scale > 1) a single-finger drag pans; at 1x a
 * horizontal drag steps photos instead, so pan and swipe-navigation never
 * fight over the same gesture. `document.body`'s `touchAction` is forced to
 * `none` for the lifetime of the lightbox, gated to touch-capable devices,
 * so the browser's own native pinch-zoom can't fight this file's pointer
 * handling on the photo itself.
 *
 * #594: the location-map tile is now a SLIDE of this same lightbox, not just
 * a static grid cell — tapping it enlarges it exactly like a photo. The
 * lightbox's open-slide index is over an extended range: slide 0 is the map
 * (only when `hasCoords`), and every slide after it is a photo — `offset`
 * (1 when there's a map, else 0) is the one conversion point between "slide
 * index" and "photo index" (`photoUrls[openIndex - offset]`). This keeps the
 * SAME `openIndex`/`step()`/wrap machinery for both kinds of slide instead of
 * inventing a parallel one, at the cost of that one offset subtraction
 * wherever a photo index is needed. The `N / M` counter (`data-testid=
 * "photo-gallery-counter"`, kept as plain text — the owner explicitly asked
 * for numbers over dots in the #594 scope cut) is DERIVED from
 * `photoUrls.length` alone and hidden entirely while the map slide is open —
 * "1 / 12" must never include the map as one of the 12.
 *
 * Gesture-conflict decision (#594): the map slide is INTERACTIVE
 * (`PropertyLocationMap interactive`) — panning is the entire point of
 * enlarging it — but the lightbox's own swipe-to-step and pinch/double-tap
 * zoom (`handleZoomPointer*` below) are SUSPENDED while it's active, each
 * gated by a `mapSlideActive` early-return, so Leaflet's own touch/mouse
 * handling owns the gesture outright instead of fighting this file's pointer
 * tracking for the same drag. Arrow-key stepping is NOT suspended — it stays
 * the lightbox's exclusive keyboard channel (`PropertyLocationMap`'s
 * `keyboard` prop is hard-`false` even when `interactive`), so ArrowLeft/
 * ArrowRight always move you OFF the map slide rather than panning it. A
 * second static image tile was considered and rejected: it would add nothing
 * over the grid tile the user already tapped past to get here.
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
  // #594: slide 0 is the map (only when hasCoords); every slide from
  // `offset` on is a photo. See the class docstring's "extended range" note.
  const offset = hasCoords ? 1 : 0;
  const totalSlides = offset + photoUrls.length;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mapTileButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openIndexRef = useRef<number | null>(null);
  openIndexRef.current = openIndex;
  const isOpen = openIndex !== null;
  const mapSlideActive = isOpen && hasCoords && openIndex === 0;

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

  // Suppresses native page pinch-zoom for the lifetime of the lightbox, so
  // it can't fight this file's own pointer-based pinch handling on a touch
  // (mouse can't pinch) device. Gated on touch support: on a mouse-only
  // desktop this effect would be a pure no-op write (the overlay and zoom
  // area below already carry their own `touchAction: "none"`, which is
  // what actually matters for touches on the photo itself) — skipping it
  // there avoids an unnecessary DOM mutation rather than fixing a bug.
  useEffect(() => {
    if (!isOpen) return;
    if (typeof window === "undefined" || !("ontouchstart" in window)) return;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.touchAction = "none";
    return () => {
      document.body.style.touchAction = previousTouchAction;
    };
  }, [isOpen]);

  const step = (delta: number) => {
    setOpenIndex((current) =>
      current === null ? null : (current + delta + totalSlides) % totalSlides,
    );
  };

  const closeLightbox = () => {
    const returnTo = openIndexRef.current;
    setOpenIndex(null);
    if (returnTo === null) return;
    // #594: the map slide has no entry in `thumbRefs` (it isn't one of the
    // grid's photo thumbnails) — return focus to its own tile button instead.
    if (hasCoords && returnTo === 0) {
      mapTileButtonRef.current?.focus();
    } else {
      thumbRefs.current[returnTo - offset]?.focus();
    }
  };

  // #575 pinch/double-tap zoom. Pointer Events (not Touch Events) so pinch
  // (2 simultaneous pointers) and single-finger pan/tap share one code path;
  // gated to `pointerType === "touch"` throughout so mouse pointers are a
  // total no-op here — desktop keeps exactly today's click-to-close /
  // stopPropagation behaviour.
  const handleZoomPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // #594: the map slide is interactive (Leaflet owns drag/pinch); this
    // file's own zoom/pan/swipe tracking must not also react to the same
    // pointer stream, or a map drag would get misread as a photo swipe.
    if (mapSlideActive) return;
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
    if (mapSlideActive) return;
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
    // #594 review (L1): deliberately NOT gated on `mapSlideActive` like
    // Down/Move above — this is the cleanup half of the same gesture those
    // two start tracking. If Down/Move guard out a gesture that began while
    // `mapSlideActive` was true, `pointersRef`/`swipeRef`/`panRef` were never
    // populated in the first place, so this runs its cleanup against empty
    // state and is a no-op either way. But if `openIndex` changes mid-gesture
    // (e.g. a nav-button tap lands while a pinch is still in flight) and End
    // bailed here too, a real tracked pointer id would never get deleted —
    // a stale entry that survives into the NEXT gesture and gets misread as
    // an already-in-progress pinch. End must always run.
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
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) && totalSlides > 1) {
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
  }, [isOpen, totalSlides]);

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
          // this" glance before the photos. #594: it now opens IN the
          // lightbox too (slide 0), same as any photo thumb. The click
          // target is a transparent overlay `<button>` SIBLING of the map,
          // not a button wrapping it — mirrors this codebase's established
          // "interactive control as a sibling, never a descendant of
          // content it doesn't own" rule (CandidatePhotoTicker.tsx's
          // docstring) rather than nesting a whole Leaflet instance inside
          // a `<button>`'s content model. `mapTileButtonRef` (not
          // `thumbRefs`, which is photo-indexed only) gets focus back on
          // close.
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
            <button
              ref={mapTileButtonRef}
              type="button"
              data-testid="photo-gallery-map-tile-open"
              onClick={() => setOpenIndex(0)}
              aria-label="Ampliar mapa de ubicación"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                padding: 0,
                margin: 0,
                border: "none",
                background: "transparent",
                cursor: "pointer",
              }}
            />
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
            onClick={() => setOpenIndex(i + offset)}
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
            // #575: `top/left/right` + `height: 100dvh` instead of `inset: 0`
            // (which is equivalent to `bottom: 0` alongside `height: 100vh`
            // in older browsers/iOS Safari versions specifically, does NOT
            // reliably resize a `position: fixed` element when the dynamic
            // address-bar/toolbar shows or hides — the classic "fixed
            // overlay doesn't adapt to phone size" bug. `100dvh` (dynamic
            // viewport height) is the standard modern fix: it tracks the
            // real visible height directly, toolbar included, without
            // depending on fixed-position viewport-tracking quirks at all.
            top: 0,
            left: 0,
            right: 0,
            height: "100dvh",
            // Keep buttons clear of a notch/home-indicator/rounded corner —
            // a no-op `env()` fallback of 0 everywhere without one.
            padding:
              "max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))",
            boxSizing: "border-box",
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

          {/* #594: gated on `totalSlides`, not `photoUrls.length` — prev/next
              must also reach a 1-photo property that also has a map (2
              slides total), and must stay hidden for a coord-less property
              with exactly 1 photo (unchanged from before this feature). */}
          {totalSlides > 1 && (
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
              {/* #594 review (L2): gated on `photoUrls.length > 1`,
                  separately from the nav buttons' `totalSlides > 1` above —
                  a property with exactly one photo (plus a map, so
                  `totalSlides` is 2) must show prev/next to reach the map,
                  but never a meaningless "1 / 1". Also never counts the map
                  as a photo — hidden outright while the map slide is open
                  rather than showing a bogus "0 / N" or "N+1 / N".
                  Denominator is always `photoUrls.length`, never
                  `totalSlides`. */}
              {!mapSlideActive && photoUrls.length > 1 && (
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
                  {openIndex - offset + 1} / {photoUrls.length}
                </p>
              )}
            </>
          )}

          {/* #594 review (L4): the photo counter above is the ONLY aria-live
              region in this lightbox — landing on the map slide hid it
              (mapSlideActive excludes it, correctly, from ever announcing a
              photo position) with nothing announced in its place, so a
              screen-reader user got silence where a photo would have
              announced "N / M". Visually hidden (the map is its own visual
              cue) but present in the accessibility tree with the same
              aria-live="polite" pattern as the counter. */}
          {mapSlideActive && (
            <p
              aria-live="polite"
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
            >
              Mapa de ubicación
            </p>
          )}

          {/* #575 review fix (B1): this div is a flex item of the outer
              lightbox, centered via `alignItems`/`justifyContent` rather
              than stretched — that makes ITS OWN resolved height
              content-based ("shrink-to-fit"), i.e. indefinite for the
              purpose of a descendant's percentage sizing. The first version
              of this fix gave it `maxWidth/maxHeight: "100%"`, which looks
              right but does nothing useful for height: per CSS, a
              percentage height against an indefinite containing-block
              height computes to `none` — so the `<img>`'s own
              `maxHeight: "100%"` resolved to `none` too, and a portrait
              photo rendered at full intrinsic size and got clipped by
              `overflow: hidden` (top AND bottom, since it's centered).
              `width`/`height: "100%"` (not `max*`) instead gives this div a
              DEFINITE box — 100% of the outer lightbox's own definite
              `100dvh`-based height — so the `<img>`'s `maxHeight: "100%"`
              now resolves against a real number and `objectFit: "contain"`
              correctly letterboxes BOTH orientations. `minWidth`/
              `minHeight: 0` override flexbox's default `min-width/height:
              auto` (content-based), which would otherwise refuse to let
              this div shrink below the image's own intrinsic size and
              defeat the fix again. `overflow: hidden` is intentional and
              kept: it's what makes a pinch-zoomed photo look like viewing
              through a window rather than growing past the lightbox's own
              edges. This is also the pinch/double-tap zoom area: the
              `<img>` inside carries the live zoom/pan transform;
              `touchAction: "none"` so the browser never intercepts a
              gesture started here as native scroll/zoom — our own pointer
              handlers own it entirely. Regression-tested for both
              orientations in `mobile-photo-gallery.spec.ts` (portrait AND
              landscape fixtures). */}
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
              width: "100%",
              height: "100%",
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            {mapSlideActive ? (
              // #594: interactive — panning is the whole point of enlarging
              // it. The fresh MapContainer instance per open (Leaflet
              // doesn't tolerate being fed a new center/props on an existing
              // instance the way a plain React re-render implies) comes from
              // this WHOLE branch mounting/unmounting on `mapSlideActive`,
              // not from `key` — `lat`/`lon` don't change within one
              // property's viewing, so this key is constant across opens.
              // Kept anyway as a defensive pin: if `lat`/`lon` ever DID
              // change while this branch stayed mounted, React would reuse
              // the same MapContainer instance and hand it a new `center`
              // prop it (per react-leaflet's own docs) ignores after mount.
              <div
                key={`map-slide-${lat}-${lon}`}
                data-testid="photo-gallery-map-slide"
                style={{ width: "100%", height: "100%" }}
              >
                <PropertyLocationMap lat={lat as number} lon={lon as number} interactive />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- see thumbnail note above
              <img
                data-testid="photo-gallery-lightbox-image"
                src={photoUrls[openIndex - offset]}
                alt={`Foto ${openIndex - offset + 1} ampliada`}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                  transition: gesturingRef.current ? "none" : "transform 150ms ease-out",
                  touchAction: "none",
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
