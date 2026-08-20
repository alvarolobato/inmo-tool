---
id: D-128
title: Property detail map opens as an interactive lightbox slide; swipe/pinch suspend, arrow keys don't
date: 2026-08-20
group: Frontend / UI
rule: "PhotoGallery's lightbox extends its open-slide index to an offset range (slide 0 = map when present, offset..N = photos); the map slide is Leaflet-interactive (dragging/zoom on, keyboard off) while the lightbox's own swipe/pinch pointer handlers early-return on it (arrow-key/button stepping stays the lightbox's, unaffected); the N / M counter always excludes the map from both N and M."
---

# D-128: property detail map opens as an interactive lightbox slide; swipe/pinch suspend, arrow keys don't

*Decided: 2026-08-20*

**Context**: Issue #594 (owner, on mobile): the detail-page location map
(`PropertyLocationMap.tsx`, first tile of `PhotoGallery.tsx`'s grid) was
deliberately static — `dragging`/`scrollWheelZoom`/`keyboard`/etc. all off —
so it can't steal scroll from the surrounding gallery grid (see that file's
own docstring). The owner wanted it reachable in the enlarged lightbox view
like any photo, but enlarging it makes panning the entire point, which
collides with the SAME lightbox already owning swipe-to-step and pinch/
double-tap zoom (`PhotoGallery.tsx`'s `handleZoomPointer{Down,Move,End}`,
#575) on the exact same touch/pointer gesture. Mid-task the owner also cut
the issue's dots/card-swipe scope (numbers over dots; card ticker keeps
prev/next only, gains a numeric overlay counter instead) — that part is not
this record's concern, only the map/lightbox interaction is.

**Decision**:

1. **Slide indexing.** `PhotoGallery`'s `openIndex` state is redefined as an
   index into an EXTENDED slide range, not `photoUrls` directly: `offset =
   hasCoords ? 1 : 0`; slide `0` (only when `hasCoords`) is the map; slides
   `[offset, offset + photoUrls.length)` are photos at `photoUrls[openIndex -
   offset]`. `step()`/the wrap arithmetic/the keyboard effect's dependency
   all move to `totalSlides = offset + photoUrls.length` instead of
   `photoUrls.length`. This keeps ONE state machine and ONE wrap formula for
   both slide kinds rather than a parallel one — the cost is remembering the
   one `- offset` subtraction everywhere a photo index is read.
2. **The map tile's click target is a sibling `<button>`, not a wrapper.**
   The grid tile keeps rendering `<PropertyLocationMap>` (non-interactive)
   plus a transparent, absolutely-positioned overlay `<button
   data-testid="photo-gallery-map-tile-open">` on top of it — never a
   `<button>` WRAPPING the Leaflet instance. Same "interactive control as a
   sibling, never a descendant of content it doesn't own" rule
   `CandidatePhotoTicker.tsx`'s docstring already establishes for the card
   ticker, applied here to avoid nesting a whole Leaflet DOM tree inside a
   `<button>`'s content model. `mapTileButtonRef` (separate from the
   photo-indexed `thumbRefs`) gets focus back on close.
3. **`PropertyLocationMap` gains an `interactive` prop** (default `false`,
   grid tile unchanged): when true, `dragging`/`scrollWheelZoom`/
   `doubleClickZoom`/`boxZoom`/`touchZoom`/`zoomControl`/`attributionControl`
   all flip on. **`keyboard` stays hard-`false` even when `interactive`** —
   the lightbox's own ArrowLeft/ArrowRight must always step slides, never pan
   the map; ceding keyboard to Leaflet would fight that.
4. **Swipe/pinch are suspended on the map slide, arrow-key stepping is not.**
   `mapSlideActive = hasCoords && openIndex === 0`, checked as the FIRST line
   of `handleZoomPointerDown`/`Move`/`End` (early-return, no-op) — Leaflet's
   own touch/mouse handling owns the drag outright instead of this file's
   pointer tracking also reacting to the same stream (which would otherwise
   misread a map pan as a photo swipe, or vice versa). The zoom area's
   `touchAction` also flips `"none" → "auto"` for the map slide: Leaflet's
   OWN bundled CSS sets `touch-action: none` on `.leaflet-container` itself
   when dragging is enabled, but CSS touch-action is the INTERSECTION of an
   element's own value and its ancestors' — an ancestor still at `"none"`
   would silently override Leaflet's more specific declaration and block its
   touch dragging. Arrow keys are UNCHANGED (the lightbox's existing
   `document`-level keydown effect, keyed on `totalSlides`) — they always
   move you off the map slide, never pan it, because of (3).
5. **The `N / M` counter never counts the map.** `M` is always
   `photoUrls.length`; `N` is `openIndex - offset + 1`; the counter element
   is omitted outright (not shown as "0 / N") while `mapSlideActive`.
6. **A second static image tile was considered and rejected** — it adds
   nothing over the grid tile the user already tapped past to get here.

**Alternatives rejected**:
- *A parallel state machine for "which slide kind is open"* (e.g. a
  `{kind: "map"} | {kind: "photo", index}` union) — rejected in favor of the
  single offset-adjusted `openIndex`, which reuses `step()`'s wrap arithmetic
  and the existing keyboard effect verbatim.
- *Wrapping `<PropertyLocationMap>` in the grid tile's own `<button>`* —
  rejected for the same "no interactive content nested inside a control it
  doesn't own" reason `CandidatePhotoTicker.tsx` already established; a
  sibling overlay button is simpler and keeps `PropertyLocationMap` itself
  free of button-content-model concerns.
- *Leaving the zoom area's `touchAction` at `"none"` for the map slide too*
  — this was the ORIGINAL implementation and passed every test written
  against jsdom/mocked Leaflet; only a real-browser e2e test driving genuine
  CDP touch input against real Leaflet would have caught that Leaflet's own
  `touch-action: none` (bundled `leaflet.css`, stamped on `.leaflet-container`
  when `dragging`/`touchZoom` are enabled) is not enough on its own — the
  ancestor value still wins per the CSS touch-action intersection rule.
  Kept as `"auto"` for the map slide specifically for this reason, even
  though a CDP-synthesized touch test in this repo's Chromium build did not
  actually distinguish the two values (JS-dispatched pointer/touch events
  reach Leaflet's listeners regardless of `touch-action`; the property
  mainly arbitrates against the BROWSER's own native compositor-driven pan,
  which a synthetic CDP touch stream doesn't reliably exercise) — real
  hardware is where `touch-action` divergence would show up as jank, so the
  correct value is kept on documented first-principles despite the
  synthetic-touch test being unable to prove it directly.

**Rationale**: An enlarged map that can't be panned is a worse experience
than the static grid tile it came from — the owner's ask was explicit
("debería mostrarse también en la vista ampliada"). Reusing the lightbox's
existing slide/step/keyboard machinery (rather than a bespoke map lightbox)
keeps the two adjacent lightbox behaviors (map panning, photo swipe/pinch)
consistent with each other in every other respect (close, Escape, arrow
keys, focus-return) while cleanly separating the ONE genuinely conflicting
gesture (drag).

**See**: `dashboard/components/property/PhotoGallery.tsx`,
`dashboard/components/property/PropertyLocationMap.tsx`,
`dashboard/components/candidates/CandidatePhotoTicker.tsx` (the sibling-not-
descendant precedent), `dashboard/e2e/property-detail.spec.ts`,
`dashboard/e2e/mobile-photo-gallery.spec.ts`, issue #594, D-123 (fixed
overlay/lightbox sizing, the other #594-adjacent gotcha), the `.leaflet-
container { isolation: isolate }` rule in `globals.css` (#591, unscoped —
already covers the map slide with no new CSS needed).
