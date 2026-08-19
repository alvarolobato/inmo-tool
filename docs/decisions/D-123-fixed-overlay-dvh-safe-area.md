---
id: D-123
title: A full-screen fixed overlay sizes itself with 100dvh + safe-area padding, not inset:0 + vw/vh
date: 2026-08-20
group: Plumbing / process
rule: "A full-screen `position: fixed` overlay uses `top/left/right: 0` + `height: \"100dvh\"` (never `inset: 0`, which behaves like `100vh` on older mobile browsers and doesn't track a dynamic toolbar), and reserves notch/home-indicator space via `padding: env(safe-area-inset-*)` on the overlay itself so absolutely-positioned children inherit it for free. Content inside sizes to `max-width/max-height: 100%` of that padded box, never a `vw`/`vh` magic-number margin."
---

# D-123: A full-screen fixed overlay sizes itself with 100dvh + safe-area padding, not inset:0 + vw/vh

*Decided: 2026-08-20*

**Context**: Issue #575's owner clarified the priority bug as the photo
lightbox ("el visor incorporado") not adapting to the phone screen. The
lightbox (`PhotoGallery.tsx`) was `position: fixed; inset: 0` with its image
capped at `maxWidth: 90vw, maxHeight: 90vh` — two things worth fixing on
their own merits regardless of the (separate, #571/#578-owned) TopBar
overflow bug that dominates the visible symptom today: `inset: 0` is
equivalent to `top/right/bottom/left: 0`, which on older/some mobile Safari
versions does not reliably resize when the dynamic address-bar/toolbar
shows or hides — a `position: fixed` element can visibly extend under or
short of the real viewport as the toolbar animates. `90vw`/`90vh` also
carries no awareness of device safe areas (notch, home-indicator, rounded
corners), so absolutely-positioned overlay buttons (`left: 16`/`right: 16`)
can land under one on notched hardware.

**Decision**: Full-screen fixed overlays in this app use:
```
style={{
  position: "fixed",
  top: 0, left: 0, right: 0,
  height: "100dvh",             // NOT `inset: 0` / `bottom: 0`
  padding:
    "max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) " +
    "max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))",
  boxSizing: "border-box",
}}
```
Content sizes to `maxWidth: "100%", maxHeight: "100%"` of that padded box —
never an independent `vw`/`vh` value, which doesn't know about the padding
and can size content larger than the space actually available. Absolutely
positioned children (close/nav buttons) keep their existing literal
`top/right/left/bottom` offsets unchanged — CSS resolves those against the
containing block's PADDING edge, so they automatically clear the safe area
without their own styles needing to change.

**Alternatives rejected**: Leaving `inset: 0` and adding `env()` padding
only — rejected because it doesn't address the dynamic-toolbar resize gap
`100dvh` exists for; the two fixes are complementary, not substitutes for
each other. A JS `visualViewport` resize listener recomputing pixel
dimensions on every event — rejected as unnecessary complexity `100dvh` and
`env()` already solve declaratively, with no listener to leak or miss an
event from.

**Rationale**: Both `100dvh` and `env(safe-area-inset-*)` are the
standard, purpose-built CSS primitives for exactly this class of problem
(replacing `100vh` for viewport-height correctness under a dynamic mobile
toolbar; reserving notch/home-indicator space) — no custom JS measurement
needed, and both degrade to their desktop-equivalent no-op (`100dvh` ≈
`100vh` without a shrinking toolbar; `env()` resolves to `0` without a
device inset) so desktop rendering is unaffected. Verified: cross-checked
in an isolated worktree with PR #578's TopBar fix applied on top (not
merged into this branch) — with that sibling fix present, the lightbox
image correctly fits the real device viewport end to end.

**See**: issue #575, `dashboard/components/property/PhotoGallery.tsx`,
`dashboard/e2e/mobile-photo-gallery.spec.ts`. D-122 (site-wide viewport meta
tag, a related but distinct fix from the same diagnosis). #571 / PR #578
(TopBar mobile shell) owns the actual overflow bug that currently masks
this fix's full visible effect on this branch alone.
