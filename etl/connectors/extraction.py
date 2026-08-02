"""Shared fallback-chain extraction helper for connectors.

Adapted from `property_web_scraper`'s field-priority design
(`astro-app/src/lib/extractor/strategies.ts`'s `retrieveTargetTextSingle`,
which tries JSON-LD, then an embedded script variable, then a CSS
selector, in order) — see docs/architecture/connectors.md's "Reusing
property_web_scraper" section for the full priority-order writeup.

Deliberately NOT a port of their JSON-mapping-file DSL: that's the right
scale for a 110-site project where field locations need to be editable
without touching code. inmo-tool has 2-4 connectors; a plain ordered list
of Python callables is the right size (issue #77).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def first_present(*getters: Callable[[], T | None]) -> T | None:
    """Try each getter in order; return the first non-None/non-empty result.

    A getter that raises is treated the same as one that returns None — try
    the next getter rather than propagating. This is deliberately a catch-
    all: a fallback getter can fail for many unrelated reasons depending on
    what it's traversing (a `None` in a JSON dict chain raises
    `AttributeError`, a missing key raises `KeyError`, a malformed number
    raises `ValueError`, a BeautifulSoup selector miss returns `None`
    itself rather than raising) — "this fallback path didn't apply to this
    page" is an expected, not exceptional, outcome for any getter after the
    first, and narrowing the except clause to one exception type would
    silently stop catching the others.
    """
    for getter in getters:
        try:
            value = getter()
        except Exception:  # noqa: BLE001, S112 — see docstring: deliberately broad
            continue
        if value is not None and value != "":
            return value
    return None


def text_to_int(text: str | None) -> int | None:
    """Parse a CSS-extracted integer, stripping non-digit characters.

    Fotocasa's icon-stat spans (e.g. "2" in a "2 habs." row) are already
    bare digits, but this stays defensive against stray whitespace/unicode
    the site might emit.
    """
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    return int(digits) if digits else None


def strip_price_punctuation(text: str | None) -> str | None:
    """Strip currency symbols and thousands separators from a price string.

    Fotocasa renders prices as e.g. "379.000 €" (`.` as thousands
    separator, no decimals shown) — mirrors property_web_scraper's
    `stripPunct` modifier on their equivalent CSS fallback. Returns a bare
    digit string suitable for `Decimal(...)`, or None if nothing numeric
    was found.
    """
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    return digits or None
