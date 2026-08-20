"""Tests for etl.dedup.signals.fuzzy (issue #16 item 5).

Added alongside the PR #55 review fix for three dead abbreviation-
expansion rules (c/, cl., av. never matched their real-world
space-separated form; see normalize_address's docstring comment).

Issue #601 (D-130) retired this module's `evaluate()` signal entirely —
see the module's own docstring. `normalize_address` survives (reused by
`address_coords.py`), so this file now covers only that; the
structured-fields-veto coverage that used to live here (calling the now-
deleted `evaluate()`) moved to test_dedup_signals_structured_fields.py's
direct, pure-function tests of `structured_fields_conflict` — see that
file, and TestStructuredFieldsNeverVetoesStrongerSignals in
test_dedup_engine.py for what remains load-bearing at the engine level.
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
