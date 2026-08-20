---
id: D-132
title: Fuzzy-purge rescue rows survive reevaluation; purge commands abort/scope defensively
date: 2026-08-20
group: Data / connectors
rule: "A `purge_pending_fuzzy` rescue row (`detail.rescued_reason` set) is exempt from `_reevaluate_pending_suggestion`'s `evaluation is None` -> `rejected` branch (stays `pending` forever, counted in `reevaluated_preserved_rescued`). `purge_pending_fuzzy`/`preview_purge_pending_fuzzy` raise `PhotoHashStoreUnavailableError` instead of proceeding when the photo-hash store is unreachable. `purge_pending_phone` deletes only `confidence = 0.500` rows, never the kept 0.750 tier. Both `purge-fuzzy`/`purge-phone` CLI subcommands support `--dry-run` and require `--yes` or an interactive y/N confirmation."
---

# D-132: Fuzzy-purge rescue rows survive reevaluation; purge commands abort/scope defensively

*Decided: 2026-08-20*

**Context**: PR #607 (issues #604/#603/#601) landed D-130's fuzzy-purge
rescue set and D-131's phone reorder/silencing, then executed the fuzzy
purge against production (24,981 rows deleted, 51 rescued, backup
`inmotool-20260820-090030-PRE-FUZZY-PURGE.sql.gz`). A pre-merge review
found three empirically-verified blockers before the PR could deploy:

1. **The 51 rescued rows would have been permanently `rejected` on the
   first post-deploy `engine.run()`.** `purge_pending_fuzzy` leaves a
   rescued row `pending` with `match_basis='fuzzy'` and a `rescued_reason`
   stamped into `detail`, but nothing else in `evaluate_pair` was ever
   going to independently corroborate these rows (that is precisely WHY
   they were fuzzy-only — see `purge_pending_fuzzy`'s own docstring). The
   very next D-024 reevaluation therefore calls `evaluate_pair`, gets
   `None`, and `_reevaluate_pending_suggestion`'s existing branch marks it
   `rejected` — which `_load_recorded_pairs` then freezes forever
   (`rejected` never gets reevaluated again). Reproduced on a real DB for
   both rescue paths: a description-rescued row and a photo-rescued row
   (1 shared hash of 5, `match_ratio` 0.2 — below `MIN_MATCH_RATIO` 0.6,
   which is exactly why `hashes_share_any_match`'s looser bar was needed
   to rescue it in the first place) both flip to `rejected` after one
   `engine.run()`. `rejected` is worse than deleted: these 51 rows are the
   only survivors of a 24,981-row purge.
2. **`purge_pending_fuzzy` silently widened to "delete nearly everything"
   when the photo-hash store was unreachable.**
   `photo_hash_store.open_connection()` returns `None` on any failure
   (by design, for the scoring path); `purge_pending_fuzzy` fed that
   straight into `_fuzzy_rescue_shares_a_photo`, which degrades to
   `False` for every pair, silently collapsing the rescue set to
   description-only matches (measured: 19 of 51 on production's numbers)
   — no error, no non-zero exit, and the `DELETE` took the rest.
3. **`purge_pending_phone` deleted valid live suggestions.** It was an
   unconditional `DELETE ... WHERE status='pending' AND match_basis='phone'`,
   with no confidence scoping — but D-131 deliberately kept phone's 0.750
   corroborated-unconfirmed-kind tier filing suggestions. Any 0.750 row
   filed between deploy and the purge command running would have been
   deleted along with the 0.500 noise it exists to clean up.

**Decision**:

1. **Rescued rows are permanently exempt from auto-reject, not re-filed
   under a different basis and not deleted.** In
   `_reevaluate_pending_suggestion`, when `evaluate_pair` returns `None`
   AND the pending row's `detail` carries a `rescued_reason`, the row's
   `detail` is refreshed with a `reevaluated_from`/`reevaluated_reason`
   note (same auditability pattern every other branch already uses) but
   `status` stays `pending` — counted in the new
   `DedupRunResult.reevaluated_preserved_rescued`, separate from
   `reevaluated_rejected`. This is deliberately a permanent exemption, not
   a one-time grace period: `evaluate_pair` returning `None` for one of
   these rows on every future run is the expected, stable shape of "this
   is fuzzy's rescue set", not new information that the pair is bad —
   re-litigating it every run would eventually reject it by attrition the
   moment any unrelated code path nudges the row.

   **Alternatives considered**: re-filing the row under a synthetic basis
   that `evaluate_pair` would recognise (rejected — there is no real
   signal backing it; inventing one would misrepresent what actually
   corroborates the pair to a human reviewer) and deleting the rescue set
   outright, i.e. admitting the rescue was theatre (rejected — the
   review's own reproduction shows the rescue set is real corroboration
   `evaluate_pair`'s live signals structurally cannot reach: exact
   price+size plus a shared photo hash below `MIN_MATCH_RATIO` or a
   near-identical description; deleting it would discard genuine
   duplicates, not noise).

2. **`purge_pending_fuzzy`/`preview_purge_pending_fuzzy` raise
   `PhotoHashStoreUnavailableError` instead of proceeding when
   `photo_hash_store.open_connection()` returns `None`.** A destructive
   migration must fail loudly on a degraded optimisation it depends on,
   not fail open — the store-unreachable-looks-like-no-photo-evidence
   conflation that's correct for scoring is wrong for a delete. Both the
   real purge and its dry-run preview share one rescue-computation helper
   (`_compute_fuzzy_rescue_ids`) so they can never disagree about the
   condition, and a dry run fails exactly the way the real run would.

3. **`purge_pending_phone` is scoped to `confidence = 0.500`.** The 0.750
   corroborated-unconfirmed-kind tier D-131 kept is never touched by this
   command, at any point in time — not just "normally, after one
   reevaluation pass".

4. **Both `purge-fuzzy` and `purge-phone` gain `--dry-run` (prints
   `(would_delete, would_rescue)` / `(would_delete, would_keep)`, writes
   nothing) and an interactive y/N confirmation, skippable with `--yes`.**
   No stdin available (EOFError) or a stream that refuses reads outright
   (OSError — e.g. pytest's captured-output stdin substitute) is a
   refusal, never a default-yes. Both are wired into `ps dedup purge-fuzzy`
   / `ps dedup purge-phone` in `cli/commands/dedup.sh` — previously
   hard-coded case-statement allowlists with no `purge-*` entries at all,
   the only working invocation was `python -m etl.dedup.cli` inside the
   container, despite D-130's own `rule:` naming `ps dedup purge-fuzzy` as
   the interface.

**Rationale**: A rescue mechanism that reliably destroys itself on the
very next scheduled run one command later is not a rescue; a destructive
migration that silently widens its blast radius on a degraded dependency
is not safe to re-run; and an unconditional delete inside a *scoped*
purge command defeats the scoping the sibling decision (D-131) just
established. All three are the same shape of bug — code that is correct
in the common case but was never tested against its own failure/edge
paths — closed by DB-backed regression tests for each (`purge_pending_fuzzy`
then `engine.run()` asserting the survivor is still reviewable; a
monkeypatched `open_connection() -> None` asserting the purge/preview/CLI
all abort with zero writes; a mixed 0.500/0.750 fixture asserting only the
0.500 row is deleted).

**See**: `etl/dedup/engine.py` (`_reevaluate_pending_suggestion`,
`purge_pending_fuzzy`, `preview_purge_pending_fuzzy`, `purge_pending_phone`,
`preview_purge_pending_phone`, `PhotoHashStoreUnavailableError`),
`etl/dedup/cli.py` (`_cmd_purge_fuzzy`, `_cmd_purge_phone`, `_confirm`),
`cli/commands/dedup.sh`, `etl/tests/test_dedup_engine.py`
(`TestFuzzyPurgeRescueSurvivesReevaluation`,
`TestPurgePendingFuzzyPhotoStoreUnavailable`,
`TestPurgePendingPhone::test_keeps_corroborated_0_750_tier`), PR #607,
issue #600 (the spike), D-130 (fuzzy retirement + rescue set, revised by
this decision's point 1-2), D-131 (phone reorder/silencing, revised by
this decision's point 3), D-024 (pending reevaluation), D-025 (photo hash
store).
