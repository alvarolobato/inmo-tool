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
- **No coordinates anywhere.** Address granularity is street-name level
  ("Calle Embajadores") plus city/province; there is no lat/lon, no
  embedded map widget, no geo microdata. So a Vivantial listing can never
  participate in issue #16's `address_coords` dedup signal — it has to
  match on `reference_code`, phone, photo-hash or fuzzy text instead. This
  is a real, permanent limitation of the source, not something a better
  parser would fix.
"""

from __future__ import annotations

import html
import re
from decimal import Decimal, InvalidOperation

from etl.connectors.extraction import first_present

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

    def from_body_text() -> Decimal | None:
        m = _M2_RE.search(_text(page))
        return _to_decimal(m.group(1)) if m else None

    return first_present(from_meta, from_body_text, field="m2_built")


def extract_rooms(page: str) -> int | None:
    """Room count — genuinely absent on some listings.

    2 of the 4 listings sampled during the spike (Lugo, Valencia) publish no
    room count at all; the meta description renders "con  por 12.000 €" with
    an empty slot. None is the correct answer there, not a parser failure —
    which is also why there is no page-wide fallback: the body's "similar
    properties" cards would happily supply a neighbour's room count.
    """

    def from_meta() -> int | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_ROOMS_RE.search(desc)
        return _to_int(m.group(1)) if m else None

    return first_present(from_meta, field="rooms")


def extract_bathrooms(page: str) -> int | None:
    """Bathroom count — optional, same reasoning as `extract_rooms`."""

    def from_meta() -> int | None:
        desc = meta_description(page)
        if not desc:
            return None
        m = _DESC_BATHS_RE.search(desc)
        return _to_int(m.group(1)) if m else None

    return first_present(from_meta, field="bathrooms")


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
