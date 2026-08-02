"""Idealista-specific field mapping: raw text/JSON values -> canonical vocabulary.

Unlike Fotocasa/Milanuncios (etl/connectors/fotocasa.py, milanuncios.py),
this connector never makes a live network request — task 1.4's feasibility
spike already established Idealista returns an immediate CAPTCHA challenge
to every direct HTTP request. It only ever parses HTML a human's own
browser already rendered and the browser-extension (browser-extension/,
issue #75) captured. See idealista.py's module docstring for the full
capture-flow explanation.

Field locations below are grounded in a real, dated Idealista listing page
(the same page property_web_scraper's own `es_idealista.json` mapping
targets, last checked by them 2026-02-20 — this repo's fixture,
etl/tests/fixtures/idealista_sample_detail.html, is trimmed from theirs,
attribution in browser-extension/NOTICE.md) — not independently
live-verified against a *current* Idealista page, since this connector has
no way to fetch one itself. If Idealista's markup has changed since
2026-02-20, the first real capture through the browser extension will
surface which fields came back empty; that's the moment to re-verify, not
before.
"""

from __future__ import annotations

import re

# Idealista's `typology`/`propertyTypeId` fields (seen in the embedded JS
# object, e.g. `typology: 'home'`, `propertyTypeId: 1`) are too coarse to
# map onto property.property_type's CHECK vocabulary
# ('piso','chalet','atico','local','nave','garaje','terreno','edificio') —
# 'home' covers everything from a studio flat to a country house, and
# propertyTypeId has no published lookup table in anything this connector
# can see. The listing title (e.g. "Duplex for sale in Calle de Alcalá")
# is the only place a more specific Spanish/English property-type word
# reliably appears — best-effort keyword matching, not a guess dressed up
# as structured data (the raw title is preserved in raw_extra regardless).
_TITLE_TYPE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("atico", "atico"),
    ("ático", "atico"),
    ("penthouse", "atico"),
    ("duplex", "piso"),
    ("dúplex", "piso"),
    ("piso", "piso"),
    ("flat", "piso"),
    ("apartment", "piso"),
    ("apartamento", "piso"),
    ("chalet", "chalet"),
    ("casa", "chalet"),
    ("house", "chalet"),
    ("local", "local"),
    ("nave", "nave"),
    ("garaje", "garaje"),
    ("garage", "garaje"),
    ("terreno", "terreno"),
    ("land", "terreno"),
    ("edificio", "edificio"),
    ("building", "edificio"),
)


def map_property_type(title: str | None) -> str | None:
    if not title:
        return None
    lowered = title.lower()
    for keyword, mapped in _TITLE_TYPE_KEYWORDS:
        if keyword in lowered:
            return mapped
    return None


_YEAR_RE = re.compile(r"\bBuilt in (\d{4})\b|\bConstruido en (\d{4})\b")


def parse_year_built(features_text: str | None) -> int | None:
    """`features_text` is the joined text of the "Basic features" detail
    list (e.g. "...Built in 1889..."). No structured year field is exposed
    anywhere this connector can see — only this free-text pattern."""
    if not features_text:
        return None
    match = _YEAR_RE.search(features_text)
    if not match:
        return None
    year_str = match.group(1) or match.group(2)
    return int(year_str)


_ELEVATOR_POSITIVE_RE = re.compile(r"\bWith lift\b|\bCon ascensor\b", re.IGNORECASE)
_ELEVATOR_NEGATIVE_RE = re.compile(r"\bWithout lift\b|\bSin ascensor\b", re.IGNORECASE)


def parse_has_elevator(features_text: str | None) -> bool | None:
    """Same "Building" detail list as parse_year_built — "With lift" /
    "Without lift" (or the Spanish equivalents, if a listing renders in
    Spanish rather than English) are the only elevator signal seen."""
    if not features_text:
        return None
    if _ELEVATOR_POSITIVE_RE.search(features_text):
        return True
    if _ELEVATOR_NEGATIVE_RE.search(features_text):
        return False
    return None


# "5th floor exterior" / "5th floor exterior with lift" — the ordinal +
# orientation is the closest thing to a floor value; kept as free text
# (property.floor is TEXT, not an integer, per docs/architecture/
# data-model.md — this project's schema already treats floor as
# non-numeric, e.g. Milanuncios' "bajo").
_FLOOR_LINE_RE = re.compile(
    r"^\s*(\d+(?:st|nd|rd|th)\s+floor[^<\n]*)", re.IGNORECASE | re.MULTILINE
)


def parse_floor(features_text: str | None) -> str | None:
    if not features_text:
        return None
    match = _FLOOR_LINE_RE.search(features_text)
    if not match:
        return None
    return match.group(1).strip()


def split_address(address_string: str | None) -> tuple[str | None, str | None]:
    """Idealista's `.main-info__title-minor` is a compound
    "district, city" string (e.g. "Goya, Madrid") — no separately
    structured city/district fields are exposed anywhere this connector
    can see. Returns (address, city): the full string is kept as `address`
    (so nothing is lost if the split is wrong for an address format this
    single sample didn't cover — e.g. a rural listing with just one
    segment), and the last comma-separated segment is promoted to `city`
    on a best-effort basis. `province`/`postal_code` are left None: no
    reliable source for either was found in the sample page (unlike
    Fotocasa/Milanuncios, which expose these as real structured JSON
    fields — see issue #76/#77/#78)."""
    if not address_string:
        return None, None
    parts = [p.strip() for p in address_string.split(",") if p.strip()]
    if not parts:
        return None, None
    city = parts[-1] if len(parts) > 1 else None
    return address_string.strip(), city
