"""Tests for ``decode_signed_int16_word`` (4D WORD unsigned → signed)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from etl.db.fourd import decode_signed_int16_word


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        (-1, -1),
        (0, 0),
        (32767, 32767),
        (32768, -32768),
        (65534, -2),
        (65535, -1),
        (65535.0, -1),
        ("65535", -1),
        (" 65534 ", -2),
        (Decimal("65535"), -1),
        (Decimal("-3"), -3),
        (Decimal("65535.5"), Decimal("65535.5")),
    ],
)
def test_decode_signed_int16_word(raw, expected):
    assert decode_signed_int16_word(raw) == expected


def test_non_numeric_string_unchanged():
    assert decode_signed_int16_word("abc") == "abc"


def test_bool_unchanged():
    assert decode_signed_int16_word(True) is True
