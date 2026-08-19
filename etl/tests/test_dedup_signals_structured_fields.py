"""Direct unit tests for etl.dedup.signals.structured_fields's pure
helpers (issue #566). End-to-end engine-level veto coverage lives in
test_dedup_engine.py's TestStructuredFieldsConflictVeto — this file only
covers the two conflict predicates in isolation, mirroring
test_dedup_signals_reference_code.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

import pytest

from etl.dedup.signals.structured_fields import (
    property_type_conflict,
    rooms_conflict,
    structured_fields_conflict,
)
from etl.dedup.types import ListingRecord


def _record(**overrides) -> ListingRecord:
    defaults = {
        "listing_id": 1,
        "property_id": 1,
        "source": "fotocasa",
        "external_id": "1",
        "listing_kind": None,
        "description": None,
        "photo_urls": (),
        "cadastral_ref": None,
        "address": None,
        "lat": None,
        "lon": None,
        "m2_built": None,
        "current_price": None,
        "contact_raw": None,
        "reference_code": None,
        "floor": None,
        "property_type": None,
        "rooms": None,
    }
    defaults.update(overrides)
    return ListingRecord(**defaults)


class TestPropertyTypeConflict:
    """Issue #566: property_type differs on both sides -> conflict, UNLESS
    the two values are the one known-compatible family (piso/atico)."""

    def test_same_type_does_not_conflict(self):
        a = _record(property_type="piso")
        b = _record(property_type="piso")
        assert property_type_conflict(a, b) is False

    @pytest.mark.parametrize(
        "type_a,type_b",
        [
            ("piso", "chalet"),
            ("chalet", "local"),
            ("local", "nave"),
            ("nave", "garaje"),
            ("garaje", "terreno"),
            ("terreno", "edificio"),
            ("atico", "chalet"),
            ("piso", "local"),
        ],
    )
    def test_genuinely_incompatible_families_conflict(self, type_a, type_b):
        a = _record(property_type=type_a)
        b = _record(property_type=type_b)
        assert property_type_conflict(a, b) is True
        # Symmetric — order of the pair must not matter.
        assert property_type_conflict(b, a) is True

    def test_piso_atico_is_the_one_compatible_family_and_does_not_conflict(self):
        """Issue #566's own flagged risk, confirmed against the live demo
        DB: an atico is a floor-position variant of a piso (top-floor
        flat), not a different kind of building — 430 pending fuzzy pairs
        carry 'piso' against 'atico' at confidences up to 0.800, many with
        IDENTICAL m2_built and price on both sides. A naive `!=` here would
        have wrongly vetoed likely-real duplicates."""
        a = _record(property_type="piso")
        b = _record(property_type="atico")
        assert property_type_conflict(a, b) is False
        assert property_type_conflict(b, a) is False

    def test_missing_type_on_one_side_does_not_conflict(self):
        a = _record(property_type="piso")
        b = _record(property_type=None)
        assert property_type_conflict(a, b) is False
        assert property_type_conflict(b, a) is False

    def test_both_missing_does_not_conflict(self):
        a = _record(property_type=None)
        b = _record(property_type=None)
        assert property_type_conflict(a, b) is False


class TestRoomsConflict:
    """Issue #566: rooms differing by >=2 conflicts; differing by exactly
    1 must NOT — deliberate tolerance for portals disagreeing on whether a
    study/interior room counts."""

    def test_equal_rooms_does_not_conflict(self):
        a = _record(rooms=3)
        b = _record(rooms=3)
        assert rooms_conflict(a, b) is False

    def test_diff_of_one_does_not_conflict(self):
        a = _record(rooms=2)
        b = _record(rooms=3)
        assert rooms_conflict(a, b) is False
        assert rooms_conflict(b, a) is False

    def test_diff_of_two_conflicts(self):
        a = _record(rooms=2)
        b = _record(rooms=4)
        assert rooms_conflict(a, b) is True
        assert rooms_conflict(b, a) is True

    def test_diff_of_three_or_more_conflicts(self):
        a = _record(rooms=1)
        b = _record(rooms=5)
        assert rooms_conflict(a, b) is True

    def test_missing_rooms_on_one_side_does_not_conflict(self):
        a = _record(rooms=2)
        b = _record(rooms=None)
        assert rooms_conflict(a, b) is False
        assert rooms_conflict(b, a) is False

    def test_both_missing_does_not_conflict(self):
        a = _record(rooms=None)
        b = _record(rooms=None)
        assert rooms_conflict(a, b) is False


class TestStructuredFieldsConflict:
    """The combined check `evaluate_pair` actually calls."""

    def test_neither_conflict_is_false(self):
        a = _record(property_type="piso", rooms=2)
        b = _record(property_type="piso", rooms=3)
        assert structured_fields_conflict(a, b) is False

    def test_type_conflict_alone_is_true(self):
        a = _record(property_type="piso", rooms=2)
        b = _record(property_type="chalet", rooms=2)
        assert structured_fields_conflict(a, b) is True

    def test_rooms_conflict_alone_is_true(self):
        a = _record(property_type="piso", rooms=2)
        b = _record(property_type="piso", rooms=5)
        assert structured_fields_conflict(a, b) is True

    def test_both_conflicting_is_true(self):
        a = _record(property_type="piso", rooms=2)
        b = _record(property_type="local", rooms=6)
        assert structured_fields_conflict(a, b) is True

    def test_all_missing_is_false(self):
        a = _record()
        b = _record()
        assert structured_fields_conflict(a, b) is False
