"""Tests for etl.dedup.signals.phone_extract (issue #16 item 3).

Previously had no dedicated unit tests for extract_phones() in isolation
(only end-to-end coverage via test_dedup_engine.py's TestPhoneSignal). Added
alongside the PR #55 review fix for a missing digit-boundary guard.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.signals.phone_extract import evaluate, extract_phones
from etl.dedup.types import ListingRecord


class TestExtractPhones:
    def test_finds_plain_nine_digit_number(self):
        assert extract_phones("Llamar al 622334455, gracias") == {"622334455"}

    def test_finds_number_with_plus34_prefix(self):
        # 3-3-3 digit grouping, matching _PHONE_RE's supported separator
        # positions — "622 33 44 55" (2-2-2-2 grouping) isn't a shape this
        # regex parses, real-world Spanish numbers are written both ways.
        assert extract_phones("Interesados +34 622 334 455") == {"622334455"}

    def test_does_not_match_inside_a_longer_digit_run(self):
        """Regression (Opus review, PR #55): without a digit-boundary guard,
        "Ref. 600123456789" (a 12-digit run, not a phone number) spuriously
        matched a phantom 9-digit "phone" at its start.
        """
        assert extract_phones("Ref. 600123456789") == set()

    def test_no_phone_returns_empty_set(self):
        assert extract_phones("Piso muy luminoso, sin ascensor") == set()

    def test_none_input_returns_empty_set(self):
        assert extract_phones(None) == set()


def _listing(**overrides) -> ListingRecord:
    return ListingRecord(
        listing_id=overrides.get("listing_id", 1),
        property_id=overrides.get("property_id", 100),
        source=overrides.get("source", "idealista"),
        external_id=overrides.get("external_id", "1"),
        listing_kind=overrides.get("listing_kind"),
        description=overrides.get("description"),
        photo_urls=overrides.get("photo_urls", ()),
        cadastral_ref=overrides.get("cadastral_ref"),
        address=overrides.get("address"),
        lat=overrides.get("lat"),
        lon=overrides.get("lon"),
        m2_built=overrides.get("m2_built"),
        current_price=overrides.get("current_price"),
        contact_raw=overrides.get("contact_raw"),
        reference_code=overrides.get("reference_code"),
        floor=overrides.get("floor"),
    )


class TestEvaluateSilencedTiers:
    """Issue #603 (D-129): the uncorroborated tier and the
    corroborated-but-either-side-agency tier now return None instead of a
    0.500 suggestion — #600 measured every one of the 320 pending phone
    rows on the live corpus as exactly one of these two shapes, 100% with
    a confirmed-agency side.
    """

    _SHARED = "Piso reformado, tel 622334455"

    def test_uncorroborated_match_returns_none(self):
        # Same phone, but size/price wildly apart — never corroborated.
        a = _listing(
            listing_id=1,
            description=self._SHARED,
            m2_built=Decimal(30),
            current_price=Decimal(90000),
        )
        b = _listing(
            listing_id=2,
            property_id=200,
            description=self._SHARED,
            m2_built=Decimal(300),
            current_price=Decimal(2000000),
        )
        assert evaluate(a, b) is None

    def test_corroborated_but_either_side_agency_returns_none(self):
        a = _listing(
            listing_id=1,
            listing_kind="agency",
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        b = _listing(
            listing_id=2,
            property_id=200,
            listing_kind="particular",
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
        )
        assert evaluate(a, b) is None
        # Symmetric: agency on the OTHER side is silenced too.
        assert evaluate(b, a) is None


class TestEvaluateSurvivingTiers:
    """Unchanged by issue #603 — a non-agency-sided corroborated match
    still carries real evidence this module alone can offer."""

    _SHARED = "Piso reformado, tel 622334455"

    def test_corroborated_particular_particular_still_auto_merges(self):
        a = _listing(
            listing_id=1,
            listing_kind="particular",
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        b = _listing(
            listing_id=2,
            property_id=200,
            listing_kind="particular",
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
        )
        result = evaluate(a, b)
        assert result is not None
        assert result.decision == "merge"
        assert result.confidence == Decimal("0.900")

    def test_corroborated_unconfirmed_kind_still_suggests(self):
        a = _listing(
            listing_id=1,
            listing_kind="particular",
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        b = _listing(
            listing_id=2,
            property_id=200,
            listing_kind=None,
            description=self._SHARED,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
        )
        result = evaluate(a, b)
        assert result is not None
        assert result.decision == "suggest"
        assert result.confidence == Decimal("0.750")
