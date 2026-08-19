"""Direct unit tests for etl.dedup.signals.reference_code's pure helpers
(issue #72). End-to-end merge/suggest-decision coverage lives in
test_dedup_engine.py's TestReferenceCodeSignal — this file only covers the
normalization/matching helpers in isolation, mirroring
test_dedup_signals_phone_extract.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

import pytest

from etl.dedup.signals.reference_code import (
    _normalize,
    _same_agency,
    evaluate,
    reference_codes_conflict,
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


class TestReferenceCodesConflict:
    """Issue #564 (D-116): the hard veto. Same agency + two different,
    usable codes vetoes; everything else (different agency, missing/
    placeholder code on either side, matching codes) does not."""

    def test_same_agency_different_valid_codes_conflicts(self):
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="NS603")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code="AB100")
        assert reference_codes_conflict(a, b) is True

    def test_same_agency_case_and_whitespace_insensitive_still_conflicts(self):
        a = _record(contact_raw="INMOBILIARIA UNO", reference_code=" NS-603 ")
        b = _record(contact_raw="inmobiliaria uno", reference_code="ab100")
        assert reference_codes_conflict(a, b) is True

    def test_same_agency_same_code_does_not_conflict(self):
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="NS603")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code="ns603")
        assert reference_codes_conflict(a, b) is False

    def test_different_agencies_different_codes_does_not_conflict(self):
        # Codes are agency-namespaced — a different agency's differing code
        # means nothing, so this is never eligible for the veto at all.
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="NS603")
        b = _record(contact_raw="Inmobiliaria Dos", reference_code="AB100")
        assert reference_codes_conflict(a, b) is False

    def test_missing_code_on_one_side_does_not_conflict(self):
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="NS603")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code=None)
        assert reference_codes_conflict(a, b) is False

    @pytest.mark.parametrize("placeholder", ["0", "-", "REF", "sin referencia", ""])
    def test_placeholder_code_on_one_side_does_not_conflict(self, placeholder):
        # A CRM template left unedited on many of an agency's listings must
        # never veto a legitimate merge for that whole agency — an unusable
        # code is treated as absent, exactly like the positive-match path.
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="NS603")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code=placeholder)
        assert reference_codes_conflict(a, b) is False

    def test_both_placeholder_does_not_conflict(self):
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="REF")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code="0")
        assert reference_codes_conflict(a, b) is False

    def test_both_blank_agency_does_not_conflict(self):
        # No captured agency name on either side means _same_agency is
        # False by construction — never eligible for the veto.
        a = _record(reference_code="NS603")
        b = _record(reference_code="AB100")
        assert reference_codes_conflict(a, b) is False
