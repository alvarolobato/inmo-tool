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
from bs4 import BeautifulSoup

from etl.connectors.extraction import (
    first_present,
    scoped_node,
    scoped_text,
    strip_price_punctuation,
    text_to_int,
    underscore_city_slug,
)


class TestUnderscoreCitySlug:
    """The pisos.com / habitaclia.com search-URL slug rule (issue #369)."""

    @pytest.mark.parametrize(
        "name,expected",
        [
            # Single word passes through unchanged.
            ("madrid", "madrid"),
            # Multi-word -> underscore-joined (the regression at the heart of
            # #369: the old table used hyphens, which 404 live).
            ("dos hermanas", "dos_hermanas"),
            ("alcala de guadaira", "alcala_de_guadaira"),
            ("mairena del aljarafe", "mairena_del_aljarafe"),
            # Accents folded to ASCII.
            ("málaga", "malaga"),
            # Apostrophes collapse to a single underscore like any other
            # non-alphanumeric run (the caller handles portal-specific
            # exceptions via a small verified override table).
            ("l'hospitalet de llobregat", "l_hospitalet_de_llobregat"),
            # Leading/trailing separators are stripped.
            (" dos hermanas ", "dos_hermanas"),
        ],
    )
    def test_slug(self, name, expected):
        assert underscore_city_slug(name) == expected


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


class TestScopedNodeAndText:
    """`drop` must apply BEFORE `keep`.

    `keep` resolves via `select_one`, which takes the first match in document
    order. If a contaminating subtree renders earlier AND contains an element
    matching `keep`, keeping first selects the *neighbour's* container and the
    subsequent drop is a no-op on the wrong subtree. This ordering was the
    reason PR #153 forked the helper instead of reusing it; fixing it here so
    the two options compose correctly for every caller (Opus review, PR #153).
    """

    CONTAMINATED = """
      <html><body>
        <section class="carousel">
          <div class="stats"><span>NEIGHBOUR999</span></div>
        </section>
        <main>
          <div class="stats"><span>SUBJECT111</span></div>
        </main>
      </body></html>
    """

    def test_drop_applies_before_keep_so_the_subject_wins(self):
        soup = BeautifulSoup(self.CONTAMINATED, "html.parser")
        assert scoped_text(soup, keep=".stats", drop=(".carousel",)) == "SUBJECT111"

    def test_keep_first_would_have_returned_the_neighbour(self):
        """Pins the bug rather than just the fix: this is what the old
        keep-then-drop order produced, so if the ordering is ever reverted the
        test above fails with exactly this value."""
        soup = BeautifulSoup(self.CONTAMINATED, "html.parser")
        assert soup.select_one(".stats").get_text(strip=True) == "NEIGHBOUR999"

    def test_scoped_node_returns_an_element_not_text(self):
        soup = BeautifulSoup(self.CONTAMINATED, "html.parser")
        node = scoped_node(soup, keep=".stats", drop=(".carousel",))
        assert node is not None
        assert node.name == "div"
        assert node.select_one("span").get_text(strip=True) == "SUBJECT111"

    def test_does_not_mutate_the_callers_tree(self):
        """Connectors memoise one soup across every fallback getter, so an
        in-place decompose would strip markup out from under the others."""
        soup = BeautifulSoup(self.CONTAMINATED, "html.parser")
        scoped_text(soup, drop=(".carousel",))
        assert soup.select_one(".carousel") is not None

    def test_keep_miss_returns_none_so_a_chain_can_fall_through(self):
        soup = BeautifulSoup(self.CONTAMINATED, "html.parser")
        assert scoped_text(soup, keep="#absent") is None
        assert scoped_node(soup, keep="#absent") is None

    def test_none_input_returns_none(self):
        assert scoped_text(None) is None
        assert scoped_node(None) is None
