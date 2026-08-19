"""Structured-field contradiction predicates (issue #566).

Two listings whose *published, structured* fields actively contradict each
other are not the same property — but ONLY when the match evidence is
otherwise weak (address-text similarity alone). `property_type_conflict`/
`rooms_conflict`/`structured_fields_conflict` below are pure predicates,
permissive on absence exactly like `floor.floors_conflict` (issue #186): a
missing value on either side is "we don't know", never "they differ".

Unlike the reference-code veto (issue #564/D-116), this is deliberately
**NOT** wired into `etl.dedup.engine.evaluate_pair` ahead of every signal.
It is called from exactly one place: `etl.dedup.signals.fuzzy.evaluate` —
see that module's docstring for the full reasoning, but in short: a live-DB
blast-radius measurement (required by issue #566 before merge) found
`property_type`/`rooms` are noisy per-connector metadata that regularly
disagree even on definite, strongly-corroborated duplicates matched by
address_coords/reference_code/photo_hash (identical photos, price, and
size) — an engine-wide veto would have broken ~76 of 615 currently-merged
properties. Fuzzy is the one signal where the issue's own reasoning holds:
price/size are already gated there (zero fuzzy pairs in the backlog differ
by >25% in price or >20% in m2_built), so a contradicting `property_type`
or `rooms` reaching that point is a structured fact two portals agree to
disagree on, not textual noise — and fuzzy is 97.1% of the 27,145-row
pending-suggestion backlog this issue targets.

Two rules:

1. **`property_type` differs on both sides, AND the two values are not the
   same "family" -> conflict.** See `_COMPATIBLE_TYPE_FAMILIES` below for
   why `piso`/`atico` are the one exception, not a naive `!=`.
2. **`rooms` differs by >= `_ROOMS_CONFLICT_MIN_DIFF` (2) -> conflict.** A
   difference of exactly 1 is deliberately NOT a conflict — portals
   genuinely disagree on whether a study, an interior room, or a converted
   space counts as a "room", and vetoing on that tolerance would destroy
   real duplicates at scale (issue #566 measured 6,728 pending pairs at
   exactly a 1-room difference, next to only 1,966 at >=2).
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
# What's real, verified against the live demo DB's pending-suggestion
# backlog: 'atico' vs 'piso' is NOT a genuine family difference. An ático
# is a top-floor flat — a floor-position variant of a flat, not a
# different kind of building the way a chalet (house) or a nave
# (warehouse) is — and portals disagree in practice about which of the two
# labels to use for the very same unit: Fotocasa's own BUILDING_TYPE_MAP
# separates "Penthouse" -> "atico" from "Flat"/"Duplex"/"StudioFlat" ->
# "piso", a distinction other portals draw differently for what is
# recognizably the same physical listing. 430 pending fuzzy pairs carry
# 'piso' against 'atico' at fuzzy confidences up to 0.800, many with
# IDENTICAL m2_built AND current_price on both sides — the classic "one
# portal calls it a penthouse, the other calls it a flat" case, not two
# properties.
#
# Every OTHER combination found in the same backlog ('chalet' vs 'piso':
# 1,712 pairs; 'atico' vs 'chalet': 23; 'piso'/'local'/'terreno'/'nave'
# combinations: a handful each) was sampled by hand and reads as exactly
# what issue #566 predicted: weak same-neighbourhood-text fuzzy matches
# between genuinely different properties (disagreeing size/price, often
# different municipalities entirely — the same underspecified,
# municipality-level address text that already ruled out a distance veto).
# None of those pairs showed the size/price agreement pattern the
# piso/atico pairs do. See the PR body for the query and sampled pairs.
_COMPATIBLE_TYPE_FAMILIES: tuple[frozenset[str], ...] = (frozenset({"piso", "atico"}),)


def _type_family(property_type: str) -> frozenset[str] | None:
    for family in _COMPATIBLE_TYPE_FAMILIES:
        if property_type in family:
            return family
    return None


def property_type_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry a `property_type` AND the two values
    belong to genuinely incompatible families.

    Absence on either side returns False — a missing type never blocks a
    merge another signal already supports, mirroring
    `floor.floors_conflict`'s permissive-on-absence shape.
    """
    if a.property_type is None or b.property_type is None:
        return False
    if a.property_type == b.property_type:
        return False
    family = _type_family(a.property_type)
    return not (family is not None and b.property_type in family)


# Issue #566: rooms differing by exactly 1 must NOT veto — deliberate
# tolerance for portals disagreeing on whether a study/interior room
# counts (6,728 pending pairs at a 1-room difference vs. 1,966 at >=2,
# measured against the live demo DB).
_ROOMS_CONFLICT_MIN_DIFF = 2


def rooms_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry `rooms` AND they differ by at least
    `_ROOMS_CONFLICT_MIN_DIFF`.

    Absence on either side returns False, same permissive-on-absence shape
    as `property_type_conflict` above.
    """
    if a.rooms is None or b.rooms is None:
        return False
    return abs(a.rooms - b.rooms) >= _ROOMS_CONFLICT_MIN_DIFF


def structured_fields_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True when either published-field conflict fires — the single check
    `etl.dedup.signals.fuzzy.evaluate` calls. See this module's docstring
    for why it's scoped to fuzzy only, not wired into
    `etl.dedup.engine.evaluate_pair`."""
    return property_type_conflict(a, b) or rooms_conflict(a, b)
