---
id: D-124
title: "flexWrap + flex:1 (basis 0%) never wraps — minWidth:0 makes it fully inert, not just less likely"
date: 2026-08-20
group: Frontend / UI
rule: "Never rely on `flexWrap: \"wrap\"` plus children at `flex: 1` (flex-basis 0%) to produce a stack at narrow widths — flexbox collects items into lines using each item's hypothetical (basis) size, computed BEFORE any grow/shrink, so basis-0 siblings always \"fit\" on one line by shrinking instead of ever wrapping. If those same children also carry `minWidth: 0`, the wrap is not just unlikely, it is fully inert: without it, a flex item's default `min-width: auto` resolves to its min-content size and the row would still wrap once min-content sizes stopped fitting. Give a child that must wrap a real non-zero `flexBasis` instead."
---

# D-124: flexWrap + flex:1 (basis 0%) never wraps — minWidth:0 makes it fully inert, not just less likely

*Decided: 2026-08-20*

**Context**: Issue #576 — `/admin/dedup`'s two-listing comparison
(`SuggestionCard.tsx`) was unusable at phone width. The comparison row was
`display: flex; flexWrap: "wrap"`, which looked like it should stack on a
narrow screen, but each `ListingSidePanel` was `flex: 1` — shorthand for
`flex: 1 1 0%`, i.e. flex-basis **0** — and also carried `minWidth: 0` (set
originally so the panel's own text children could ellipsis-truncate instead
of forcing the row wider). At 390px the two panels rendered side-by-side at
~140px each, and the `repeat(4, 1fr)` photo grid inside produced ~32px
thumbnails. Nothing overflowed and nothing errored — it silently degraded.

A flex-wrap decision is made against each item's *hypothetical* main size
(clamped by its `min-width`/`max-width`), computed before flex-grow/shrink
are resolved — not against its final, post-grow rendered size. With
`flexBasis: 0` and no `minWidth` override, an item's hypothetical size would
still be its min-content size (browsers clamp the effective minimum to
`min-content` under automatic sizing even when the specified basis is 0),
which for a panel full of images and text is nowhere near 0 — the row would
likely still wrap once enough min-content sizes stacked up past the
container width. It was specifically the *combination* with `minWidth: 0`
that removed that floor and made the wrap decision see a hypothetical size
of 0 for every panel, so two (or more) panels always "fit" on one line no
matter how narrow the container — reproduced directly in review: reverting
only `flex: "1 1 280px"` back to `flex: 1` (leaving `minWidth: 0` in place)
was enough on its own to break the wrap and fail the mobile e2e spec with
real geometry numbers (panel width 415.5 vs an expected >586 combined row
width, confirm/reject tap target 33.5 vs the required 44).

**Decision**: A flex item that must wrap at some container width needs a
real `flexBasis` close to its natural minimum width — never `flex: 1` (or
any basis-0 shorthand) relying on `flexWrap: "wrap"` alone, and never in
combination with `minWidth: 0` without also setting a real basis, since that
specific combination is what makes the wrap fully inert rather than merely
narrower-than-ideal. When two (or more) siblings share the same basis and
grow factor, the resolved width **above** the wrap threshold is provably
identical to the old basis-0 behaviour (both converge to an equal split of
the remaining space) — this is safe to apply even under a hard
"desktop-must-stay-pixel-identical" constraint; verify a container width at
the target breakpoint boundary has comfortable slack over the summed bases,
not just that it happens to fit today.

This record is narrower than an earlier draft (superseded before merge) that
also covered *where* mobile-only CSS overrides for values like grid column
count and per-page padding should live — that convention landed first as its
own decision from the sibling `/profiles` mobile PR (#580) and is not
duplicated here; this record covers only the flex-wrap mechanism itself.

Two more padding layers stack around `/admin/dedup` below 768px besides the
one #576 removed (the page's own redundant `padding: var(--pad)`, on top of
`AdminChrome`'s identical padding): the global app shell's
`main.main-content` padding, and `AdminChrome`'s own content-div padding —
both shared by every page (`main.main-content`) or every `/admin/*` page
(`AdminChrome`, e.g. `/admin/llm` has the identical stack), and both
correctly out of #576's scope. Noted here as a real, not-yet-filed follow-up
rather than silently dropped.

**Alternatives rejected**: `grid-template-columns:
repeat(auto-fit, minmax(Npx, 1fr))` to make the photo grid's column count
fall out of available width with no breakpoint at all — rejected because
with only 4 grid items and no explicit column count, whether an `auto-fit`
track collapses depends on spec details (empty-track collapsing interacting
with `1fr` distribution) that are easy to get subtly wrong, and the
desktop-pixel-identical constraint left no room for an unverified edge case.

**Rationale**: The flex-basis-0-defeats-wrap trap is explicitly called out
in issue #576 itself as a "root cause pattern to remember repo-wide," and
the `minWidth: 0` interaction specifically is easy to miss on a second read
(it looks like an unrelated truncation fix, not part of the wrap bug) —
worth naming precisely, with the reviewer's own stricter reproduction as
evidence, so the next mobile-aware screen in this batch (#572, #574, #575)
recognizes the exact shape rather than just "flex wrap sometimes doesn't
work."

**See**: issue #576, `dashboard/components/dedup/SuggestionCard.tsx`,
`dashboard/app/admin/dedup/page.tsx`, `dashboard/app/globals.css`,
`dashboard/e2e/mobile-dedup.spec.ts`. Issue #572 / its PR #580 records the
sibling decision for where a mobile-only value divergence should live in an
inline-styled component — not yet merged as of this writing, so not linked
by filename here to avoid a dangling cross-reference; reconcile/cross-link
once it lands.
