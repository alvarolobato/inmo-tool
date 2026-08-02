"""Tests for etl.dedup.signals.phone_extract (issue #16 item 3).

Previously had no dedicated unit tests for extract_phones() in isolation
(only end-to-end coverage via test_dedup_engine.py's TestPhoneSignal). Added
alongside the PR #55 review fix for a missing digit-boundary guard.
"""

from __future__ import annotations

from etl.dedup.signals.phone_extract import extract_phones


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
