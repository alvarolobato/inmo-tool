"""Tests for etl.dedup.signals.floor (issue #186).

Direct unit tests for the normalizer + corroboration primitives, against
the real floor-string formats issue #186 names explicitly: "3º", "3ª
planta", "Bajo", "Entreplanta", "A partir de la 15ª planta" — plus the
exact pair from suggestion 197 ("10º" vs. "A partir de la 15ª planta") and
the exact pair from issue #185's own reported bug ("3º" vs. "3ª planta").
"""

from __future__ import annotations

import pytest

from etl.dedup.signals.floor import floors_agree, floors_conflict, normalize_floor


class TestNormalizeFloor:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("3º", "3"),
            ("3ª planta", "3"),
            ("10º", "10"),
            ("A partir de la 15ª planta", "15"),
            ("Bajo", "bajo"),
            ("bajo", "bajo"),
            ("Planta baja", "bajo"),
            ("Entreplanta", "entresuelo"),
            ("Entresuelo", "entresuelo"),
            ("Ático", "atico"),
            ("atico", "atico"),
            ("Principal", "principal"),
            ("Sótano", "sotano"),
            ("Semisótano", "semisotano"),
            ("1", "1"),
            ("0", "0"),
        ],
    )
    def test_real_format_corpus(self, raw, expected):
        assert normalize_floor(raw) == expected

    def test_the_185_pair_normalizes_equal(self):
        """Issue #185's own reported pair: floor="3º" (Milanuncios) vs.
        floor="3ª planta" (Fotocasa) is the *same* floor, formatted
        differently. A naive string-equality gate would under-corroborate
        this exact case — the normalizer must not.
        """
        assert normalize_floor("3º") == normalize_floor("3ª planta")

    def test_suggestion_197_pair_normalizes_different(self):
        """The clean illustration from issue #186: floors "10º" vs. "A
        partir de la 15ª planta", identical photos, identical price, 6m²
        apart. Floor is the one discriminating data point that was present
        and unread — the normalizer must resolve these to different keys.
        """
        assert normalize_floor("10º") != normalize_floor("A partir de la 15ª planta")

    @pytest.mark.parametrize("raw", [None, "", "   ", "sin especificar", "N/D"])
    def test_unparseable_or_empty_returns_none(self, raw):
        assert normalize_floor(raw) is None

    def test_semisotano_not_confused_with_sotano(self):
        assert normalize_floor("Semisótano") != normalize_floor("Sótano")
        assert normalize_floor("Semisótano") == "semisotano"
        assert normalize_floor("Sótano") == "sotano"


class TestFloorsConflict:
    def test_matching_floors_do_not_conflict(self):
        assert floors_conflict("3º", "3ª planta") is False

    def test_different_floors_conflict(self):
        assert floors_conflict("10º", "A partir de la 15ª planta") is True

    def test_different_word_floors_conflict(self):
        assert floors_conflict("Bajo", "Ático") is True

    @pytest.mark.parametrize(
        "a, b",
        [
            (None, "3º"),
            ("3º", None),
            (None, None),
            ("", "3º"),
            ("sin especificar", "3º"),
        ],
    )
    def test_absence_on_either_side_never_conflicts(self, a, b):
        """The whole point of issue #186: absent floor data is 'no
        evidence', never treated as either agreement or disagreement — a
        missing floor must never block a merge another signal supports."""
        assert floors_conflict(a, b) is False


class TestFloorsAgree:
    def test_matching_floors_agree(self):
        assert floors_agree("3º", "3ª planta") is True

    def test_different_floors_do_not_agree(self):
        assert floors_agree("10º", "15º") is False

    @pytest.mark.parametrize(
        "a, b",
        [
            (None, "3º"),
            ("3º", None),
            (None, None),
        ],
    )
    def test_absence_on_either_side_is_never_agreement(self, a, b):
        """The distinction issue #186 explicitly calls out: 'treat absent
        on either side as no evidence, never as agreement'."""
        assert floors_agree(a, b) is False
