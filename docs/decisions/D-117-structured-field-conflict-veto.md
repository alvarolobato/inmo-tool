---
id: D-117
title: Contradicting property_type or rooms>=2 vetoes a fuzzy suggestion only
date: 2026-08-19
group: Data / connectors
rule: 'A `property_type` mismatch across genuinely incompatible families (piso/atico is the one compatible pair) vetoes `etl.dedup.signals.fuzzy.evaluate` ONLY, UNLESS `m2_built` AND `current_price` are BOTH exactly equal on both sides (a portal type-mapping quirk, not two properties). `rooms` differing by >=2 (treating `0` as unknown, same as `None`) also vetoes `fuzzy.evaluate` only. Never wired into `evaluate_pair` ahead of address_coords/phone/reference_code/photo_hash, whose auto-merges must NOT be vetoed on these fields. A `rooms` difference of exactly 1 does NOT veto. Missing/unusable values are permissive.'
---

# D-117: Contradicting `property_type` or `rooms>=2` vetoes a `fuzzy` suggestion only

*Decided: 2026-08-19. Amended same day after PR #567's independent review (B1/B3 below).*

**Status note (2026-08-20, issue #607/S3, requested by #601):** D-130
deleted `etl.dedup.signals.fuzzy.evaluate` outright (issue #601, PR #607)
— the ONLY call site this decision's point 4 names. `structured_fields_conflict`
is therefore currently **DORMANT**: reachable from nothing in
`evaluate_pair`'s pipeline, exactly as D-130 itself already documents
("D-117's veto stays (loses its only call site, not retired)"). This is not
a bug and this decision is not being retired — the live-DB blast-radius
finding it encodes (`property_type`/`rooms` are noisy per-connector
metadata that must never veto the stronger signals: address_coords,
reference_code, photo_hash, phone) remains true and worth keeping as a
forward-looking guard for any future signal shaped like `fuzzy` (address-
text-similarity-driven, no independent corroboration). Every "vetoes
`etl.dedup.signals.fuzzy.evaluate` ONLY" reference below should be read as
"vetoed fuzzy.evaluate while that function existed; the veto itself is
unchanged code, just currently unreachable."

**Context**: Issue #566, raised by the owner after asking whether any rule
could be extracted from the pending-suggestion backlog rather than
reviewing it by hand. Measured against the live demo DB: 27,145 pending
`suggested_merge` rows, 97.1% `match_basis='fuzzy'`. Price and size are
already gates on that signal (zero fuzzy pairs differ by >25% in price or
>20% in `m2_built`), so the backlog is not vague text matches — it's pairs
that agree on price and size and differ elsewhere. 40% of it (10,467 pairs)
carries a contradicting structured field: `property_type` differs on 2,112
pairs, `rooms` differs by >=2 on 1,966, and by exactly 1 on 6,728 (a
deliberately-not-vetoed tolerance — see below).

A distance/geocoding veto was proposed and explicitly rejected by the owner
("no me creo la geocodificación") — verified: 146 distinct properties share
one exact coordinate, 2,673 sit on a point shared by more than 5
(municipality/neighbourhood-centroid geocoding). This decision does not
touch coordinates at all.

**The issue's plan asked for a hard veto shaped like the reference-code veto
(issue #564/D-116) — checked ahead of every signal in `evaluate_pair`. The
mandatory pre-merge blast-radius measurement found that shape would have
been wrong for this data, and the issue explicitly requires reporting that
loudly rather than burying it. This record documents the corrected design,
then a second round of review findings (B1/B3) that corrected the FAMILY
DEFINITION itself.**

**Decision**:

1. **`property_type` conflict**: `structured_fields.property_type_conflict(a,
   b)` is `True` only when both sides carry a `property_type`, the two
   values are not the same "family", AND `m2_built`/`current_price` do NOT
   both agree exactly (point 8, B1, below). `property.property_type` is
   already canonicalized onto the schema's fixed CHECK vocabulary (`piso`,
   `chalet`, `atico`, `local`, `nave`, `garaje`, `terreno`, `edificio`) by
   every connector's own `map_property_type` at ingestion time — so the
   naive worry ("piso" vs "apartamento" as raw-text synonyms) does not
   apply; every connector already folds that onto one bucket before the
   row reaches this module.

   `piso`/`atico` is the one compatible family: an ático is a
   floor-position variant of a flat (top floor), not a different kind of
   building the way a chalet or a nave is, and portals disagree in
   practice about which label to use for the same unit — Fotocasa's own
   `BUILDING_TYPE_MAP` separately maps `"Penthouse"` -> `"atico"` and
   `"Flat"`/`"Duplex"`/`"StudioFlat"` -> `"piso"`.

2. **`rooms` conflict**: `structured_fields.rooms_conflict(a, b)` is `True`
   only when both sides carry a USABLE `rooms` value (point 9, B3, below)
   AND they differ by at least 2. A difference of exactly 1 is
   deliberately NOT a conflict — portals genuinely disagree on whether a
   study, an interior room, or a converted space counts as a "room"
   (6,728 pending pairs sit at exactly a 1-room difference, next to only
   1,966 at >=2); vetoing on that tolerance would destroy real duplicates
   at scale. **PR #567's review confirmed no off-by-one at this threshold
   (diff 0 and 1 both pass, diff 2 conflicts) — left exactly as originally
   designed.**

3. **Absence/unusability is permissive on both checks** — mirrors
   `floor.floors_conflict`'s shape (issue #186): a missing `property_type`,
   a missing `rooms`, or (point 9) a `rooms=0` value on either side is "we
   don't know", never "they differ".

4. **Where it applies**: `structured_fields_conflict` is called from
   exactly ONE place: `etl.dedup.signals.fuzzy.evaluate`, after that
   signal's own address/size/price gates pass. It is deliberately **NOT**
   wired into `etl.dedup.engine.evaluate_pair` ahead of
   `address_coords`/`phone_extract`/`reference_code`/`photo_hash` the way
   the reference-code veto (D-116) is.

   **Why the reference-code shape doesn't transfer**: the mandatory
   blast-radius query (join `property_merge_log` to both the surviving AND
   the losing `property` row via `losing_property_id`, which is never
   deleted — see D-116's own note on that column) found `property_type`/
   `rooms` are noisy per-connector metadata that regularly disagree even on
   DEFINITE, strongly-corroborated duplicates. **PR #567's review
   independently reproduced this measurement**: 104 non-reverted
   merge-log rows carry a type/rooms contradiction, touching 80 of 590
   currently-merged properties (13.6% — my original figure was 76/615,
   12.4%; both reproduce within live-DB drift between measurements). 97 of
   97 type-conflicting merge-log rows are `chalet`/`piso` — ALL of them,
   the exact pair the original version of this decision called "sampled
   by hand, genuinely different properties." 7 merge-log rows conflict on
   `rooms>=2` (a much smaller population than type's 97).

   Reference codes are an agency's own authoritative CRM bookkeeping
   (D-116's justification for the hard, engine-wide shape); `property_type`
   and `rooms` are not — they are extracted/mapped per-connector fields
   that visibly disagree even when every other signal (identical photos,
   coordinates, an agency reference code) proves the SAME real unit.

   `fuzzy` is the one signal where the issue's own reasoning holds without
   this risk: no merge in the live DB has ever been made via
   `match_basis='fuzzy'` (it never auto-merges, confidence capped at
   0.590), so scoping the veto there carries **zero** blast radius against
   already-merged properties.

5. **Effect on an existing `pending` `suggested_merge` row**: no new code
   path — D-024 already re-evaluates every `pending` row on every `run()`.
   A `fuzzy`-basis row whose pair now trips this veto gets a fresh
   `evaluation is None` from `evaluate_pair` (via `fuzzy.evaluate`
   returning `None`) and is demoted to `status='rejected'`, the same
   mechanism issue #186's floor veto and D-116's reference-code veto
   already exercise. A pending row on any OTHER `match_basis` is
   unaffected — this veto never fires for those signals at all. **60
   pending `photo_hash` rows and 42 pending `phone` rows also carry a
   structured-field contradiction (re-measured post-B1/B3: 45 and 33
   respectively, live-DB drift) — deliberately left untouched, for the
   same blast-radius reason as point 4: those signals' own corroboration
   (an exact/partial photo match, a shared phone number) is independent,
   often stronger, evidence this veto must not override.**

6. **Effect on an already-merged property: none — by construction, not just
   by policy.** Since no merge has ever gone through `fuzzy`, and this
   veto is unreachable from every other signal's code path, there is no
   scenario in the current codebase where this change could affect an
   already-merged property. Measured: **0 of 590** currently-merged
   properties are affected (vs. the 80 an engine-wide shape would have
   blocked, independently confirmed by the review).

7. **Cleared pending backlog, re-measured after B1/B3**: **3,469** of
   27,517 pending `fuzzy` rows (12.6% — down from the pre-fix 3,666; the
   B1 exemption and B3's `rooms=0` fix both remove pairs from the cleared
   set that should never have been vetoed). **Two pairs in the
   re-measured cleared set still carry identical `m2_built` AND
   `current_price`** (reported explicitly per the review's instruction,
   not glossed over): both are `rooms`-conflict-only (type agrees as
   `piso`/`piso` on both), with genuine non-placeholder room counts 4 vs 1
   and 1 vs 3 — a 3- and a 2-room difference respectively, not a `0`
   artifact. This is left as-is: the review's own guidance was to keep the
   `rooms>=2` threshold exactly as designed (no off-by-one, confirmed
   correct), and the evidence for a rooms-specific price/size gate is far
   weaker than what justified B1 for type — 2 pairs out of 3,469 (0.06%)
   versus the 24 out of 3,709 (0.65%) that justified B1, and only 7
   rooms-conflicting merge-log rows total (vs. 97 for type) in the
   currently-merged population. A future review with more evidence could
   revisit this; not done here.

8. **B1 — the price/size gate on `property_type_conflict` (added after
   PR #567's review).** The ORIGINAL version of this decision exempted
   only `piso`/`atico`, on the theory (sampled by hand against the
   pending backlog) that every OTHER type-conflicting pair was genuinely
   different properties. The review falsified that with the merge-log
   evidence in point 4 (97 of 97 = `chalet`/`piso`) and a second
   measurement: comparing identical-m²/identical-price rates for
   `piso`/`atico` vs. `chalet`/`piso` PENDING `fuzzy` pairs shows the two
   populations are **statistically indistinguishable** on that metric —
   `piso`/`atico`: 424 pairs, 1 exactly identical (0.2%); `chalet`/`piso`:
   1,718 pairs, 21 exactly identical (1.2%). The `piso`/`atico`-only
   family allowlist was overfit to the one pair this decision's original
   investigation happened to sample, not principled.

   Rather than special-case a second family (which the review also
   offered as an option — the owner explicitly deferred to the more
   general fix), `property_type_conflict` now ALSO exempts any pair whose
   `m2_built` AND `current_price` are BOTH exactly equal, regardless of
   which two type labels are involved: `pisos.com` mapping *casa
   adosada* to `chalet` where `fotocasa` maps the identical unit to
   `piso` (verified, e.g. review's suggestion 5481: listing 157003
   (pisos) vs 157086 (fotocasa), identical description text, both 90 m²,
   both €260,000) is the same failure mode as `piso`/`atico` — a
   portal-vocabulary quirk, not evidence of two properties. The exemption
   is deliberately EXACT equality, not a tolerance band: a merely-close
   match (which `fuzzy.evaluate`'s own gates already require just to
   reach this check — up to 10% size / 20% price) is not strong enough
   evidence on its own to override a genuine type contradiction (this
   decision's own `chalet`/`piso` sampling, before B1, found real
   different-property pairs well inside those looser tolerances). NOT
   applied to `rooms_conflict` — see point 7's reasoning for why that
   risk is a single different mechanism (B3), not a generalizable
   price/size pattern.

9. **B3 — `rooms=0` is a scrape artifact, not a room count (added after
   PR #567's review).** 2,578 of 12,480 properties (20.7%) carry
   `rooms=0`. The review caught the SAME fotocasa listing (property
   121/128 in the merge-log evidence, point 4) scraped twice — once with
   `rooms=0`, once with `rooms=4` — i.e. `0` behaves as a missing-value
   placeholder for at least one connector's extraction path, not a
   genuine studio count. `rooms_conflict` now treats `0` identically to
   `None` on either side via `_usable_rooms`. 219 of the original 3,666
   cleared pairs were cleared *solely* because one side had `rooms=0` —
   those are no longer vetoed.

10. **Factual corrections to the original write-up** (per the review):
    - "430 pending fuzzy pairs carry `piso` against `atico` at
      confidences up to 0.800" was WRONG — `fuzzy._MAX_CONFIDENCE` caps
      at 0.590 and the live max for `match_basis='fuzzy'` `piso`/`atico`
      pairs is exactly 0.590. Traced the error: `0.800` is the confidence
      of suggestion id 6473, whose `match_basis` is `photo_hash`, not
      `fuzzy` — the original query that produced the "430...up to 0.800"
      claim did not filter by `match_basis`, silently mixing populations.
      The corrected, `fuzzy`-only figures are in point 8 above (424
      pairs, 1 identical).
    - "many with IDENTICAL m2_built AND current_price" for `piso`/`atico`,
      contrasted with "none showed [that] pattern" for `chalet`/`piso` —
      WRONG in both directions: `piso`/`atico` has exactly 1 of 424
      (0.2%) identical pairs; `chalet`/`piso` has 21 of 1,718 (1.2%) —
      i.e. `chalet`/`piso` is not lower on this metric, it's higher. The
      two populations are statistically indistinguishable, which is
      exactly why B1 (a general price/size gate) is the right fix and a
      second family entry would not have been.

**Alternatives rejected**:
- *The engine-wide hard veto originally planned* (ahead of every signal,
  mirroring D-116) — rejected on measured evidence: 76-80/590-615
  (12.4%-13.6%, two independent measurements) currently-merged properties,
  overwhelmingly matched via `photo_hash` exact-match auto-merge or
  `address_coords`/`reference_code`, would have been blocked.
- *Adding `chalet`/`piso` as a second compatible family* — considered as
  the direct alternative to B1's price/size gate, and rejected in favour
  of the gate: a family entry only covers the ONE pair with evidence
  today, while the price/size gate generalizes to any future
  connector-vocabulary mismatch without needing a new decision each time
  one is found, and doesn't weaken the veto for `chalet`/`piso` pairs
  that genuinely disagree on price or size (which the pre-B1 sampling
  showed are real, different properties).
- *A naive `property_type != property_type` veto with no family
  grouping* — rejected: it would additionally have vetoed 424 `piso`/
  `atico` pending pairs, of which at least 1 is a confirmed likely
  duplicate.
- *Vetoing on a `rooms` difference of exactly 1* — rejected per the
  issue's own explicit instruction; independently confirmed correct by
  the review (no off-by-one at the diff-2 threshold).
- *A distance/geocoding veto* — explicitly rejected by the owner (see
  Context above); not implemented, not considered here.

**Rationale**: `property_type` and `rooms` are per-connector extracted/
mapped fields, not an agency's own authoritative record (contrast D-116's
reference codes) — reliable enough to discriminate between two
otherwise-weakly-matched listings (fuzzy address-text similarity alone),
but not reliable enough to override signals with independent, much
stronger corroboration (matching coordinates, an agency reference code, an
exact photo hash, or — B1's addition — an exact size+price match even
under a weak text-similarity signal). B3 extends the same
permissive-on-absence discipline `floors_conflict`/`reference_codes_conflict`
already apply to a value that LOOKS present but is actually a per-connector
placeholder.

**See**: `etl/dedup/signals/structured_fields.py`
(`property_type_conflict`, `rooms_conflict`, `structured_fields_conflict`,
`_identical_size_and_price`, `_usable_rooms` — see the module's own
docstring sections "B1"/"B3" for the code-level version of this
reasoning), `etl/dedup/signals/fuzzy.py` (`evaluate`, the only call site),
issue #566, PR #567 (both blast-radius rounds, before and after B1/B3),
issue #186 (`floor.floors_conflict`, the permissive-on-absence shape this
mirrors), D-024 (pending-suggestion re-evaluation), D-116 (the
reference-code veto whose engine-wide shape this decision explicitly does
NOT copy, and why).
