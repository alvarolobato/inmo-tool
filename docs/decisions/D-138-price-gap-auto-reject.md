---
id: D-138
title: Auto-reject a dedup pair on a large price gap, corroborated by size/rooms
date: 2026-08-20
group: Data / connectors
rule: "`evaluate_pair` rejects a pair outright when price differs by more than 30%, or by 15%+ AND (m2_built differs by >=5% OR rooms differ by >=2, reusing `structured_fields.rooms_conflict`) — checked after cadastral/D-116, before address_coords's positive match falls through to it in practice, before photo_hash/phone. A rule-based rejection is NEVER filed as a `suggested_merge` row for a brand-new pair and NEVER creates a `property_merge_veto`; an already-`pending` row the rule now rejects on reevaluation moves to `rejected` with `resolved_reason='price_gap_rule'`. Counted in both `ps dedup run` and the orchestrator log line (`DedupRunResult.price_gap_rejected`, issue #627)."
---

# D-138: Auto-reject a dedup pair on a large price gap, corroborated by size/rooms

*Decided: 2026-08-20*

**Context**: Issue #627. The owner's rule, in his words: *"cuando la
diferencia en el precio es de más de un 30% hay que rechazar directamente
el duplicado. Y si la diferencia es del 15% o más y la superficie también
es diferente un 10% o más, o las habitaciones, rechazamos también."*,
refined once on the size threshold: *"los metros pueden ser un 5% de
diferencia y habitaciones diferentes también afectan, para así salvar el
problema de las promociones que son muchos."*

Measured against the owner's own decision history, reconstructed via
`property_merge_log.losing_property_id` — **never** a `listing ->
property` join, which returns a merged pair's single survivor property
row twice and manufactures agreement (this exact mistake produced a false
"49/49 merges identical, 0/19 rejections identical" claim in an earlier
session's analysis for a different issue; it had to be retracted — see
D-137's own "The m2_built evidence — corrected" section):

| | his merges (88) | his rejections (62) |
|---|---|---|
| price >30% alone | 2 | 10 |
| full rule | 3 (3.4%) | 24 (39%) |

The full rule reproduces ~39% of the owner's rejection workload at a 3.4%
contradiction rate against his own merges. Two of the three contradicted
merges are the same fotocasa-vs-idealista pair (32 vs 37 m², 48%/58% price
gaps) confirmed **before** the photo-match card existed (#615/#621) — he
decided without being able to see the photos side by side, so these may be
the rule's successes rather than its failures, not just noise to accept.

**5% vs 10% on the size leg**: measured identically on the same history —
both catch exactly the same merges/rejections; the rooms condition and the
price gap are what's doing the discriminating work, not the specific size
percentage. **5% is used because it is the owner's later, explicit,
refined intent — not because it was measured to outperform 10%.** Saying
this plainly, rather than manufacturing evidence that 5% is better, is the
whole point of this note: an earlier analysis in this repo (D-137, before
its correction) drew a false conclusion from a measurement bug in exactly
this shape, and it cost nothing to just say "he asked for 5%" instead of
implying a discriminating test that was never run.

**Decision**:

1. `etl/dedup/signals/price_gap.py` (`price_gap_conflict(a, b) -> dict |
   None`) implements the two-rule veto: price differs by MORE than 30%
   rejects on its own; price differs by 15% or MORE, corroborated by
   `m2_built` differing by 5% or more OR `rooms` genuinely differing,
   rejects. A missing/non-positive price on either side always returns
   `None` (rules 1 and 2 both key off the price ratio). The size ratio
   uses the same `abs(a-b)/max(a,b)` convention as
   `address_coords.prices_close`/`sizes_close` elsewhere in this
   pipeline.

2. **Rooms leg reuses `structured_fields.rooms_conflict` directly, not a
   second implementation.** That predicate already treats `rooms=0` as
   unknown (D-117's "B3": a scrape artifact affecting 20.7% of
   properties, not a genuine studio count) and already requires a
   difference of at least 2, never exactly 1 — on a real, large-sample
   measurement (issue #566: 6,728 pending pairs at exactly a 1-room
   difference vs. only 1,966 at >=2; portals genuinely disagree on
   whether a study/interior room counts, and vetoing on a 1-room
   tolerance would cost real recall at scale). The owner's own phrasing
   here ("habitaciones diferentes también afectan") does not qualify by
   how much, so this decision reuses D-117's threshold rather than
   introducing a second, un-reconciled one for the same field.

   **Supplementary check, this session**: production's own decision
   history (read-only, via `ps prod psql`; nothing written to production
   — see AGENTS.md's "verifying against production is normal" note)
   reconstructed with the SAME `property_merge_log`-based methodology:
   59 genuine human confirms (`suggested_merge.detail ? 'confirmed_merge'`
   — the marker `confirm_suggestion` alone writes, i.e. an actual
   dashboard/CLI click) and 1 genuine human reject (`status='rejected'`
   with no `reevaluated_from` marker, i.e. not an engine auto-reject).
   Of the 59 merges, only 11 had `rooms` known (non-null, non-zero) on
   BOTH sides; of those, 0 had rooms differing by exactly 1 or by >=2 in
   the price band where the rooms leg would matter. The 1 genuine reject
   had rooms unknown on at least one side. **This sample is too small to
   independently discriminate between the two thresholds — it neither
   confirms nor contradicts D-117's own larger-sample finding.** Reusing
   D-117's threshold is therefore a consistency choice backed by that
   larger prior measurement, not a re-decision from this thin one; this
   record says so rather than presenting the small sample as if it had
   settled anything (the same discipline the 5%-vs-10% note above
   applies).

3. **A rule-based rejection is never filed as a `suggested_merge` row for
   a brand-new pair.** `evaluate_pair` returns a `PairEvaluation` with
   `decision='reject'`; `_run`'s dispatch counts it
   (`DedupRunResult.price_gap_rejected`) and `continue`s — no INSERT, no
   `suggested_merge_action`, nothing. The pair never enters the review
   queue, nothing is recorded as a decision, and a later data change
   (price correction, a merge upstream) re-opens it naturally on the next
   run — the preferred option from the issue, taken as-is rather than the
   fallback (file it with a distinguishing `resolved_reason`).

4. **An existing `pending` row the rule now rejects on reevaluation** (a
   row an earlier, weaker signal filed before this rule existed, or
   before a later price/size update) is the one case that DOES get
   written: `_reevaluate_pending_suggestion` moves it to `status =
   'rejected'` with `detail.resolved_reason = 'price_gap_rule'` —
   distinct from the pre-existing generic "no signal matched this pair
   under current rules" auto-reject, so an operator (or a human looking
   at a `rejected` row later) can tell "the numeric rule said no" apart
   from "nothing currently supports this" apart from "a human said no".
   This is the one deliberate deviation from "don't record it": an
   existing row has to land somewhere once reevaluated (the alternative —
   leaving it `pending` forever — is worse, and the codebase's own
   `_reevaluate_pending_suggestion` contract already requires every
   branch to resolve to something), so it's recorded with a reason
   instead of silently vanishing.

5. **Neither path ever creates a `property_merge_veto`.** That table is
   written by exactly one function in this codebase,
   `engine.reject_property_pair` — called only from the human-driven
   dashboard/CLI reject-pair action (`suggested_merge_action` ->
   `etl.dedup.actions._process_one`). Nothing in `_run` or
   `_reevaluate_pending_suggestion`'s price-gap branches calls it, so
   structurally a heuristic rejection here can never trip D-132/D-133's
   permanent, auto-widening property-level veto — the design constraint
   the issue called out as mattering most, given the rule's measured
   ~3.4% contradiction rate against imperfect ground truth. Pinned by a
   DB-backed test (`TestPriceGapRule` in `test_dedup_engine.py`) asserting
   `property_merge_veto` stays empty after both a brand-new-pair
   rejection and a pending-row reevaluation rejection.

6. **Placement in `evaluate_pair`**: checked immediately after `cadastral`
   and the D-116 reference-code conflict veto, and after the
   `address_coords`/`reference_code` positive-match loop — before
   `photo_hash` ever fetches a hash, and before `phone`. It is never
   placed ahead of cadastral or reference_code (the issue's explicit
   constraint: a government registry ID or an agency's own bookkeeping
   outranks a price/size/rooms heuristic) — proven by two PRE-EXISTING
   tests that needed no change for this issue:
   `TestAddressCoordsSignal.test_matching_coords_size_address_and_no_floor_data_auto_merges`
   (250000 vs 400000, a 60% price gap, still auto-merges via
   `address_coords`) and
   `TestReferenceCodeSignal.test_shared_reference_code_without_corroboration_is_suggestion`
   (150000 vs 600000, a 75% gap, still files a `reference_code`
   suggestion) — both signals return before this rule ever runs, purely
   from loop ordering, with no special-casing needed. It DOES run ahead
   of `photo_hash`/`phone` on purpose: those are exactly the signals a
   same-development "promoción" (many nearly-identical flats, nearly-
   identical photos, genuinely different prices/sizes/room counts) fools,
   and checking price/size/rooms first also means a rejected pair never
   triggers `photo_hash`'s real network fetch.

**Alternatives rejected**:
- Filing every rule-rejection as a `suggested_merge` row with a
  distinguishing `resolved_reason`, always. Rejected as the *default* per
  the issue's own stated preference (don't manufacture a decision record
  for a pair nothing ever really evaluated) — kept only for the
  already-`pending` case, where a row already exists and has to resolve
  to something.
- A `rooms` difference of exactly 1 counting as "differ", per a literal
  reading of the owner's unqualified "habitaciones diferentes". Rejected
  for consistency with D-117's own larger-sample measurement on the
  identical field, and because this session's own supplementary check
  found no evidence either way to override that prior.

**Rationale**: Mirrors D-116's placement discipline (strong, unambiguous
signals go first) and D-132/D-133's separation of "human decision, binding
and permanent" from "heuristic, reversible, and never auto-widening" —
applied here to a NEW heuristic with a real, non-trivial (if honestly
small) measured error rate.

**See**: issue #627, `etl/dedup/signals/price_gap.py`,
`etl/dedup/engine.py`'s `evaluate_pair`/`_run`/`_reevaluate_pending_suggestion`,
`etl/tests/test_dedup_signal_price_gap.py`,
`etl/tests/test_dedup_engine.py::TestPriceGapRule`, D-116, D-117, D-132,
D-133, D-137.
