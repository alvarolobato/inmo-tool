---
id: D-139
title: Dedup card shows every photo (no cap) and links each side to its internal property page
date: 2026-08-20
group: Data / connectors
rule: 'Dedup ListingSidePanel renders every stored photo, matched-first, no cap (supersedes D-135 point 2). Each side also links to /profiles/[id]/properties/[propertyId] (target=_blank) when it matches an active profile.'
---

# D-139: Dedup card shows every photo (no cap) and links each side to its internal property page

*Decided: 2026-08-20*

**Context**: Issue #626, filed by the owner reviewing duplicates right
after PR #621 (D-135) shipped:

> *"te dije que en los duplicados quería poder ver todas las fotos y solo
> me muestras 4 como mucho. por otro lado no hay forma de ver la ficha
> interna del anuncio en los duplicados, solo el anuncio original."*

Two gaps, both against the SAME card D-135 just changed.

**1. The #615/D-135 "capped at 4, expandable" design was itself a
misreading.** The owner's original #615 wording — *"me muestras 4 fotos
como máximo. necesito ver el resto, o por lo menos que me muestres las
que coinciden"* — was read by the coordinating agent mid-implementation as
"4 by default is fine, PROVIDED they're the ones that matched, with an
expander for the rest," and shipped that way (D-135 point 2). Issue #626
is the owner repeating essentially the same sentence and clarifying it
was never conditional: *"te dije que ... quería poder ver todas las fotos
y solo me muestras 4 como mucho"* — he meant **there should be no cap at
all**, full stop. Deciding whether two adverts are the same flat is
exactly the task where every photo is the signal — a kitchen that matches
and a bathroom that doesn't is the whole picture, and a 4-photo default
(even matched-first) hides that bathroom behind a tap most reviews never
take.

Issue #625 (parallel, same week) measured why this had gone unnoticed on
many pairs: idealista stores only ~2.8 photos per listing (all 3,263
measured rows ≤3) against fotocasa's average of 27, so on an
idealista-heavy pair "capped at 4" and "uncapped" render identically —
the cap's effect was invisible until reviewed against a fotocasa-heavy
pair.

**2. No route from the dedup card into the app's own property page.** The
card links out to the portal advert (`Ver anuncio original`) on each side
but offers no way into `/profiles/[id]/properties/[propertyId]` — so
checking price history, AI assessments, the property's other adverts, or
the map means leaving for the portal or hunting the property down by hand
in a separate tab.

**Decision**:

1. **The photo cap is gone — `ListingSidePanel` renders every photo in
   `photos` (still matched-first, per `resolveMatchedPhotos`/
   `orderPhotosMatchedFirst`, unchanged from D-135 point 1's matching
   logic and point 2's ordering).** No `DEFAULT_VISIBLE_PHOTOS`, no
   `expanded` state, no `dedup-photos-expand` button — that testid no
   longer exists anywhere on the card. `.dedup-photo-grid`'s existing
   `max-height` + `overflow-y: auto` (globals.css, unchanged values —
   240px desktop / 320px mobile) is what keeps this usable: a
   fixed-height, internally-scrolling box regardless of photo count,
   which is what keeps the confirm/reject decision buttons reachable
   without scrolling past the gallery on a 3-photo listing exactly as on
   a 27-photo one. Nothing about that CSS mechanism changed — only the
   React side stopped truncating what it feeds into it.
2. **Both sides gain an internal link to `/profiles/[id]/properties/[propertyId]`.**
   The route 404s unless the property is a matched candidate for the
   EXACT profile id in the URL (`isPropertyMatchedForProfile`), so the
   link needs a real profile id per property, not just the pair-level
   `profile_relevant` boolean (which only says "at least one side matches
   SOME active profile," not which one, not which side).
   `listDedupPropertyPairSuggestions`'s query (`lib/dedup.ts`) gains two
   correlated-subquery columns, `lo_profile_id`/`hi_profile_id` — the
   lowest-id active (non-archived `search_profile`, `matched = true`)
   profile each property currently matches, mirroring
   `PROFILE_RELEVANT_EXISTS`'s own predicate but resolved per side.
   Surfaced as `property_lo_profile_id`/`property_hi_profile_id` on
   `DedupPropertyPairSuggestion` (nullable — `null` when that side
   matches no active profile). `internalPropertyHref(profileId,
   propertyId)` (`lib/dedup-shared.ts`) is the one place `{profileId,
   propertyId}` becomes the URL string, or `null`; `ListingSidePanel`
   renders a `data-testid="dedup-internal-link"` anchor when non-null, or
   a muted `data-testid="dedup-internal-link-unavailable"` note when
   `null` — never a link that would 404.
3. **The internal link opens in a new tab — `target="_blank"
   rel="noopener"` — as the permanent design, not an interim
   workaround.** Direct owner decision, given verbatim after this issue
   was filed: *"ábrelo en otra pestaña y es más fácil."* This also
   settles the issue's own open question about queue position: the
   `/admin/dedup` review queue (`PropertyPairQueue`) keeps its loaded
   items/filters entirely in client-side React `useState`, with no
   `sessionStorage`/URL persistence — the same unsolved shape as #595's
   candidate-feed problem. A same-tab navigation into the property page
   and back would fully reset that state (empty list, filters cleared,
   scroll at the top) — a strictly worse version of #595's bug, since
   this queue has no pagination URL at all to even partially recover
   from. Opening in a new tab sidesteps the problem entirely rather than
   solving it: the `/admin/dedup` tab is never unmounted, so there is no
   state to lose. The owner's own framing was also that this is the
   better INTERACTION, not merely the cheaper fix — comparing two
   properties works better with the detail page open NEXT TO the card
   than instead of it. #595 remains open, scoped to the candidate feed,
   untouched by this decision.
4. **Distinct label from the portal link, never relying on an icon
   alone.** Both links can render side by side on the same panel now
   (`Ver anuncio original ↗` for the portal, `Ver ficha interna
   (inmo-tool) ↗` for the internal page) — the wording is the only thing
   distinguishing which page a tap leads to, since both already carry the
   same `↗` glyph.

**Alternatives rejected**:
- *Keep a cap, just raise the number (e.g. 8 or 12)*: rejected — any
  fixed cap re-creates the exact bug this issue reports on a large enough
  gallery (fotocasa averages 27), and the owner's own words ("todas las
  fotos") name an uncapped view, not a bigger one.
- *Build session/URL-based queue-position preservation for the internal
  link (the #595-style fix)*: rejected for this PR — explicitly declined
  by the owner (see point 3) as unnecessary once the link opens in a new
  tab; would also have meant partially solving #595 inside an unrelated
  issue rather than as its own piece of work.
- *Same-tab navigation with a "back to queue" affordance*: rejected —
  still loses the in-flight filter/scroll state on return (no mechanism
  exists to restore it), and is a worse interaction for the actual task
  (comparing two properties side by side) than a new tab.

**Rationale**: The owner asked for the same thing twice in the same week
because the first fix under-corrected — a cap that hides evidence is the
bug regardless of how the default 4 photos are chosen. Removing it
outright, while keeping the matched-first ordering and the existing
bounded-height scroll container, delivers "see everything" without
reintroducing the "card pushes the buttons off screen" failure mode the
cap was originally invented to prevent. The internal link closes a
second, independent gap in the same review workflow: the investor
currently has no way to pull up a property's full context without
leaving the queue by hand.

**See**: issue #626, issue #615 (parent of D-135), issue #625 (idealista
photo-count measurement that hid the cap's real-world effect), issue #595
(the still-open, unrelated candidate-feed queue-position problem),
[D-135](D-135-dedup-card-photos-and-advert-counts.md) (this decision's
point 2, on the cap/ordering mechanic, and point 4, on advert counts —
unchanged and still binding), `dashboard/components/dedup/ListingSidePanel.tsx`,
`dashboard/components/dedup/PropertyPairCard.tsx`,
`dashboard/lib/dedup-shared.ts` (`internalPropertyHref`,
`DedupPropertyPairSuggestion.property_lo_profile_id`/`property_hi_profile_id`),
`dashboard/lib/dedup.ts` (`lo_profile_id`/`hi_profile_id` subqueries),
`dashboard/app/globals.css` (`.dedup-photo-grid`, values unchanged),
`dashboard/e2e/mobile-dedup.spec.ts`, `dashboard/e2e/dedup-review.spec.ts`,
`dashboard/lib/__tests__/dedup.integration.test.ts`.
