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

import copy
import logging
import re
import unicodedata
from collections.abc import Callable, Sequence
from typing import Any, TypeVar

logger = logging.getLogger("etl.connectors.extraction")

T = TypeVar("T")


def underscore_city_slug(name: str) -> str:
    """Slugify a gazetteer municipality name the way pisos.com AND
    habitaclia.com both build their search-URL path segment.

    Both portals use the SAME convention: accent-stripped, lowercased, with
    every run of non-alphanumeric characters (spaces, hyphens, apostrophes)
    collapsed to a single underscore. Live-verified 2026-08 against both
    sites (issue #369): `dos hermanas` -> `dos_hermanas`
    (`https://www.pisos.com/venta/pisos-dos_hermanas/` and
    `https://www.habitaclia.com/viviendas-dos_hermanas.htm` both HTTP 200
    with real listings, while the hyphenated `dos-hermanas` 404s on both);
    `alcala de guadaira` -> `alcala_de_guadaira` and `mairena del aljarafe`
    -> `mairena_del_aljarafe` likewise HTTP 200 on pisos.com; single-word
    names (`madrid`) pass through unchanged.

    Shared here rather than duplicated per connector because the convention
    is genuinely identical across the two connectors that use it — the
    reason issue #369 existed at all was a hand-maintained per-city slug
    table drifting from what the sites actually serve, so the fix is to
    derive the slug mechanically from the resolved gazetteer name instead.
    A name whose naive slug the portal doesn't serve (e.g. pisos.com drops
    the leading article of `l'hospitalet de llobregat`) is handled by the
    caller: an HTTP 404 on that URL is treated as "city not on this portal"
    (a clean, uncovered result), never a hard failure.
    """
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c)
    )
    return re.sub(r"[^a-z0-9]+", "_", folded.lower()).strip("_")


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


def scoped_node(
    node: Any,
    *,
    keep: str | None = None,
    drop: Sequence[str] = (),
) -> Any | None:
    """Return the subject element after removing `drop` and scoping to `keep`.

    The element-returning sibling of `scoped_text`, for callers that need to
    run their own regex over the result, read attributes, or iterate child
    elements rather than consume a flattened string (issue #149 needed a
    regex over the scoped markup; flattening first would have thrown away
    the structure it matches against).

    `drop` is applied BEFORE `keep`, which matters: `keep` resolves via
    `select_one`, so it takes the first match in document order. If a
    contaminating subtree happens to contain an element matching `keep` and
    renders earlier in the document, keeping first would select the
    *neighbour's* container and the subsequent drop would be a no-op on the
    wrong subtree. Dropping first makes the two options compose in the only
    order that is correct in every case (Opus review, PR #153).

    Never mutates the caller's tree: `drop` operates on a copy, because a
    shared helper that silently `decompose()`d the caller's soup would be a
    trap for the next connector to reach for it — connectors memoise a
    single parsed soup across every fallback getter, so an in-place
    decompose would strip markup out from under the other extractors.
    """
    if node is None:
        return None
    scope = node
    if drop:
        scope = copy.copy(scope)
        for selector in drop:
            for contaminant in scope.select(selector):
                contaminant.decompose()
    if keep is not None:
        scope = scope.select_one(keep)
        if scope is None:
            return None
    return scope


def scoped_text(
    node: Any,
    *,
    keep: str | None = None,
    drop: Sequence[str] = (),
    separator: str = " ",
) -> str | None:
    """Flatten an element's text after removing `drop` and scoping to `keep`.

    Exists because three separate connectors independently hit the same bug:
    a listing page renders a "similar properties" carousel whose cards carry
    their *own* price/m2/room figures in the same page text, so an unscoped
    regex over `soup.get_text()` can silently attribute a neighbouring
    property's numbers to the subject. Vivantial read 310.000 EUR off a
    neighbour instead of the subject's 288.000 EUR (PR #139); Solvia's price
    fallback had the same latent exposure (PR #138); Servihabitat hit it live
    on ref 60645658, an 80 m2 / 230.000 EUR listing whose page text also
    contains a neighbour's "48m 2 2 hab. 1 bano ... 190.000 EUR" (PR #141).

    Each connector fixed it by hand. Promoting it here so connector #6 gets
    the defence for free instead of rediscovering the bug a fourth time, and
    so the *reason* travels with the code (Opus review, PR #141).

    Two independent defences, usable together:
      `keep` -- CSS selector for the subject-property container, so only its
                text is considered at all. The stronger option where the page
                has such a container. Returns None when it does not match,
                which lets a `first_present` chain fall through to a
                whole-page attempt rather than silently yielding "".
      `drop` -- CSS selectors for known-contaminating subtrees (carousels,
                related-listing rails), removed before flattening. The
                fallback for pages with no clean subject container.

    Never mutates the caller's tree: `drop` operates on a copy, because a
    shared helper that silently `decompose()`d the caller's soup would be a
    trap for the next connector to reach for it. The copy costs one deep-copy
    per listing fetch, negligible against the HTTP request that produced it.

    Scoping order (`drop` then `keep`) and the copy semantics both live in
    `scoped_node`, which this delegates to — use that directly when you need
    the element rather than its flattened text.
    """
    scope = scoped_node(node, keep=keep, drop=drop)
    if scope is None:
        return None
    return scope.get_text(separator, strip=True) or None


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
