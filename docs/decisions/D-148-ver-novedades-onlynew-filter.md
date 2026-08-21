---
id: D-148
title: '"Ver novedades" freezes its visit anchor and excludes rejected candidates so the promised count and the feed agree'
date: 2026-08-21
group: Product / candidate feed
rule: 'The onlyNew filter (issue #667) freezes previous_viewed_at into the link as newSince (never re-derives it live) and lib/db/profile-overview.ts''s new_count excludes rejected candidates — both required for the "Ver novedades" button''s promised count to equal what the destination feed shows.'
---

# D-148: "Ver novedades" freezes its visit anchor and excludes rejected candidates so the promised count and the feed agree

*Decided: 2026-08-21, revised same day after opus review of PR #668*

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
previous_viewed_at, created_at - interval '1 day')`. It is computed in two
places: `lib/db/profile-overview.ts`'s `new_count` (the Perfiles row's "N
nuevos" metric) and `lib/candidates.ts`'s `ranked.is_new` (the feed's NUEVO
badge, via the `novelty` CTE).

**The first version of this record (and the PR it described) claimed count
and feed agree "by construction" and was wrong on two independent axes** —
found by opus review of PR #668, not by the original build. Both are fixed
here; this revision documents the actual, corrected mechanism.

**B1 — the anchor shifts between count and filter**: `/profiles` computes
`new_count` against `previous_viewed_at` at render time. Clicking "Ver
novedades" navigates to `/profiles/[id]?onlyNew=true`, whose page first
awaits `GET /api/profiles/[id]` — which runs `touchProfileViewedAt`,
**shifting `previous_viewed_at ← last_viewed_at`** whenever the last visit
was >30 min ago — *before* the candidate feed's own query ever runs. A
naive `onlyNew` filter re-reading `search_profile.previous_viewed_at` live
(the same column `ranked.is_new` reads) therefore reads the *already-shifted*
value: order of operations is literally "record the view, then read the
filter." Measured live on the demo DB: a profile showing "937 nuevos"
returned **0** candidates under `onlyNew=true`. Reproduced end-to-end
against a throwaway DB seeding candidates inside the anchor-shift gap.

**B2 — `new_count` counted rejected candidates; the feed hides them**:
`new_count`'s LATERAL filtered only on `pls.matched = true`, no feedback
join. The candidate feed defaults to `includeRejected=false` (D-094). A
profile with 4 newly-first-seen candidates, 2 of them already rejected,
promised "4 nuevos" and the feed showed 2. This is an everyday loop (open
feed, reject a few, go back to Perfiles, click again) — the 30-minute
debounce on `previous_viewed_at` means the count doesn't move between
visits even though what the feed shows does.

**Decision**:
- **"Nuevo" still means "since I last viewed this specific profile"** —
  `previous_viewed_at`, not the digest anchor (D-054), not a fixed window.
  Unchanged from the original design call; see "Alternatives rejected"
  below.
- **B1 fix — freeze the anchor into the link, never re-derive it live.**
  `lib/db/profile-overview.ts`'s query now also selects
  `COALESCE(sp.previous_viewed_at, sp.created_at - interval '1 day') AS
  novelty_anchor_ts`, surfaced as `ProfileOverviewMetrics.new_since` (an ISO
  string) — the exact timestamp `new_count` was computed against.
  `ProfileOverviewRow.tsx`'s link snapshots it:
  `?onlyNew=true&newSince=<new_since>`. `lib/candidates.ts`'s `onlyNew`
  filter, when `newSince` is present, evaluates `MIN(active-source
  listing.first_seen_at) > newSince` via a correlated subquery bound to that
  literal — the SAME aggregate shape as the `novelty` CTE's `is_new`, just
  against the frozen value instead of the live `(SELECT ts FROM anchor)`.
  `ranked.is_new`/`novelty_tier` themselves (the NUEVO badge, the fresh-first
  sort) are UNTOUCHED — they stay anchored to the live visit timestamp, as
  before; `onlyNew` is a pure WHERE-clause narrowing, never a second
  ranking/display definition of "new." When `newSince` is absent (a
  hand-typed `onlyNew=true` with no snapshot — never how the button itself
  links), the filter falls back to the live `ranked.is_new`, documented as
  best-effort only, not race-free.
- **B2 fix — `new_count` now excludes the profile's rejected candidates.**
  `match_stats`'s LATERAL joins the SAME `feedback_current` CTE the
  accept/reject counts already use (never a second feedback read) and the
  `new_count` FILTER adds `AND fbc.feedback_type IS DISTINCT FROM 'reject'`
  — aligning it with the feed's own default visibility (D-094) instead of
  changing the feed's default to match the count.
- **The button is hidden, not disabled, not shown with "0", when
  `new_count === 0`** — unchanged, same pattern as "N con alertas."
- **Count and feed now agree by construction FOR THE BUTTON'S OWN LINK** —
  both fixes are required together: B1 alone would still leak rejected
  candidates into the promised count; B2 alone would still race on the
  anchor shift. Neither fix touches the other's mechanism. "By construction"
  is scoped to the path the button actually takes (`onlyNew=true` +
  `newSince=<snapshot>`); a caller invoking `onlyNew=true` without a
  snapshot gets the pre-B1 best-effort behavior, explicitly documented as
  such in `CandidateFilters.onlyNew`'s doc — not silently promised as
  race-free.
- **B4 — the cold-start trade-off is NOT self-clearing on every axis.** The
  original text claimed a card returned under `onlyNew=true` without its own
  NUEVO badge (cold-start suppression, #425) is "rare and self-clearing (one
  profile visit ends cold-start)." That is true only of the *never-visited*
  branch. The *>60%-of-pool-is-fresh* branch does NOT self-clear on a visit
  — a profile whose matched pool stays predominantly fresh (measured live:
  one demo profile sits at ~80% fresh) keeps showing the cold-start note
  ("Perfil nuevo: todo es reciente") and zero per-card NUEVO badges
  indefinitely, chip-vs-badge contradiction included ("Solo nuevos" active,
  no card individually marked). This is stated honestly here rather than
  "fixed": `CandidateList.tsx`'s existing `novelty-cold-start-note` already
  renders in this state (unconditionally, whenever `coldStart` is true,
  onlyNew or not) — it is the mitigation, not a proof the contradiction
  cannot occur.

**Alternatives rejected** (unchanged from the original design call):
- *Anchor on the last digest send (`digest_run.sent_at`)* — would make the
  button disagree with the row's own "N nuevos" count, which is
  visit-anchored, not digest-anchored.
- *A fixed 24h/7d window* — doesn't answer "have I personally seen this."
- *Filter on the cold-start-suppressed `is_new` (what the badge shows)* —
  would diverge from `new_count` on every cold-start profile, the same class
  of bug #447 fixed, on a new axis.

**Rationale**: Reuses established, tested machinery at every layer (anchor
definition, feedback-state read, filter-state plumbing) rather than
inventing parallel ones, and the two fixes close the two independent races
opus review found by construction for the real user flow, while stating
plainly where "by construction" stops applying (no `newSince` snapshot;
coverage-based cold-start).

**See**: `dashboard/lib/candidates.ts` (`CandidateFilters.onlyNew`/
`newSince`, the `$26`/`$27` WHERE clause), `dashboard/lib/db/
profile-overview.ts` (`novelty_anchor_ts`, the `feedback_current` join on
`new_count`), `dashboard/lib/profile-overview-types.ts`
(`ProfileOverviewMetrics.new_since`), `dashboard/lib/candidate-filters.ts`,
`dashboard/app/api/profiles/[id]/candidates/route.ts`,
`dashboard/components/profiles/ProfileOverviewRow.tsx`,
`dashboard/components/candidates/CandidateFilterBar.tsx`,
`dashboard/e2e/ver-novedades.spec.ts`, issue #667, prior art #416/#425/#447,
D-054, D-057, D-059, D-094.
