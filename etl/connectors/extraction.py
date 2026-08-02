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

import logging
from collections.abc import Callable
from typing import TypeVar

logger = logging.getLogger("etl.connectors.extraction")

T = TypeVar("T")


def first_present(*getters: Callable[[], T | None], field: str) -> T | None:
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

    `field` is required (not optional) specifically so a genuinely broken
    getter — e.g. a typo'd attribute access that raises on every single
    call, forever — doesn't silently and permanently degrade to "field
    absent" with zero observability. Every raise is logged with the field
    name and getter position, so a getter that's been broken since the
    last site redesign shows up in logs instead of just looking like sparse
    data forever (Opus review, PR #84).
    """
    for i, getter in enumerate(getters):
        try:
            value = getter()
        except Exception:
            logger.warning(
                "extraction: getter %d for field %s raised", i, field, exc_info=True
            )
            continue
        if value is not None and value != "":
            return value
    return None


def _strip_es_number_punctuation(text: str) -> str | None:
    """Normalize an es-ES formatted number string to a bare digit string.

    Spanish locale uses `.` as the thousands separator and `,` as the
    decimal separator — e.g. "379.000" (379 thousand, no decimals) or
    "60,5" (sixty point five). Naively stripping every non-digit character
    would silently turn "60,5 m²" into 605 (10x error) and "379.000,50 €"
    into 37900050 (100x error) — both real order-of-magnitude bugs, not
    hypothetical (Opus review, PR #84). This only ever strips the
    thousands-separator dots and drops anything after a decimal comma
    (this codebase's numeric fields — rooms, bathrooms, m2, price — don't
    need sub-unit precision from a CSS fallback), rather than attempting a
    general locale-aware float parse.
    """
    whole_part = text.split(",", 1)[0]
    digits = "".join(ch for ch in whole_part if ch.isdigit())
    return digits or None


def text_to_int(text: str | None) -> int | None:
    """Parse a CSS-extracted integer, handling es-ES number punctuation.

    Fotocasa's icon-stat spans (e.g. "2" in a "2 habs." row) are usually
    already bare digits, but this stays defensive against thousands
    separators/decimals the site might emit for a larger stat (see
    `_strip_es_number_punctuation`).
    """
    if not text:
        return None
    digits = _strip_es_number_punctuation(text)
    return int(digits) if digits else None


def strip_price_punctuation(text: str | None) -> str | None:
    """Strip currency symbols and es-ES thousands/decimal punctuation from
    a price string.

    Fotocasa renders prices as e.g. "379.000 €" (`.` as thousands
    separator, no decimals shown) — mirrors property_web_scraper's
    `stripPunct` modifier on their equivalent CSS fallback, but decimal-
    comma-aware (see `_strip_es_number_punctuation`). Returns a bare digit
    string suitable for `Decimal(...)`, or None if nothing numeric was
    found.
    """
    if not text:
        return None
    return _strip_es_number_punctuation(text)
