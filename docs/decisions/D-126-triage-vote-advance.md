---
id: D-126
title: Triage-bar vote advance — confirm before navigate, clear/note never advance
date: 2026-08-20
group: Product / candidate feed
rule: A vote (accept/reject) advances the property-detail triage bar to the next candidate ONLY after the feedback POST is server-confirmed — never on the optimistic write. `clear` (re-tapping the active toggle) and `note` never advance. `adjacent` is snapshotted on mount, before the vote, so a just-rejected property's own next stays valid; it only drops out of the NEXT page's chain.
---

# D-126: Triage-bar vote advance — confirm before navigate, clear/note never advance

*Decided: 2026-08-20*

**Context** (issue #585): the owner is triaging a long property queue on a
phone, with his thumb — his own framing: *"lo que busco es una forma fácil
de categorizar todo"*. He asked for four things that are fragments of one
feature (a triage loop): prev/next more prominent, prev/next always visible,
vote controls in that header, and advance to the next candidate on vote. The
property-detail page's controls previously fought that loop: a 12px
non-sticky prev/next row, a mid-page "Tu valoración" box with 26×26px
buttons (under the 44px WCAG 2.5.5 minimum), and voting did nothing
afterward — the user had to scroll back up and tap "Siguiente →" manually.

The design collapsed both surfaces into one sticky `TriageBar`
(`dashboard/components/property/TriageBar.tsx`, `position: sticky; top: 0`
inside `.main-content`, which itself starts right below the 56px TopBar —
NOT `top: 56px`, which double-counts the TopBar offset since `.main-content`
is already the scrolling container that begins there) carrying prev/next
(≥44px), the accept/reject/note toggles (≥44px via a `size="detail"` prop on
`FeedbackControls`), and a compact price + `InvestorScoreChip`.

**Decision**:

1. **Advance on server confirm, never optimistically.** `FeedbackControls`
   gained an `onVoted?: (state: StateFeedbackType) => void` prop, called
   from `submitState`'s success branch — after `applyState(body.currentState)`,
   never from the optimistic write at the top of the function, and never from
   the `catch`/`!res.ok` rollback branches. A flaky mobile network must never
   silently drop a verdict by navigating before the write is known to have
   landed; the button's optimistic fill already covers the perceived latency
   (one round trip).
2. **Only accept and reject advance.** `onVoted` fires exactly when
   `submitState`'s locally-computed `target` (the derived next toggle state)
   is non-null — i.e. a genuine accept or reject, including a SWITCH from one
   active state to the other. `target === null` is a `clear` (re-tapping the
   already-active toggle, D-094's un-reject mechanism) and must never fire
   it. `note` is a wholly separate submit path (`submitNote`) that never
   calls `onVoted` at all. Both are legitimate "stay and reconsider" actions,
   not "categorised and done."
3. **Adjacency is snapshotted pre-vote; the page awaits it, not a stale
   snapshot.** The detail page's `GET .../adjacent` fetch (unchanged
   trigger: on mount / propertyId change, per D-094) resolves BEFORE the
   vote in normal use. The page's `onVoted` handler doesn't read the
   `adjacent` React state directly, though — it `await`s a ref
   (`adjacentPromiseRef`) holding that fetch's promise. A vote confirmed
   fast enough to race the initial fetch (a deliberate rapid double-tap, or
   this feature's own e2e suite voting immediately after `goto`) would
   otherwise read `adjacent`'s still-initial `{ null, null }` state and
   misreport "no next" — wrongly showing "Fin de la lista" on a property
   that has a real neighbour. Awaiting the promise makes the read always
   correct regardless of timing, with no added latency in the normal case
   (the promise is already settled).
4. **A rejected property's own adjacency is not recomputed for its own
   navigation.** Per D-094, rejecting the current property doesn't
   retroactively remove it from ITS OWN pre-fetched `nextPropertyId` — the
   vote lands on whatever neighbour the pre-vote snapshot named. The
   rejected property only drops out of the NEXT page's own prev/next chain
   (a fresh fetch, scoped to the new propertyId). This is correct for
   triage: the queue never steps backward onto a card just discarded.
5. **`includeRejected` carries through the vote-driven navigation**
   (#417), exactly like the existing `AdjacentLink` hrefs: the page's
   `handleVoted` appends `?includeRejected=true` to the pushed URL when the
   flag is set, so voting from the show-rejected view keeps stepping through
   that same order rather than reverting to the default (rejected-excluded)
   one.
6. **Last candidate stays put, with an explicit end state.** When the
   resolved `nextPropertyId` is `null`, the page sets `endOfQueue = true`
   instead of navigating; `TriageBar` swaps its prev/next row for "Fin de la
   lista" + a "Volver al perfil" link. `endOfQueue` resets to `false` on
   every `propertyId` change, so arriving anywhere via any other route
   starts fresh.

**Alternatives rejected**:
- *Navigate on the optimistic write, roll back the URL on failure too.*
  Rejected — a URL rollback (`router.back()` after a failed POST) is a worse
  user experience than simply not navigating: it either flashes the wrong
  property or fights whatever the user did in the meantime, and it still
  requires the same round-trip wait to know whether to roll back, so it buys
  no real latency win over waiting up front.
- *Read `adjacent` React state directly in the vote handler.* The original
  implementation did this and was provably racy under fast voting (this
  spec's own "vote advances" test failed against it reproducibly) —
  superseded by the promise-ref approach in point 3.

**Rationale**: the owner's own words frame this as a workflow whose entire
value is throughput — "categorizar todo" — so the one failure mode that
would destroy trust in the loop is a vote that appears to succeed (the
button fills, the page moves on) but didn't actually save. Every decision
above optimizes for that one invariant over raw speed, while keeping the
optimistic UI's perceived latency benefit intact everywhere it's safe to.

**See**: issue #585, `dashboard/components/property/TriageBar.tsx`,
`dashboard/components/candidates/FeedbackControls.tsx`,
`dashboard/app/profiles/[id]/properties/[propertyId]/page.tsx`,
`dashboard/e2e/triage-loop.spec.ts`, D-094, D-096, D-100, D-120, D-121,
D-124.
