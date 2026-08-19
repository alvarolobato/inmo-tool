"""Direct unit tests for etl.dedup.signals.structured_fields's pure
helpers (issue #566). End-to-end engine-level veto coverage lives in
test_dedup_engine.py's TestStructuredFieldsConflictVeto — this file only
covers the two conflict predicates in isolation, mirroring
test_dedup_signals_reference_code.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

from decimal import Decimal

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
        flat), not a different kind of building. A naive `!=` here would
        have wrongly vetoed likely-real duplicates — this exemption holds
        regardless of the price/size gate below (TestPropertyTypeConflictPriceSizeGate),
        i.e. even when size/price are NOT identical."""
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


class TestPropertyTypeConflictPriceSizeGate:
    """Issue #566 / PR #567 review (B1): a genuinely-incompatible type pair
    (e.g. chalet/piso) must NOT veto when m2_built AND current_price are
    BOTH exactly equal — the review found 97 of 97 type-conflicting,
    currently-merged properties were chalet/piso, all with identical size
    and price, i.e. a portal type-mapping quirk, not two properties.
    Independent of the piso/atico family exemption above — this fires for
    ANY incompatible pair, not just piso/atico."""

    def test_identical_m2_and_price_exempts_an_incompatible_pair(self):
        a = _record(
            property_type="chalet",
            m2_built=Decimal(90),
            current_price=Decimal(260000),
        )
        b = _record(
            property_type="piso",
            m2_built=Decimal(90),
            current_price=Decimal(260000),
        )
        assert property_type_conflict(a, b) is False
        assert property_type_conflict(b, a) is False

    def test_identical_m2_but_different_price_still_conflicts(self):
        a = _record(
            property_type="chalet",
            m2_built=Decimal(90),
            current_price=Decimal(260000),
        )
        b = _record(
            property_type="piso",
            m2_built=Decimal(90),
            current_price=Decimal(300000),
        )
        assert property_type_conflict(a, b) is True

    def test_identical_price_but_different_m2_still_conflicts(self):
        a = _record(
            property_type="chalet",
            m2_built=Decimal(90),
            current_price=Decimal(260000),
        )
        b = _record(
            property_type="piso",
            m2_built=Decimal(95),
            current_price=Decimal(260000),
        )
        assert property_type_conflict(a, b) is True

    def test_close_but_not_exact_match_still_conflicts(self):
        """Deliberately exact, not a tolerance band — a merely-close match
        (which fuzzy.evaluate's own gates already require to even reach
        this check) is not strong enough evidence on its own."""
        a = _record(
            property_type="chalet",
            m2_built=Decimal("90.00"),
            current_price=Decimal(260000),
        )
        b = _record(
            property_type="piso",
            m2_built=Decimal("90.01"),
            current_price=Decimal(260000),
        )
        assert property_type_conflict(a, b) is True

    def test_missing_m2_or_price_does_not_exempt(self):
        a = _record(
            property_type="chalet", m2_built=None, current_price=Decimal(260000)
        )
        b = _record(property_type="piso", m2_built=None, current_price=Decimal(260000))
        assert property_type_conflict(a, b) is True


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

    def test_zero_on_one_side_treated_as_absent(self):
        """Issue #566 / PR #567 review (B3): rooms=0 is a scrape-artifact
        placeholder for at least one connector (the same fotocasa listing
        recorded rooms=0 on one scrape and rooms=4 on another), not a
        genuine studio count — treated identically to None."""
        a = _record(rooms=0)
        b = _record(rooms=5)
        assert rooms_conflict(a, b) is False
        assert rooms_conflict(b, a) is False

    def test_zero_on_both_sides_does_not_conflict(self):
        a = _record(rooms=0)
        b = _record(rooms=0)
        assert rooms_conflict(a, b) is False

    def test_zero_and_none_does_not_conflict(self):
        a = _record(rooms=0)
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
