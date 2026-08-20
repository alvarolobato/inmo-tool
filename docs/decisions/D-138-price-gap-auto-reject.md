---
id: D-138
title: Auto-reject a dedup pair on a large price gap, corroborated by size/rooms
date: 2026-08-20
group: Data / connectors
rule: "`evaluate_pair` rejects a pair outright when price differs by more than 30%, or by 15%+ AND (m2_built differs by >=5% OR rooms differ by >=2 — owner-confirmed, not exactly 1: reuses `structured_fields.rooms_conflict`) — checked after cadastral/D-116 AND after address_coords/reference_code's own positive-match loop, before photo_hash/phone (the one auto-merge tier this genuinely preempts is phone's coords-corroborated particular tier — photo_hash's own 5% price band makes it structurally immune). A rule-based rejection is NEVER filed as a `suggested_merge` row for a brand-new pair, is DELETED (never frozen as `rejected`) for an already-`pending` row on reevaluation — reversible without a DB console, per the issue's own requirement — and NEVER creates a `property_merge_veto`. Counted in `ps dedup run`, the orchestrator log line, AND a persisted `dedup_runs.price_gap_rejected` column (`DedupRunResult.price_gap_rejected`, issue #627)."
---

# D-138: Auto-reject a dedup pair on a large price gap, corroborated by size/rooms

*Decided: 2026-08-20*

**Status note on the rooms threshold**: the owner's phrasing
("habitaciones diferentes") is unqualified — it does not say by how much.
That gap was not overlooked: it was surfaced to him explicitly as a
choice, with D-117's measurement and the portal-miscounting reasoning
behind it (see Decision point 2 below), and **he confirmed keeping the
existing >=2 threshold** ("dejamos las habitaciones en 2"), not exactly
1. Read the rooms leg below as a confirmed decision, not an unresolved
deviation.

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
   second implementation** — and its threshold (difference of at least 2,
   never exactly 1) is a considered, owner-confirmed choice, not a gap
   the literal instruction left open. The owner's own phrasing
   ("habitaciones diferentes también afectan") is unqualified — read
   literally it would veto on ANY difference, including exactly 1. That
   literal reading was surfaced to him explicitly, with the numbers
   below, rather than silently resolved either way: **he confirmed
   keeping the threshold at 2** ("dejamos las habitaciones en 2").

   The evidence behind that call: `rooms=0` is already treated as unknown
   (D-117's "B3": a scrape artifact affecting 20.7% of properties, not a
   genuine studio count), and D-117 measured this exact field at scale —
   issue #566 found 6,728 pending pairs differing by exactly 1 room
   against only 1,966 differing by >=2. Taking "diferentes" literally
   would more than triple this rule's reach on the rooms leg alone. The
   reason a 1-room difference is weak evidence, not just a smaller
   number: portals count rooms differently — one includes the living
   room, another counts a box room or a study that another doesn't — so
   a 1-room gap is routinely portal noise about the SAME flat, not
   evidence of two different ones. Vetoing on that tolerance would cost
   real recall without buying real precision.

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
   confirms nor contradicts D-117's own larger-sample finding**, and was
   presented to the owner as exactly that: not evidence for >=2, just
   evidence that couldn't argue against it. The >=2 choice rests on
   D-117's larger prior plus the owner's explicit confirmation, not on
   this thin sample — if better data arrives, that prior (not this
   session's 59/1) is what to re-measure against.

3. **A rule-based rejection is never filed as a `suggested_merge` row for
   a brand-new pair.** `evaluate_pair` returns a `PairEvaluation` with
   `decision='reject'`; `_run`'s dispatch counts it
   (`DedupRunResult.price_gap_rejected`) and `continue`s — no INSERT, no
   `suggested_merge_action`, nothing. The pair never enters the review
   queue, nothing is recorded as a decision, and a later data change
   (price correction, a merge upstream) re-opens it naturally on the next
   run — the issue's own preferred option, taken as-is. Point 4 below
   describes the one other case (an already-`pending` row), which after
   review M1 lands on this SAME behaviour rather than the fallback the
   issue offered as an alternative — see point 4 for why.

4. **An existing `pending` row the rule now rejects on reevaluation** (a
   row an earlier, weaker signal filed before this rule existed, or
   before a later price/size update) is **DELETED**, not moved to
   `status='rejected'`. This is a correction (review M1): the first
   version of this record had `_reevaluate_pending_suggestion` move the
   row to `rejected` with a distinguishing `resolved_reason`, and that
   was wrong against the issue's own explicit requirement — *"it must be
   reversible without a DB console."* A `rejected` row is NOT reversible
   in practice: D-024's `_load_recorded_pairs` puts a `rejected` listing
   pair in `skip_pairs` forever, the dashboard's review queue only ever
   lists `status='pending'` rows, and `ps dedup` has `unveto` but no
   `unreject`. A heuristic with a measured ~3.4% contradiction rate
   against the owner's own merges must not get to permanently close a
   door with no handle on the other side. Deleting instead gives an
   already-`pending` pair the SAME behaviour as a brand-new pair the rule
   rejects (point 3 above): simply absent from `suggested_merge`, free to
   be re-suggested the moment the underlying data changes — one
   behaviour, not two, and genuinely reversible (proven by a DB-backed
   test that deletes, corrects the price, re-runs, and confirms the pair
   is suggestible again — no DB console involved at any step). This does
   NOT go through the `purge_pending_fuzzy` rescue exemption
   (`_reevaluate_pending_suggestion`'s `is_rescued` branch) — a rescue row
   is corroborated by evidence no live signal was ever going to
   re-derive; `price_gap`'s evidence is a genuine, fresh contradiction on
   the SAME fields the rescue never looked at.

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
   and the D-116 reference-code conflict veto, and AFTER (not before —
   the first version of this record garbled this and read as though
   price_gap preceded `address_coords`) the `address_coords`/
   `reference_code` positive-match loop — before `photo_hash` ever
   fetches a hash, and before `phone`. It is never placed ahead of
   cadastral or reference_code (the issue's explicit constraint: a
   government registry ID or an agency's own bookkeeping outranks a
   price/size/rooms heuristic) — proven by two PRE-EXISTING tests that
   needed no change for this issue:
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

   **Reconciling this with D-117's placement rule (review M3).** D-117's
   binding rule is explicit that a `rooms`/`property_type` conflict is
   *"never wired into `evaluate_pair` ahead of
   address_coords/phone/reference_code/photo_hash, whose auto-merges must
   NOT be vetoed on these fields"* — measured, on that record, to break
   ~80 correct merges (13.6% of 590) if it had been. This decision DOES
   wire a rooms-based condition (as part of price_gap's rule 2) ahead of
   `photo_hash`/`phone`, which reads as a direct contradiction unless the
   difference in *exposure* is made explicit, so here it is:

   - **`address_coords`/`reference_code` are unaffected** — checked
     earlier in the very same loop, they return before price_gap is ever
     reached (the two pre-existing tests above prove this, not an
     assertion).
   - **`photo_hash`'s auto-merge is structurally immune to price_gap's
     rule 2** (the >=15%-plus-corroboration leg, the one carrying a rooms
     condition): it requires price within `PHOTO_MERGE_PRICE_RATIO` (5%
     on `main` — D-137). A price gap that clears photo_hash's own 5% band
     can never also clear price_gap's >=15% floor, so the rooms condition
     is never even reached for a pair on that path. Rule 1 (price >30%)
     is equally moot there for the same reason.
   - **`phone`'s corroborated-agency and uncorroborated tiers are also
     immune**: D-131 already returns `None` for both (no suggestion, no
     merge), so price_gap never gets a chance to preempt anything there
     either way.
   - **The one path this decision genuinely CAN preempt: `phone`'s
     coords-corroborated `particular`/`particular` merge tier**
     (`phone_extract._corroborated`'s coords+size branch,
     `phone_extract.evaluate`'s `particular`/`particular` branch). Unlike
     every other auto-merge path in this pipeline, that specific tier has
     **no price constraint at all** — shared phone + coords within ~15m +
     size within 5% + both sides `particular` merges at 0.900 regardless
     of price. A >30% (or >=15%-plus-rooms) price gap on such a pair now
     gets rejected by price_gap instead. This population is real but
     small, and — importantly — it was **never part of the 88-merge/
     62-rejection measurement this decision otherwise leans on**, which
     counted the owner's genuine human confirms/rejects from the review
     queue, not every technically-reachable auto-merge path. Pinned by a
     DB-backed test
     (`TestPriceGapRule.test_phone_coords_corroborated_particular_merge_is_the_one_preemptable_path`)
     that first confirms `phone_extract.evaluate` alone WOULD merge the
     constructed pair, then confirms `evaluate_pair` rejects it via
     price_gap instead — so the claim is demonstrated, not just asserted.

   D-117's own rule stands as written and is unaffected — it still
   applies to its one call site (the retired `fuzzy` signal, kept as a
   forward-looking guard per that record) and this decision does not
   change or relax it. What changes here is that price_gap is a
   DIFFERENT rule, on different (if overlapping) evidence, accepting a
   narrower, explicitly measured/documented exposure on one specific
   auto-merge tier — not a reversal of D-117's placement reasoning.

**Alternatives rejected**:
- Filing every rule-rejection as a `suggested_merge` row with a
  distinguishing `resolved_reason`, always. Rejected per the issue's own
  stated preference (don't manufacture a decision record for a pair
  nothing ever really evaluated).
- (Review M1 correction) Moving an already-`pending` row the rule rejects
  to `status='rejected'` with a `resolved_reason`, instead of deleting
  it. This was this record's OWN first choice and it was wrong: the
  issue requires reversibility "without a DB console", and a `rejected`
  row is frozen forever by D-024's `skip_pairs` with no `unreject`
  command to undo it — see point 4 above for the corrected behaviour
  (delete, not reject-with-reason).
- A `rooms` difference of exactly 1 counting as "differ" — the literal
  reading of the owner's unqualified "habitaciones diferentes". This was
  the one point in the issue genuinely left open by his wording, so it
  was surfaced to him explicitly (D-117's 6,728-vs-1,966 measurement, the
  portal-miscounting explanation for why a 1-room gap is weak evidence,
  and this session's own inconclusive 59/1 supplementary sample) rather
  than resolved unilaterally either way. **He confirmed keeping the
  threshold at 2** ("dejamos las habitaciones en 2") — not overlooked,
  considered and rejected on the evidence above.

**Rationale**: Mirrors D-116's placement discipline (strong, unambiguous
signals go first) and D-132/D-133's separation of "human decision, binding
and permanent" from "heuristic, reversible, and never auto-widening" —
applied here to a NEW heuristic with a real, non-trivial (if honestly
small) measured error rate.

**See**: issue #627, `etl/dedup/signals/price_gap.py`,
`etl/dedup/engine.py`'s `evaluate_pair`/`_run`/`_reevaluate_pending_suggestion`,
`etl/orchestrator.py`'s `_finish_dedup_run`/`run_dedup` (the persisted
`dedup_runs.price_gap_rejected` column, `etl/schema/init.sql`, mirroring
#624's own `photo_hash_auto_merged` fix), `etl/tests/test_dedup_signal_price_gap.py`,
`etl/tests/test_dedup_engine.py::TestPriceGapRule`, D-116, D-117, D-132,
D-133, D-137.
