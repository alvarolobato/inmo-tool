---
id: D-137
title: Photo-hash auto-merge requires exact m2_built, not a 5% band — 2% price, configurable
date: 2026-08-20
group: Data / connectors
rule: "Photo-hash pairs auto-merge only when match_ratio == 1.0 AND m2_built is EXACTLY equal on both sides AND price is within `PHOTO_MERGE_PRICE_RATIO` (2%) — missing m2_built/price on either side never auto-merges. Supersedes #602's own proposal (partial ratio >= 0.6, m2 within 5%, price within 5%, a floor-from-text veto, a photo-promiscuity guard); the issue #186 floor-conflict veto no longer gates this decision (still surfaced for suggestion review). D-116/D-117/property_merge_veto are unaffected."
---

# D-137: Photo-hash auto-merge requires exact m2_built, not a 5% band — 2% price, configurable

*Decided: 2026-08-20*

**Context**: Issue #600 (a read-only production-data spike) proposed issue
#602's "corroborated partial-photo auto-merge": auto-merge whenever photo
match_ratio >= 0.6 AND m2_built within 5% AND price within 5% AND no floor
conflict (reading both the structured field and description text) AND a
photo-promiscuity guard. That proposal was never implemented — before
building it, the owner hand-reviewed 68 real photo_hash pairs from the
pending queue (49 merged, 19 rejected) on 2026-08-19, and candidate rules
were replayed against those real decisions instead of against #602's own
proposed thresholds.

Two findings from that replay:

1. **Photo match ratio does not discriminate at all.** The 49 merges
   averaged ratio 1.000; the 19 rejections averaged 0.996, ranging
   0.929-1.000 — the owner rejected pairs whose photos matched 100%. A
   rule that leans on photo ratio alone (as #602's `>= 0.6` proposed)
   merges things the owner says are different: exactly the
   promotion/same-development pattern he predicted from the start.
2. **`m2_built` is the real discriminator, not a proximity band.** ALL 49
   of the owner's merges had identical m2_built on both sides; NONE of the
   19 rejections did. The pre-existing exact-photo-match auto-merge path
   (issue #188) used a `sizes_close(..., 5%)` band — exactly wide enough to
   admit a same-building-different-unit false merge (a 6m² gap on a
   ~145m² flat is 4.14%, comfortably inside 5%).

Conditioned on match_ratio == 1.0 AND m2_built identical, every price band
tested against the 19 rejections produced **zero contradictions**:

| price band | matches owner's merges | contradicts owner's rejections |
|---|---|---|
| identical | 29 | 0 |
| <= 1% | 31 | 0 |
| <= 2% | 31 | 0 |
| <= 3% | 35 | 0 |
| <= 5% | 47 | 0 |

**Decision**: `etl.dedup.engine.evaluate_pair`'s photo_hash branch
auto-merges (`basis="photo_hash"`, `confidence=0.900`) only when **all
three** hold:

1. `match_ratio == 1.0` (unchanged from issue #188 — never lowered to
   #602's proposed `>= 0.6`; a partial match always stays a suggestion,
   scaled by `photo_hash.confidence_for_ratio`).
2. `m2_built` present and **exactly equal** on both sides
   (`address_coords.sizes_equal`, a new pure helper — no tolerance
   parameter, unlike `sizes_close`). Missing `m2_built` on either side is
   never a match (same permissive-on-absence-means-no-match discipline
   every other proximity check in this codebase already follows).
3. `current_price` present and within `PHOTO_MERGE_PRICE_RATIO` (2%) on
   both sides (`address_coords.prices_close`, unchanged from issue #188).
   Missing price on either side is never a match.

Anything short of all three stays a `suggest` verdict for the owner to
review, at `photo_hash.confidence_for_ratio(ratio)`.

**2%, not 3% or 5%, even though both also measured clean on this sample**:
19 rejected pairs is thin evidence for an irreversible operation (a wrong
auto-merge fuses two real properties, corrupting their score and feedback
history), and the owner named 1-2% himself when discussing this. 3% and 5%
are recorded here explicitly so widening `PHOTO_MERGE_PRICE_RATIO` later,
on more labeled evidence, is a one-line change to a documented constant —
a data decision, not a rediscovery of this reasoning. The constant is kept
as a plain named module constant in `etl/dedup/signals/photo_hash.py`
(this project's existing convention for every dedup threshold — none of
`MIN_MATCH_RATIO`, `address_coords._MAX_SIZE_RATIO`,
`reference_code._CORROBORATION_*` are wired into `config/schema.yaml`
either), not a runtime config knob.

**The issue #186 floor-conflict veto no longer gates this decision.** It
used to be a fourth required condition (`not floor_conflict`) on the
issue #188 auto-merge. Floor was never exercised as a discriminator in the
68-pair replay above — m2_built exact-equality alone already separates
every merge from every rejection in that sample — and #602's own proposed
enhancement (reading floor from *both* the structured field and the
description text, not just the structured field) was never built, since
#602's whole rule is superseded by the simpler one above. `floor_conflict`
is still computed and written into `PairEvaluation.detail` on every
photo_hash verdict (merge or suggest) so a human reviewing a `suggest` row
still sees the discriminating data point — it simply no longer blocks an
otherwise-qualifying merge.

**Auto-merge visibility**: every photo_hash auto-merge still lands in
`property_merge_log` with `match_basis='photo_hash'` (unchanged — issue
#188's mechanism), and `DedupRunResult.photo_hash_auto_merged` (new field,
not persisted to `dedup_runs` — same "visibility counter, not a schema
change" precedent as `same_source_skipped`/`vetoed_pairs_skipped`) counts
how many of a run's merges took this specific path; `ps dedup run` prints
it when nonzero.

**What is explicitly NOT built** (all part of #602's original proposal,
now superseded rather than implemented): the partial-ratio (`>= 0.6`)
auto-merge path, the floor-from-text extractor (reading ordinals out of
the description, not just the structured field), and the photo-promiscuity
guard (demoting a merge to suggestion when a photo set matches >= 3
distinct properties). None of them are needed once match_ratio stays at
1.0 and m2_built must be exact — see the findings above for why.

**Unaffected**: D-116 (`reference_code.reference_codes_conflict`) still
vetoes unconditionally before `evaluate_pair` ever reaches the photo_hash
branch. D-117 (`structured_fields_conflict`, property_type/rooms) was
never wired into this path and stays that way — its own rule already
forbids vetoing photo_hash auto-merges on those fields. `property_merge_veto`
is still checked in `_run`'s pairwise loop before `evaluate_pair` is ever
called for a vetoed property pair, and `perform_merge`'s own veto guard
(the last-line defense) still refuses a vetoed merge without killing the
run (#611's M-1 fix) — neither of those checks live inside the branch this
decision touches.

**Alternatives rejected**:
- #602's own proposal (partial ratio, 5%/5% bands, floor-from-text veto,
  promiscuity guard) — superseded before implementation once real
  decision-history replay showed the photo ratio doesn't discriminate and
  a 5% size band is exactly what lets a false merge through.
- A 5% (or 3%) price band — also measured clean on this sample, but 19
  rejections is too thin a sample to spend that margin on an irreversible
  operation; recorded above so it's a documented, easy option later.
- Wiring `PHOTO_MERGE_PRICE_RATIO` into `config/schema.yaml` as a runtime
  knob — rejected as inconsistent with every other dedup threshold in this
  codebase, all of which are hand-tuned, documented, hardcoded constants
  changed via a code PR, not an env var.

**Rationale**: the owner's own accept/reject history is a much stronger
basis for an auto-merge rule than a hypothesis about which signals *should*
correlate — replaying against it directly caught that the previously
"obviously right" size-and-price corroboration overloaded m2_built with a
useless 5% band while measuring nothing about what actually differs
between the owner's merges and rejections.

**See**: `etl/dedup/engine.py::evaluate_pair` (photo_hash branch),
`etl/dedup/signals/photo_hash.py` (`PHOTO_MERGE_PRICE_RATIO`'s module
comment carries the full evidence table), `etl/dedup/signals/address_coords.py`
(`sizes_equal`), `etl/tests/test_dedup_engine.py`
(`TestPhotoHashAutoMerge`, `TestFloorConflictNoLongerGatesAutoMerge`,
`TestOwnerDecisionHistoryReplay`, `TestPhotoHashAutoMergeVisibility`),
issues #600 (spike) and #602 (this decision supersedes its proposed rule).
D-116, D-117, D-133 (property_merge_veto).
