---
id: D-121
title: Phone-width divergence in an inline-styled component threads through CSS custom properties, never duplicated markup or a competing class
date: 2026-08-19
group: UI / frontend
rule: "When an inline-styled dashboard component needs a value to differ only below 768px, define it as a `:root` custom property (default = the existing desktop literal) flipped under `@media (max-width: 767px)` in globals.css, and read it via `var(--x, same literal)` inside the inline `style` prop — never duplicate the element behind a Tailwind `hidden md:flex` toggle, and never fight inline-style specificity with a plain CSS class."
---

# D-121: phone-width divergence in an inline-styled component threads through CSS custom properties, never duplicated markup or a competing class

*Decided: 2026-08-19*

**Context**: Issue #572 fixed the `/profiles` card at 390px — `ProfileOverviewRow.tsx`
and `app/profiles/page.tsx` style everything with inline `style` objects, and a
few values (Entrar's tap-target padding/min-height, the page's padding stack)
genuinely needed to differ below 768px while staying **pixel-identical** at
desktop width. Two mechanisms were considered and rejected:

1. **Duplicate the element behind a Tailwind `hidden md:flex` / `md:hidden`
   toggle** (one desktop copy, one mobile copy). Rejected: both copies would
   carry `data-testid="profile-enter-button"`, and `getByTestId` in Playwright
   throws in strict mode on multiple matches — this is a real single-DOM-node
   assumption several existing specs (`profiles.spec.ts`,
   `profiles-kebab-menu.spec.ts`) already depend on.
2. **A plain CSS class + `@media` rule setting the same property** (e.g.
   `.entrar-mobile { padding: ...; }`). Rejected: an inline `style` value
   always wins specificity over a class for the same property, so the media
   query would silently do nothing unless forced with `!important` — fragile,
   and easy to defeat with a later inline-style edit that nobody notices broke
   the responsive rule.

A sibling in-flight PR (#576, `/admin/dedup`'s mobile layout) hit the identical
problem independently and reached for option 2 with `!important` overrides
(`docs/decisions` was not yet updated when this was written) — confirming this
is a recurring shape, not a one-off, in a codebase whose dashboard components
are inline-style-first by convention.

**Decision**: The sanctioned mechanism for "this inline-styled value must
differ below 768px, desktop must be byte-identical" is a CSS custom property:

```css
:root {
  --profile-enter-pad: 7px 14px; /* today's exact desktop literal */
}
@media (max-width: 767px) {
  :root {
    --profile-enter-pad: 13px 18px;
  }
}
```
```tsx
style={{ padding: "var(--profile-enter-pad, 7px 14px)" }}
```

The value assigned to the inline `style` prop is still literally an inline
style — this only changes what a `var()` reference inside it resolves to — so
there is no specificity fight, and the desktop branch is guaranteed to render
the exact pixel value it always did (the `:root` default IS that literal,
duplicated only as the `var()` fallback for defense-in-depth). No markup is
duplicated, so every existing single-node e2e assumption holds unchanged.

Tailwind's `hidden`/`md:flex`/`md:hidden` utilities remain reserved for actual
display/visibility toggling (an element that should not exist in the DOM at
all at one breakpoint) — never for a value that should exist everywhere but
differ.

**Alternatives rejected**: duplicated markup behind a Tailwind display toggle
(breaks `data-testid` singularity in e2e); a plain CSS class fighting inline
style with `!important` (fragile, silently defeated by future inline edits,
and the approach #576 took before this record existed).

**Rationale**: Custom properties are the one mechanism that changes *what an
inline style resolves to* without touching *how* it's applied — the only way
to get genuine breakpoint divergence on a value that must otherwise be
pixel-identical, in a codebase where inline styles are the deliberate,
already-documented convention (see `AGENTS.md`'s note on this component: inline
style beats Tailwind for the same property).

**See**: `dashboard/app/globals.css` (the `#572` block), `dashboard/components/profiles/ProfileOverviewRow.tsx`, `dashboard/app/profiles/page.tsx`, `dashboard/e2e/mobile-profiles.spec.ts`, issue #572, issue #576 (sibling problem, different PR).
