"""Diglo-specific field mapping: raw values -> canonical vocabulary.

Diglo (`digloservicer.com`) is Banco Santander's own REO portal — the
site's `RealEstateAgent` JSON-LD says so verbatim: "Diglo es el nuevo
portal inmobiliario del Grupo Banco Santander". Like Servihabitat, the
property type is encoded as a URL path segment (`/venta-pisos/...`,
`/venta-casas/...`) rather than a body field, so the URL is the
authoritative type signal. The richer subject data (price, city,
province, reference, publish date) comes from the page's own
`window.utag_data` analytics blob, and coordinates from the Drupal
`drupalSettings` JSON — see diglo.py's module docstring for the spike.

Keeping the lossy "their vocabulary -> our vocabulary" translation in its
own module mirrors servihabitat_mapping.py / fotocasa_mapping.py.
"""

from __future__ import annotations

import re
import unicodedata

# A Diglo detail URL always ends in a reference code: 2-4 letters then 6+
# digits (`efe0000200053`, `ib00100180146`, `var...`, `gar...`). Category /
# facet URLs end in a word slug with no trailing digit run (`cualquiera`,
# `chalets-adosados`, `madrid`), so this pattern is what separates a real
# property URL from a navigation URL in the national sitemap.
_REFCODE_RE = re.compile(r"^[a-z]{2,4}[0-9]{6,}$", re.IGNORECASE)

# URL type segment (after stripping the `venta-` prefix) -> property_type
# (schema CHECK: 'piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'). Unmapped values fall through to None (the CHECK allows NULL)
# rather than guessing; the raw segment is kept in raw_extra either way.
#
# Observed segments in the live sitemap/nav (2026-08): pisos, casas,
# garajes, locales, oficinas, naves, terrenos, trasteros, hoteles,
# obras-paradas, activos, otros.
_TYPE_SEGMENT_MAP: dict[str, str] = {
    "pisos": "piso",
    "casas": "chalet",
    "garajes": "garaje",
    "locales": "local",
    "oficinas": "local",
    "naves": "nave",
    "terrenos": "terreno",
    "hoteles": "edificio",
    "obras-paradas": "edificio",
}

# Residential segments only. `discover()` filters to these: this is a
# residential-investment tool, and the raw sitemap is dominated by garages,
# locales and terrenos (of ~987 property URLs, the overwhelming majority
# carry the `ib` bulk-portfolio prefix and are non-residential) which would
# otherwise swamp every candidate list. `pisos` and `casas` are the two
# residential families the site exposes.
RESIDENTIAL_SEGMENTS: frozenset[str] = frozenset({"pisos", "casas"})


def strip_accents(value: str) -> str:
    """ASCII-fold a string (á->a, ñ->n) for slug comparison.

    Diglo's URL province slugs are accent-stripped (`cadiz`, `avila`,
    `leon`, `ciudad-real`); the shared gazetteer's `Place.province` is the
    ASCII province name (`Malaga`, `Ciudad Real`). Folding both to a
    hyphenated lowercase form lets the two meet without a hand-maintained
    per-province slug table (unlike Servihabitat, whose sitemap is split
    one-file-per-province and so needs the explicit mapping).
    """
    return "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c)
    )


def province_slug(province: str) -> str:
    """Turn an ASCII province name into Diglo's URL slug form.

    `"Ciudad Real"` -> `"ciudad-real"`, `"Malaga"` -> `"malaga"`. Matches the
    third-from-last segment of a Diglo detail URL path.
    """
    return re.sub(r"\s+", "-", strip_accents(province).strip().lower())


def is_refcode(segment: str | None) -> bool:
    """True if the segment is a Diglo property reference code (ends a detail URL)."""
    return bool(segment) and bool(_REFCODE_RE.match(segment))


def map_property_type(type_segment: str | None) -> str | None:
    """Map a URL type segment (`pisos`, `casas`, ...) to our vocabulary."""
    if not type_segment:
        return None
    return _TYPE_SEGMENT_MAP.get(type_segment.lower())


def is_residential(type_segment: str | None) -> bool:
    if not type_segment:
        return False
    return type_segment.lower() in RESIDENTIAL_SEGMENTS


def parse_listing_path(url_or_path: str) -> dict[str, str | None]:
    """Split a Diglo listing URL/path into its meaningful segments.

    Two real shapes exist — a subtype segment is present for `casas` and
    absent for `pisos`:
        /venta-pisos/<province>/<municipality>/<refcode>
        /venta-casas/<subtype>/<province>/<municipality>/<refcode>

    The reference code is ALWAYS the last segment, municipality the
    second-last, province the third-last — so those are read from the tail,
    which is stable across the presence/absence of the subtype segment.
    Returns all-None when the tail doesn't end in a reference code (a
    category/facet URL), which is how `discover()` filters navigation URLs
    out of the national sitemap.
    """
    path = url_or_path.split("?", 1)[0]
    path = re.sub(r"^https?://[^/]+", "", path)
    parts = [p for p in path.split("/") if p]
    empty = {
        "type_segment": None,
        "subtype_segment": None,
        "province_slug": None,
        "municipality_slug": None,
        "refcode": None,
    }
    if len(parts) < 4 or not parts[0].startswith("venta-"):
        return empty
    refcode = parts[-1]
    if not is_refcode(refcode):
        return empty
    type_segment = parts[0][len("venta-") :]
    # 4 segments => no subtype; 5+ => a subtype sits between type and province.
    subtype = parts[1] if len(parts) >= 5 else None
    return {
        "type_segment": type_segment,
        "subtype_segment": subtype,
        "province_slug": parts[-3],
        "municipality_slug": parts[-2],
        "refcode": refcode,
    }
