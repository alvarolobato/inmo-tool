---
id: D-121
title: "flex-basis triggers a real wrap; grid-column-count and redundant per-page padding are mobile-only CSS overrides, not inline"
date: 2026-08-20
group: Frontend / UI
rule: "`flexWrap: 'wrap'` on children with `flex: 1` (basis 0%) never wraps — give the wrapping children a real non-zero `flexBasis` instead. Layout that must differ ONLY below the mobile breakpoint (grid column count, a page's own redundant padding) goes in a `@media (max-width: 767px)` CSS-class override in `globals.css`, never an inline style, since inline styles apply unconditionally and would also change the ≥768px look this project requires to stay pixel-identical."
---

# D-121: flex-basis triggers a real wrap; grid-column-count and redundant per-page padding are mobile-only CSS overrides, not inline

*Decided: 2026-08-20*

**Context**: Issue #576 — `/admin/dedup`'s two-listing comparison
(`SuggestionCard.tsx`) was unusable at phone width. The comparison row was
`display: flex; flexWrap: "wrap"`, which looked like it should stack on a
narrow screen, but each `ListingSidePanel` was `flex: 1` — shorthand for
`flex: 1 1 0%`, i.e. flex-basis **0**. A flex-wrap decision is made against
each item's hypothetical (basis) size, not its post-grow size; with basis 0
both panels always "fit" on one line by shrinking instead of ever wrapping,
so at 390px the two panels rendered side-by-side at ~140px each, and the
`repeat(4, 1fr)` photo grid inside produced ~32px thumbnails. Nothing
overflowed and nothing errored — it silently degraded, which is why it
survived unnoticed.

Fixing the wrap (`flex: "1 1 280px"`) exposed a second, unrelated
pre-existing bug while measuring against a phone viewport: `AdminChrome`
(`app/admin/AdminChrome.tsx`, shared by every `/admin/*` page) already wraps
page content in its own `padding: var(--pad)`, and `app/admin/dedup/page.tsx`
applied a second, redundant `padding: var(--pad)` of its own — together
costing 40px of width per side that isn't visible as a problem on desktop
(just extra margin) but was directly shrinking the comparison panels on a
390px phone (measured 244px vs. a 284px panel once the page's own duplicate
padding was zeroed).

**Decision**:
1. **A flex item that must wrap needs a real basis.** Never rely on `flex: 1`
   (basis 0%) plus a parent `flexWrap: "wrap"` to produce a stack at narrow
   widths — pick a `flexBasis` (or shorthand `flex: "<grow> <shrink>
   <basis>px"`) close to the item's natural minimum width instead. When two
   (or more) siblings share the same basis and grow factor, the resolved
   width above the wrap threshold is provably identical to the basis-0 case
   (both converge to an equal split of the remaining space) — so this is
   safe to apply even under a hard "desktop must stay pixel-identical"
   constraint; verify a container width straddling the target breakpoint has
   comfortable slack over the summed bases, not just that it happens to fit
   today.
2. **Width-dependent CSS that must NOT apply above the mobile breakpoint**
   (grid `template-columns`, a redundant padding layer, forcing an element
   onto its own flex line via `flex-basis: 100%`) goes in a
   `@media (max-width: 767px)` block in `globals.css`, targeting a
   `className` added to the element — never as an unconditional inline
   style, which this codebase's own convention (inline styles beat Tailwind
   for the same property) would otherwise make the natural first reach, and
   which has no width-conditional form. 767px matches Tailwind's `md:`
   (768px) default, which the mobile shell PR (#571) independently landed as
   this app's breakpoint convention — use the same threshold for any future
   width-conditional CSS in this app rather than picking a new number.
3. **A page-level "double padding" is a real, fixable bug when the
   duplicating file is in scope** — not just a cosmetic nit to route around.
   Here `app/admin/dedup/page.tsx` was explicitly an authorized touchpoint
   for #576, so its own redundant padding was zeroed (mobile-only, via the
   same override mechanism) rather than left in place or "fixed" by shrinking
   something else (e.g. the card's own padding) to compensate. The shared
   `AdminChrome.tsx` wrapper that also contributes padding was left
   untouched — it's used by every `/admin/*` page, not just this one, and
   was out of scope for this issue.

**Alternatives rejected**:
- *CSS `grid-template-columns: repeat(auto-fit, minmax(Npx, 1fr))` to make
  the photo grid column count fall out of available width automatically,
  with no breakpoint at all.* Rejected — with only 4 grid items and no
  explicit column count, whether an `auto-fit` track collapses depends on
  spec details (empty-track collapsing interacting with `1fr` distribution)
  that are easy to get subtly wrong, and this PR's desktop-pixel-identical
  constraint left no room for an unverified edge case.
- *Zeroing `AdminChrome.tsx`'s own padding instead of this page's.* Rejected
  — `AdminChrome` is shared by every admin page, not just `/admin/dedup`,
  and editing it was out of this issue's stated scope (`Repo touchpoints`
  named `SuggestionCard`/`ListingSidePanel` + the dedup page + its e2e spec
  only).

**Rationale**: Same shape as D-120's inline-style/Tailwind interaction bug —
a codebase convention (inline styles for design-token-driven properties) is
correct in general but has a specific failure mode (no width-conditional
form) that's cheap to name once so the next mobile-aware screen in this batch
(#572, #574, #575) doesn't rediscover it independently, and the flex-basis-0
wrap trap is explicitly called out in #576 itself as a "root cause pattern to
remember repo-wide."

**See**: issue #576, `dashboard/components/dedup/SuggestionCard.tsx`,
`dashboard/app/admin/dedup/page.tsx`, `dashboard/app/globals.css`,
`dashboard/e2e/mobile-dedup.spec.ts`. Issue #571 / its PR #578 independently
record a sibling decision pinning the same 768px breakpoint for the mobile
shell — not yet merged as of this writing, so not linked by filename here to
avoid a dangling cross-reference; reconcile/cross-link once it lands.
