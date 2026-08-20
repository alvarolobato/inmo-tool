---
id: D-130
title: Retire the fuzzy dedup signal; purge its backlog with a rescue set
date: 2026-08-20
group: Data / connectors
rule: "`etl.dedup.engine.evaluate_pair` no longer calls `fuzzy.evaluate` at all (deleted; only `normalize_address` survives, reused by `address_coords.py`). `ps dedup purge-fuzzy` / `engine.purge_pending_fuzzy` deletes pending `match_basis='fuzzy'` rows except a rescue set: exact `m2_built`+`current_price` cross-listing, corroborated by a shared photo hash or a near-identical description. D-117's veto stays (loses its only call site, not retired)."
---

# D-130: Retire the fuzzy dedup signal; purge its backlog with a rescue set

*Decided: 2026-08-20*

**Context**: Issue #601, evidence gathered in the #600 spike (an aggressive
data review of the 25,850-row dedup backlog, prompted by the owner not
believing the queue's size). `fuzzy` was **96.8%** of the pending
`suggested_merge` backlog (25,027 of 25,850 rows). Measured precision on a
stratified hand-labeled sample (n=582, degree-weighted): **~0.4-0.7% true
duplicates**. 561 of 569 sampled pairs with computable photo hashes on
both sides shared **zero** photos (and photo hashing itself is healthy —
99.9%/100% success on fotocasa/idealista, ruling out "photos are broken"
as the explanation); ~97% had unrelated descriptions.

The root cause is structural, not a threshold problem. fotocasa and
idealista publish neighbourhood-level address strings, not street
addresses: 3,981 fotocasa listings share only 372 distinct address
strings (~10.7 listings per string); idealista, 3,245 listings → 308
strings. 99.2% of the 25,028 pending fuzzy pairs carry no street number on
either side; 2,024 pairs have byte-identical address strings; the single
largest neighbourhood-pair bucket alone generates 567 pairs.
`token_sort_ratio >= 0.55` + m² ±10% + price ±20% against that input
percolates whole districts into one connected component — 4,787 of 5,324
involved listings end up in a single component, with ~80% of the backlog
being pure transitive redundancy (A~B, A~C, B~C for one real group).

`fuzzy` has **zero human confirmations ever**: every one of the 6,357
"rejected" fuzzy rows was the engine re-evaluating and auto-rejecting
under D-024, not a human decision. No threshold retune fixes an input
(neighbourhood-level text) that carries no unit-discriminating
information — the fix is to stop generating suggestions from it.

**Decision**:

1. `fuzzy.evaluate` is deleted (not just uncalled) — `etl/dedup/signals/
   fuzzy.py` now contains only `normalize_address` and the abbreviation
   table it needs, which `address_coords.py`'s `addresses_close` still
   imports and uses for its own, coordinate-gated match. `evaluate_pair`
   (`etl/dedup/engine.py`) no longer references the `fuzzy` module at all.
2. D-117 (`structured_fields_conflict`, the `property_type`/`rooms`
   contradiction veto) **stays** — it simply loses its only call site
   (fuzzy's `evaluate`) and is currently unreferenced from
   `evaluate_pair`'s pipeline. It is not retired: the live-DB blast-radius
   finding it encodes (property_type/rooms are noisy per-connector
   metadata, must never veto the stronger signals) remains true and worth
   keeping as a forward-looking guard, per the issue's own instruction.
3. A one-off migration, `ps dedup purge-fuzzy` (`engine.purge_pending_fuzzy`),
   deletes pending `match_basis='fuzzy'` rows except a **rescue set**:
   both listings' `m2_built` AND `current_price` are EXACTLY equal
   cross-listing, AND EITHER they share at least one photo
   (`photo_hash.hashes_share_any_match`, read from the persistent
   `photo_hashes` store — issue #221/D-025 — never a live fetch) OR their
   descriptions are near-identical (rapidfuzz `token_sort_ratio >= 0.90`).
   Exact price+size alone is not sufficient (common in a dense market by
   coincidence, per the percolation finding above); photo/description
   agreement alone (without exact price+size) is exactly the
   same-neighbourhood-different-unit shape this decision retires. Rescued
   rows stay `pending` with `match_basis` left at `'fuzzy'` (nothing else
   fired for them) and get a `rescued_reason` stamped into `detail` for
   whoever reviews them next.

**Alternatives rejected**:
- *Tighten `_MIN_TEXT_SIMILARITY` or require a street number* — there is
  no address-text signal to salvage at fotocasa/idealista's current
  granularity; any threshold still percolates on neighbourhood-token
  overlap, and requiring a street number would simply return `None` for
  99.2% of the corpus, which is functionally the same as retiring it.
- *Blanket-delete every pending fuzzy row* — measured 43 of 201
  exact-m²+price pairs are corroborated by real evidence (photo or
  description); deleting first and rescuing after (or not rescuing at
  all) would destroy real duplicates the backlog actually contains.
- *Wire `structured_fields_conflict` into `evaluate_pair` directly now
  that its old call site is gone* — out of scope for this decision and
  contrary to D-117's own finding (an engine-wide veto broke ~80
  already-correct merges in the live-DB measurement); left as a
  forward-looking guard only.

**Rationale**: A signal with ~0.5% precision, 96.8% of queue volume, zero
human confirmations ever, and a root cause (neighbourhood-granularity
addresses) that no threshold fixes is worth killing outright rather than
tuning. `photo_hash` (evaluated before phone as of D-131) already covers
the cross-portal duplicate-detection case whenever photos exist, which —
per the measurement above — is effectively always for a real duplicate.

**See**: `etl/dedup/engine.py` (`evaluate_pair`, `purge_pending_fuzzy`),
`etl/dedup/signals/fuzzy.py`, `etl/dedup/signals/photo_hash.py`
(`hashes_share_any_match`), `etl/dedup/cli.py` (`purge-fuzzy`), issue #600
(the spike), issue #601, D-024 (pending reevaluation), D-025 (photo hash
store), D-117 (structured-fields veto, kept dormant), D-131 (phone/photo
reorder, landed alongside this in the same PR).
