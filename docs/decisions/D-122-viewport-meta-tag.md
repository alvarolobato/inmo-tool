---
id: D-122
title: Add a site-wide viewport meta tag, without disabling native pinch-zoom
date: 2026-08-20
group: Plumbing / process
rule: "`app/layout.tsx` exports `viewport: { width: \"device-width\", initialScale: 1 }` — never add `maximumScale`/`userScalable: false`; scope any zoom-gesture takeover locally via `touch-action`, not by disabling zoom app-wide."
---

# D-122: Add a site-wide viewport meta tag, without disabling native pinch-zoom

*Decided: 2026-08-20*

**Context**: While diagnosing issue #575 ("las fotos no hacen zoom bien cuando
se capturan"), live measurement against the property-detail page under
`devices["iPhone 13"]` emulation showed `document.body.scrollWidth = 654`
against a 390px device width — a genuine horizontal-overflow layout bug
(root-caused to `TopBar.tsx`'s nav row, tracked separately by #571/PR #578,
not touched here). Because the app had **no `<meta name="viewport">` tag at
all** (confirmed via `curl` — Next.js App Router does not inject one for
free, it must be exported explicitly), the browser fell back to
desktop-compatibility layout: the LAYOUT viewport sized itself to the
overflowing content (654px) while the VISUAL viewport stayed 390px and
auto-panned to fit, and `position: fixed; inset: 0` elements (e.g. the photo
lightbox) size themselves to the LAYOUT viewport. The result — measured, not
inferred — was `visualViewport.offsetLeft = 264`, which put the lightbox's
`left: 16`-anchored prev button and roughly 60% of the photo off-screen to
the left on a real phone-width viewport. This is very plausibly (though not
proven, since #571/#578 wasn't reverted to test in isolation) part of the
"the overlay re-anchors to the visual viewport; prev/next/close buttons
drift" mechanism issue #575 itself named as one candidate cause of the
photo-zoom complaint.

**Decision**: `app/layout.tsx` exports `viewport: Viewport = { width:
"device-width", initialScale: 1 }`. No `maximumScale` and no `userScalable:
false`. The photo lightbox's own pinch/double-tap zoom (#575 Phase 2) keeps
native browser pinch-zoom from fighting its custom gesture handling by
setting `document.body.style.touchAction = "none"` for the lifetime of the
open lightbox only (`PhotoGallery.tsx`) — a locally-scoped takeover, not an
app-wide one.

**Alternatives rejected**: `maximumScale: 1` / `userScalable: false` (the
common "fix" for zoom-vs-fixed-overlay fights) — rejected because it
disables the browser's own pinch-zoom everywhere in the app, a WCAG
1.4.4/1.4.10 accessibility regression this single-viewport-meta-tag fix does
not need to make. Fixing the actual overflow (TopBar) — out of scope here,
already owned by #571/PR #578; this decision documents the meta tag as a
correctness fix *independent* of whatever causes overflow, since a missing
viewport meta tag is wrong regardless of whether anything currently
overflows.

**Rationale**: `width=device-width, initial-scale=1` makes the CSS layout
viewport track the real visual viewport, which is what every `vw`-based and
`position: fixed` calculation in the app has implicitly assumed all along.
It fixes the viewport-tracking bug without trading away pinch-zoom
accessibility, and composes cleanly with #575's lightbox-scoped
`touch-action: none` (two different, deliberately non-overlapping
mechanisms: one sets up a correct default viewport site-wide, the other
locally suspends the default's zoom gesture only where a custom one
replaces it).

**See**: issue #575, PR (mobile-photo-zoom-p1), `dashboard/app/layout.tsx`,
`dashboard/components/property/PhotoGallery.tsx`. #571 / PR #578 (mobile
shell) owns the actual TopBar-overflow fix this decision does not attempt.
