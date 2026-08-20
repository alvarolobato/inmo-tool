---
id: D-129
title: "--pad-x horizontal-padding token: define it at :root unconditionally, apply it at every shared horizontal-padding layer, never per page"
date: 2026-08-20
group: UI / frontend
rule: "Horizontal-only phone-width padding shrink goes through one token, `--pad-x`. It MUST be declared unconditionally on a bare `:root { --pad-x: var(--pad); }` rule (so it resolves correctly at every width, not just inside a phone `@media` block) before any narrower selector overrides it under `@media (max-width: 767px)`. Every layer that already spends `var(--pad)`/a flat literal on left/right padding across more than one page — `.main-content`, `AdminChrome.tsx`'s content div, `.dedup-page`, the repeated per-route `<main style={{padding:24}}>` shell — reads `--pad-x` for its horizontal sides; fixing only one such layer while leaving siblings on the old value is not a fix, it's a partial one that reads as \"still too much margin\" to the person who reported it. Never trim an individual nested card's own padding as a substitute for fixing the shared layer it sits inside."
---

# D-129: `--pad-x` horizontal-padding token — define unconditionally, apply at every shared layer

*Decided: 2026-08-20*

**Context**: Issue #596 (PR #599) shrank `.main-content`'s horizontal
padding below 768px via a new `--pad-x` custom property, declared only
inside `@media (max-width: 767px)`. Opus review of that PR (S1–S3) found
three problems with that first cut:

1. **`.main-content` is not the dominant horizontal-padding layer on the
   page the owner actually screenshotted.** Measured live at 390px, the
   `/captura` stack is `main-content (12) + captura-page's own inline
   `padding: 24` + ConnectorSection's card + the task row's own card` — the
   fixed layer contributed the SMALLEST share. Two more shared layers
   (`AdminChrome.tsx`'s content div, wrapping every `/admin/*` AND `/etl/*`
   page; `.dedup-page`) were left on the unshrunk `var(--pad)` value, and a
   THIRD shared shape — eight routes' own `<main style={{ padding: 24,
   maxWidth: NNN }}>` wrapper (`app/captura/page.tsx`, `app/etl/
   connectors/page.tsx`, `app/etl/captura/page.tsx`, `app/profiles/[id]/
   filtros/page.tsx`, `app/profiles/[id]/map/page.tsx` ×2, `app/profiles/
   [id]/properties/[propertyId]/page.tsx` ×2) — wasn't touched at all.
   Fixing one layer in isolation recovered only ~11% of the horizontal
   chrome on the screenshotted page (8 of 74px) — not enough to actually
   resolve a complaint the owner had already repeated once.
2. **The token itself was only defined inside the phone media query**, so
   `var(--pad-x)` was unresolved at desktop width; every call site papered
   over that with a fallback (`var(--pad-x, 12px)`) that happened to be the
   *phone* number. A future component copying that idiom outside its own
   `@media` guard would silently render at 12px on desktop — wrong, and not
   caught by any type-checker or build step, only by an e2e spec that isn't
   wired into CI.
3. **The reviewer, independently probing the same PR, needed the general
   shape of the fix explained in one place** rather than re-deriving it
   from four separate diff hunks — the token's contract (default value,
   who reads it, when it changes) is exactly what a decision record is for,
   not a comment repeated at each call site.

**Decision**:

1. **`--pad-x` is declared unconditionally first**: a bare `:root { --pad-x:
   var(--pad); }` rule (specificity 0,1,0, no attribute selector) runs
   before any density- or breakpoint-scoped override. Because `var()`
   resolves lazily against the already-cascaded value of `--pad` on the
   same element, this correctly picks up whichever density's `--pad` value
   is active (20/14/28 comfort/compact/spacious) — desktop is
   pixel-identical to using `--pad` directly, by construction, with no
   fallback needed at any call site for desktop correctness.
2. **`@media (max-width: 767px)` then narrows `--pad-x` per density**
   (10/12/16 — compressed but keeping each density's original ordering:
   compact < comfort < spacious), exactly mirroring how `--pad`/`--gap`/
   `--kpi-pad` already vary by density in this file.
3. **Every shared horizontal-padding layer reads `--pad-x` for left/right,
   `--pad` (or its own literal) for top/bottom** — never the other way
   around, and never a per-page override applied to only one instance of a
   repeated pattern:
   - `.main-content` (global app shell, every page)
   - `.admin-chrome-content` (`AdminChrome.tsx`'s content div — every
     `/admin/*` and `/etl/*` page, since both route groups share this one
     layout component)
   - `.dedup-page` (kept the two-value shorthand for symmetry even though
     its own phone override already zeroes it — see the class's comment)
   - `.route-shell` (the repeated `<main style={{ padding: 24, maxWidth:
     NNN }}>` shape — `maxWidth`/`margin` stay inline per page since those
     genuinely differ; only the shared `padding: 24` moved to this class)
4. **A component/page-specific padding value that ISN'T one of the shared
   layers above** (a single nested card, e.g. the captura task row's own
   `12px 14px`) is not a `--pad-x` consumer — trimming those individually
   is exactly the anti-pattern #572/#576 already rejected once (a per-card
   trim doesn't survive the next card that adds its own padding on top).
   `--pad-x` exists so the shared layers do the work once.

**Alternatives rejected**:
- Keeping `--pad-x` phone-only-defined and requiring every call site to
  carry a correct fallback (`var(--pad-x, 20px)` at desktop-safe layers,
  `var(--pad-x, 12px)` would be wrong there) — rejected because it requires
  every future author to know and copy the *correct* fallback per layer,
  which is exactly the silent-defeat failure mode D-121 already warned
  about for a different mechanism (inline `var()` fallbacks). A single
  unconditional default removes the need to get any fallback right at all.
- Fixing `.main-content` only and treating the remaining layers as
  follow-up work — rejected because the measured numbers show
  `.main-content` was the smallest contributor on the exact page the owner
  complained about; shipping only that layer does not resolve "sigue
  habiendo demasiados márgenes" (still too much margin) in any way he
  could actually perceive.

**Rationale**: a horizontal-padding token that's correct only inside its
own media query is a trap for the next person who reads it — this makes it
correct everywhere by construction, and lists every layer it must be wired
into so the token doesn't quietly become "the `.main-content` one" while
three siblings keep the old, larger value.

**See**: `dashboard/app/globals.css` (`:root { --pad-x: var(--pad); }` and
its four consumer classes), `dashboard/app/admin/AdminChrome.tsx`, the
eight `.route-shell` call sites, issue #596, PR #599 (Opus review, S1–S3),
D-121 (the general inline-style-to-class ladder this token's *consumers*
still follow — this record is specifically about the token's own
declaration contract, which D-121 doesn't cover).
