"""Field extraction for Vivantial listing pages (pure parsing, no network).

Split from `vivantial.py` the same way `fotocasa_mapping.py` /
`milanuncios_mapping.py` are: everything here is a pure function over an
HTML string, so the whole field-extraction surface is unit-testable
against saved fixtures without touching the network.

Site shape, established by the issue #120 feasibility spike (2026-08-02,
4 real listings sampled across Madrid/Murcia/Lugo/Valencia):

- **Fully server-rendered.** No `__NEXT_DATA__`, no JSON-LD, no embedded
  JSON blob at all — unlike Fotocasa/Milanuncios, which both hang their
  primary extraction off a script-tag JSON payload. Every field here comes
  from real markup, so the fallback chains are CSS-class -> regex-over-text
  rather than JSON-path -> CSS.
- Prices, m2 and room counts render as plain text inside classed elements
  (`class="... precio ..."`, and a summary sentence in the `<h1>`/lead).
- The reference code is exposed as `VIVANTIAL-<id>` in a
  `class="referencia"` element — a real per-property code, so issue #72's
  dedup signal applies to this connector.
- **Coordinates ARE published**, in two hidden spans inside the map
  container (`<span id="latitude" class="hide">40,399</span>`). The
  original spike recorded "no coordinates anywhere" as a permanent source
  limitation; that was wrong, and PR #139's review caught it — the spans
  are `class="hide"` and use comma decimal separators, which is why a
  visual/regex sweep missed them. Verified live as genuine per-listing
  geocoding rather than a city centroid (Madrid 40,399/-3,698, Murcia
  37,977/-1,131, Lugo 43,121/-7,62).

  Honest consequence: precision is 3 decimal places, ~±60 m, while issue
  #16's `address_coords` signal requires agreement within 15 m. So this
  connector still realistically won't match on coordinates, and continues
  to rely on `reference_code` (#72) for dedup — but the data is real, it
  feeds the map view (#43), and discarding it would have been wrong.
- **No cadastral reference.** Checked explicitly (it is now a standing
  per-site question for the bank/fund batch, #132, after Solvia turned out
  to publish one): Vivantial mentions "según Catastro" in prose only, with
  no structured field. So issue #1 §6's highest-confidence dedup signal is
  unavailable here.
"""

from __future__ import annotations

import datetime
import html
import re
from decimal import Decimal, InvalidOperation

from etl.connectors.extraction import first_present

# Vivantial publishes age ("Antigüedad: 96 años"), not a construction
# year, so year_built is derived against the current year. UTC rather than
# local time: the exact new-year boundary is immaterial for a value that is
# only accurate to the year anyway, and a tz-aware call keeps the linter's
# DTZ rule satisfied without pretending to a precision we don't have.
_CURRENT_YEAR = datetime.datetime.now(datetime.timezone.utc).year

# `//cdn.vivantial.es/photos/...` — protocol-relative, exactly the shape
# that produced a `https:////host/path` double-slash bug in the Milanuncios
# connector (PR #85 review). Normalised by `_absolute_photo_url` below.
_PHOTO_RE = re.compile(
    r'(?:src|data-src)="(//cdn\.vivantial\.es/[^"]+)"', re.IGNORECASE
)

_REFERENCIA_RE = re.compile(r'class="[^"]*referencia"[^>]*>\s*([^<]+)', re.IGNORECASE)
# The *current* asking price. Note there are two `precio` divs: the first
# is an empty placeholder, the second (`precio-rojo`) holds the real value —
# so a regex matching plain `precio` picks up the empty one and falls
# through, which is how an early version of this module ended up reading a
# neighbouring "similar properties" card's price instead (see
# `_META_DESCRIPTION_RE` below for the fix).
_PRECIO_ROJO_RE = re.compile(
    r'class="[^"]*precio-rojo[^"]*"[^>]*>\s*([^<]+)', re.IGNORECASE
)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_TITLE_RE = re.compile(r"<title>([^<]*)</title>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")

# "67 m2" / "67 m²" — the summary sentence and the feature list both use it.
_M2_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*m\s*(?:2|²)", re.IGNORECASE)
# "4 hab." / "4 habitaciones" / "4 dormitorios"
_ROOMS_RE = re.compile(r"(\d+)\s*(?:hab\b|habitacion|dormitorio)", re.IGNORECASE)
# "1 baño" / "2 banos"
_BATHS_RE = re.compile(r"(\d+)\s*ba[ñn]o", re.IGNORECASE)
# Any euro amount: "288.000 €" (es-ES thousands separator).
_EURO_RE = re.compile(r"(\d{1,3}(?:\.\d{3})+|\d+)\s*€")

# `<meta name="description">` is the single best source on this site: it is
# generated per listing and reads
#   "Piso en venta en <city> <province> de <m2> m2. con <n> hab. y <n> baño
#    por <price> €"
# Crucially it is *scoped to this listing*, unlike the page body, which also
# renders "similar properties" cards carrying their own prices/room counts.
# Reading those by accident is a real bug this module previously had — the
# Madrid fixture reported a neighbour's 310.000 € instead of its own
# 288.000 €. Every numeric field therefore reads the meta description first
# and only falls back to body markup.
_META_DESCRIPTION_RE = re.compile(
    r'<meta\s+name="description"\s+content="([^"]*)"', re.IGNORECASE
)

# Fields inside that description. Rooms/baths are genuinely optional: the
# Rábade fixture renders "... de 127 m2. con  por 12.000 €" with nothing
# between "con" and "por".
_DESC_M2_RE = re.compile(r"\bde\s+(\d+(?:[.,]\d+)?)\s*m\s*2", re.IGNORECASE)
_DESC_ROOMS_RE = re.compile(r"\bcon\s+(\d+)\s*hab", re.IGNORECASE)
_DESC_BATHS_RE = re.compile(r"\by\s+(\d+)\s*ba[ñn]o", re.IGNORECASE)
_DESC_PRICE_RE = re.compile(r"\bpor\s+(\d{1,3}(?:\.\d{3})+|\d+)\s*€", re.IGNORECASE)

# Coordinates live in two hidden spans inside the map container:
#   <span id="latitude" class="hide">40,399</span>
# `class="hide"` plus comma decimal separators is why the original spike
# missed them and recorded "no coordinates anywhere" as a permanent source
# limitation (PR #139 review). They are real per-listing values, not a city
# centroid — verified live across Madrid/Murcia/Lugo, which resolve to
# 40,399/-3,698, 37,977/-1,131 and 43,121/-7,62 respectively.
_LATITUDE_RE = re.compile(r'id="latitude"[^>]*>\s*(-?\d+(?:[.,]\d+)?)', re.IGNORECASE)
_LONGITUDE_RE = re.compile(r'id="longitude"[^>]*>\s*(-?\d+(?:[.,]\d+)?)', re.IGNORECASE)

# The "Características" block, e.g.
#   Tipo de inmueble: Piso | Superficie: 67 m2 | Nº habitaciones: 4 |
#   Baños: 1 | Planta: 4 planta | Antigüedad: 96 años
# followed by an "Equipamiento:" list (Ascensor, Terraza, Garaje, ...).
# Matched over tag-stripped text so intervening markup doesn't matter.
_CARACT_TIPO_RE = re.compile(r"Tipo de inmueble:\s*([^|\n]+)", re.IGNORECASE)
_CARACT_SUPERFICIE_RE = re.compile(
    r"Superficie:\s*(\d{1,3}(?:\.\d{3})*|\d+)", re.IGNORECASE
)
_CARACT_ROOMS_RE = re.compile(r"N[ºo°]?\s*habitaciones:\s*(\d+)", re.IGNORECASE)
_CARACT_BATHS_RE = re.compile(r"Ba[ñn]os:\s*(\d+)", re.IGNORECASE)
_CARACT_PLANTA_RE = re.compile(r"Planta:\s*([^|\n]+)", re.IGNORECASE)
_CARACT_ANTIGUEDAD_RE = re.compile(r"Antig[üu]edad:\s*(\d+)\s*a[ñn]os", re.IGNORECASE)
# The equipment list runs from "Equipamiento:" to the next section
# heading — on a real page that's "Ubicación:", and the block is followed
# by "Fotos:", the contact form, the footer and a cookie banner. Without a
# terminator anchored on the *next* `Label:` heading the match swallows all
# of that, so `features` filled up with 'politica_de_cookies',
# 'guardar_cambios' and every footer link (caught testing against the real
# fixture). Section headings are `| Capitalised words :`, which is what
# the lookahead pins.
_EQUIPAMIENTO_RE = re.compile(
    r"Equipamiento:\s*(.*?)"
    r"(?=\|\s*[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ ]{2,40}:|$)",
    re.IGNORECASE | re.DOTALL,
)

# The substantive listing copy. Distinct from the <h1>, which is pure
# boilerplate ("Piso en venta en Madrid, Madrid"). This block is where
# occupancy status is disclosed — live examples include "PISO OCUPADO POR
# PERSONA SIN JUSTO TÍTULO" and references to standing rental contracts —
# which makes it the evidence issue #25's occupancy assessment depends on.
_DESCRIPCION_RE = re.compile(
    r'<p[^>]*class="[^"]*descripcion[^"]*"[^>]*>(.*?)</p>',
    re.IGNORECASE | re.DOTALL,
)

# Vivantial's own type vocabulary -> the `property.property_type` CHECK
# values ('piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'). Unknown -> None rather than a guess: PR #138 had every
# Solvia ingest fail on a CheckViolation from passing a site's raw label
# straight through, so an unrecognised type must degrade to NULL.
_PROPERTY_TYPE_MAP: dict[str, str] = {
    "piso": "piso",
    "vivienda": "piso",
    "apartamento": "piso",
    "estudio": "piso",
    "duplex": "piso",
    "dúplex": "piso",
    "atico": "atico",
    "ático": "atico",
    "casa": "chalet",
    "chalet": "chalet",
    "chalé": "chalet",
    "adosado": "chalet",
    "pareado": "chalet",
    "villa": "chalet",
    "local": "local",
    "local comercial": "local",
    "oficina": "local",
    "nave": "nave",
    "nave industrial": "nave",
    "garaje": "garaje",
    "parking": "garaje",
    "plaza de garaje": "garaje",
    "trastero": "garaje",
    "terreno": "terreno",
    "solar": "terreno",
    "parcela": "terreno",
    "finca": "terreno",
    "edificio": "edificio",
}


def _text(fragment: str) -> str:
    """Strip tags/entities and collapse whitespace."""
    return re.sub(r"\s+", " ", _TAG_RE.sub(" ", html.unescape(fragment))).strip()


def _to_decimal(raw: str | None) -> Decimal | None:
    """Parse an es-ES amount ("288.000") into a Decimal.

    Dots are thousands separators here, not decimal points — a naive
    `Decimal("288.000")` would yield 288, a 1000x error. Property prices
    and areas on this site are always whole numbers of euros / m2, but a
    decimal comma is handled for safety since the m2 regex accepts one.
    """
    if not raw:
        return None
    cleaned = raw.strip().replace(".", "").replace(",", ".")
    try:
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None


def _to_int(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _absolute_photo_url(src: str) -> str:
    """Normalise a protocol-relative CDN URL to https://.

    `//cdn.vivantial.es/x.png` -> `https://cdn.vivantial.es/x.png`, not
    `https:////cdn...` (the Milanuncios bug this mirrors the fix for).
    """
    src = src.strip()
    if src.startswith("//"):
        return f"https:{src}"
    if src.startswith(("http://", "https://")):
        return src
    return f"https://{src.lstrip('/')}"


def extract_reference_code(page: str) -> str | None:
    """`VIVANTIAL-5336` from the reference element (issue #72 dedup signal)."""

    def from_class() -> str | None:
        m = _REFERENCIA_RE.search(page)
        return _text(m.group(1)) if m else None

    def from_text() -> str | None:
        m = re.search(r"Referencia:\s*([A-Z0-9\-]+)", _text(page), re.IGNORECASE)
        return m.group(1) if m else None

    return first_present(from_class, from_text, field="reference_code")


def meta_description(page: str) -> str | None:
    """The per-listing `<meta name="description">` text, entity-decoded."""
    m = _META_DESCRIPTION_RE.search(page)
    return html.unescape(m.group(1)) if m else None


def extract_price(page: str) -> Decimal | None:
    """Current asking price.

    Primary: the meta description's "por <price> €" (listing-scoped).
    Fallback: the `precio-rojo` element, which is the *second* `precio` div
    (the first is an empty placeholder). Deliberately no page-wide
    euro-amount fallback — that is what previously read a "similar
    properties" card's price.
    """

    def from_meta() -> Decimal | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_PRICE_RE.search(desc)
        return _to_decimal(m.group(1)) if m else None

    def from_precio_rojo() -> Decimal | None:
        m = _PRECIO_ROJO_RE.search(page)
        if not m:
            return None
        euro = _EURO_RE.search(m.group(1))
        return _to_decimal(euro.group(1)) if euro else None

    return first_present(from_meta, from_precio_rojo, field="current_price")


def extract_m2_built(page: str) -> Decimal | None:
    def from_meta() -> Decimal | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_M2_RE.search(desc)
        return _to_decimal(m.group(1)) if m else None

    def from_caracteristicas() -> Decimal | None:
        m = _CARACT_SUPERFICIE_RE.search(_caracteristicas_text(page))
        return _to_decimal(m.group(1)) if m else None

    def from_body_text() -> Decimal | None:
        m = _M2_RE.search(_text(page))
        return _to_decimal(m.group(1)) if m else None

    return first_present(
        from_meta, from_caracteristicas, from_body_text, field="m2_built"
    )


def extract_rooms(page: str) -> int | None:
    """Room count — genuinely absent on some listings.

    2 of the 4 listings sampled during the spike (Lugo, Valencia) publish no
    room count at all; the meta description renders "con  por 12.000 €" with
    an empty slot. None is the correct answer there, not a parser failure.

    The Características block ("Nº habitaciones: 4") is a real second
    getter — label-anchored, so unlike a bare page-wide `\\d+ hab` regex it
    can't pick up a "similar properties" card's room count.
    """

    def from_meta() -> int | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_ROOMS_RE.search(desc)
        return _to_int(m.group(1)) if m else None

    def from_caracteristicas() -> int | None:
        m = _CARACT_ROOMS_RE.search(_caracteristicas_text(page))
        return _to_int(m.group(1)) if m else None

    return first_present(from_meta, from_caracteristicas, field="rooms")


def extract_bathrooms(page: str) -> int | None:
    """Bathroom count — optional, same reasoning as `extract_rooms`."""

    def from_meta() -> int | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_BATHS_RE.search(desc)
        return _to_int(m.group(1)) if m else None

    def from_caracteristicas() -> int | None:
        m = _CARACT_BATHS_RE.search(_caracteristicas_text(page))
        return _to_int(m.group(1)) if m else None

    return first_present(from_meta, from_caracteristicas, field="bathrooms")


def _caracteristicas_text(page: str) -> str:
    """Page text with tag boundaries preserved as `|` separators.

    Distinct from `_text`, which replaces tags with a space and so lets
    adjacent label/value cells run together — "Planta: 4 planta" followed
    by "Antigüedad: 96 años" becomes one unbounded string, and a
    `[^|\\n]+` value pattern then swallows the rest of the document
    (caught while testing this against the real fixture). The
    Características block is a run of sibling cells rather than one
    classed container, so an explicit separator is what makes per-field
    matching bounded.
    """
    return re.sub(r"\s*\|\s*", " | ", _TAG_RE.sub(" | ", html.unescape(page))).strip()


def extract_coordinates(page: str) -> tuple[Decimal | None, Decimal | None]:
    """(lat, lon) from the hidden map spans, or (None, None).

    Comma decimal separators are normalised to dots. Precision is 3
    decimal places (~±60 m at Spanish latitudes), which matters: issue
    #16's `address_coords` signal requires agreement within
    `_MAX_DISTANCE_METERS = 15.0`, so two Vivantial listings of the same
    flat would still not match on coordinates alone. These are worth
    capturing anyway — the map view (#43) plots them, and a future
    looser-radius signal could use them — but this connector still relies
    on `reference_code` (#72) for dedup, not geometry.
    """

    def one(pattern: re.Pattern[str], field: str) -> Decimal | None:
        m = pattern.search(page)
        return _to_decimal(m.group(1)) if m else None

    return (
        first_present(lambda: one(_LATITUDE_RE, "lat"), field="lat"),
        first_present(lambda: one(_LONGITUDE_RE, "lon"), field="lon"),
    )


def extract_property_type(page: str, url: str | None = None) -> str | None:
    """Canonical `property.property_type`, or None when unrecognised.

    Primary source is the "Tipo de inmueble:" row of the Características
    block; the URL slug's leading token is the fallback (detail URLs look
    like `/Inmuebles/vivienda_en_venta_en_madrid_en_madrid_5336`). The
    live sitemap carries 1151 vivienda, 46 parking, 9 local, 2 trastero,
    1 oficina and 1 edificio, so hardcoding "piso" mistyped ~5% of stock.
    """

    def from_caracteristicas() -> str | None:
        m = _CARACT_TIPO_RE.search(_caracteristicas_text(page))
        if not m:
            return None
        return _PROPERTY_TYPE_MAP.get(m.group(1).strip().lower())

    def from_url_slug() -> str | None:
        if not url:
            return None
        m = re.search(r"/Inmuebles/([a-z0-9\-]+?)_", url, re.IGNORECASE)
        if not m:
            return None
        return _PROPERTY_TYPE_MAP.get(m.group(1).strip().lower())

    return first_present(from_caracteristicas, from_url_slug, field="property_type")


def extract_floor(page: str) -> str | None:
    """Floor as published ("4 planta", "Bajo"), or None."""

    def from_caracteristicas() -> str | None:
        m = _CARACT_PLANTA_RE.search(_caracteristicas_text(page))
        return m.group(1).strip() if m else None

    return first_present(from_caracteristicas, field="floor")


def extract_year_built(page: str) -> int | None:
    """Construction year, derived from the published "Antigüedad: N años".

    The site states an age, not a year, so this is a derivation rather
    than a reading — accurate to the year only if the age was computed
    against the current one, which is the ordinary reading of the field.
    """

    def from_antiguedad() -> int | None:
        m = _CARACT_ANTIGUEDAD_RE.search(_caracteristicas_text(page))
        if not m:
            return None
        age = _to_int(m.group(1))
        if age is None:
            return None
        return _CURRENT_YEAR - age

    return first_present(from_antiguedad, field="year_built")


def extract_features(page: str) -> tuple[str, ...]:
    """Equipment list ("Ascensor", "Terraza", ...), de-duplicated.

    Emitted as short slug-ish tokens to match the `features` convention
    documented in `data-model.md` (the Milanuncios connector was corrected
    to this in PR #85's review, so containment queries behave uniformly).
    """
    m = _EQUIPAMIENTO_RE.search(_caracteristicas_text(page))
    if not m:
        return ()
    seen: dict[str, None] = {}
    for raw in m.group(1).split("|"):
        token = raw.strip().lower()
        if not token or len(token) > 60:
            continue
        seen.setdefault(re.sub(r"[^a-z0-9áéíóúñü]+", "_", token).strip("_"), None)
    return tuple(t for t in seen if t)


def extract_has_elevator(page: str) -> bool | None:
    """True when the equipment list names a lift; None when there is no
    equipment block at all (absence of evidence, not evidence of absence)."""
    features = extract_features(page)
    if not features:
        return None
    return any("ascensor" in f for f in features)


def extract_description(page: str) -> str | None:
    """The substantive listing copy, not the <h1> boilerplate.

    This is the field issue #25's occupancy assessment reads: live
    listings disclose "PISO OCUPADO POR PERSONA SIN JUSTO TÍTULO", standing
    rental contracts, and no-viewing restrictions here. The <h1> ("Piso en
    venta en Madrid, Madrid") carries none of that.
    """

    def from_descripcion_block() -> str | None:
        m = _DESCRIPCION_RE.search(page)
        if not m:
            return None
        body = _text(m.group(1))
        return body or None

    def from_meta() -> str | None:
        return meta_description(page)

    return first_present(from_descripcion_block, from_meta, field="description")


def extract_photo_urls(page: str) -> tuple[str, ...]:
    """Listing photos from the Vivantial CDN, de-duplicated, order preserved.

    Scoped to `cdn.vivantial.es` on purpose: the page also carries site
    chrome (`/Assets/img/logoHead.png`, favicon) which must not end up in
    `photo_urls` — the same class of leak as the Fotocasa `tour-virtual`
    entry that broke the property detail gallery (Phase 2 Fable review).
    """
    seen: dict[str, None] = {}
    for src in _PHOTO_RE.findall(page):
        seen.setdefault(_absolute_photo_url(src), None)
    return tuple(seen)


def extract_address(page: str) -> str | None:
    """Street-level address, e.g. "Calle Embajadores".

    No house number and no coordinates are published — see the module
    docstring on the dedup consequence.
    """

    def from_street_pattern() -> str | None:
        # Unescape first: accented street names arrive as entities
        # (`Calle &Aacute;vila`), and matching the raw markup truncates at
        # the `&`, which is how this previously produced "Calle Á".
        m = re.search(
            r"\b((?:Calle|C/|Avenida|Avda|Plaza|Paseo|Camino|Carrer|Ronda)"
            r"[^<,\"';]{2,60})",
            html.unescape(page),
        )
        return _text(m.group(1)) if m else None

    return first_present(from_street_pattern, field="address")


def extract_city_province(url: str) -> tuple[str | None, str | None]:
    """City and province from the detail URL slug.

    Populates two of issue #76's superset columns from data that would
    otherwise be discarded — the slug is the only place province appears in
    a structured form.

    Compound names arrive concatenated ("saguntosagunt" for
    "Sagunto/Sagunt"), so these are normalised-ish labels, not canonical
    municipality names. Good enough for display and for fuzzy dedup; not
    something to key an exact join on.

    Split on `_en_` rather than regex-matching it: the prefix itself
    contains one ("vivienda_en_venta_en_..."), so a leading `_en_(.+?)`
    anchors on the wrong occurrence and yields "Venta/Madrid En Madrid".
    The last two `_en_`-separated segments are always <city> and
    <province>_<id>.
    """
    path = url.rstrip("/").rsplit("/", 1)[-1]
    parts = path.split("_en_")
    if len(parts) < 3:
        return None, None
    city_raw = parts[-2]
    province_raw = re.sub(r"_\d+$", "", parts[-1])
    city = city_raw.replace("_", " ").strip() or None
    province = province_raw.replace("_", " ").strip() or None
    return (city.title() if city else None, province.title() if province else None)


def extract_title(page: str) -> str | None:
    def from_h1() -> str | None:
        m = _H1_RE.search(page)
        return _text(m.group(1)) if m else None

    def from_title_tag() -> str | None:
        m = _TITLE_RE.search(page)
        return _text(m.group(1)) if m else None

    return first_present(from_h1, from_title_tag, field="description")


def external_id_from_url(url: str) -> str | None:
    """Trailing numeric id from a detail URL (`..._madrid_5336` -> `5336`)."""
    m = re.search(r"_(\d+)/?$", url.rstrip("/"))
    return m.group(1) if m else None
