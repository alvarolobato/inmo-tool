"""Direct unit tests for etl.dedup.signals.reference_code's pure helpers
(issue #72). End-to-end merge/suggest-decision coverage lives in
test_dedup_engine.py's TestReferenceCodeSignal — this file only covers the
normalization/matching helpers in isolation, mirroring
test_dedup_signals_phone_extract.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from etl.dedup.signals.reference_code import (
    _SUFFIX_TOLERANT_CONFIDENCE,
    _normalize,
    _same_agency,
    codes_equivalent,
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

    def test_short_non_placeholder_code_with_a_digit_is_still_rejected(self):
        # Independent of the leading-label logic: a genuinely short code
        # (below _MIN_CODE_LENGTH) that isn't a known placeholder must
        # still be rejected as unusable noise -- "ab1" is 3 chars, has a
        # digit, and isn't in _PLACEHOLDER_CODES.
        assert _normalize("ab1") is None
        assert _normalize("ab12") == "ab12"  # 4 chars: the boundary itself


class TestNormalizeLeadingLabel:
    """Issue #629 (D-140): a leading "ref"/"ref."/"referencia" label some
    connectors capture inline with the code is stripped before comparison."""

    def test_ref_prefix_stripped(self):
        assert _normalize("Ref: LCSE42305") == _normalize("LCSE42305")

    def test_ref_dot_prefix_stripped(self):
        assert _normalize("Ref. LCSE42305") == _normalize("LCSE42305")

    def test_referencia_prefix_stripped(self):
        assert _normalize("Referencia: LCSE42305") == _normalize("LCSE42305")

    def test_label_stripping_does_not_touch_internal_punctuation(self):
        # The label regex is anchored to the start of the string — it must
        # never eat characters from inside an already-label-free code.
        assert _normalize("09502,1") == "09502,1"


class TestCodesEquivalent:
    """Issue #629 (D-140): the ONE normalizer+equality both `evaluate` and
    `reference_codes_conflict` share. Every case here is expressed on
    already-`_normalize`d inputs, matching how both call sites use it."""

    def test_exact_match_is_equivalent(self):
        assert codes_equivalent("lcse42305", "lcse42305") is True

    def test_trailing_suffix_on_one_side_is_equivalent(self):
        # The owner's own flagged example: one portal renders the bare
        # code, the other appends a "-1" unit/variant suffix.
        assert codes_equivalent("lcse42305", "lcse42305-1") is True
        assert codes_equivalent("lcse42305-1", "lcse42305") is True

    def test_slash_and_underscore_suffixes_also_tolerated(self):
        assert codes_equivalent("lcse42305", "lcse42305/2") is True
        assert codes_equivalent("lcse42305", "lcse42305_a") is True

    def test_differing_suffixes_on_both_sides_are_not_equivalent(self):
        # Two different unit suffixes is two different units, not one
        # property rendered two ways — never tolerated.
        assert codes_equivalent("lcse42305-1", "lcse42305-2") is False

    def test_middle_digit_change_is_not_equivalent(self):
        # No edit-distance/fuzzy tolerance — a changed digit mid-code is a
        # different property.
        assert codes_equivalent("lcse42305", "lcse42315") is False

    def test_none_on_either_side_is_not_equivalent(self):
        assert codes_equivalent(None, "lcse42305") is False
        assert codes_equivalent("lcse42305", None) is False
        assert codes_equivalent(None, None) is False

    def test_space_separated_trailing_token_is_not_equivalent(self):
        # Pinned real pair (property 37, TestPlainComparisonNoPrefixTolerance):
        # a space, not a hyphen/underscore/slash, so this stays a plain
        # inequality.
        assert codes_equivalent("8385 11", "8385 11 1") is False

    def test_comma_separated_trailing_token_is_not_equivalent(self):
        # Pinned real pair (property 71434): a comma, not a tolerated
        # separator.
        assert codes_equivalent("09502,1", "09502") is False


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

    def test_trailing_variant_suffix_matches_at_the_suffix_tolerant_tier(self):
        # Issue #629 (D-140): the owner's own example — one portal renders
        # the bare code, the other appends a "-1" unit/variant suffix.
        # Opus review (B1): this must land at the FIXED, capped
        # suffix-tolerant tier, never the exact-match tiers — pinning the
        # tier is the whole point, not just "some result came back".
        a = _record(reference_code="LCSE42305")
        b = _record(reference_code="LCSE42305-1")
        result = evaluate(a, b)
        assert result is not None
        assert result.basis == "reference_code"
        assert result.decision == "suggest"
        assert result.confidence == _SUFFIX_TOLERANT_CONFIDENCE
        assert result.detail["suffix_tolerant"] is True

    def test_suffix_tolerant_match_never_reaches_merge_even_with_full_corroboration(
        self,
    ):
        # Opus review (B1), the lead finding: same-agency base-vs-suffix
        # with matching coords+size satisfies _proximity_corroborated
        # exactly like two adjacent identical units in one building would
        # (the live corpus measured 56 such same-agency, different-
        # property pairs) — corroboration must NOT be allowed to promote
        # this to "merge". This is the test that would have caught the
        # 180-degree flip (hard veto -> automatic 0.900 merge) the review
        # found.
        a = _record(
            reference_code="LCSE42305",
            contact_raw="Inmobiliaria Uno",
            lat=Decimal("40.0"),
            lon=Decimal("-3.0"),
            m2_built=Decimal(70),
        )
        b = _record(
            reference_code="LCSE42305-1",
            contact_raw="Inmobiliaria Uno",
            lat=Decimal("40.0"),
            lon=Decimal("-3.0"),
            m2_built=Decimal(70),
        )
        result = evaluate(a, b)
        assert result is not None
        assert result.decision == "suggest"
        assert result.confidence == _SUFFIX_TOLERANT_CONFIDENCE

    def test_exact_match_still_reaches_merge_with_corroboration(self):
        # Contrast case for the test above: an EXACT code match with the
        # same corroboration must still merge at the full 0.900 tier —
        # the cap is specific to the non-exact, suffix-tolerant path.
        a = _record(
            reference_code="LCSE42305",
            lat=Decimal("40.0"),
            lon=Decimal("-3.0"),
            m2_built=Decimal(70),
        )
        b = _record(
            reference_code="LCSE42305",
            lat=Decimal("40.0"),
            lon=Decimal("-3.0"),
            m2_built=Decimal(70),
        )
        result = evaluate(a, b)
        assert result is not None
        assert result.decision == "merge"
        assert result.confidence == Decimal("0.900")

    def test_middle_digit_change_still_does_not_match(self):
        a = _record(reference_code="LCSE42305")
        b = _record(reference_code="LCSE42315")
        assert evaluate(a, b) is None


class TestLeadingLabelBoundary:
    """Issue #628/#629 Opus review (B2): the label strip must never eat
    into a real code that merely starts with "ref" -- it needs a real
    separator (whitespace/colon/hyphen) or end-of-string right after the
    label, not just an OPTIONAL one."""

    def test_reforma_is_not_treated_as_a_labelled_code(self):
        # The reported corruption: "REFORMA-12" -> "orma-12".
        assert _normalize("REFORMA-12") == "reforma-12"

    def test_ref_immediately_followed_by_digits_is_not_stripped(self):
        # The reported silent-prefix-drop: "REF1234" -> "1234".
        assert _normalize("REF1234") == "ref1234"

    def test_ref100_stays_usable_not_collapsed_to_a_too_short_code(self):
        # The reported disarming of D-116's own textbook example: "REF100"
        # must stay a real, usable, DISTINGUISHABLE code -- not collapse
        # to "100" (3 chars, below _MIN_CODE_LENGTH) and disappear.
        assert _normalize("REF100") == "ref100"
        assert _normalize("REF1005") == "ref1005"
        assert _normalize("REF100") != _normalize("REF1005")

    def test_ref100_vs_ref1005_same_agency_still_conflicts(self):
        # End-to-end: D-116's own motivating collision shape must still
        # veto once contact_raw is populated on both sides.
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="REF100")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code="REF1005")
        assert reference_codes_conflict(a, b) is True

    def test_reforma_vs_orma_never_matches_or_merges_across_agencies(self):
        # The reported cross-agency false merge: "REFORMA1234" vs
        # "ORMA1234" must NOT be treated as the same code just because an
        # unguarded label strip would have turned the first into the
        # second.
        a = _record(reference_code="REFORMA1234")
        b = _record(reference_code="ORMA1234")
        assert evaluate(a, b) is None

    def test_ref_prefix_with_a_real_separator_still_strips(self):
        # The 2/11,475 real shape this strip exists for: a label the
        # connector captured inline WITH its own separator.
        assert _normalize("Ref: LCSE42305") == _normalize("LCSE42305")
        assert _normalize("Referencia: LCSE42305") == _normalize("LCSE42305")


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

    def test_same_agency_trailing_variant_suffix_does_not_conflict(self):
        # Issue #629 (D-140): this is the exact bug the issue reports —
        # once the agency is captured on both sides, a same-agency pair
        # whose codes differ ONLY by a trailing unit/variant suffix must
        # NOT be vetoed as "definitely not a duplicate". Before D-140 this
        # asserted True (plain inequality); the fix is exactly this flip.
        a = _record(contact_raw="Inmobiliaria Uno", reference_code="LCSE42305")
        b = _record(contact_raw="Inmobiliaria Uno", reference_code="LCSE42305-1")
        assert reference_codes_conflict(a, b) is False


class TestPlainComparisonNoPrefixTolerance:
    """Issue #564 review round (D-116 amendment 2): a prefix-based
    exemption from the veto was tried and reverted. It was motivated by
    two live-DB pairs (property 37: "8385 11"/"8385 11 1"; property
    71434: "09502,1"/"09502") that looked like false positives — but both
    are SAME-SOURCE (fotocasa/fotocasa) pairs, which `engine._run` never
    hands to `evaluate_pair` at all (issue #197's same-source skip,
    `etl/dedup/engine.py`). The exemption solved a problem this signal
    can never actually be asked about in the live pipeline, while opening
    a real one: it would also have exempted "REF100" vs "REF1005",
    exactly the sequential-CRM-id collision this veto exists to catch.
    `reference_codes_conflict` is correctly a PLAIN inequality once both
    codes clear `_normalize` — these two real code pairs are pinned here
    as regression coverage of that, not as evidence they matter in
    practice (they don't reach this signal at all — see
    TestReferenceCodeConflictVeto in test_dedup_engine.py and
    issue #197)."""

    def test_property_37_pair_conflicts_under_the_plain_comparison(self):
        a = _record(contact_raw="HOUSE MAISON, S.L.", reference_code="8385 11")
        b = _record(contact_raw="HOUSE MAISON, S.L.", reference_code="8385 11 1")
        assert reference_codes_conflict(a, b) is True

    def test_property_71434_pair_conflicts_under_the_plain_comparison(self):
        a = _record(contact_raw="AC-10 ASOCIADAS, S.L.", reference_code="09502,1")
        b = _record(contact_raw="AC-10 ASOCIADAS, S.L.", reference_code="09502")
        assert reference_codes_conflict(a, b) is True
