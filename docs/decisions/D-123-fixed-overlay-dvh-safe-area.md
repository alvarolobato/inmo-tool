---
id: D-123
title: A full-screen fixed overlay uses 100dvh + safe-area padding + a definite content box — not inset:0, not vw/vh, not max-width/max-height on a shrink-to-fit flex item
date: 2026-08-20
group: Plumbing / process
rule: "A full-screen `position: fixed` overlay uses `top/left/right: 0` + `height: \"100dvh\"` (never `inset: 0`, which behaves like `100vh` and doesn't track a dynamic mobile toolbar on some browsers) and `padding: env(safe-area-inset-*)` (requires `viewportFit: \"cover\"` in the app's `viewport` export — see `app/layout.tsx` — or every `env()` resolves to 0). Its content wrapper gets a DEFINITE box — `width/height: \"100%\"` plus `minWidth/minHeight: 0` — never `maxWidth/maxHeight` on a flex item whose own cross-size is content-based (`alignItems: \"center\"` and no explicit size means its own height is indefinite, so a descendant's `max-height: \"100%\"` computes to `none` and a portrait child clips top and bottom). Verify any such component on BOTH a landscape and a portrait fixture — a landscape-only test cannot catch this."
---

# D-123: A full-screen fixed overlay uses 100dvh + safe-area padding + a definite content box — not inset:0, not vw/vh, not max-width/max-height on a shrink-to-fit flex item

*Decided: 2026-08-20*

**Context**: Issue #575's owner clarified the priority bug as the photo
lightbox ("el visor incorporado") not adapting to the phone screen. The
lightbox (`PhotoGallery.tsx`) was `position: fixed; inset: 0` with its image
capped at `maxWidth: 90vw, maxHeight: 90vh`.

Two real, independent problems, found in two passes (the first PR review
caught the second one after the first version of this fix shipped it):

1. `inset: 0` is equivalent to `top/right/bottom/left: 0`, which on some
   mobile browsers does not reliably resize a `position: fixed` element
   when the dynamic address-bar/toolbar shows or hides. `90vw`/`90vh` also
   carries no awareness of device safe areas (notch, home-indicator),
   so absolutely-positioned overlay buttons (`left: 16`/`right: 16`) can
   land under one on notched hardware.
2. **The first fix for (1) introduced a worse bug.** It replaced
   `90vw`/`90vh` with `maxWidth: "100%", maxHeight: "100%"` on the image's
   immediate wrapper (`photo-gallery-zoom-area`) — which looks like the
   obviously-correct replacement, but that wrapper is a flex item of the
   overlay, centered via `alignItems`/`justifyContent` rather than
   stretched, which makes the wrapper's OWN resolved height content-based
   ("shrink-to-fit") — indefinite, for the purpose of a descendant's
   percentage sizing. A percentage height against an indefinite containing
   block computes to `none` per CSS, so the `<img>`'s `maxHeight: "100%"`
   silently did nothing. For a landscape photo this is invisible (the
   width constraint alone already bounds it); **for a portrait photo it
   rendered at full intrinsic size and got clipped by `overflow: hidden`,
   top and bottom** — measured on a 600×1200 fixture in a 390×664
   viewport: main's original `90vw/90vh` rendered it fully visible at
   298.8×597.6; the first fix rendered it at 374×748, 84px clipped (42px
   off each end). The accompanying e2e test only used a landscape fixture,
   so it never exercised this path — see the "Alternatives rejected"
   entry on decorative tests.

**Decision**: Full-screen fixed overlays in this app use:
```
// The overlay itself
style={{
  position: "fixed",
  top: 0, left: 0, right: 0,
  height: "100dvh",             // NOT `inset: 0` / `bottom: 0`
  padding:
    "max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) " +
    "max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))",
  boxSizing: "border-box",
  display: "flex", alignItems: "center", justifyContent: "center",
}}

// Its content wrapper — a flex item, centered (not stretched)
style={{
  width: "100%", height: "100%",   // NOT maxWidth/maxHeight — must be DEFINITE
  minWidth: 0, minHeight: 0,        // override flex's default min-*: auto
  display: "flex", alignItems: "center", justifyContent: "center",
  overflow: "hidden",
}}

// The actual content (e.g. an <img>) — THIS is where max* belongs
style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
```
`env(safe-area-inset-*)` only resolves to a real device inset if the app's
`viewport` export includes `viewportFit: "cover"` (`app/layout.tsx`) —
without it the page never extends under the safe area and every `env()`
call is permanently `0`, silently reducing the padding to its `max(8px,
...)` floor. (Next.js's App Router already injects a default `viewport`
meta tag — `width: "device-width", initialScale: 1` — unconditionally, via
`createDefaultViewport()`/`mergeViewport()` in
`next/dist/lib/metadata/resolve-metadata.js`; re-exporting those two keys
is redundant. `viewportFit: "cover"` is the one key actually worth adding.)

Absolutely positioned children (close/nav buttons) keep their existing
literal `top/right/left/bottom` offsets unchanged — CSS resolves those
against the overlay's PADDING edge, so they automatically clear the safe
area without their own styles needing to change.

**Alternatives rejected**:
- Leaving `inset: 0` and adding `env()` padding only — doesn't address the
  dynamic-toolbar resize gap `100dvh` exists for; complementary fixes, not
  substitutes.
- A JS `visualViewport` resize listener — unnecessary; `100dvh`/`env()`
  solve this declaratively with nothing to leak or miss an event from.
- **A landscape-only e2e fixture as "the" regression test.** The first
  review round shipped exactly this and it passed with the portrait-clipping
  bug live — main's `90vw/90vh` already fits a landscape photo inside a 390
  viewport, so a landscape-only assertion can't distinguish the buggy
  `maxWidth/maxHeight` version from the correct `width/height` one, or even
  from `90vw/90vh` reverted outright. Any test claiming to guard this
  pattern must include a portrait fixture and assert the rendered box is
  fully within `[0, viewportWidth] x [0, viewportHeight]` (catches negative
  `y`/`x`, i.e. clipping off an edge — not just "not wider than the
  viewport").

**Rationale**: `100dvh`, `env(safe-area-inset-*)` + `viewportFit: "cover"`,
and a definite `width/height: 100%` content wrapper are each the standard,
purpose-built primitive for one specific sub-problem (dynamic-toolbar
height, safe-area reservation, percentage-size resolution) — no custom JS
measurement needed anywhere, and each degrades to a desktop-equivalent
no-op (`100dvh` ≈ `100vh` without a shrinking toolbar; `env()` resolves to
`0` without a device inset) so desktop rendering is unaffected. Verified
end-to-end: cross-checked in an isolated worktree with PR #578's TopBar
overflow fix (merged into `main` since) applied — with that sibling fix
present, this pattern correctly fits the real device viewport for both a
landscape and a portrait fixture.

**See**: issue #575, `dashboard/components/property/PhotoGallery.tsx`,
`dashboard/e2e/mobile-photo-gallery.spec.ts`, `dashboard/app/layout.tsx`
(`viewportFit: "cover"`). #571 / PR #578 (TopBar mobile shell, merged) is
what this pattern's fit is measured against.
