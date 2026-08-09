"""Unicaja Inmuebles field mapping: raw values -> canonical vocabulary.

Unicaja Inmuebles (`unicajainmuebles.com`) is the REO portal of Unicaja
Banco, operated by its servicer **Gestión de Inmuebles Adquiridos, S.L.
(GIA)** — the footer copyright and the `inmueblesgia` social handles on
every page say so verbatim, which is why issue #119 names the owner as
"Unicaja Banco (also referred to as GIA)".

Unlike the sitemap-driven REO portals (Diglo, Servihabitat), Unicaja is a
classic server-rendered Java/Struts app (`*.do` actions). There is no
sitemap; discovery paginates a search action (`listadoPromocion.do`) whose
result **cards are richly structured** — each card carries provincia,
municipio, código postal, tipo, surface, rooms, reference code and a
description in labelled `label.titulo` / `label.valor` pairs. The detail
page (`fichainmueble.do?referencia=<ref>`) adds coordinates (server-injected
`var coordX`/`coordY` JS), bathrooms, useful surface and photos, but does
**not** repeat the postal code — so the connector keeps the card data and
merges it with the detail page (see unicaja.py's module docstring).

The province the search action wants is a numeric INE province code
(29=Málaga, 3=Alicante, ...). The gazetteer (`Place.province`) gives an
ASCII province name, and those names differ from the site's own labels for
several provinces (gazetteer "Bizkaia" vs. site "VIZCAYA", "Coruna" vs.
"A CORUÑA", "Castello" vs. "CASTELLÓN", "Illes Balears" vs. "BALEARES").
`province_to_ine_code` folds both vocabularies (plus the usual bilingual
aliases) to the one authoritative code table below, keyed by an
accent-stripped lowercase form so a name from either source resolves.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

# INE province code (== the value of Unicaja's own `provincia` <select>,
# captured live 2026-08-05) keyed by every accent-stripped-lowercase name
# that either the gazetteer (etl.connectors.geography.Place.province) or the
# site's own label — or a common bilingual alias — could produce. A single
# code can have several keys (aliases); that is intentional.
_PROVINCE_INE_CODE: dict[str, str] = {
    "araba / alava": "1",
    "araba": "1",
    "alava": "1",
    "albacete": "2",
    "alicante": "3",
    "alacant": "3",
    "almeria": "4",
    "asturias": "33",
    "avila": "5",
    "badajoz": "6",
    "illes balears": "7",
    "balears": "7",
    "baleares": "7",
    "islas baleares": "7",
    "barcelona": "8",
    "burgos": "9",
    "caceres": "10",
    "cadiz": "11",
    "cantabria": "39",
    "castello": "12",
    "castellon": "12",
    "ceuta": "51",
    "ciudad real": "13",
    "cordoba": "14",
    "coruna": "15",
    "a coruna": "15",
    "la coruna": "15",
    "cuenca": "16",
    "girona": "17",
    "gerona": "17",
    "granada": "18",
    "guadalajara": "19",
    "gipuzkoa": "20",
    "guipuzcoa": "20",
    "huelva": "21",
    "huesca": "22",
    "jaen": "23",
    "la rioja": "26",
    "rioja": "26",
    "las palmas": "35",
    "leon": "24",
    "lleida": "25",
    "lerida": "25",
    "lugo": "27",
    "madrid": "28",
    "malaga": "29",
    "melilla": "52",
    "murcia": "30",
    "navarra": "31",
    "nafarroa": "31",
    "ourense": "32",
    "orense": "32",
    "palencia": "34",
    "pontevedra": "36",
    "salamanca": "37",
    "santa cruz de tenerife": "38",
    "tenerife": "38",
    "segovia": "40",
    "sevilla": "41",
    "soria": "42",
    "tarragona": "43",
    "teruel": "44",
    "toledo": "45",
    "valencia": "46",
    "valladolid": "47",
    "bizkaia": "48",
    "vizcaya": "48",
    "zamora": "49",
    "zaragoza": "50",
}

# Site "Tipo" label (accent-stripped lowercase) -> canonical property_type
# (schema CHECK: 'piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'). The site's search categories (its `tipoInmueble` <select>)
# and the per-listing "Tipo" text share this vocabulary. Unmapped values
# fall through to None (the CHECK allows NULL) rather than guessing — the
# raw value is kept in raw_extra either way. 'trastero' has no canonical
# slot and so maps to None deliberately.
_TYPE_MAP: dict[str, str] = {
    "piso": "piso",
    "estudio": "piso",
    "duplex": "piso",
    "triplex": "piso",
    "atico": "atico",
    "casa": "chalet",
    "chalet": "chalet",
    "chalet adosado": "chalet",
    "chalet independiente": "chalet",
    "chalet pareado": "chalet",
    "local": "local",
    "oficina": "local",
    "nave": "nave",
    "garaje": "garaje",
    "garaje moto": "garaje",
    "garaje coche": "garaje",
    "solar": "terreno",
    "finca": "terreno",
    "terreno": "terreno",
    "edificio": "edificio",
    "hotel": "edificio",
    "obra nueva": "edificio",
    "urbanizacion": "edificio",
}

# Residential dwelling categories. discover() searches with the site's
# `tipoInmueble=0` (VIVIENDA) category, which the server already restricts to
# these dwelling types — but the filter below is a second, belt-and-braces
# guard applied to each card's own "Tipo" text so a garage/solar/local can
# never slip into a residential-investment sweep even if the server category
# ever widens. Mirrors Diglo's RESIDENTIAL_SEGMENTS.
_RESIDENTIAL_TYPES: frozenset[str] = frozenset(
    {
        "vivienda",
        "casa",
        "chalet",
        "chalet adosado",
        "chalet independiente",
        "chalet pareado",
        "piso",
        "atico",
        "estudio",
        "duplex",
        "triplex",
        "obra nueva",
    }
)

# A Unicaja reference code is a run of digits, zero-padded to 10 (e.g.
# `0001234854`, `0019105996`). Used to pull the ids out of a search-results
# page's `fichainmueble.do?referencia=` hrefs and to validate an external_id.
_REFCODE_RE = re.compile(r"^\d{6,}$")


def strip_accents(value: str) -> str:
    """ASCII-fold a string (á->a, ñ->n) for name comparison."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c)
    )


def _norm(value: str) -> str:
    """Accent-stripped, lowercased, whitespace-collapsed comparison key."""
    return re.sub(r"\s+", " ", strip_accents(value).strip().lower())


# The inverse of `_PROVINCE_INE_CODE`: INE province code -> a single canonical
# display name (issue #494). `_PROVINCE_INE_CODE` is many-keys-to-one-code
# (bilingual aliases), so it cannot be inverted programmatically without an
# arbitrary tie-break; this is the curated, one-name-per-code table the
# "Validar filtros" UI shows so a bare INE code ("29") reads as "INE 29 ·
# Málaga". Names are the site's own province labels (Spanish, proper case).
_INE_CODE_TO_PROVINCE: dict[str, str] = {
    "1": "Álava",
    "2": "Albacete",
    "3": "Alicante",
    "4": "Almería",
    "5": "Ávila",
    "6": "Badajoz",
    "7": "Baleares",
    "8": "Barcelona",
    "9": "Burgos",
    "10": "Cáceres",
    "11": "Cádiz",
    "12": "Castellón",
    "13": "Ciudad Real",
    "14": "Córdoba",
    "15": "A Coruña",
    "16": "Cuenca",
    "17": "Girona",
    "18": "Granada",
    "19": "Guadalajara",
    "20": "Guipúzcoa",
    "21": "Huelva",
    "22": "Huesca",
    "23": "Jaén",
    "24": "León",
    "25": "Lleida",
    "26": "La Rioja",
    "27": "Lugo",
    "28": "Madrid",
    "29": "Málaga",
    "30": "Murcia",
    "31": "Navarra",
    "32": "Ourense",
    "33": "Asturias",
    "34": "Palencia",
    "35": "Las Palmas",
    "36": "Pontevedra",
    "37": "Salamanca",
    "38": "Santa Cruz de Tenerife",
    "39": "Cantabria",
    "40": "Segovia",
    "41": "Sevilla",
    "42": "Soria",
    "43": "Tarragona",
    "44": "Teruel",
    "45": "Toledo",
    "46": "Valencia",
    "47": "Valladolid",
    "48": "Vizcaya",
    "49": "Zamora",
    "50": "Zaragoza",
    "51": "Ceuta",
    "52": "Melilla",
}


def province_to_ine_code(province_name: str | None) -> str | None:
    """Map a province name (gazetteer or site vocabulary) to its INE code.

    Returns None for an unknown name rather than guessing — discover() turns
    that into a clean "no coverage for this scope" rather than searching the
    wrong province.
    """
    if not province_name:
        return None
    return _PROVINCE_INE_CODE.get(_norm(province_name))


def ine_code_to_province(ine_code: str | None) -> str | None:
    """Map an INE province code back to its canonical display name (issue #494).

    The inverse of `province_to_ine_code` for the UI: the search URL carries a
    bare code (`provincia=29`), and the "Validar filtros" page shows it as a
    legible "INE 29 · Málaga" chip. Returns None for an unknown code."""
    if not ine_code:
        return None
    return _INE_CODE_TO_PROVINCE.get(ine_code.strip())


def is_refcode(value: str | None) -> bool:
    return bool(value) and bool(_REFCODE_RE.match(value.strip()))


def map_property_type(tipo: str | None) -> str | None:
    if not tipo:
        return None
    return _TYPE_MAP.get(_norm(tipo))


def is_residential(tipo: str | None) -> bool:
    if not tipo:
        return False
    return _norm(tipo) in _RESIDENTIAL_TYPES


def parse_es_price(text: str | None) -> str | None:
    """Bare integer-euro digit string from an es-ES price ("169.400,00 €").

    Spanish price format uses `.` for thousands and `,` for decimals, so the
    whole-euro part is everything left of the comma with the dots removed.
    Returns None when no plausible price (a 4+ digit thousands-grouped
    number) is present — e.g. a card whose price block only reads "Compra*"
    with no figure.
    """
    if not text:
        return None
    match = re.search(r"(\d{1,3}(?:\.\d{3})+|\d{4,})(?:,\d+)?", text)
    if not match:
        return None
    return match.group(1).replace(".", "")


def parse_es_surface(text: str | None) -> int | None:
    """First whole-metre integer from a surface string.

    Unicaja renders surfaces with a `.` DECIMAL point ("53.23 m2",
    "169.0m2") — the opposite of its price format. Take the integer part
    before the dot; never treat the dot as a thousands separator here.
    """
    if not text:
        return None
    match = re.search(r"(\d+)(?:\.\d+)?\s*m", text, re.IGNORECASE)
    if not match:
        # A bare number with no unit (defensive).
        match = re.search(r"(\d+)", text)
    return int(match.group(1)) if match else None


def parse_int(text: str | None) -> int | None:
    if not text:
        return None
    match = re.search(r"\d+", text)
    return int(match.group(0)) if match else None


def refcodes_in_search(html: str) -> list[str]:
    """Ordered, de-duplicated reference codes from a search-results page."""
    seen: set[str] = set()
    out: list[str] = []
    for ref in re.findall(r"fichainmueble\.do\?referencia=(\d+)", html):
        if ref not in seen:
            seen.add(ref)
            out.append(ref)
    return out


def parse_search_cards(html: str) -> dict[str, dict[str, Any]]:
    """Parse a `listadoPromocion.do` results page into per-reference cards.

    Each result card is a run of `<label class="titulo">Field:</label>
    <label class="valor">Value</label>` pairs plus a description block and a
    price block, terminated by the `fichainmueble.do?referencia=<ref>` info
    button. Keyed by that reference. Only the fields the connector actually
    reads are extracted; everything else is ignored.

    Returns `{}` for a page with no cards — the caller (discover) decides
    whether that is a legitimate empty last page or an error worth raising.
    """
    return {ref: _card_fields_for(html, ref) for ref in refcodes_in_search(html)}


def _label_value(block: str, label: str) -> str | None:
    match = re.search(
        rf'<label[^>]*class="titulo">\s*{re.escape(label)}\s*:?\s*</label>\s*'
        rf'<label[^>]*class="valor"[^>]*>\s*(.*?)\s*</label>',
        block,
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    value = re.sub(r"<[^>]+>", "", match.group(1))
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def _card_fields_for(html: str, ref: str) -> dict[str, Any]:
    """Extract one card's fields from the page.

    A card's labelled fields render before its `fichainmueble.do` info
    button; the previous card ends at the previous button. Scope to the
    window between the previous referencia href and this one so labels are
    read against the right card.
    """
    anchor = f"fichainmueble.do?referencia={ref}"
    end = html.find(anchor)
    if end == -1:
        return {}
    # Start just after the previous card's info-button href (or page start).
    prev = html.rfind("fichainmueble.do?referencia=", 0, end - 1)
    start = 0 if prev == -1 else html.find('"', prev)
    block = html[max(start, 0) : end + len(anchor)]
    desc = re.search(r'contenedorTextoDescripcion"[^>]*>(.*?)</div>', block, re.DOTALL)
    description = None
    if desc:
        description = re.sub(r"<[^>]+>", "", desc.group(1))
        description = re.sub(r"\s+", " ", description).strip() or None
    price_block = re.search(r"contenedorPrecio.*?</div>\s*</div>", block, re.DOTALL)
    price_text = price_block.group(0) if price_block else block
    return {
        "province": _label_value(block, "Provincia"),
        "city": _label_value(block, "Municipio"),
        "postal_code": _label_value(block, "Código Postal"),
        "property_type_raw": _label_value(block, "Tipo"),
        "m2_built_raw": _label_value(block, "Sup. Const."),
        "rooms_raw": _label_value(block, "Habitaciones"),
        "description": description,
        "price_raw": parse_es_price(price_text),
    }
