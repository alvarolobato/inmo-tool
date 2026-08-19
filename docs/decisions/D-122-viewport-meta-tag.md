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
se capturan" / later clarified by the owner to be about the lightbox not
fitting the phone screen), live measurement against the property-detail page
under `devices["iPhone 13"]` emulation showed `document.body.scrollWidth =
654` against a 390px device width — a genuine horizontal-overflow layout bug
(root-caused to `TopBar.tsx`'s nav row, tracked separately by #571/PR #578,
NOT touched here) — plus `visualViewport.offsetLeft = 264`, which puts the
lightbox's `left: 16`-anchored prev button and roughly 60% of the photo
off-screen to the left.

The app also had **no `<meta name="viewport">` tag at all** (confirmed via
`curl` — Next.js App Router does not inject one for free, it must be
exported explicitly), which was the FIRST hypothesis for the pan/overflow
symptom above. That hypothesis was tested and **disproven**: adding the tag
and re-measuring the exact same page produced byte-identical numbers
(`scrollWidth`/`offsetLeft` unchanged) — the pan is caused entirely by
`TopBar.tsx`'s real content overflow, independent of the meta tag's
presence. A second, controlled cross-check (this fix applied on top of PR
#578's TopBar fix, in an isolated worktree, never merged into this branch)
confirmed the pan disappears once the TopBar overflow itself is fixed — with
or without this viewport-meta-tag change. So this decision does NOT explain
or fix issue #575's dominant visible symptom; it is a separate, independently
correct piece of hygiene the diagnosis happened to surface along the way (a
real single-page app should not ship with no viewport meta tag at all,
regardless of whether anything else is currently broken).

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

**Rationale**: `width=device-width, initial-scale=1` is the standard,
correct viewport declaration for a responsive app and was simply absent —
worth having regardless of whether it explains any specific symptom. It
composes cleanly with #575's lightbox-scoped `touch-action: none` (two
different, deliberately non-overlapping mechanisms: one sets up a correct
default viewport site-wide, the other locally suspends the default's zoom
gesture only where a custom one replaces it), and does not trade away
pinch-zoom accessibility to get there.

**See**: issue #575, PR (mobile-photo-zoom-p1), `dashboard/app/layout.tsx`,
`dashboard/components/property/PhotoGallery.tsx`. #571 / PR #578 (mobile
shell) owns the actual TopBar-overflow fix this decision does not attempt.
