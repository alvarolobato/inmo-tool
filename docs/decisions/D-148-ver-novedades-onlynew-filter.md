---
id: D-148
title: '"Ver novedades" button filters on the raw visit-anchored is_new, not the cold-start-suppressed badge value'
date: 2026-08-21
group: Product / candidate feed
rule: 'The onlyNew feed filter (issue #667) reuses ranked.is_new/previous_viewed_at verbatim (never a second "new" definition) and reads the RAW value, not the cold-start-suppressed badge, so the Perfiles row''s "N nuevos" count and the filtered feed''s result count agree by construction.'
---

# D-148: "Ver novedades" button filters on the raw visit-anchored is_new, not the cold-start-suppressed badge value

*Decided: 2026-08-21*

**Context**: The owner asked for a "ver novedades" button per profile row on
`/profiles` that jumps straight to that profile's candidate feed filtered to
only what's new. Two design questions had to be answered before building:
what "nuevo" means, and how to guarantee the button's implied count agrees
with what the destination actually shows — a class of bug this repo has
already hit twice (#447's "~400 nuevos advertised, 7 shown" regression, and
the D-054 digest note calling out the same risk explicitly).

This codebase already had exactly one definition of "new": #416/#447
established it as "first-seen since the profile's own last visit" —
`MIN(active-source listing.first_seen_at) > COALESCE(search_profile.
previous_viewed_at, created_at - interval '1 day')`. It is computed in
exactly two places today, both reading the same predicate: `lib/db/
profile-overview.ts`'s `new_count` (the Perfiles row's "N nuevos" metric,
and the input to `lib/novedades.ts`'s page-level strip) and `lib/
candidates.ts`'s `ranked.is_new` (the feed's NUEVO badge, via the shared
`novelty` CTE). Two rejected alternatives: the daily digest's "since the
last digest" anchor (D-054) — deliberately a DIFFERENT anchor, chosen so an
in-app glance and an out-of-band email don't have to agree on visit timing;
and a fixed 24h/7d window — tells the owner nothing about whether *he* has
seen a candidate, the exact complaint D-054's persona note is about.

A second, less obvious wrinkle: `ranked.is_new` (raw) and what the NUEVO
*badge* actually renders are NOT the same value. `listCandidates`'s cold-start
suppression (#425) zeroes the per-card `is_new` field the client receives
whenever the profile was never visited, or when raw novelty would cover more
than 60% of the matched pool — so the whole feed doesn't highlight as "new"
on a first look, where that carries no information. `new_count` never applies
this suppression (its own doc says so explicitly). So a naive "filter on
whatever the badge shows" implementation would disagree with `new_count` on
every cold-start profile — the exact drift #447 already burned the team on
once, just relocated to a second axis (badge-suppression vs. source-toggle
this time, instead of D-055's disabled-source toggle).

**Decision**:
- **"Nuevo" means "since I last viewed this specific profile"** —
  `previous_viewed_at`, not the digest anchor, not a fixed window. The
  `onlyNew` filter (`dashboard/lib/candidates.ts`) is a single new `AND`
  clause in the existing `ranked` CTE's outer WHERE:
  `AND ($26::boolean IS NOT TRUE OR ranked.is_new = true)`. `ranked.is_new`
  is read VERBATIM — no new SQL expression, no second copy of the anchor
  logic.
- **The filter reads the RAW `ranked.is_new`, not the cold-start-suppressed
  value** the mapping step applies to `CandidateRow.is_new` (what the badge
  renders). This is deliberate: `new_count` is also raw (profile-overview.ts
  never suppresses it), so filtering on the same raw predicate guarantees the
  button's count and `onlyNew=true`'s result count are equal BY
  CONSTRUCTION — extending the #447 invariant to a third read site instead of
  opening a fourth place the two numbers could silently drift apart.
  Accepted trade-off: on a cold-start profile, a card returned under
  `onlyNew=true` may not carry its own NUEVO badge (still suppressed for
  cosmetic reasons) even though it matched the filter — rare (only right
  after profile creation, or a still-mostly-fresh pool) and self-clearing
  (one visit ends cold-start for that profile).
- **The button is hidden, not disabled, not shown with "0", when
  `new_count === 0`** — same pattern this file already used for the "N con
  alertas" link (`metrics.flagged_count > 0 && (...)`). A button that opens a
  confirmed-empty list reads as broken; hiding it is honest and costs
  nothing since the row's own "N nuevos: 0" is already visible next to where
  the button would be.
- The filter is plumbed through the SAME URL-param filter machinery every
  other feed filter uses (`dashboard/lib/candidate-filters.ts`'s `onlyNew`
  boolean, param `onlyNew=true`), gets an active-filter chip ("Solo nuevos")
  in `CandidateFilterBar.tsx` so it's visibly active and clearable without
  back-navigation, and composes (AND) with every other filter, the keyset
  cursor, the below-market pool, and the alerts tri-state — it narrows the
  same `ranked` CTE's outer WHERE, never a parallel query path.

**Alternatives rejected**:
- *Anchor on the last digest send (`digest_run.sent_at`)* — would make the
  button disagree with the row's own "N nuevos" count, which is
  visit-anchored, not digest-anchored; two profile-level "new" numbers on
  the same page reading differently would be worse than the #447 bug this
  avoids.
- *A fixed 24h/7d window* — simplest, but doesn't answer "have I personally
  seen this" — the whole point of "novedades" as a mental model.
- *Filter on the cold-start-suppressed `is_new` (what the badge shows)* —
  would make the filtered feed's card count silently diverge from the row's
  `new_count` on every never-visited or mostly-fresh profile, reopening
  exactly the class of bug #447 fixed, just on a new axis.

**Rationale**: Reuses established, tested machinery at every layer (anchor
definition, SQL predicate, filter-state plumbing) rather than inventing a
parallel one, and picks the one raw/suppressed reading that keeps the
button's promised count and the destination's actual count structurally
equal — the explicit design constraint the owner's ask carried ("if you
cannot make them agree cheaply, don't show a count" — here they agree for
free, so the count is safe to show).

**See**: `dashboard/lib/candidates.ts` (`CandidateFilters.onlyNew`, the `$26`
WHERE clause), `dashboard/lib/candidate-filters.ts`, `dashboard/app/api/
profiles/[id]/candidates/route.ts`, `dashboard/components/profiles/
ProfileOverviewRow.tsx`, `dashboard/components/candidates/
CandidateFilterBar.tsx`, `dashboard/e2e/ver-novedades.spec.ts`, issue #667,
prior art #416/#425/#447, D-054, D-057, D-059.
