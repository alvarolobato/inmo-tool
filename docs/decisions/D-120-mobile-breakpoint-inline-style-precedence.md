---
id: D-120
title: Mobile breakpoint is Tailwind md (768px); Tailwind owns display/visibility only, inline styles own every other property
date: 2026-08-20
group: Frontend / UI
rule: Mobile breakpoint is Tailwind's default `md:` (768px). On components mixing inline styles with Tailwind, use Tailwind ONLY for `hidden`/`md:*` display toggling — never set `display` inline on an element that also carries a responsive display class, or the inline style wins and silently defeats the breakpoint. Other inline properties (color, fontSize) are fine — the collision is per-property.
---

# D-120: Mobile breakpoint is Tailwind md (768px); Tailwind owns display/visibility only, inline styles own every other property

*Decided: 2026-08-20*

**Context**: Issue #571 — the dashboard shell (`TopBar.tsx`) overflowed the
390px mobile viewport by a measured +264px on every route, because the header
was a single non-wrapping flex row with no width-based media query anywhere
in the app (`app/globals.css` had only print/hover/pointer/motion queries).
This PR introduces the app's first width breakpoint, so it is worth pinning
the convention rather than letting each future mobile-aware screen (#572
candidate feed, #574 property detail, ...) invent its own.

While building the hamburger menu, the button itself briefly regressed:
its inline style object set `display: "flex"` (to center the icon), on the
*same* element that carried Tailwind's `md:hidden` class (to hide it on
desktop). The inline `display` won — a plain CSS specificity fact, not a
Next.js/Tailwind quirk — so the hamburger stayed visible at 1280px wide even
though the class list looked correct. It was only caught because the
`freshness-indicator.spec.ts`-style desktop assertion in the new e2e spec
failed; a purely visual review at mobile width would have missed it since the
button also renders correctly there.

**Decision**:
1. **Breakpoint**: use Tailwind's unmodified default `md:` (`min-width: 768px`)
   as the mobile/desktop split for this app. No `tailwind.config.ts` `screens`
   override — introducing one now would silently reflow every other
   `sm:`/`md:`/`lg:` utility already in use (e.g. `app/etl/page.tsx`'s
   `sm:grid-cols-4`).
2. **On a component that mixes inline styles with Tailwind classes** (the
   established pattern in this codebase — inline styles win over Tailwind for
   the same CSS property, so Tailwind is normally reserved for things inline
   styles don't easily express): Tailwind's responsive display utilities
   (`hidden`, `md:inline`, `md:flex`, `md:hidden`, ...) are the ONLY
   Tailwind usage allowed for toggling an element across the breakpoint, and
   the element they're applied to must never also set `display` inline. If an
   element needs both a responsive display toggle AND inline flex/grid
   centering, put the toggle class on the outer element and the inline
   `display: flex` on an inner wrapper that carries no responsive class (see
   `TopBar.tsx`'s hamburger button: the class lives on the `<button>`, the
   centering `display: flex` lives on a child `<span>`).
3. **Verification for mobile-affecting changes**: assert the real rendered
   viewport, never the emulated `window.innerWidth` (Chromium device
   emulation reports the zoom-level layout viewport there — 653 on an
   iPhone-13-emulated 390px page — which hides genuine overflow). Use
   `document.documentElement.clientWidth` / `scrollWidth`, as
   `e2e/mobile-topbar.spec.ts` does.

**Alternatives rejected**:
- *A custom breakpoint value (e.g. 480px or a dedicated `mobile:` alias).*
  Rejected — no evidence any screen needs a split other than
  phone-vs-everything-else, and a nonstandard value would need to be
  remembered project-wide instead of falling out of Tailwind's defaults.
- *Moving the whole component off inline styles to Tailwind.* Out of scope
  for a shipping mobile-hotfix PR, and the codebase's existing convention
  (inline styles for design-token-driven properties, Tailwind for what it's
  uniquely good at) is unaffected by this bug — the bug was a misuse of that
  convention, not a flaw in it.

**Rationale**: The failure mode (inline `display` silently beating a Tailwind
visibility class) is easy to reintroduce by habit, since most of this
component's other inline style objects also set `display` for unrelated
layout reasons (flex centering, etc.). Naming the rule explicitly, with the
concrete fix shown, is cheaper than re-discovering it once per future mobile
screen — and cheap enough that a one-paragraph rule + example fully prevents
the recurrence class.

**See**: issue #571, `dashboard/components/TopBar.tsx`,
`dashboard/e2e/mobile-topbar.spec.ts`.
