"""habitaclia.com-specific field mapping: raw values -> canonical vocabulary.

habitaclia.com (Adevinta, same group as Fotocasa) is — despite the shared
owner — a completely different, older stack from Fotocasa: classic ASP.NET
`.htm` pages with `*DTO` JS config objects, NOT Fotocasa's Next-style
`__initial_props__` JSON blob. There is no payload reuse to exploit (issue
#79's Adevinta-reuse hypothesis checked and found false, live 2026-08), and
— contrary to property_web_scraper's `es_habitaclia.json` reference mapping
— the live detail page carries NO JSON-LD at all. Fields are read from
bespoke HTML plus a `VGPSLat`/`VGPSLon` regex for coordinates (see
habitaclia.py). This module isolates the vocabulary translation, mirroring
fotocasa_mapping.py.

The property TYPE is the first path token of the listing URL
(`/comprar-<type>-en_venta_..._-<city>-i<id>.htm`), e.g. `piso`, `casa`,
`atico` — the same URL-token approach pisos_mapping.py uses, for the same
reason (no reliable structured type field on the page).
"""

from __future__ import annotations

import re

# habitaclia URL type token (`/comprar-<token>-...`) -> property.property_type
# (schema CHECK: 'piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'). Unmapped tokens fall through to None rather than guessing; the
# raw token is preserved in raw_extra either way. `piso` observed live
# 2026-08; the rest are habitaclia's own property-type URL vocabulary.
URL_TYPE_TOKEN_MAP: dict[str, str] = {
    "piso": "piso",
    "apartamento": "piso",
    "estudio": "piso",
    "duplex": "piso",
    "loft": "piso",
    "atico": "atico",
    "casa": "chalet",
    "casa_adosada": "chalet",
    "adosado": "chalet",
    "pareado": "chalet",
    "chalet": "chalet",
    "torre": "chalet",
    "masia": "chalet",
    "finca": "chalet",
    "local": "local",
    "oficina": "local",
    "nave": "nave",
    "nave_industrial": "nave",
    "parking": "garaje",
    "garaje": "garaje",
    "terreno": "terreno",
    "solar": "terreno",
    "suelo": "terreno",
    "edificio": "edificio",
}

# `/comprar-piso-en_venta_..._-barcelona-i4737003828090.htm` -> "piso".
_URL_TYPE_RE = re.compile(r"/comprar-([a-z_]+?)-en_", re.IGNORECASE)
# The city token sits right before the `-i<id>.htm` id suffix.
_URL_CITY_RE = re.compile(r"-([a-z_]+)-i\d+\.htm", re.IGNORECASE)


def type_token_from_url(url: str | None) -> str | None:
    if not url:
        return None
    m = _URL_TYPE_RE.search(url)
    return m.group(1).lower() if m else None


def map_property_type(url: str | None) -> str | None:
    token = type_token_from_url(url)
    if not token:
        return None
    return URL_TYPE_TOKEN_MAP.get(token)


def city_from_url(url: str | None) -> str | None:
    """The municipality token from a habitaclia listing URL slug.

    `..._-barcelona-i4737003828090.htm` -> "Barcelona" (title-cased, `_`
    underscores turned to spaces). A loose signal — habitaclia's slug city
    is the search-scope city, not necessarily a granular municipality — but
    honest for the `city` column, and None when the pattern doesn't match.
    """
    if not url:
        return None
    m = _URL_CITY_RE.search(url)
    if not m:
        return None
    token = m.group(1).replace("_", " ").strip()
    return token.title() or None
