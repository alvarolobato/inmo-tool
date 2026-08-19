"""Structured-field contradiction predicates (issue #566).

Two listings whose *published, structured* fields actively contradict each
other are not the same property — but ONLY when the match evidence is
otherwise weak (address-text similarity alone), and ONLY when size/price
don't already say "obviously one property" (see the price/size gate on
`property_type_conflict` below, added after PR #567's review — B1).
`property_type_conflict`/`rooms_conflict`/`structured_fields_conflict` are
pure predicates, permissive on absence exactly like `floor.floors_conflict`
(issue #186): a missing (or, for `rooms`, unusable — see B3 below) value on
either side is "we don't know", never "they differ".

Unlike the reference-code veto (issue #564/D-116), this is deliberately
**NOT** wired into `etl.dedup.engine.evaluate_pair` ahead of every signal.
It is called from exactly one place: `etl.dedup.signals.fuzzy.evaluate` —
see that module's docstring for the full reasoning, but in short: a live-DB
blast-radius measurement (required by issue #566 before merge) found
`property_type`/`rooms` are noisy per-connector metadata that regularly
disagree even on definite, strongly-corroborated duplicates matched by
address_coords/reference_code/photo_hash (identical photos, price, and
size) — an engine-wide veto would have broken ~80 of 590 currently-merged
properties (PR #567's review reproduced this independently: 104 merge-log
rows, 80 properties, 13.6%). Fuzzy is the one signal where the issue's own
reasoning holds: price/size are already gated there (zero fuzzy pairs in
the backlog differ by >25% in price or >20% in m2_built), so a
contradicting `property_type` or `rooms` reaching that point is USUALLY a
structured fact two portals agree to disagree on, not textual noise — and
fuzzy is 97.1% of the 27,145-row pending-suggestion backlog this issue
targets.

Three rules:

1. **`property_type` differs on both sides, the two values are not the same
   "family", AND size+price do NOT already agree exactly -> conflict.**
   See `_COMPATIBLE_TYPE_FAMILIES` and the price/size gate below for why
   neither a naive `!=` nor a family allowlist alone is safe.
2. **`rooms` differs by >= `_ROOMS_CONFLICT_MIN_DIFF` (2) -> conflict**,
   after treating `0` the same as missing (B3 below). A difference of
   exactly 1 is deliberately NOT a conflict — portals genuinely disagree on
   whether a study, an interior room, or a converted space counts as a
   "room", and vetoing on that tolerance would destroy real duplicates at
   scale (issue #566 measured 6,728 pending pairs at exactly a 1-room
   difference, next to only 1,966 at >=2).
3. **Missing/unusable values are permissive on both rules.**

## B1 — the price/size gate on `property_type_conflict` (post-review fix)

The original version of this module exempted only the `piso`/`atico`
family from the type veto, on the theory that every OTHER type-conflicting
pair in the live backlog was "genuinely different properties, sampled by
hand." PR #567's independent review falsified that: of every real,
currently-merged property this veto would have blocked, **100% (97 of 97
type-conflicting merge-log rows) were `chalet`/`piso`** — the exact pair
this module claimed was safe to veto — and a live-DB comparison of
identical-m2/identical-price rates for `piso`/`atico` vs. `chalet`/`piso`
pending pairs showed the two populations are **statistically
indistinguishable** on that metric (both ~1-2% exactly identical, both
~10-12% within 5%). The `piso`/`atico`-only family allowlist was not
principled; it was overfit to the one pair issue #566's own investigation
happened to sample.

The fix generalizes instead of special-casing a second pair: `pisos.com`
mapping *casa adosada* to `chalet` where `fotocasa` maps the identical unit
to `piso` (verified pattern, e.g. PR #567 review's suggestion 5481: listing
157003 (pisos) vs 157086 (fotocasa), identical description text, both 90
m², both €260,000) is exactly the same failure mode as the `piso`/`atico`
case — a portal-vocabulary quirk, not evidence of two properties. **A pair
whose `m2_built` AND `current_price` are BOTH exactly equal is such strong
independent evidence of being one property that a `property_type` label
disagreement must not override it**, regardless of which two type labels
are involved. This is the same principle `photo_hash`'s issue #188
auto-merge and `address_coords`' address+coords+size checks already act
on — corroborating structured facts (photos, coordinates, and now
exact-match size+price) outrank a noisier field. `rooms_conflict` is NOT
given the same gate: the currently-merged-property risk there was a single
mechanism (B3's `rooms=0` scrape artifact, fixed directly below), not a
generalizable price/size-agreement pattern, and the review found only 7
rooms>=2-conflicting merge-log rows total (vs. 97 for type).

## B3 — `rooms = 0` is a scrape artifact, not a room count (post-review fix)

2,578 of 12,480 properties (20.7%) carry `rooms = 0`. That is not "zero
bedrooms" at any real rate the connectors report reliably — the review
caught the same fotocasa listing (property 121/128 in this issue's own
merge-log evidence) scraped twice with `rooms=0` then `rooms=4`, i.e. `0`
behaves as a missing-value placeholder for at least one connector's
extraction path, not a genuine studio count. `rooms_conflict` now treats
`0` identically to `None` on either side — "we don't know", never "they
differ" — via `_usable_rooms` below.
"""

from __future__ import annotations

from etl.dedup.types import ListingRecord

# property.property_type's CHECK vocabulary: 'piso', 'chalet', 'atico',
# 'local', 'nave', 'garaje', 'terreno', 'edificio' — already canonicalized
# by every connector's own map_property_type at ingestion time (see e.g.
# fotocasa_mapping.BUILDING_TYPE_MAP), never raw portal text. That ruled
# out the naive worry issue #566 raised first ("piso" vs "apartamento"
# textual synonyms) — every connector already folds those onto one bucket
# before the row ever reaches this module.
#
# 'atico' vs 'piso' is NOT a genuine family difference. An ático is a
# top-floor flat — a floor-position variant of a flat, not a different
# kind of building the way a chalet (house) or a nave (warehouse) is —
# and portals disagree in practice about which of the two labels to use
# for the very same unit: Fotocasa's own BUILDING_TYPE_MAP separates
# "Penthouse" -> "atico" from "Flat"/"Duplex"/"StudioFlat" -> "piso", a
# distinction other portals draw differently for what is recognizably the
# same physical listing.
#
# This is deliberately the ONLY family exemption, even though B1's
# price/size gate below (added after PR #567's review) is what actually
# makes the `chalet`/`piso` mismapping pattern safe now — see this
# module's docstring, section "B1", for why a second family entry would
# have been the wrong fix (it was tried, and falsified: the two
# populations are statistically indistinguishable on the metric that
# justified the piso/atico exemption in the first place). Kept as a
# family exemption rather than folded into the price/size gate because
# piso/atico corroborate with EITHER weak OR strong size/price agreement —
# unlike chalet/piso, sampling found no genuinely-different-property
# piso/atico pair in the backlog at any confidence, so there is no
# evidence a price/size gate is even needed there.
_COMPATIBLE_TYPE_FAMILIES: tuple[frozenset[str], ...] = (frozenset({"piso", "atico"}),)


def _type_family(property_type: str) -> frozenset[str] | None:
    for family in _COMPATIBLE_TYPE_FAMILIES:
        if property_type in family:
            return family
    return None


def _identical_size_and_price(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides publish `m2_built` AND `current_price`,
    and both are EXACTLY equal (not just close) — see this module's
    docstring, section "B1". Deliberately exact, not a tolerance band: an
    exact match is qualitatively different evidence (the classic "same
    listing, mis-mapped type label" signature found in PR #567's review)
    from a merely-close match, which fuzzy.evaluate's own size/price gates
    already require and which is NOT strong enough on its own to override
    a genuine type contradiction (issue #566's own chalet/piso sampling
    found real different-property pairs well inside those looser
    tolerances)."""
    if a.m2_built is None or b.m2_built is None:
        return False
    if a.current_price is None or b.current_price is None:
        return False
    return a.m2_built == b.m2_built and a.current_price == b.current_price


def property_type_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry a `property_type`, the two values
    belong to genuinely incompatible families, AND size+price do not
    already agree exactly (see `_identical_size_and_price` / this module's
    docstring section "B1").

    Absence on either side returns False — a missing type never blocks a
    merge another signal already supports, mirroring
    `floor.floors_conflict`'s permissive-on-absence shape.
    """
    if a.property_type is None or b.property_type is None:
        return False
    if a.property_type == b.property_type:
        return False
    family = _type_family(a.property_type)
    if family is not None and b.property_type in family:
        return False
    return not _identical_size_and_price(a, b)


# Issue #566: rooms differing by exactly 1 must NOT veto — deliberate
# tolerance for portals disagreeing on whether a study/interior room
# counts (6,728 pending pairs at a 1-room difference vs. 1,966 at >=2,
# measured against the live demo DB).
_ROOMS_CONFLICT_MIN_DIFF = 2


def _usable_rooms(rooms: int | None) -> int | None:
    """`0` is treated identically to `None` — see this module's docstring,
    section "B3": it behaves as a missing-value placeholder for at least
    one connector's extraction path (the same fotocasa listing recorded
    `rooms=0` on one scrape and `rooms=4` on another), not a genuine
    studio count, and 20.7% of all properties carry it."""
    if rooms in (None, 0):
        return None
    return rooms


def rooms_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry a usable `rooms` value (see
    `_usable_rooms`) AND they differ by at least `_ROOMS_CONFLICT_MIN_DIFF`.

    Absence (or `0` — B3) on either side returns False, same
    permissive-on-absence shape as `property_type_conflict` above.
    """
    rooms_a = _usable_rooms(a.rooms)
    rooms_b = _usable_rooms(b.rooms)
    if rooms_a is None or rooms_b is None:
        return False
    return abs(rooms_a - rooms_b) >= _ROOMS_CONFLICT_MIN_DIFF


def structured_fields_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True when either published-field conflict fires — the single check
    `etl.dedup.signals.fuzzy.evaluate` calls. See this module's docstring
    for why it's scoped to fuzzy only, not wired into
    `etl.dedup.engine.evaluate_pair`."""
    return property_type_conflict(a, b) or rooms_conflict(a, b)
