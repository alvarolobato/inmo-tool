---
id: D-024
title: Dedup engine re-evaluates every pending suggestion on every run
date: 2026-08-04
group: Data / connectors
rule: '`engine.run()` re-evaluates every `pending` `suggested_merge` row every run (only `rejected`/`conflict` stay frozen); an in-flight `suggested_merge_action` defers reevaluation one run.'
order: 34
---

# D-024: Dedup engine re-evaluates every pending suggestion on every run

*Decided: 2026-08-04*

**Context**: Issue #214. The owner's day-one duplicate report (listings 62
milanuncios / 146 fotocasa) was still `pending` after three PRs that should
each have fixed it (#198 photo auto-merge, #209 Milanuncios photo CDN fix,
#213 URL backfill). Root cause: `engine._load_recorded_pairs()`
(`etl/dedup/engine.py`) preloaded every already-suggested pair and the main
loop in `run()` skipped all of them — `pending` was treated exactly like
`rejected`/`conflict`, so a pair scored once was never looked at again no
matter how much `evaluate_pair`'s rules changed underneath it.

This was worse than "stale": live-checked against the real corpus,
**193 of 196 `suggested_merge` rows were `pending`**, and a real chunk of
them (the Milanuncios photo_hash suggestions specifically) were scored
*while Milanuncios photos were entirely unhashable* — `match_ratio`
computed from missing data, not merely from data that later changed.

**Decision**: `run()` re-evaluates every `pending` suggestion against the
*current* rules on every run, instead of skipping it forever. Only
`rejected` and `conflict` stay permanently frozen — the same status set the
pre-existing `_load_recorded_pairs` docstring already argued for
`confirmed` (a human decision or a merge-time state clash both need an
explicit human action, never a silent re-score). This is the source
issue's **option 1** of three:

1. **Always re-evaluate `pending`** (chosen). Cost is one extra
   `evaluate_pair` call per pending row per run — bounded by suggestions
   filed (193 today), not by n², the same cost shape
   `_load_recorded_pairs`'s own reasoning already accepted for `confirmed`.
   Rule changes take effect automatically; nobody has to remember a step.
2. **Version the rules** (stamp each suggestion with an engine version,
   re-evaluate only on a version mismatch) — rejected as unnecessary
   machinery for the win it buys: it would save re-scoring pairs whose
   verdict provably can't have changed, but at 193 rows and ~13.3us/pair
   (issue #185's own measurement, before photo-hash network cost) that
   saving isn't worth a new versioning scheme to invalidate correctly.
3. **A `ps dedup rescore` command** — rejected because it reintroduces
   exactly the failure mode this issue is about: someone has to remember to
   run it after every rule change, and evidently nobody did across three
   PRs that each should have triggered one.

**Mechanism** (`etl/dedup/engine.py`):
- `_load_recorded_pairs(cur)` now returns `(skip_pairs, pending_by_pair)`
  instead of a single skip set, still via **one** query (a scalar
  correlated `EXISTS` subquery rides along, not a second round-trip —
  `TestRecordedPairBatching.test_skip_check_costs_one_query_per_run_not_one_per_pair`
  pins this as a regression guard). `skip_pairs` holds `rejected`/
  `conflict` rows, plus any `pending` row with an unprocessed
  `suggested_merge_action` (see below). `pending_by_pair` holds every
  other `pending` row, keyed by the normalized listing pair.
- `run()`'s main loop calls `evaluate_pair` for a pair found in
  `pending_by_pair` exactly like a brand-new pair, then hands the fresh
  verdict to `_reevaluate_pending_suggestion`, which reconciles it against
  the *existing* row rather than inserting a duplicate:
  - `evaluation is None` (nothing fires any more) → `status='rejected'`.
    This is what makes re-evaluation bidirectional, not just a path to more
    merges — a pair that now fails every signal (the #186 floor-veto shape:
    a signal that used to fire gets vetoed and nothing weaker catches it)
    leaves the queue instead of sitting in it forever with a verdict nobody
    stands behind.
  - `decision == "suggest"` → refresh `match_basis`/`confidence`/`detail`
    in place, stays `pending`. This is the fix for the sharpest case: a
    Milanuncios photo_hash suggestion's `match_ratio` gets recomputed now
    that the photos are actually hashable, even though it's still below the
    auto-merge bar.
  - `decision == "merge"` → run the normal `perform_merge` path and mark
    the *existing* row `confirmed` (mirroring `confirm_suggestion`'s own
    bookkeeping) rather than leaving a suggestion dangling at `pending` for
    listings that are now unified.
  - Every branch stamps the row's pre-reevaluation state into
    `detail.reevaluated_from` — an audit trail distinguishing "the engine
    changed its mind" from a human's own `confirm_suggestion`/
    `reject_suggestion` call (which never writes that key).

**Human-seen-but-unactioned suggestions**: there is no `viewed_at` or
session concept anywhere in this schema, so a run structurally cannot know
a human is *looking* at a suggestion right now — that residual race (rules
change and reject a pair in the exact window between a human opening it and
clicking "Confirmar") is accepted, not solved, because solving it would
need new state this issue didn't ask for and the codebase doesn't otherwise
track. What a run *can* know, and does check: whether a human has already
**clicked** confirm/reject and the resulting `suggested_merge_action` row
hasn't been drained yet by `etl.dedup.actions.run_action_poll_loop` (polls
every 3 seconds vs. this run's hourly cadence). A `pending` suggestion with
an in-flight action is left completely untouched this run — re-scoring
(and potentially rejecting) it underneath an in-progress human decision
would race it for no benefit, since the action processor is about to
resolve it anyway. If the action fails for an unrelated reason (e.g. a
stale listing), the row stays `pending` and is picked up normally next run.
This is not a new mechanism — `suggested_merge_action` already existed for
the dashboard's confirm/reject queue (see `etl/schema/init.sql`); this
decision only adds a read against it before re-scoring.

**Orphaned `property` rows — documented, not cleaned up**: issue #214 also
flagged that `property` rows aren't removed on merge (830 properties for
830 listings live, of which only 22 held 2+ listings — meaning a matching
number of losing-side rows sit with zero listings, invisible in any
`COUNT(*) FROM property`). Traced to source: `etl.dedup.engine.perform_merge`
only reassigns `listing.property_id`, never deletes `property`, and
`etl/schema/init.sql`'s comment on `property_merge_log.losing_property_id`
plus `engine.revert`'s own docstring already state this is intentional —
`revert` restores a merge by pointing listings back at the losing property,
which only works if that row still physically exists. This was **already
documented at the code level** but not at the data-model level where
someone writing a "how many properties do we have" query would look —
fixed by adding a paragraph to `docs/architecture/data-model.md` stating
the fact, the reason, the query to exclude orphans from a count, and the
live measurement (29 of 880 as of this issue, matching the ~22-of-830 the
issue reported — the corpus grew via the normal hourly connector sweep
between the report and this fix, the ratio is consistent). No code change:
deleting these rows would break `revert`, which nothing in the issue asked
to remove.

**Rationale**: the same reasoning `_load_recorded_pairs`'s original
docstring already used for `confirmed` — a queue whose entries never get
looked at again is only as good as the rules were on the day each entry was
filed, and this project's own history (#198, #209, #213 all landing without
fixing the day-one report) shows rules change often enough that "filed
once, frozen forever" silently rots the queue. Re-evaluating costs one
`evaluate_pair` per pending row, which is cheap at real-world queue sizes
and self-limiting (a queue that grows doesn't grow re-evaluation cost
faster than linearly).

**See**: `etl/dedup/engine.py` (`_load_recorded_pairs`,
`_reevaluate_pending_suggestion`, `run`), `etl/tests/test_dedup_engine.py`
(`TestPendingSuggestionReevaluation`), `docs/architecture/data-model.md`
(orphaned-property paragraph), issue #214, issue #186 (the floor-veto
acceptance case reused here to demonstrate the rejected direction),
`etl/dedup/actions.py` (the `suggested_merge_action` poll loop this
decision reads from without modifying).
