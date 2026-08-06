---
id: D-094
title: Rejecting a candidate defers its removal to the next fetch; un-reject is a 'clear' event, not a delete
date: 2026-08-06
group: Product / candidate feed
rule: The candidate feed hides 'reject' by default (removal deferred to next fetch); a show-rejected toggle opts them back in. Un-reject appends a 'clear' event (feedback stays append-only) that every latest-state derivation must collapse to neutral.
order: 40
---

# D-094: Reject defers removal to the next fetch; un-reject is a `clear` event

*Decided: 2026-08-06*

**Context** (issue #379): rejecting a candidate on the feed used to leave the
card in place permanently (the feed never excluded rejected properties), and
there was no way to review or undo a rejection. The owner asked for two
changes: (1) a reject should not make the card vanish instantly — jarring, and
you lose your place — it should stay visibly marked for the current browse and
drop out only on the next fetch/reload; (2) a toggle to show rejected
properties so you can review and un-reject them. The `feedback_event` table is
append-only by design (data-model.md) — an audit trail the scoring retrain and
"why did we think this three weeks ago" both depend on — so un-reject cannot be
a DELETE.

**Decision**:
- **Deferred removal is client-side.** The reject write stays immediate
  (server-side, unchanged). The card is NOT removed on click — `CandidateCard`
  holds the verdict in local state and renders it marked (`data-rejected`, a
  "Descartada" badge, dimmed content) while staying in the list. The next
  server fetch naturally drops it. No refetch-and-remove on click.
- **The feed excludes `reject` by default.** `listCandidates` takes
  `includeRejected` (default false); the outer query drops any candidate whose
  derived verdict is `reject` unless it's true. The route parses
  `?includeRejected=true` (only the exact string opts in). `getAdjacentCandidates`
  applies the same exclusion so detail-page prev/next never steps onto a hidden
  card. The candidate row now carries `feedback_state` so the card renders its
  mark without a per-card GET.
- **Un-reject is a new `clear` feedback_type**, not a delete. `clear` resets the
  derived accept/reject/star state to neutral while keeping history append-only.
  Every "latest-state-wins" read MUST derive over `accept/reject/star/clear`
  and collapse a trailing `clear` to null: `getCurrentState`,
  `recordStateFeedbackIfChanged`, the scoring pipeline
  (`fetchLatestFeedbackStates`, which then drops the `clear` rows so a retracted
  verdict trains on nothing), the profile-overview counts, and the feed's
  `feedback_state` derivation. Clicking an already-active toggle in the UI
  records a `clear` (this is the un-reject gesture).

**Alternatives rejected**:
- *Delete the reject rows on un-reject.* Violates the append-only invariant the
  audit trail and retrain depend on; loses "changed my mind" history.
- *Un-reject by recording an `accept`.* Pollutes the training set with a
  positive the user never gave — un-reject means "no verdict", not "good".
- *Exclude rejected at materialization (set `matched=false`).* Conflates the
  hard-filter pipeline's notion of "matched" with a per-user verdict, and would
  make un-reject require re-materializing.

**Rationale**: keeping removal client-deferred means the reject write and the
scoring retrain stay exactly as they were; only the render lifecycle changed.
Modeling un-reject as an event keeps one uniform "latest state wins" rule across
every consumer instead of a special delete path, and keeps the history intact.

**See**: issue #379; `dashboard/lib/candidates.ts`,
`dashboard/lib/db/feedback.ts` (`DERIVED_STATE_FEEDBACK_TYPES`),
`dashboard/lib/scoring/preference.ts`, `dashboard/lib/db/profile-overview.ts`,
`dashboard/components/candidates/{CandidateCard,CandidateList,FeedbackControls}.tsx`,
`etl/schema/init.sql` (feedback_type CHECK), `dashboard/e2e/feedback.spec.ts`;
append-only rule in `docs/architecture/data-model.md`.
