"""Direct unit tests for etl.dedup.signals.reference_code's pure helpers
(issue #72). End-to-end merge/suggest-decision coverage lives in
test_dedup_engine.py's TestReferenceCodeSignal — this file only covers the
normalization/matching helpers in isolation, mirroring
test_dedup_signals_phone_extract.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

from etl.dedup.signals.reference_code import _normalize, _same_agency, evaluate
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
    }
    defaults.update(overrides)
    return ListingRecord(**defaults)


class TestNormalize:
    def test_case_and_whitespace_insensitive(self):
        assert _normalize("NS603") == _normalize(" ns603 ")

    def test_none_and_empty_string_both_normalize_to_none(self):
        assert _normalize(None) is None
        assert _normalize("") is None
        assert _normalize("   ") is None


class TestSameAgency:
    def test_matching_names_case_insensitive(self):
        a = _record(contact_raw="Inmobiliaria Sevilla 2000")
        b = _record(contact_raw="INMOBILIARIA SEVILLA 2000")
        assert _same_agency(a, b) is True

    def test_different_names_do_not_match(self):
        a = _record(contact_raw="Inmobiliaria Uno")
        b = _record(contact_raw="Inmobiliaria Dos")
        assert _same_agency(a, b) is False

    def test_both_blank_does_not_match(self):
        """Two listings with no captured contact name must never be treated
        as "the same agency" by default — that would make an empty
        contact_raw a backdoor around the corroboration requirement."""
        assert _same_agency(_record(), _record()) is False


class TestEvaluate:
    def test_no_shared_code_returns_none(self):
        a = _record(reference_code="NS603")
        b = _record(reference_code="AB100")
        assert evaluate(a, b) is None

    def test_both_missing_code_returns_none(self):
        assert evaluate(_record(), _record()) is None
