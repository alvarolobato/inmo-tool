"""Tests for etl.dedup.signals.fuzzy (issue #16 item 5).

Previously had zero coverage — added alongside the PR #55 review fix for
three dead abbreviation-expansion rules (c/, cl., av. never matched their
real-world space-separated form; see normalize_address's docstring comment).
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.signals.fuzzy import evaluate, normalize_address
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
        "address": "Calle Mayor 5, Madrid",
        "lat": None,
        "lon": None,
        "m2_built": Decimal(70),
        "current_price": Decimal(250000),
        "contact_raw": None,
        "reference_code": None,
        "floor": None,
        "property_type": None,
        "rooms": None,
        "city": None,
    }
    defaults.update(overrides)
    return ListingRecord(**defaults)


class TestNormalizeAddress:
    def test_c_slash_abbreviation_matches_calle(self):
        """Regression: `\\bc/\\b` never matched "c/ trafalgar" (no word
        boundary exists between "/" and the following space) — fixed to
        `\\bc/(?!\\w)`.
        """
        assert normalize_address("C/ Trafalgar 5") == normalize_address(
            "Calle Trafalgar 5"
        )

    def test_cl_dot_abbreviation_matches_calle(self):
        """Regression: `\\bcl\\.\\b` never matched "cl. mayor" for the same
        reason as c/ above — fixed to `\\bcl\\.?(?!\\w)`.
        """
        assert normalize_address("Cl. Mayor 10") == normalize_address("Calle Mayor 10")

    def test_av_dot_abbreviation_matches_avenida(self):
        """Regression: `\\bav\\.\\b` never matched "av. mayor" for the same
        reason — fixed to `\\bav\\.?(?!\\w)`.
        """
        assert normalize_address("Av. Mayor 3") == normalize_address("Avenida Mayor 3")

    def test_abbreviation_without_trailing_dot_still_matches(self):
        """avda/av/pza's optional-dot form already worked via backtracking
        before this fix (only the mandatory-dot c/, cl., av. rules were
        dead) — confirm the fix didn't regress the no-dot case."""
        assert normalize_address("Avda Mayor 3") == normalize_address("Avenida Mayor 3")

    def test_accents_and_case_are_normalized(self):
        assert normalize_address("CALLE MAYÓR") == normalize_address("calle mayor")

    def test_punctuation_is_stripped(self):
        assert normalize_address("Calle Mayor, 10 - 2ºA") == "calle mayor 10 2oa"


class TestStructuredFieldsVeto:
    """Issue #566: a property_type/rooms contradiction vetoes this signal's
    suggestion outright (returns None), even when address/size/price all
    agree well enough to otherwise fire. See this module's own docstring
    for why the veto lives here and nowhere else in evaluate_pair.

    PR #567's review (B1/B3) found the ORIGINAL veto shape unsafe on two
    real, live-DB-verified patterns: (B1) a genuinely-incompatible type
    pair whose m2_built AND current_price are BOTH exactly equal is almost
    always one portal's type-mapping quirk, not two properties (97 of 97
    type-conflicting currently-merged properties were chalet/piso, all
    identical on size+price); (B3) `rooms=0` is a scrape-artifact
    placeholder for at least one connector, not a genuine studio count.
    `_record`'s defaults deliberately give both sides the SAME m2_built/
    current_price, so tests that want a genuine (non-exempted) conflict
    must explicitly vary one of those two fields."""

    def test_property_type_conflict_vetoes_an_otherwise_matching_pair(self):
        """Genuine conflict: size/price also disagree (not just type), so
        the B1 exemption below does not apply."""
        a = _record(
            property_type="piso", m2_built=Decimal(70), current_price=Decimal(250000)
        )
        b = _record(
            listing_id=2,
            property_id=2,
            property_type="local",
            m2_built=Decimal(71),
            current_price=Decimal(260000),
        )
        assert evaluate(a, b) is None

    def test_identical_size_and_price_exempts_a_type_conflict(self):
        """B1: even a genuinely-incompatible type pair (chalet/piso, NOT
        the piso/atico family) must not veto when size+price are both
        exactly identical — the live-DB pattern PR #567's review found."""
        a = _record(property_type="chalet")
        b = _record(listing_id=2, property_id=2, property_type="piso")
        result = evaluate(a, b)
        assert result is not None
        assert result.basis == "fuzzy"

    def test_rooms_diff_of_two_vetoes_an_otherwise_matching_pair(self):
        a = _record(rooms=2)
        b = _record(listing_id=2, property_id=2, rooms=4)
        assert evaluate(a, b) is None

    def test_rooms_diff_of_one_does_not_veto(self):
        a = _record(rooms=2)
        b = _record(listing_id=2, property_id=2, rooms=3)
        result = evaluate(a, b)
        assert result is not None
        assert result.basis == "fuzzy"

    def test_rooms_zero_on_one_side_does_not_veto(self):
        """B3: rooms=0 is treated as unusable, same as None — not a
        genuine studio count contradicting a real rooms value."""
        a = _record(rooms=0)
        b = _record(listing_id=2, property_id=2, rooms=4)
        result = evaluate(a, b)
        assert result is not None

    def test_piso_atico_synonym_does_not_veto(self):
        a = _record(property_type="piso")
        b = _record(listing_id=2, property_id=2, property_type="atico")
        result = evaluate(a, b)
        assert result is not None

    def test_missing_type_and_rooms_does_not_veto(self):
        a = _record(property_type="piso", rooms=2)
        b = _record(listing_id=2, property_id=2, property_type=None, rooms=None)
        result = evaluate(a, b)
        assert result is not None


class TestMunicipalityVeto:
    """Issue #568 (D-118): a normalized-municipality conflict vetoes this
    signal's suggestion outright (returns None), even when
    address/size/price all agree well enough to otherwise fire. See this
    module's own docstring and etl.dedup.signals.municipality for why the
    veto lives here and nowhere else in evaluate_pair."""

    def test_genuinely_different_municipality_vetoes_an_otherwise_matching_pair(
        self,
    ):
        a = _record(city="Málaga")
        b = _record(listing_id=2, property_id=2, city="Sevilla")
        assert evaluate(a, b) is None

    def test_same_municipality_written_differently_does_not_veto(self):
        a = _record(city="Sevilla Capital")
        b = _record(listing_id=2, property_id=2, city="Sevilla")
        result = evaluate(a, b)
        assert result is not None
        assert result.basis == "fuzzy"

    def test_district_does_not_veto_its_own_municipality(self):
        a = _record(city="Montequinto")
        b = _record(listing_id=2, property_id=2, city="Dos Hermanas")
        result = evaluate(a, b)
        assert result is not None

    def test_missing_city_does_not_veto(self):
        a = _record(city="Sevilla")
        b = _record(listing_id=2, property_id=2, city=None)
        result = evaluate(a, b)
        assert result is not None
