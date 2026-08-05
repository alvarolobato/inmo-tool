"""Escogecasa-specific field mapping: raw values -> canonical vocabulary.

Escogecasa (`escogecasa.es`) is Abanca's own REO portal — the footer and
every listing's financing block point at `abanca.com`, and the portal is
the successor to Novagalicia Banco's stock, concentrated in Galicia and the
northern coast. See escogecasa.py's module docstring for the live feasibility
spike (2026-08-05).

Two lossy translations live here, kept out of the connector proper the same
way diglo_mapping.py / unicaja_mapping.py do it:

  - the site's Spanish `subtipo` label ("Vivienda aislada", "Piso") -> our
    `property_type` CHECK vocabulary, and
  - es-ES number strings (price "80.000", surface "69,38 m²") -> bare numbers,
    with the SAME thousands(`.`)/decimal(`,`) trap Unicaja documented.

The canonical domain is `escogecasa.es`; the historical `escogecasa.com` no
longer resolves (authoritative DNS SERVFAIL as of the spike) — issue #135
asked to confirm this, and it is confirmed.
"""

from __future__ import annotations

import math
import re
import unicodedata

# subtipo (or a token found in the detail h1 / URL slug) -> property_type.
# Schema CHECK: 'piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'. Order matters: the first token that matches wins, so the more
# specific house subtypes are checked before the generic "vivienda".
#
# Observed subtipos in the live search payload (2026-08): "Vivienda aislada",
# "Vivienda adosada", "Vivienda pareada", "Piso", "Piso dúplex", "Vivienda".
_TYPE_TOKENS: tuple[tuple[str, str], ...] = (
    ("adosad", "chalet"),
    ("aislad", "chalet"),
    ("paread", "chalet"),
    ("unifamiliar", "chalet"),
    ("chalet", "chalet"),
    ("atico", "atico"),
    ("duplex", "piso"),
    ("piso", "piso"),
    ("apartament", "piso"),
    ("estudio", "piso"),
    ("oficina", "local"),
    ("local", "local"),
    ("nave", "nave"),
    ("garaje", "garaje"),
    ("plaza de garaje", "garaje"),
    ("trastero", "garaje"),
    ("parcela", "terreno"),
    ("terreno", "terreno"),
    ("solar", "terreno"),
    ("suelo", "terreno"),
    ("edificio", "edificio"),
    # Generic dwelling word, last: a bare "Vivienda" with no house-subtype
    # token is treated as an apartment/piso, the commonest case.
    ("vivienda", "piso"),
)

# subtipo tokens we consider residential dwellings. The search runs with the
# site's own VIVIENDAS category (tgs=1), so non-dwelling stock should not
# appear — this is belt-and-braces so a local/garaje/terreno that slips
# through the server filter is still dropped in discover(), mirroring
# diglo/unicaja.
_RESIDENTIAL_TYPES: frozenset[str] = frozenset({"piso", "chalet", "atico"})


def strip_accents(value: str) -> str:
    """ASCII-fold a string (á->a, ñ->n) for token matching."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c)
    )


def map_property_type(subtipo: str | None) -> str | None:
    """Map an Escogecasa subtipo/type label to our CHECK vocabulary.

    Matches accent- and case-insensitively on substring tokens, so "Piso
    dúplex", "PISO", "Vivienda aislada" all resolve. Unmapped input returns
    None (the CHECK allows NULL) rather than guessing.
    """
    if not subtipo:
        return None
    folded = strip_accents(subtipo).lower()
    for token, mapped in _TYPE_TOKENS:
        if token in folded:
            return mapped
    return None


def is_residential(subtipo: str | None) -> bool:
    return map_property_type(subtipo) in _RESIDENTIAL_TYPES


def parse_es_price(text: str | None) -> str | None:
    """es-ES price string -> bare integer-euros digit string, or None.

    "80.000" / "80.000 €" / "146.500 " -> "80000"/"146500". The dot is the
    thousands separator here (never a decimal); everything after a decimal
    comma (cents) is dropped. Mirrors unicaja_mapping.parse_es_price — the
    same class of trap where a "strip all dots" parser would 1000x the value.
    """
    if text is None:
        return None
    whole = text.split(",", 1)[0]
    digits = "".join(ch for ch in whole if ch.isdigit())
    return digits or None


def parse_es_surface(text: str | None) -> int | None:
    """es-ES surface string -> integer square metres, or None.

    "69,38 m²" -> 69, "753,54" -> 753, "87,5" -> 87. Here the comma is the
    DECIMAL separator (opposite role to the price dot on the same site — the
    Unicaja lesson), so the integer part before the comma is taken and any
    dot (rare, a thousands separator on a huge plot) removed. Sub-unit
    precision is deliberately dropped: a canonical m² field never needs the
    centimetre fraction a CSS/text figure carries.
    """
    if text is None:
        return None
    match = re.search(r"(\d[\d.]*)", text)
    if not match:
        return None
    whole = match.group(1).split(",", 1)[0].replace(".", "")
    return int(whole) if whole else None


def parse_int(text: str | None) -> int | None:
    """First integer in a short label ("2 baños" -> 2, "3 hab." -> 3)."""
    if text is None:
        return None
    match = re.search(r"\d+", text)
    return int(match.group(0)) if match else None


def bbox_from_center(
    lat: float, lon: float, radius_km: float
) -> tuple[float, float, float, float]:
    """A (lat_min, lat_max, lng_min, lng_max) box around a point.

    Escogecasa's search is a Google-Maps bbox query (the page fills hidden
    lat_min/lat_max/lng_min/lng_max from the map's own getBounds()), so a
    (center, radius_km) scope — the shape `ConnectorScope` already carries —
    translates to a box directly. 1° latitude ≈ 111 km everywhere; 1°
    longitude shrinks by cos(latitude). The longitude denominator is floored
    so a point near a pole can't blow the box up to the whole globe (a
    non-issue for Spain, but cheap correctness).
    """
    dlat = radius_km / 111.0
    dlon = radius_km / max(111.0 * math.cos(math.radians(lat)), 1e-6)
    return (lat - dlat, lat + dlat, lon - dlon, lon + dlon)
