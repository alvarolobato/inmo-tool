---
id: D-137
title: Photo-hash auto-merge tightens an existing path — exact m2_built, 5% price
date: 2026-08-20
group: Data / connectors
rule: "Photo-hash pairs auto-merge only when match_ratio == 1.0 AND m2_built is EXACTLY equal on both sides AND price is within `PHOTO_MERGE_PRICE_RATIO` (5%) — missing m2_built/price on either side never auto-merges. Tightens the pre-existing issue #188 auto-merge path (5% size / 2% price) rather than adding a new one; supersedes #602's own proposal (partial ratio >= 0.6, m2/price within 5%, a floor-from-text veto, a photo-promiscuity guard). The issue #186 floor-conflict veto no longer gates this decision (still surfaced for suggestion review, on a narrower argument than first stated — see Context). D-116/D-117/property_merge_veto are unaffected."
---

# D-137: Photo-hash auto-merge tightens an existing path — exact m2_built, 5% price

*Decided: 2026-08-20*

**Status note on this record**: this decision was revised twice on the day it
was written, once by the owner (price band 2% -> 5%, see "Price band" below)
and once by a review that caught the original m2_built evidence was a
measurement artifact (see "The m2_built evidence — corrected" below). Both
revisions are folded into this single record rather than superseded by a
separate D-NNN, since the underlying rule's *shape* (three conditions,
floor-conflict not gating) never changed — only the evidence quality and the
price threshold did.

## Context

Issue #600 (a read-only production-data spike) proposed issue #602's
"corroborated partial-photo auto-merge": auto-merge whenever photo
match_ratio >= 0.6 AND m2_built within 5% AND price within 5% AND no floor
conflict (reading both the structured field and description text) AND a
photo-promiscuity guard. That proposal was never implemented — before
building it, the owner hand-reviewed 68 real photo_hash pairs from the
pending queue (49 merged, 19 rejected) on 2026-08-19, and candidate rules
were replayed against those real decisions instead of against #602's own
proposed thresholds.

**Finding 1 (unchanged by either revision): photo match ratio does not
discriminate at all.** The 49 merges averaged ratio 1.000; the 19
rejections averaged 0.996, ranging 0.929-1.000 — the owner rejected pairs
whose photos matched 100%. A rule that leans on photo ratio alone (as
#602's `>= 0.6` proposed) merges things the owner says are different:
exactly the promotion/same-development pattern he predicted from the
start. `match_ratio == 1.0` stays required, never lowered to 0.6. Note:
`match_ratio` is the fraction of the SMALLER photo set with a match in the
larger one — `== 1.0` means the smaller set is fully contained in the
larger, not that the two galleries are the same size. A 3-photo listing
whose every photo matches inside a 30-photo listing's gallery clears this
exactly as a 10-vs-10 exact match does.

## The m2_built evidence — corrected

**The first version of this decision claimed "ALL 49 of the owner's
merges had identical m2_built; NONE of the 19 rejections did." That claim
was WRONG — a measurement artifact caught in review, not a real finding.**
`m2_built` lives only on `property` (never on `listing`). After a merge,
`suggested_merge.listing_id_a`/`listing_id_b` both point at the SAME
survivor property row — so a naive `listing -> property` join for an
already-CONFIRMED pair returns one property's m2_built twice, not two
independent measurements. On the live corpus, every confirmed photo_hash
row has `listing_id_a`'s and `listing_id_b`'s CURRENT `property_id` equal
by construction; every rejected row has them distinct (rejected pairs are
never merged). "49/49 identical, 0/19 identical" was therefore guaranteed
by which rows had been merged, not measured from the data.

**Corrected methodology**: `property_merge_log.losing_property_id` still
points at the LOSING property row, which `perform_merge` never touches
again once its listings are repointed — its `m2_built` is the genuine
PRE-merge value. The survivor side is approximated from its CURRENT
`m2_built` (a field `perform_merge` never rewrites, but which could in
principle have drifted since via a later connector re-fetch — an
upper-bound caveat on "identical," not an exact one). Matching each
confirmed `photo_hash` suggestion to its `property_merge_log` row (via
`merged_listing_ids` containment) and restricting to GENUINE human
confirms (`confidence <= 0.800` — a suggestion can never be filed above
`_MAX_SUGGESTION_CONFIDENCE`, so a confirmed row at 0.900 is
`_reevaluate_pending_suggestion`'s own re-evaluation auto-confirm, not a
human decision):

| reconstruction | matchable confirmed pairs | identical m2_built | differing m2_built |
|---|---|---|---|
| review's live-corpus measurement | 45 of 49 | 13 (~29%) | 32 |
| this session's local-restore measurement (smaller, partial sample — see "Measured impact" below) | 16 of 16 | 8 (50%) | 8 |

Both measurements agree on the qualitative correction: **not** every merge
has identical m2_built — roughly a third to a half do, not all. What
*does* survive cleanly, with no tautology, because rejected pairs were
never merged and so need no reconstruction: **zero of the owner's
rejections ever have identical m2_built** — 0/19 in the review's
measurement, 0/5 in this session's smaller local sample.

**What this means for the rule**: `m2_built` exact-equality
(`address_coords.sizes_equal`, no tolerance, replacing the old
`sizes_close(..., 5%)`) is kept as a required auto-merge gate because it
never contradicted a rejection in either sample — not because it captures
every real merge. This is a conservative, low-recall-but-specific trade,
which is the right one for an irreversible auto-merge: some real
duplicates with slightly different recorded m2_built stay suggestions
(false negatives, costing a human a click), but nothing the owner would
have rejected gets through on m2_built alone.

**A claim that also fails and had to be rewritten, not softened**: the
first version stated a 5% size band "is exactly what let a false merge
through" under the old issue #188 rule. That is unsupported — none of the
19 rejections would have cleared the OLD rule's gates either (in the
review's larger sample, `floor_conflict` catches some of what a 5% size
band alone would have missed, and no specific false merge was ever traced
to the old rule in production). The real basis for tightening size to
exact equality is the conservative trade above, not a demonstrated
historical failure.

## The floor-conflict veto — a narrower argument than first stated

The issue #186 floor-conflict veto used to be a fourth required condition
(`not floor_conflict`) on the issue #188 auto-merge. The first version of
this decision justified dropping it with the same corrupted claim above
("m2_built exact-equality already separates every merge from every
rejection, so floor was never exercised"). The corrected, narrower basis:
`floor_conflict` is present on a meaningful share of the owner's
LEGITIMATE confirmed merges too — 9 of 57 confirms in the review's
measurement (~16%), 4 of 16 in this session's — so it does not cleanly
separate merges from rejections on its own (it also appears on 10/19 and
3/5 rejections respectively, i.e. it's *correlated* with rejection but far
from exclusive to it). Since `m2_built` exact-equality already accounts
for every rejection in both samples without any help from floor_conflict,
keeping it as an ADDITIONAL required gate would cost real recall
(blocking ~16-25% of genuine merges) without preventing any false merge
either sample demonstrates. `floor_conflict` is still computed and written
into `PairEvaluation.detail` on every photo_hash verdict so a human
reviewing a `suggest` row still sees it — it simply is not a required
gate. #602's own proposed enhancement (reading floor from *both* the
structured field and description text) was never built, since #602's
whole rule is superseded by the simpler one here.

## Price band: 5%, revised from an initial 2% same-day

Conditioned on ratio == 1.0 + m2_built identical, every price band tested
against the owner's rejections in both replays produced **zero
contradictions**. This session's own reconstruction (16 matchable
confirmed pairs, corrected methodology):

| price band (m2_built identical subset, n=8) | count clearing it |
|---|---|
| identical | 4 |
| <= 1% | 5 |
| <= 2% | 5 |
| <= 3% | 5 |
| <= 5% | 8 (all) |

(0 of the m2_built-identical rejections — 0 in this session's 5-row
rejection sample — clear any band, at any width, since none have
identical m2_built to begin with.)

**A 2% band was shipped first same-day**, on the reasoning that 19
hand-labeled rejections was too thin a sample to spend past the owner's
own named 1-2% figure. Measured against the LIVE pending queue (not just
the hand-labeled sample), it was **effectively inert**: of pairs already
clearing ratio==1.0 + m2_built identical, only a small fraction also
cleared 2% price — most of the qualifying candidates sat precisely in the
2-5% band the 2% cut excluded (roughly three-quarters, per the owner's own
live measurement: 1 of ~59 vs. 46 of ~59 — see "Measured impact" for the
property-pair-corrected version of these numbers). An irreversible
automation that fires on essentially nothing is worse than none: it
creates false confidence in coverage the feature doesn't actually
provide.

**Decision: 5%.** Also measured zero contradictions on the same sample —
this is not a loosening on a hunch, it is the smallest band that gives the
rule actual reach against the live queue.

**Why a 2-5% price gap, with identical photos and identical m2_built, is
corroborating evidence rather than counter-evidence**: it is the signature
of **one property with a stale price on one portal** — a price change
that hasn't propagated to every listing yet — not two different units. A
development's genuinely distinct units differ in `m2_built` (already
excluded by the exact-equality gate) or share the developer's list price
exactly; they do not coincidentally land 2-5% apart on an otherwise
photo-and-size-identical listing.

**The not-taken option is now anything wider than 5%** — not because a
wider band measured unsafe (nothing past 5% was tested), but because 19
hand-labeled rejections remains thin evidence to spend further than what
this specific replay covers. `PHOTO_MERGE_PRICE_RATIO` is kept as a plain
named module constant in `etl/dedup/signals/photo_hash.py` (this
project's convention for every dedup threshold — none of
`MIN_MATCH_RATIO`, `address_coords._MAX_SIZE_RATIO`,
`reference_code._CORROBORATION_*` are wired into `config/schema.yaml`
either), not a runtime config knob, so a future widening is a one-line
change to a documented constant — a data decision, not a rediscovery.

## This is not a net-new merge path — it tightens an existing one

`property_merge_log` shows **851 photo_hash auto-merges already performed
under the pre-existing issue #188 rule** (exact ratio + 5% size + 2%
price) before this decision, confirmed identically in both this session's
local restore and the review's live measurement (851 rows at
`confidence = 0.900`, the value that uniquely identifies the old
auto-merge path — a human confirm never reaches 0.900 for photo_hash,
since a suggestion tops out at 0.800). **Framing this feature as "how many
NEW pairs does it add" understates what matters — how much of an
already-running, irreversible automation it tightens versus leaves
unchanged.**

Since the OLD rule's price band (2%) is a strict SUBSET of the NEW one
(5%), and since `m2_built` is far more stable post-merge than price (the
surviving listing keeps getting re-fetched and its price can move; a
structural field like m2_built rarely does), **the price condition is
guaranteed to still be satisfied for every one of the 851 historical
merges** (they cleared <=2% at merge time by construction, and 2% <= 5%)
— the ONLY thing that can flip a historical auto-merge to "would now
demote to suggestion" is `m2_built` no longer matching exactly. This
session's own reconstruction (via `losing_property_id`, same tautology-
avoiding method as above) found **755 of 851 (88.7%) have identical
m2_built and would still auto-merge; 96 (11.3%) differ and would demote to
a suggestion** — an exact match to the review's own independent
measurement of the same population, which is expected: `property_merge_log`
is an immutable append-only history, so both measurements are reading the
identical 851-row population regardless of when the snapshot was taken
(unlike the *pending* queue, which is live and shrinks as it's
reevaluated — see "Measured impact" below for why the reach numbers
disagree across snapshots but the historical-merge numbers do not).

A naive current-price reconstruction (comparing the loser's frozen price
to the survivor's CURRENT, possibly-drifted price) undercounts this to
697/851 — that additional ~58-row gap is a reconstruction artifact of
price drift since merge time, not evidence those merges would fail the
new rule; the correct answer uses the price-monotonicity argument above,
not a current-price comparison.

**Read this as the headline number for this change**: 88.7% of the
existing irreversible auto-merge history is preserved unchanged; roughly
11% (96 historical merges, and a comparable share of future candidates)
tightens down to a suggestion a human reviews instead.

## Measured impact — live-queue reach, in PROPERTY PAIRS

**A row in `suggested_merge` is a LISTING pair, not a property pair — and
multiple pending rows, or even a whole clique of 3+ properties sharing one
photoset, can collapse into far fewer actual merge events than the raw row
count suggests.** An earlier version of this "Measured impact" section
reported raw row counts (both this session's "10" and the owner's own
first-pass "46") — both wrong in the same way, corrected here:

- This session's first "10 pairs would auto-merge" (at the original 2%
  band) was actually **2 distinct property pairs**: all 10 rows were one
  clique across 3 property ids, and 2 of the 10 rows were stale
  same-property pending rows (issue #604's shape) that `_run` skips
  before `evaluate_pair` is ever reached — never real candidates.
- The owner's own live "46 pairs at 5%" carried the identical row-vs-pair
  conflation.

**Corrected, property-pair-level counts** (local restore of
`inmotool-20260820-090030-PRE-FUZZY-PURGE.sql.gz`, cross-property pending
`photo_hash` rows only, excluding stale same-property rows per issue
#604):

| | cross-property pending photo_hash rows | ratio==1.0 | + m2_built exact | + price <=2% (rows / property pairs / merge events) | + price <=5% (rows / property pairs / merge events) |
|---|---|---|---|---|---|
| this session (local restore) | 447 | 236 | 91 | 8 / 2 / 2 | 78 / 15 / 13 |
| owner (live production, same day) | 353 | 152 | 59 | 1 / — | 46 / **5** |

"Merge events" is the graph-collapsed count (union-find over the
qualifying property pairs) — the actual number of `perform_merge` calls a
run would make, since merging A-B then A-C also unifies B-C without a
third merge call. "Property pairs" is the simpler distinct-pair count,
which can slightly overstate merge events when a clique is involved.

**The two snapshots disagree in absolute terms** (this session's counts
are consistently ~1.3-1.7x the owner's live ones at every stage) **but
agree in shape**: 2% is near-inert either way (2 vs ~1 merge), 5% gives
real reach either way (13 vs 5 merge events). The most likely cause: this
session's local-restore snapshot (`...090030-PRE-FUZZY-PURGE...`) predates
further production activity between when it was taken and when the
owner's live query ran — the filename itself documents a fuzzy-suggestion
purge that ran on production afterward, and issue #214's D-024
reevaluation logic re-scores EVERY pending row (not just fuzzy ones) on
every dedup pass, so that purge's own triggering activity (plus any
ordinary scheduled connector/dedup passes since) plausibly resolved a
slice of the photo_hash backlog in the interim, shrinking the live queue
relative to the older static backup. This session did not query
production directly to confirm it (no production reads for this task, per
the standing "no writes, no dry run against live data" constraint) — the
owner's number, measured directly against the live state, is the one to
treat as authoritative for post-deploy sanity-checking.

**Expectation for the first post-deploy run against the LIVE pending
queue: roughly 5 property-pair merges** (owner's measurement), not 46 and
not the 150 either #602's own original proposal or this decision's first
draft implied. If the first run merges dramatically more than that low
single digits, or dramatically more than the 96-ish historical-merge
share reprocessed on reevaluation, that's a signal something is wrong
with the implementation, not evidence the rule is more effective than
measured.

## What is explicitly NOT built

All of the following were part of #602's original proposal and are
superseded rather than implemented: the partial-ratio (`>= 0.6`)
auto-merge path, the floor-from-text extractor (reading ordinals out of
the description, not just the structured field), and the
photo-promiscuity guard (demoting a merge to suggestion when a photo set
matches >= 3 distinct properties). None of them are needed once
match_ratio stays at 1.0 and m2_built must be exact.

## Unaffected

D-116 (`reference_code.reference_codes_conflict`) still vetoes
unconditionally before `evaluate_pair` ever reaches the photo_hash branch.
D-117 (`structured_fields_conflict`, property_type/rooms) was never wired
into this path and stays that way — its own rule already forbids vetoing
photo_hash auto-merges on those fields. `property_merge_veto` is still
checked in `_run`'s pairwise loop before `evaluate_pair` is ever called
for a vetoed property pair, and `perform_merge`'s own veto guard (the
last-line defense) still refuses a vetoed merge without killing the run
(#611's M-1 fix) — neither of those checks live inside the branch this
decision touches.

## Visibility

Every photo_hash auto-merge lands in `property_merge_log` with
`match_basis='photo_hash'`, `confidence=0.900`, and (new) an explicit
`detail.auto_merge_rule = "photo_hash_exact_d137"` flag — added because
`confidence == 0.900` was previously the ONLY (implicit, undocumented)
signal distinguishing an automatic merge from a human `confirm_suggestion`
click. `DedupRunResult.photo_hash_auto_merged` counts how many of a run's
merges took this path; it is now (a) printed by `ps dedup run`, and (b)
persisted to a new `dedup_runs.photo_hash_auto_merged` column and logged
by `orchestrator.run_dedup` — the actual production entry point
(scheduler/connector-sweep trigger), where the counter previously existed
nowhere at all outside a manual CLI invocation.

## Alternatives rejected

- #602's own proposal (partial ratio, 5%/5% bands, floor-from-text veto,
  promiscuity guard) — superseded before implementation once real
  decision-history replay showed the photo ratio doesn't discriminate.
- Shipping and keeping 2% — tried first, found effectively inert against
  the live queue, reversed same-day once measured.
- A price band wider than 5% — not rejected on evidence (nothing past 5%
  was tested), just not yet supported by the sample size.
- Wiring `PHOTO_MERGE_PRICE_RATIO` into `config/schema.yaml` as a runtime
  knob — rejected as inconsistent with every other dedup threshold in
  this codebase.
- Keeping the floor-conflict veto as a required gate "to be safe" —
  rejected once measured: it costs real recall (blocks ~16-25% of
  legitimate merges) without demonstrated benefit (m2_built-exact already
  excludes every rejection in both samples without it).

## Rationale

The owner's own accept/reject history is a much stronger basis for an
auto-merge rule than a hypothesis about which signals *should* correlate
— replaying against it directly caught that the previously "obviously
right" size-and-price corroboration overloaded m2_built with a useless 5%
band. Measuring the SHIPPED rule against the live queue (not just the
hand-labeled sample) then caught a second, different problem — a
technically-correct-but-inert threshold — that the hand-labeled sample
alone could not surface, because it only ever tested pairs that already
satisfied whatever price band was being evaluated. And a fresh-context
review, re-deriving the evidence from the schema rather than trusting the
narrative, caught a third problem — a tautological join — that neither
the implementer nor the owner's own manual review had reason to suspect,
because the corrupted number ("100% separation") looked exactly like what
a real, clean signal would produce.

**See**: `etl/dedup/engine.py::evaluate_pair` (photo_hash branch, and
`perform_merge`'s `auto_merge_rule` stamping), `etl/dedup/signals/photo_hash.py`
(`PHOTO_MERGE_PRICE_RATIO`'s module comment carries the full evidence),
`etl/dedup/signals/address_coords.py` (`sizes_equal`), `etl/orchestrator.py`
(`dedup_runs.photo_hash_auto_merged` persistence), `etl/schema/init.sql`
(the `dedup_runs` column migration), `etl/tests/test_dedup_engine.py`
(`TestPhotoHashAutoMerge`, `TestFloorConflictNoLongerGatesAutoMerge`,
`TestOwnerDecisionHistoryReplay`, `TestPhotoHashAutoMergeVisibility`),
issues #600 (spike) and #602 (this decision supersedes its proposed
rule). D-116, D-117, D-133 (property_merge_veto).
