"""Direct unit tests for the shared fallback-chain extraction helper.

`etl/connectors/extraction.py` is reused (not reimplemented) by every
connector that adopts issue #77's fallback-chain pattern — Fotocasa today,
Milanuncios (#78) and Idealista (#75) next. Prior to this file it was only
exercised indirectly through Fotocasa's own tests; a bug here would have
silently propagated into every connector that copies it (Opus review,
PR #84).
"""

from __future__ import annotations

import logging
from decimal import Decimal

import pytest

from etl.connectors.extraction import (
    first_present,
    strip_price_punctuation,
    text_to_int,
)


class TestFirstPresent:
    def test_returns_first_non_empty_result_in_order(self):
        calls: list[str] = []

        def first():
            calls.append("first")

        def second():
            calls.append("second")
            return "found"

        def third():
            calls.append("third")
            return "should never run"

        result = first_present(first, second, third, field="x")
        assert result == "found"
        assert calls == ["first", "second"]

    def test_empty_string_is_treated_as_absent_not_found(self):
        result = first_present(lambda: "", lambda: "real value", field="x")
        assert result == "real value"

    def test_zero_int_is_a_real_found_value_not_absent(self):
        """A property with 0 bathrooms is real data; only None/'' means
        'this getter found nothing'."""
        result = first_present(lambda: 0, lambda: 99, field="bathrooms")
        assert result == 0

    def test_zero_decimal_is_a_real_found_value_not_absent(self):
        result = first_present(lambda: Decimal(0), lambda: Decimal(99), field="m2")
        assert result == Decimal(0)

    def test_raising_getter_does_not_crash_the_chain(self):
        def broken():
            raise AttributeError("simulated: a None in a JSON dict chain")

        result = first_present(broken, lambda: "recovered", field="x")
        assert result == "recovered"

    def test_all_getters_failing_or_raising_returns_none(self):
        def broken():
            raise KeyError("missing")

        result = first_present(lambda: None, lambda: "", broken, field="x")
        assert result is None

    def test_raising_getter_logs_a_warning_with_field_name(
        self, caplog: pytest.LogCaptureFixture
    ):
        def broken():
            raise ValueError("simulated site-structure change")

        with caplog.at_level(logging.WARNING, logger="etl.connectors.extraction"):
            first_present(broken, lambda: "recovered", field="current_price")

        assert len(caplog.records) == 1
        assert "current_price" in caplog.records[0].message
        assert caplog.records[0].levelno == logging.WARNING


class TestTextToInt:
    def test_bare_digits(self):
        assert text_to_int("2") == 2

    def test_strips_surrounding_whitespace_and_unit_label(self):
        assert text_to_int(" 3 habs.") == 3

    def test_thousands_separator_dot_is_stripped_not_counted_as_decimal(self):
        assert text_to_int("1.234") == 1234

    def test_decimal_comma_truncates_rather_than_multiplying_by_ten(self):
        """Real bug this guards against: naive digit-stripping turned
        "60,5 m²" into 605 (a 10x error)."""
        assert text_to_int("60,5 m²") == 60

    def test_none_input_returns_none(self):
        assert text_to_int(None) is None

    def test_empty_string_returns_none(self):
        assert text_to_int("") is None

    def test_no_digits_returns_none(self):
        assert text_to_int("sin datos") is None


class TestStripPricePunctuation:
    def test_thousands_separator_dot(self):
        assert strip_price_punctuation("379.000 €") == "379000"

    def test_decimal_comma_is_dropped_not_multiplied_in(self):
        """Real bug this guards against: naive digit-stripping turned
        "379.000,50 €" into 37900050 (a 100x error)."""
        assert strip_price_punctuation("379.000,50 €") == "379000"

    def test_none_input_returns_none(self):
        assert strip_price_punctuation(None) is None

    def test_no_digits_returns_none(self):
        assert strip_price_punctuation("Consultar precio") is None
