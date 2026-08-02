"""Fotocasa-specific field mapping: raw JSON values -> canonical vocabulary.

Fotocasa embeds a full JSON blob per listing page in a
`<script type="application/json" id="__initial_props__">` tag (no headless
browser needed — it's server-rendered, plain HTML parsing suffices). This
module isolates the "their vocabulary -> our vocabulary" translation so
fotocasa.py stays about fetching/parsing structure, not field semantics.

Mirrors the source project's `_ARTICULOS_MAPPING`-style dicts
(etl/sync/articulos.py in powershop-analytics) for the same reason: keep the
lossy, judgment-call parts of a connector in one legible place.
"""

from __future__ import annotations

# realEstate.buildingType -> property.property_type (schema CHECK constraint:
# 'piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Unmapped values fall through to None (CHECK allows NULL) rather than
# guessing — the raw value is preserved in raw_extra either way.
BUILDING_TYPE_MAP: dict[str, str] = {
    "Flat": "piso",
    "Duplex": "piso",
    "Penthouse": "atico",
    "StudioFlat": "piso",
    "House": "chalet",
    "Chalet": "chalet",
    "SemidetachedHouse": "chalet",
    "TerracedHouse": "chalet",
    "Premise": "local",
    "Office": "local",
    "IndustrialBuilding": "nave",
    "Land": "terreno",
    "Garage": "garaje",
    "Building": "edificio",
}


def map_property_type(raw_building_type: str | None) -> str | None:
    if not raw_building_type:
        return None
    return BUILDING_TYPE_MAP.get(raw_building_type)


# clientTypeId is not a reliable particular/agency signal on its own — a
# spot-checked listing had clientTypeId=3 with an obviously corporate name
# ("ESTUDIO SANTA EUGENIA 2010 SL"), so a numeric-only mapping would have
# been a confident-looking guess with no verified ground truth. clientUrl
# is the sturdier signal: Fotocasa routes every agency through a
# `/inmobiliaria-<slug>/` microsite path; a private seller has no such URL.
# Revisit with more sampled listings if this heuristic turns out wrong in
# practice (task 2.1's second-connector work is a natural point to check).
_AGENCY_URL_MARKER = "/inmobiliaria-"
_AGENCY_NAME_SUFFIXES = (" sl", " s.l.", " slu", " s.l.u.", " sa", " s.a.")


def infer_listing_kind(client_url: str | None, client_name: str | None) -> str | None:
    if client_url and _AGENCY_URL_MARKER in client_url:
        return "agency"
    if client_name:
        lowered = client_name.strip().lower()
        if lowered.endswith(_AGENCY_NAME_SUFFIXES):
            return "agency"
    if client_name or client_url:
        return "particular"
    return None
