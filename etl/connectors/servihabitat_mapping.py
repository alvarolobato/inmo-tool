"""Servihabitat-specific field mapping: raw values -> canonical vocabulary.

Servihabitat (CaixaBank / Lone Star; also administers Sareb and some
Kutxabank stock) encodes the property type as a path segment in the
listing URL rather than as a field in the page body, e.g.
`/es/venta/vivienda/...` or `/es/venta/promociones/garaje/...`. That makes
the URL the authoritative type signal here, unlike Fotocasa/Milanuncios
where it comes out of an embedded JSON blob.

Keeping the "their vocabulary -> our vocabulary" translation in its own
module mirrors fotocasa_mapping.py / milanuncios_mapping.py for the same
reason: the lossy, judgment-call parts of a connector belong in one
legible place.
"""

from __future__ import annotations

# URL path segment -> property.property_type (schema CHECK constraint:
# 'piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Unmapped values fall through to None (the CHECK allows NULL) rather than
# guessing; the raw segment is preserved in raw_extra either way.
#
# Observed segments in the live sitemaps (Madrid/Barcelona/Valencia/
# Alicante, 2026-08): vivienda, vivienda-piso, vivienda-casa, garaje,
# garaje-garajecoche, garaje-garajemoto, local, oficina, nave, terreno-*,
# obraparada, promociones.
_TYPE_SEGMENT_MAP: dict[str, str] = {
    "vivienda": "piso",
    "vivienda-piso": "piso",
    "vivienda-casa": "chalet",
    "vivienda-chalet": "chalet",
    "vivienda-atico": "atico",
    "vivienda-duplex": "piso",
    "garaje": "garaje",
    "garaje-garajecoche": "garaje",
    "garaje-garajemoto": "garaje",
    "local": "local",
    "oficina": "local",
    "nave": "nave",
    "obraparada": "edificio",
    "edificio": "edificio",
}

# Residential segments only. `discover()` filters to these: this is a
# residential-investment tool, and the raw sitemaps are dominated by
# garages (Madrid: 178 of 360 entries) which would otherwise swamp every
# candidate list with parking spaces.
RESIDENTIAL_SEGMENTS: frozenset[str] = frozenset(
    {
        "vivienda",
        "vivienda-piso",
        "vivienda-casa",
        "vivienda-chalet",
        "vivienda-atico",
        "vivienda-duplex",
    }
)


def map_property_type(type_segment: str | None) -> str | None:
    """Map a URL path segment to our property_type vocabulary."""
    if not type_segment:
        return None
    segment = type_segment.lower()
    if segment in _TYPE_SEGMENT_MAP:
        return _TYPE_SEGMENT_MAP[segment]
    # `terreno-urbanoparaconstruir`, `terreno-rustico`, `terreno-urbanizable`
    # etc. all collapse to 'terreno'; prefix match avoids enumerating every
    # cadastral land classification the site emits.
    if segment.startswith("terreno"):
        return "terreno"
    if segment.startswith("vivienda"):
        return "piso"
    if segment.startswith("garaje"):
        return "garaje"
    return None


def is_residential(type_segment: str | None) -> bool:
    if not type_segment:
        return False
    segment = type_segment.lower()
    return segment in RESIDENTIAL_SEGMENTS or segment.startswith("vivienda")


def parse_location_slug(location_slug: str | None) -> tuple[str | None, str | None]:
    """Split Servihabitat's `province-comarca-municipality` slug.

    Real examples:
        `madrid-areametropolitanamadrid-madtetuan_cuatrocaminos`
        `madrid-cuencadelguadarrama-estacionlacolladovillalba`
        `madrid-lasvegas-sanmartindelavega`

    Returns `(city, province)`. The first segment is the province; the
    last is the municipality, which is the closest thing to a city this
    slug carries. The middle segment is a comarca (sub-provincial region)
    with no slot in our schema — it stays in raw_extra.

    The slug is lowercase and de-spaced, so this cannot recover proper
    capitalisation or word boundaries ("sanmartindelavega"). It is
    deliberately returned as-is rather than guessed at: a wrong
    reconstruction would poison the address-similarity dedup signal
    (issue #16 signal 2), which compares normalized address text.
    """
    if not location_slug:
        return None, None
    parts = [p for p in location_slug.split("-") if p]
    if not parts:
        return None, None
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[-1], parts[0]
