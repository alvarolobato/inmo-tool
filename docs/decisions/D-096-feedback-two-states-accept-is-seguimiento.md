---
id: D-096
title: Feedback has two states — accept (= "en seguimiento") and reject; the `star` toggle is retired
date: 2026-08-07
group: Product / candidate feed
rule: Candidate feedback has exactly two active states — accept (which IS the follow/track "en seguimiento" action) and reject. `star` is retired — not writable (POST → 400) and collapsed to neutral (null) like `clear` in every latest-wins read. The DB enum keeps `star` inert for legacy rows; no migration.
order: 41
---

# D-096: Feedback is two states — accept = seguimiento; `star` retired

*Decided: 2026-08-07*

**Context** (issue #422, phase 4 of #415): the candidate feedback model carried
three active toggle states — `accept`, `reject`, and `star` ("destacar"). In
practice `accept` had no distinct meaning of its own and `star` was doing the
"this is one I'm following" job, so the two overlapped. The owner decided
(2026-08-07) to collapse the model: there is no separate "destacar"; **accepting
a property IS how you track it** ("en seguimiento"), and `reject` ("descartada")
stays as-is. The tracked working set = properties whose latest verdict is
`accept`.

**Decision**:
- **Two active states only**: `accept` (the follow/track action, surfaced in the
  UI as "Seguir" / "En seguimiento") and `reject` ("Descartar" / "Descartada").
  The third `star` toggle is removed from `FeedbackControls` (feed card + detail
  page).
- **`star` is retired, not migrated**: the `feedback_type` DB enum keeps `star`
  inert so historical rows still read. `star` is **not writable** — it is absent
  from the POST validation set (`WRITABLE_FEEDBACK_TYPES`), so posting it is a
  `400`.
- **Latest-wins reads collapse `star` like `clear`**: every derivation
  (`getCurrentState`, `recordStateFeedbackIfChanged`, `fetchLatestFeedbackStates`,
  the candidate-feed `feedback_state`, the profile-overview counts) keeps `star`
  in the *derive* set (so a trailing legacy star still WINS the ordering) and
  then maps it to neutral (`null`) — the single rule lives in
  `deriveToggleState()` (`lib/db/feedback.ts`). A legacy-starred property thus
  reads as un-marked, never as an older accept/reject underneath it.
- **Training** (`retrain.ts` / `preference.ts`, #373/D-089): with `star` gone the
  label map is simply `accept → 1`, `reject → 0`. `fetchLatestFeedbackStates`
  already drops the retired-star and cleared rows, so the classifier never sees a
  star.
- **Working-set view**: `listCandidates` gains a `state` filter
  (`?state=accept`, param `$18`) mirroring the `includeRejected` convention, plus
  an "En seguimiento" preset toggle in the feed filter bar. A tracked card shows
  an "EN SEGUIMIENTO" mark and a `data-tracked` hook — the hook phase 3 uses to
  **exempt** a followed property from novelty-tier suppression.
- **`effective_score` / ORDER BY / cursor are untouched** — this is a
  feedback-model + reads + UI change, not a ranking change.

**Alternatives rejected**:
- *Migrate legacy `star` rows to `accept`*: unnecessary and irreversible;
  collapsing star to neutral on read is simpler and the owner did not ask to
  preserve the old star signal.
- *Keep `star` writable-but-hidden*: leaves a dead code path and a way to write a
  state the UI can't show — rejected per this project's "no dual code paths"
  default.

**Rationale**: one deployment, no external consumers — the cleanest model wins.
Two states map exactly onto the owner's mental model (following vs. discarded),
and folding the retired star into the same neutral-collapse the `clear` un-mark
already uses (D-094) means no reader needs a bespoke star branch.

**See**: issue #422; `dashboard/lib/db/feedback.ts` (`deriveToggleState`,
`WRITABLE_FEEDBACK_TYPES`), `dashboard/lib/candidates.ts` (`state` filter +
`feedback_state` collapse), `dashboard/lib/scoring/{preference,retrain}.ts`,
`dashboard/components/candidates/{FeedbackControls,CandidateCard,CandidateList}.tsx`;
builds on D-094 (reject deferred-removal + `clear`) and D-089 (preference
signal).
