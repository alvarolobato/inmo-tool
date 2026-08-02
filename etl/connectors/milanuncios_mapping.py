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
