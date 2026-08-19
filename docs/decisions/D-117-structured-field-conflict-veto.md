---
id: D-117
title: Contradicting property_type or rooms>=2 vetoes a fuzzy suggestion only
date: 2026-08-19
group: Data / connectors
rule: 'A `property_type` mismatch across genuinely incompatible families (piso/atico is the one compatible pair; every other combination is incompatible) OR `rooms` differing by >=2 vetoes `etl.dedup.signals.fuzzy.evaluate` ONLY (returns None, no suggestion filed) — never wired into `evaluate_pair` ahead of address_coords/phone/reference_code/photo_hash, whose auto-merges must NOT be vetoed on these fields. A `rooms` difference of exactly 1 does NOT veto. Missing values on either side are permissive.'
---

# D-117: Contradicting `property_type` or `rooms>=2` vetoes a `fuzzy` suggestion only

*Decided: 2026-08-19*

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
loudly rather than burying it. This record documents the corrected design.**

**Decision**:

1. **`property_type` conflict**: `structured_fields.property_type_conflict(a,
   b)` is `True` only when both sides carry a `property_type` AND the two
   values are not the same "family". `property.property_type` is already
   canonicalized onto the schema's fixed CHECK vocabulary (`piso`,
   `chalet`, `atico`, `local`, `nave`, `garaje`, `terreno`, `edificio`) by
   every connector's own `map_property_type` at ingestion time — so the
   naive worry ("piso" vs "apartamento" as raw-text synonyms) does not
   apply; every connector already folds that onto one bucket before the
   row reaches this module.

   What IS real, verified against the live demo DB's pending-suggestion
   backlog: `piso`/`atico` is the one compatible family, not a naive `!=`.
   An ático is a floor-position variant of a flat (top floor), not a
   different kind of building the way a chalet or a nave is, and portals
   disagree in practice about which label to use for the same unit —
   Fotocasa's own `BUILDING_TYPE_MAP` separately maps `"Penthouse"` ->
   `"atico"` and `"Flat"`/`"Duplex"`/`"StudioFlat"` -> `"piso"`. 430
   pending fuzzy pairs carry `piso` against `atico` at confidences up to
   0.800, many with IDENTICAL `m2_built` AND `current_price` on both sides
   — vetoing on that combination would have broken likely-real duplicates.
   Every OTHER type combination in the same fuzzy backlog (`chalet`/`piso`:
   1,712 pairs; `atico`/`chalet`: 23; a handful of
   `piso`/`local`/`terreno`/`nave` combinations) was sampled by hand and
   reads as exactly what the issue predicted: weak same-neighbourhood-text
   fuzzy matches between genuinely different properties (disagreeing
   size/price, often different municipalities — e.g. Milanuncios'
   city-only "Sevilla, Sevilla" address text fuzzy-matching a listing
   actually in Carmona or Almensilla). None showed the size/price-agreement
   pattern the `piso`/`atico` pairs do.

2. **`rooms` conflict**: `structured_fields.rooms_conflict(a, b)` is `True`
   only when both sides carry `rooms` AND they differ by at least 2. A
   difference of exactly 1 is deliberately NOT a conflict — portals
   genuinely disagree on whether a study, an interior room, or a converted
   space counts as a "room" (6,728 pending pairs sit at exactly a 1-room
   difference, next to only 1,966 at >=2); vetoing on that tolerance would
   destroy real duplicates at scale.

3. **Absence is permissive on both checks** — mirrors `floor.floors_conflict`'s
   shape (issue #186) exactly: a missing `property_type` or `rooms` value
   on either side is "we don't know", never "they differ".

4. **Where it applies — the corrected part.** `structured_fields_conflict`
   is called from exactly ONE place: `etl.dedup.signals.fuzzy.evaluate`,
   after that signal's own address/size/price gates pass. It is
   deliberately **NOT** wired into `etl.dedup.engine.evaluate_pair` ahead
   of `address_coords`/`phone_extract`/`reference_code`/`photo_hash` the
   way the reference-code veto (D-116) is.

   **Why the reference-code shape doesn't transfer**: the mandatory
   blast-radius query (join `property_merge_log` to both the surviving AND
   the losing `property` row via `losing_property_id`, which is never
   deleted — see D-116's own note on that column) found `property_type`/
   `rooms` are noisy per-connector metadata that regularly disagree even on
   DEFINITE, strongly-corroborated duplicates: of 615 currently-merged
   properties, **76 (12.4%)** would have been blocked had the veto been
   engine-wide — **91 of the 99 flagging merge-log rows were `photo_hash`
   exact-match auto-merges** (issue #188: identical photo hash, identical
   `m2_built`, identical `current_price`), the remaining 8 split across
   `address_coords` (6) and `reference_code` (2). Concrete examples (all
   with identical price AND identical m2_built on both sides — see PR body
   for the full query and sample):
   - property 747/2045: fotocasa `piso` vs idealista `chalet`, both
     203.00 m2, both €375,000, matched via `photo_hash` (ratio 1.000).
   - property 58 (a 15-listing cluster spanning fotocasa/idealista/
     habitaclia, all 94.00 m2, all €165,000): several fotocasa listings
     carry `property_type='chalet'` while the rest of the cluster carries
     `'piso'` — matched via `photo_hash`/`reference_code`.
   - property 128/129/137 (three fotocasa listings of the SAME property,
     scraped at different times): `rooms` recorded as `0` on one scrape,
     `4` on another, same address/price — matched via `address_coords`.

   Reference codes are an agency's own authoritative CRM bookkeeping
   (D-116's justification for the hard, engine-wide shape); `property_type`
   and `rooms` are not — they are extracted/mapped per-connector fields
   that visibly disagree even when every other signal (identical photos,
   coordinates, an agency reference code) proves the SAME real unit.
   Vetoing those signals on this evidence would have broken ~76
   already-correct merges for no benefit.

   `fuzzy` is the one signal where the issue's own reasoning holds without
   this risk: no merge in the live DB has ever been made via
   `match_basis='fuzzy'` (it never auto-merges, confidence capped at
   0.590), so scoping the veto there carries **zero** blast radius against
   already-merged properties, while still clearing **3,666** of the 27,517
   pending `fuzzy` suggestions (13.3%) — real, structured-field-contradicted
   noise in exactly the population issue #566 measured (weak,
   address-text-only matches where price/size happen to align by
   coincidence).

5. **Effect on an existing `pending` `suggested_merge` row**: no new code
   path — D-024 already re-evaluates every `pending` row on every `run()`.
   A `fuzzy`-basis row whose pair now trips this veto gets a fresh
   `evaluation is None` from `evaluate_pair` (via `fuzzy.evaluate`
   returning `None`) and is demoted to `status='rejected'`, the same
   mechanism issue #186's floor veto and D-116's reference-code veto
   already exercise. A pending row on any OTHER `match_basis` is
   unaffected — this veto never fires for those signals at all.

6. **Effect on an already-merged property: none — by construction, not just
   by policy.** Since no merge has ever gone through `fuzzy`, and this
   veto is unreachable from every other signal's code path, there is no
   scenario in the current codebase where this change could affect an
   already-merged property. Measured: **0 of 615** currently-merged
   properties are affected (vs. the 76 the rejected engine-wide shape
   would have blocked).

**Alternatives rejected**:
- *The engine-wide hard veto originally planned* (ahead of every signal,
  mirroring D-116) — rejected on measured evidence: 76/615 (12.4%)
  currently-merged properties, overwhelmingly matched via `photo_hash`
  exact-match auto-merge, would have been blocked. See point 4 above for
  the query and sampled pairs.
- *A naive `property_type != property_type` veto with no family
  grouping* — rejected: it would additionally have vetoed 430 `piso`/
  `atico` pairs, a meaningful fraction of which (same neighbourhood,
  identical size and price) read as likely real duplicates, not two
  properties.
- *Vetoing on a `rooms` difference of exactly 1* — rejected per the
  issue's own explicit instruction and the measured 6,728-pair tolerance
  population.
- *A distance/geocoding veto* — explicitly rejected by the owner (see
  Context above); not implemented, not considered here.

**Rationale**: `property_type` and `rooms` are per-connector extracted/
mapped fields, not an agency's own authoritative record (contrast D-116's
reference codes) — they are reliable enough to discriminate between two
otherwise-weakly-matched listings (fuzzy address-text similarity alone),
but not reliable enough to override signals with independent, much
stronger corroboration (matching coordinates, an agency reference code, or
an exact photo hash). The one place this needed care beyond the
signal-placement question was `property_type`'s `piso`/`atico` ambiguity,
checked against the live corpus rather than assumed.

**See**: `etl/dedup/signals/structured_fields.py`
(`property_type_conflict`, `rooms_conflict`, `structured_fields_conflict`),
`etl/dedup/signals/fuzzy.py` (`evaluate`, the only call site), issue #566,
issue #186 (`floor.floors_conflict`, the permissive-on-absence shape this
mirrors), D-024 (pending-suggestion re-evaluation), D-116 (the
reference-code veto whose engine-wide shape this decision explicitly does
NOT copy, and why).
