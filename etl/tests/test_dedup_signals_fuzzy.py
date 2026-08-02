"""Tests for etl.dedup.signals.fuzzy (issue #16 item 5).

Previously had zero coverage — added alongside the PR #55 review fix for
three dead abbreviation-expansion rules (c/, cl., av. never matched their
real-world space-separated form; see normalize_address's docstring comment).
"""

from __future__ import annotations

from etl.dedup.signals.fuzzy import normalize_address


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
