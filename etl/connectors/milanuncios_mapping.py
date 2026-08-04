"""Milanuncios-specific field mapping: raw JSON values -> canonical vocabulary.

Mirrors fotocasa_mapping.py's role: isolate the "their vocabulary -> our
vocabulary" translation so milanuncios.py stays about fetching/parsing
structure, not field semantics. See docs/skills/connectors.md.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("etl.connectors.milanuncios_mapping")

# ad['category']['slug'] -> property.property_type (schema CHECK constraint:
# 'piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Unmapped values fall through to None (CHECK allows NULL) — the raw slug is
# preserved in raw_extra either way. Milanuncios' category taxonomy is much
# larger than this (rentals, shared rooms, parking, etc.) — only sale-relevant
# residential/commercial slugs observed during the Phase 2.1 feasibility spike
# are mapped; discover() itself is scoped to a single sale category per run
# (see milanuncios.py), so most of these won't be hit until a future task
# broadens scope to multiple categories.
#
# "alquiler-de-pisos" (issue #31): live-verified 2026-08-03 against
# https://www.milanuncios.com/alquiler-de-pisos-en-madrid-madrid/ (real
# HTTP 200, 41 ads, every one carrying this exact category.slug) — the one
# rental category etl/connectors/milanuncios_rental.py's discover() is
# scoped to, same "only what's actually reachable today" discipline as the
# venta-* entries above. Left unmapped WITHOUT this entry, every rental
# listing would normalize with `property_type = NULL`, which would silently
# break rent-estimate.ts's comparable query (`WHERE property_type = ...`
# can never match a NULL) for every single ingested rental row — this is
# not a cosmetic gap, the feature depends on it. The other alquiler-*
# siblings (aticos/duplex/chalets/etc.) almost certainly follow the same
# naming convention as their venta-* counterparts, but that's inference,
# not verification — deliberately NOT added speculatively (this module's
# own stated discipline: "only slugs observed... are mapped"); add them
# once milanuncios_rental.py's discover() actually broadens beyond the
# single "-de-pisos" category and a real fetch confirms each slug.
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
    "alquiler-de-pisos": "piso",
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
    # Non-empty but unrecognized -- the exact miscategorization case this
    # per-listing derivation exists to catch (as opposed to blanket-
    # labeling everything "sale"). The orchestrator's INSERT path still
    # COALESCEs a None operation to 'sale' at the DB layer (a schema-level
    # safe default shared by every connector), so without this log a
    # miscategorized listing would silently end up labeled 'sale' anyway
    # with zero trace of the uncertainty (Opus review, PR #85).
    logger.warning(
        "milanuncios: unrecognized category slug %r -- operation left "
        "unknown rather than defaulted to sale/rent",
        category_slug,
    )
    return None


# Attribute `type` values already surfaced as first-class CanonicalListingVersion
# columns — excluded from `extra_features` so nothing is duplicated between a
# real column and the free-text `features` array. `squareMeterPrice` was
# wrongly included here (Opus review, PR #85): no `price_per_m2`-style column
# exists anywhere in base.py/init.sql, so it was being silently dropped from
# *both* a column and `features` for no reason — removed from this set so it
# now flows into `features` like any other unmapped attribute.
_ATTRIBUTES_MAPPED_TO_COLUMNS = frozenset(
    {
        "bedrooms",
        "bathrooms",
        "squareMeters",
        "floor",
        "energyCertificate",
    }
)


def _slugify(text: str) -> str:
    """Lowercase ascii snake_case token: camelCase word boundaries and
    non-alnum runs both become a single underscore, stripped at the edges.
    `"hotWater"` -> `"hot_water"`; `"natural_gas"` stays `"natural_gas"`;
    `"Aire acondicionado"` -> `"aire_acondicionado"` — without the
    camelCase split, Milanuncios' own camelCase attribute-type names
    (`hotWater`, `squareMeterPrice`) would collapse into unreadable
    unbroken runs (`hotwater`, `squaremeterprice`)."""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", text)
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def extra_features(attributes: list[Any]) -> tuple[str, ...]:
    """Surface any `ad.attributes` entry not already mapped to a first-class
    column as a short `"<type>_<value>"` slug token (issue #78, issue #76's
    `property.features` column) — mirrors `property_web_scraper`'s
    `features` array concept, not their code.

    Emits slug tokens (e.g. `"heating_natural_gas"`), not the original
    `"<label>: <value>"` human-readable strings — `property.features` is
    documented in data-model.md and indexed with a GIN index specifically
    for containment queries (`features @> ARRAY[...]`) once hard-filtering
    uses it; a full sentence-like string can't be matched that way (Opus
    review, PR #85).

    Confirmed live (2026-08 spike, 3 real listings): `heating`/`hotWater`
    are the attribute types this actually captures today; the list isn't
    hardcoded to those two so any other attribute type Milanuncios adds
    later is picked up automatically without a code change, as long as it
    carries a `type` and a raw `value`.
    """
    features: list[str] = []
    for item in attributes:
        if not isinstance(item, dict):
            continue
        attr_type = item.get("type")
        if not attr_type or attr_type in _ATTRIBUTES_MAPPED_TO_COLUMNS:
            continue
        raw_value = item.get("value")
        if not raw_value:
            continue
        token = f"{_slugify(str(attr_type))}_{_slugify(str(raw_value))}"
        if token:
            features.append(token)
    return tuple(features)


def energy_rating_value(attributes: list[Any]) -> str | None:
    """Look up the energy-certificate rating, preferring a bare A-G letter
    over Milanuncios' human-readable formatting.

    Milanuncios' `valueFormatted` for this attribute is usually a bare
    letter too ("E"), but can also be a non-letter state like "En trámite"
    (pending) or "Exento" (exempt) — neither of which is a real A-G rating.
    Preferring the raw `value` uppercased when it genuinely is a single
    A-G letter keeps this column's format consistent with Fotocasa's
    (which stores bare letters), while still preserving the informative
    non-letter states via `valueFormatted` rather than forcing them into a
    letter they aren't (Opus review, PR #85)."""
    for item in attributes:
        if isinstance(item, dict) and item.get("type") == "energyCertificate":
            raw = item.get("value")
            if isinstance(raw, str) and re.fullmatch(r"[a-gA-G]", raw.strip()):
                return raw.strip().upper()
            return item.get("valueFormatted") or (raw if isinstance(raw, str) else None)
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
