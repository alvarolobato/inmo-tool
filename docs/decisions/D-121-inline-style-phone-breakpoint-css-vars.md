---
id: D-121
title: Phone-width divergence in an inline-styled component — move static values to a class; reach for a CSS var only when the value depends on props/state
date: 2026-08-19
group: UI / frontend
rule: "When an inline-styled dashboard component needs a value to differ only below 768px: if the value is a static literal (no prop/state dependency), delete it from the inline style object and let a component class own it (base rule + `@media (max-width: 767px)` override in globals.css) — this project's tokens (`--pad`, `--gap`, `--kpi-pad`, `--accent`) already prove classes can hold breakpoint-varying values with zero specificity fight against an inline style that no longer declares the property. Only when the inline declaration must stay (its value is computed from props/state) does it become a `:root` custom property, default = the desktop literal, flipped under the same media query, read via `var(--x, same literal)` inside the inline `style` prop — the escape hatch, not the default: unlike a class rule, a `var()` reference is silently defeatable by a later inline edit that types the desktop literal back in (a natural, correct-looking change that matches desktop exactly), and nothing fails except a visual regression only `mobile-profiles.spec.ts` would catch — and that spec doesn't run in CI. Never `!important`, and never duplicate the element behind a Tailwind `hidden md:flex` toggle."
---

# D-121: phone-width divergence in an inline-styled component — move static values to a class; reach for a CSS var only when the value depends on props/state

*Decided: 2026-08-19, revised 2026-08-20 (review of PR #580 caught a factual
error in the original text — see Correction below)*

**Context**: Issue #572 fixed the `/profiles` card at 390px —
`ProfileOverviewRow.tsx` and `app/profiles/page.tsx` style everything with
inline `style` objects, and a few values (Entrar's tap-target padding/
min-height, the page's padding stack) genuinely needed to differ below 768px
while staying **pixel-identical** at desktop width. A sibling in-flight PR
(#576, `/admin/dedup`'s mobile layout) hit the identical shape independently —
confirming this is a recurring problem, not a one-off, in a codebase whose
dashboard components are inline-style-first by convention.

**Correction (2026-08-20)**: the original version of this record claimed a
plain CSS class + `@media` override would be "silently defeated without
`!important`" and was "fragile" for that reason, and characterised #576's
`!important`-based approach as "more fragile" on that basis. **That is
factually wrong.** A stylesheet declaration marked `!important` *beats* a
non-`!important` inline style — a later inline-style edit cannot silently
defeat it; the two rejections were conflated ("a plain class loses to
inline" is true; "class + `!important` is fragile against inline edits" is
not). Both this record and #576's original review argued a plain class can't
win *only if the inline declaration stays at all* — neither considered
deleting the inline declaration and letting the class own the property
outright, which needs no `!important` and has no specificity fight to lose.
Every value actually in dispute here (`padding`, `display`, `min-height`,
`width`) is a static literal per breakpoint — none derived from a prop or
piece of state — so that option was always available. This revision replaces
the false claim with the corrected ladder below; PR #580 was updated to move
its six previously-`:root`-scoped values onto a component class accordingly
(see that PR's diff — none of them needed to stay a CSS var once this was
understood).

**Decision — the ladder**: pick the first rung that applies.

1. **The value is a static literal (no prop/state dependency).** Delete it
   from the inline `style` object; let the component's class own it, with a
   `@media (max-width: 767px)` override in `globals.css`. No specificity
   fight exists to have — the inline style simply no longer declares that
   property, so there's nothing for the class to lose to. This project
   already proves the pattern works at scale: `--pad`, `--gap`, `--kpi-pad`
   and `--accent` (`globals.css`) are exactly this — breakpoint/theme-varying
   values consumed by classes, never fought over with an inline declaration.
   **This is the default. Prefer it.**

2. **The inline declaration must stay** (its value is computed from a prop
   or piece of component state, so it can't simply move to a static class
   rule). Use a CSS custom property: defined in `:root` (default = the exact
   desktop literal) and flipped under `@media (max-width: 767px)`, read via
   `var(--x, same literal)` inside the inline `style` prop. The value
   assigned to `style` is still literally an inline style — only what the
   `var()` reference resolves to changes — so there's still no specificity
   fight, and the fallback duplicates the desktop literal for defense in
   depth.

   **This is an escape hatch, not the default, and it has a real cost a
   class rule does not**: a `var()` reference is silently defeatable. A
   future edit that writes `padding: "7px 14px"` in place of
   `padding: "var(--profile-enter-pad, 7px 14px)"` is a natural, plausible,
   *correct-looking* change — it matches the desktop value exactly and
   compiles clean — and it silently kills the mobile behavior with nothing
   failing: not the type-checker, not `next build`, not `npm test`. Only
   `dashboard/e2e/mobile-profiles.spec.ts` would catch it, and per this
   repo's e2e status that spec is not wired into CI. Rung 1 has no
   equivalent failure mode: there's no inline declaration left to
   accidentally reintroduce.

3. **`!important` is never the mechanism for breakpoint divergence.** If a
   class-based override needs `!important` to beat an inline style, that's a
   sign the property should have moved off the inline style entirely (rung
   1), not a sign to reach for `!important`.

Tailwind's `hidden`/`md:flex`/`md:hidden` utilities remain reserved for actual
display/visibility toggling — an element that should not exist in the DOM at
one breakpoint — never for a value that should exist everywhere but differ.
Duplicating an element behind such a toggle was considered and rejected here
independent of the class-vs-var question: two `data-testid="profile-enter-
button"` nodes break `getByTestId`'s single-match assumption in existing e2e
specs (`profiles.spec.ts`, `profiles-kebab-menu.spec.ts`).

**A specificity note for whoever's `var()` reference survives rung 1**:
`@media (max-width: 767px) { :root { --x: ...; } }` compiles to specificity
(0,1,0). `:root[data-theme="light"]` and `:root[data-density="compact"]`
(`globals.css`) are (0,2,0) and are declared *earlier* in the file — they
don't redeclare any of this component's tokens today, so there's no live
collision, but the day one does, the mobile media query loses silently
(later-but-lower-specificity always loses, not "last rule wins"). Anyone
adding a `var()` token that a `[data-theme]`/`[data-density]` block might
also want to set should check this file for a collision before assuming the
media query wins.

**Alternatives rejected**: duplicated markup behind a Tailwind display toggle
(breaks `data-testid` singularity in e2e, independent of the class-vs-var
question above); `!important` as the general mechanism (rung 3).

**Rationale**: most of this component's phone-vs-desktop divergence is a
static literal with no reason to stay inline at all — the class-based rung is
strictly safer (no defeatable escape hatch, no CI-blind-spot risk) and is
already this project's proven pattern for exactly this shape of value
(`--pad`/`--gap`/`--kpi-pad`/`--accent`). The CSS-var rung stays documented
for the genuine case rung 1 can't cover — a value driven by a prop or piece of
state — where deleting the inline declaration isn't an option because the
value isn't static.

**See**: `dashboard/app/globals.css`, `dashboard/components/profiles/ProfileOverviewRow.tsx`, `dashboard/app/profiles/page.tsx`, `dashboard/e2e/mobile-profiles.spec.ts`, issue #572, issue #576 (sibling problem, PR #579 — takes its own ID for its flex-basis rule and drops its CSS half in favor of this record), PR #580 review (caught the `!important` error corrected above).
