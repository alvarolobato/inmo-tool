"""Milanuncios-specific field mapping: raw JSON values -> canonical vocabulary.

Mirrors fotocasa_mapping.py's role: isolate the "their vocabulary -> our
vocabulary" translation so milanuncios.py stays about fetching/parsing
structure, not field semantics. See docs/skills/connectors.md.
"""

from __future__ import annotations

from typing import Any

# ad['category']['slug'] -> property.property_type (schema CHECK constraint:
# 'piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Unmapped values fall through to None (CHECK allows NULL) — the raw slug is
# preserved in raw_extra either way. Milanuncios' category taxonomy is much
# larger than this (rentals, shared rooms, parking, etc.) — only sale-relevant
# residential/commercial slugs observed during the Phase 2.1 feasibility spike
# are mapped; discover() itself is scoped to a single sale category per run
# (see milanuncios.py), so most of these won't be hit until a future task
# broadens scope to multiple categories.
CATEGORY_SLUG_MAP: dict[str, str] = {
    "venta-de-pisos": "piso",
    "venta-de-aticos": "atico",
    "venta-de-duplex": "piso",
    "venta-de-chalets": "chalet",
    "venta-de-casas": "chalet",
    "venta-de-locales": "local",
    "venta-de-oficinas": "local",
    "venta-de-naves": "nave",
    "venta-de-garajes": "garaje",
    "venta-de-terrenos": "terreno",
    "venta-de-fincas": "terreno",
    "venta-de-edificios": "edificio",
}


def map_property_type(category_slug: str | None) -> str | None:
    if not category_slug:
        return None
    return CATEGORY_SLUG_MAP.get(category_slug)


def attribute_value(attributes: list[Any], attr_type: str) -> str | None:
    """Look up the human-readable value by `type` in `ad.attributes`.

    Each entry has shape `{type, fieldFormatted, value, valueFormatted}`.
    Returns `valueFormatted` (e.g. floor `value="ground"` /
    `valueFormatted="bajo"`) — for fields where the human-readable form is
    what you actually want to store (floor, condition, etc.), for the same
    don't-fabricate-precision reason documented in fotocasa.py. **Do not use
    this for numeric fields** — `valueFormatted` often carries a unit
    suffix (e.g. squareMeters' `valueFormatted="353 m²"`, which `Decimal()`
    can't parse) or locale formatting; use `attribute_numeric_value` for
    those instead. A real listing (external_id 608287339, feasibility
    spike) had `m2_built` silently come back `None` before this distinction
    was made — see `attribute_numeric_value`.
    """
    for item in attributes:
        if isinstance(item, dict) and item.get("type") == attr_type:
            return item.get("valueFormatted") or item.get("value")
    return None


def attribute_numeric_value(attributes: list[Any], attr_type: str) -> str | None:
    """Look up the raw (unformatted) value by `type` in `ad.attributes`.

    For fields going into a numeric column (m², price/m², etc.) — the raw
    `value` (e.g. squareMeters `value="353"`, no unit suffix), not
    `valueFormatted` (`"353 m²"`, which `int()`/`Decimal()` can't parse).
    See `attribute_value`'s docstring for the failure this fixes.
    """
    for item in attributes:
        if isinstance(item, dict) and item.get("type") == attr_type:
            return item.get("value")
    return None


def infer_operation(category_slug: str | None) -> str | None:
    """Derive sale-vs-rent from the listing's own `category.slug`, not the
    discovery URL alone (issue #78).

    `discover()` only ever fetches the `venta-de-pisos` category URL today,
    so a Fotocasa-style hardcoded `"sale"` would be defensible on the same
    grounds Fotocasa used — but Milanuncios is a general classifieds site,
    not a dedicated real-estate portal with rigorously enforced categories,
    so per-listing miscategorization is a real (if rare) possibility there
    in a way it may not be for Fotocasa. Deriving from each listing's own
    `category.slug` instead of the discovery URL means a stray
    non-`venta-*` listing (miscategorized, or a future connector run that
    broadens scope beyond `venta-de-pisos`) is reflected honestly rather
    than blanket-labeled `sale`. Only `venta-*`/`alquiler-*` prefixes are
    recognized (Milanuncios' actual category-slug convention, confirmed
    against `CATEGORY_SLUG_MAP`); anything else returns `None` rather than
    guessing.
    """
    if not category_slug:
        return None
    if category_slug.startswith("venta-"):
        return "sale"
    if category_slug.startswith("alquiler-"):
        return "rent"
    return None


# Attribute `type` values already surfaced as first-class CanonicalListingVersion
# columns — excluded from `extra_features` so nothing is duplicated between a
# real column and the free-text `features` array.
_ATTRIBUTES_MAPPED_TO_COLUMNS = frozenset(
    {
        "bedrooms",
        "bathrooms",
        "squareMeters",
        "squareMeterPrice",
        "floor",
        "energyCertificate",
    }
)


def extra_features(attributes: list[Any]) -> tuple[str, ...]:
    """Surface any `ad.attributes` entry not already mapped to a first-class
    column as a human-readable `"<field>: <value>"` string (issue #78,
    issue #76's `property.features` column) — mirrors
    `property_web_scraper`'s `features` array concept, not their code.

    Confirmed live (2026-08 spike, 3 real listings): `heating`/`hotWater`
    ("calefaccion: gas natural", "agua caliente: gas natural") are the
    attribute types this actually captures today; the list isn't
    hardcoded to those two so any other attribute type Milanuncios adds
    later is picked up automatically without a code change, as long as it
    carries both `fieldFormatted` and a formatted/raw value.
    """
    features: list[str] = []
    for item in attributes:
        if not isinstance(item, dict):
            continue
        attr_type = item.get("type")
        if not attr_type or attr_type in _ATTRIBUTES_MAPPED_TO_COLUMNS:
            continue
        label = item.get("fieldFormatted")
        value = item.get("valueFormatted") or item.get("value")
        if label and value:
            features.append(f"{label}: {value}")
    return tuple(features)


def infer_listing_kind(seller_type: dict[str, Any] | None) -> str | None:
    """`ad.sellerType.isPrivate` is an explicit boolean — no heuristic needed.

    Unlike Fotocasa (where listing_kind had to be inferred from a URL/name
    pattern because no reliable structured field existed — see
    fotocasa_mapping.py), Milanuncios publishes this directly. Still return
    None rather than guess when the field is missing/malformed, consistent
    with this project's don't-fabricate-confidence principle.
    """
    if not isinstance(seller_type, dict):
        return None
    is_private = seller_type.get("isPrivate")
    if is_private is True:
        return "particular"
    if is_private is False:
        return "agency"
    return None
