"""Direct unit tests for etl.dedup.signals.price_gap's pure predicate
(issue #627, D-138). Mirrors test_dedup_signals_structured_fields.py's
split between direct signal tests and engine-level placement tests — the
engine-level coverage (ordering vs. cadastral/reference_code, the
DedupRunResult counter, the "never files a suggestion"/"never creates a
property_merge_veto" behaviour) lives in test_dedup_engine.py's
TestPriceGapRule.

Every threshold gets a boundary test on BOTH sides (a one-sided test
passes if someone later changes 30% to 80%) — see the class docstrings
below for the exact reasoning behind each ratio's "just below / just at
or above" pair.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.signals.price_gap import price_gap_conflict
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


class TestPriceGapHardReject:
    """Rule 1: price differs by MORE than 30% -> reject on its own,
    regardless of size/rooms (both left None/unset here on purpose)."""

    def test_29_9_percent_does_not_reject(self):
        # 100000 vs 70100 -> (100000-70100)/100000 = 29.9%
        a = _record(current_price=Decimal(100000))
        b = _record(current_price=Decimal(70100))
        assert price_gap_conflict(a, b) is None

    def test_30_1_percent_rejects(self):
        # 100000 vs 69900 -> 30.1%
        a = _record(current_price=Decimal(100000))
        b = _record(current_price=Decimal(69900))
        conflict = price_gap_conflict(a, b)
        assert conflict is not None
        assert conflict["rule"] == "price_gap_over_30pct"

    def test_exactly_30_percent_does_not_reject(self):
        """'Más de un 30%' — strictly greater than, not inclusive."""
        a = _record(current_price=Decimal(100000))
        b = _record(current_price=Decimal(70000))
        assert price_gap_conflict(a, b) is None

    def test_size_and_rooms_are_irrelevant_once_price_gap_exceeds_30pct(self):
        a = _record(current_price=Decimal(100000), m2_built=Decimal(80), rooms=3)
        b = _record(current_price=Decimal(50000), m2_built=Decimal(80), rooms=3)
        conflict = price_gap_conflict(a, b)
        assert conflict is not None
        assert conflict["rule"] == "price_gap_over_30pct"


class TestPriceGapSoftRejectPriceLeg:
    """Rule 2's price leg: 15% OR MORE, gated on size or rooms also
    disagreeing (both boundary tests here keep size/rooms fixed at a
    value that WOULD corroborate, isolating the price threshold)."""

    def test_14_9_percent_does_not_reject_even_with_size_corroboration(self):
        # 100000 vs 85100 -> 14.9%; size differs by a lot, but price alone
        # doesn't clear the soft threshold.
        a = _record(current_price=Decimal(100000), m2_built=Decimal(100))
        b = _record(current_price=Decimal(85100), m2_built=Decimal(50))
        assert price_gap_conflict(a, b) is None

    def test_15_1_percent_rejects_with_size_corroboration(self):
        a = _record(current_price=Decimal(100000), m2_built=Decimal(100))
        b = _record(current_price=Decimal(84900), m2_built=Decimal(50))
        conflict = price_gap_conflict(a, b)
        assert conflict is not None
        assert conflict["rule"] == "price_gap_15pct_with_size_or_rooms"

    def test_exactly_15_percent_rejects_with_size_corroboration(self):
        """'15% o más' — inclusive."""
        a = _record(current_price=Decimal(100000), m2_built=Decimal(100))
        b = _record(current_price=Decimal(85000), m2_built=Decimal(50))
        assert price_gap_conflict(a, b) is not None

    def test_soft_band_without_size_or_rooms_corroboration_does_not_reject(self):
        """Price alone in [15%, 30%] with size AND rooms both agreeing (or
        unknown) never rejects — rule 2 requires corroboration."""
        a = _record(current_price=Decimal(100000), m2_built=Decimal(80))
        b = _record(current_price=Decimal(87000), m2_built=Decimal(81))
        assert price_gap_conflict(a, b) is None


class TestPriceGapSoftRejectSizeLeg:
    """Rule 2's size leg: m2_built differing by 5% OR MORE, with price
    fixed at 20% (comfortably inside [15%, 30%)) and rooms left unset so
    only the size leg can be responsible for the verdict."""

    _PRICE_A = Decimal(100000)
    _PRICE_B = Decimal(80000)  # 20% gap

    def test_4_9_percent_size_diff_does_not_contribute(self):
        # 100 vs 95.1 -> (100-95.1)/100 = 4.9%
        a = _record(current_price=self._PRICE_A, m2_built=Decimal(100))
        b = _record(current_price=self._PRICE_B, m2_built=Decimal("95.1"))
        assert price_gap_conflict(a, b) is None

    def test_5_1_percent_size_diff_rejects(self):
        a = _record(current_price=self._PRICE_A, m2_built=Decimal(100))
        b = _record(current_price=self._PRICE_B, m2_built=Decimal("94.9"))
        conflict = price_gap_conflict(a, b)
        assert conflict is not None
        assert conflict["rule"] == "price_gap_15pct_with_size_or_rooms"
        assert "size_diff_pct" in conflict

    def test_exactly_5_percent_size_diff_rejects(self):
        """'Los metros pueden ser un 5% de diferencia' — inclusive, same
        'or more' reading as the price legs."""
        a = _record(current_price=self._PRICE_A, m2_built=Decimal(100))
        b = _record(current_price=self._PRICE_B, m2_built=Decimal(95))
        assert price_gap_conflict(a, b) is not None


class TestPriceGapSoftRejectRoomsLeg:
    """Rule 2's rooms leg reuses `structured_fields.rooms_conflict`
    directly (D-117's own threshold: >= 2, not exactly 1 — see this
    module's docstring for why that's reused rather than re-decided).
    Price fixed at 20%, size fixed identical, so only rooms can be
    responsible for the verdict."""

    _PRICE_A = Decimal(100000)
    _PRICE_B = Decimal(80000)  # 20% gap
    _M2 = Decimal(80)

    def test_rooms_differing_by_1_does_not_reject(self):
        a = _record(current_price=self._PRICE_A, m2_built=self._M2, rooms=3)
        b = _record(current_price=self._PRICE_B, m2_built=self._M2, rooms=4)
        assert price_gap_conflict(a, b) is None

    def test_rooms_differing_by_2_rejects(self):
        a = _record(current_price=self._PRICE_A, m2_built=self._M2, rooms=2)
        b = _record(current_price=self._PRICE_B, m2_built=self._M2, rooms=4)
        conflict = price_gap_conflict(a, b)
        assert conflict is not None
        assert conflict["rooms_a"] == 2
        assert conflict["rooms_b"] == 4

    def test_rooms_zero_on_either_side_is_treated_as_unknown(self):
        """D-117: rooms=0 is a scrape artifact, not a genuine studio
        count — never treated as "differs"."""
        a = _record(current_price=self._PRICE_A, m2_built=self._M2, rooms=0)
        b = _record(current_price=self._PRICE_B, m2_built=self._M2, rooms=4)
        assert price_gap_conflict(a, b) is None


class TestPriceGapMissingValuesNeverReject:
    """Missing/unusable values never reject — a rule firing on unknown
    data is worse than no rule. One test per field."""

    def test_missing_price_a_never_rejects(self):
        a = _record(current_price=None)
        b = _record(current_price=Decimal(40000))  # would be a huge gap
        assert price_gap_conflict(a, b) is None

    def test_missing_price_b_never_rejects(self):
        a = _record(current_price=Decimal(100000))
        b = _record(current_price=None)
        assert price_gap_conflict(a, b) is None

    def test_missing_m2_never_contributes_to_the_size_leg(self):
        """Price alone in the soft band, m2 missing on one side, rooms
        unset -> no signal to corroborate, never rejects."""
        a = _record(current_price=Decimal(100000), m2_built=Decimal(80))
        b = _record(current_price=Decimal(80000), m2_built=None)
        assert price_gap_conflict(a, b) is None

    def test_missing_rooms_never_contributes_to_the_rooms_leg(self):
        a = _record(current_price=Decimal(100000), m2_built=Decimal(80), rooms=None)
        b = _record(current_price=Decimal(80000), m2_built=Decimal(80), rooms=4)
        assert price_gap_conflict(a, b) is None

    def test_rooms_zero_never_contributes_to_the_rooms_leg(self):
        """Same field, phrased as its own explicit test per the exit
        criteria ('missing/unknown values never reject... including
        rooms = 0') — distinct from TestPriceGapSoftRejectRoomsLeg's
        threshold test above, which already covers it, but named here so
        the requirement is traceable to an unambiguous test."""
        a = _record(current_price=Decimal(100000), m2_built=Decimal(80), rooms=0)
        b = _record(current_price=Decimal(80000), m2_built=Decimal(80), rooms=4)
        assert price_gap_conflict(a, b) is None

    def test_zero_price_never_rejects(self):
        """Non-positive is treated the same as missing — see
        `_diff_ratio`'s guard."""
        a = _record(current_price=Decimal(0))
        b = _record(current_price=Decimal(100000))
        assert price_gap_conflict(a, b) is None


def test_this_module_never_needs_a_property_type():
    """Sanity guard: `price_gap_conflict` reads only price/m2/rooms — it
    must not accidentally start depending on `property_type` in a way that
    would make a `None` there change the verdict (structured_fields' own
    `property_type_conflict` is a SEPARATE, not-reused predicate)."""
    a = _record(
        current_price=Decimal(100000),
        m2_built=Decimal(80),
        rooms=3,
        property_type=None,
    )
    b = _record(
        current_price=Decimal(50000),
        m2_built=Decimal(80),
        rooms=3,
        property_type="piso",
    )
    # Price alone is >30% here regardless of property_type.
    assert price_gap_conflict(a, b) is not None
