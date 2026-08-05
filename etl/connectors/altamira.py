"""Altamira connector — capture-only, no live network fetch (issue #271).

═══════════════════════════════════════════════════════════════════════════
  CAPTURE-ONLY. SELECTORS CALIBRATED AGAINST REAL CAPTURES (issue #271).
═══════════════════════════════════════════════════════════════════════════

D-027 (docs/decisions/D-027-altamira-not-viable-akamai-block.md) established,
with live reconnaissance, that Altamira is NOT buildable as an automated
connector: every direct HTTP request to `altamirainmuebles.com` returns an
Akamai WAF 403, including `robots.txt`. A `discover()` / `fetch_detail()`
implementation would have nothing to parse.

The 2026-08-05 live human test (issue #271, GO verdict) confirmed the page
renders normally for a human in an ordinary browser — so the answer is the
same one settled on for Idealista (etl/connectors/idealista.py) and Aliseda
(aliseda.py): a human legitimately viewing a listing in their own browser
captures the *rendered* DOM, and this connector parses it. No automated fetch
to Altamira ever happens anywhere in this path.

This connector therefore mirrors Idealista/Aliseda precisely:
  - `scope_key()` always returns None — the orchestrator's profile-driven
    sweep skips it every time; discover()/fetch_detail() are never called.
  - `discover()`/`fetch_detail()` exist only to satisfy the Connector ABC and
    raise immediately as a defensive invariant.
  - The real entry point is `normalize()`, called by etl/capture.py with a
    RawListing built from HTML a human's browser rendered and the extension
    POSTed to /api/extension/capture.

──────────────────────────────────────────────────────────────────────────
  GROUND TRUTH: two real captures (issue #271).
──────────────────────────────────────────────────────────────────────────
Calibrated against two real captured Altamira detail pages
(`/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1`
and `/venta-de-casa/murcia/alhama-de-murcia/segunda-mano/9186_1004_PE0001/375864/1`),
preserved as trimmed fixtures under etl/tests/fixtures/altamira_detail_*.html.
What the real pages actually expose:

  1. **No embedded structured data.** Checked per docs/skills/connectors.md's
     "embedded JSON over HTML" rule: there is NO `application/ld+json`, NO
     `__NEXT_DATA__`, and NO `window.__*` state blob on these pages. Extraction
     is therefore from OpenGraph/`<meta>` tags, a small set of stable DOM
     nodes, and — most reliably — the URL itself.
  2. **The URL is the richest structured source.** Detail URLs are
     `/venta-de-<tipo>/<provincia>/<municipio>/segunda-mano/<REF>/<numeric-id>/1`.
     `<tipo>` gives property_type + operation, `<provincia>`/`<municipio>` give
     the location, `<numeric-id>` is the external_id, `<REF>` (e.g.
     `9186_1001_PE0001`) is the reference code. All available before any HTML
     parsing.
  3. **Whitespace is escaped.** The browser-extension capture serialises text
     nodes with literal `\\n` / `\\t` two-char sequences (NOT real control
     chars) — the same capture format Aliseda's JSON-LD parser had to undo.
     `_clean_ws()` normalises them on every extracted text value.
  4. **Price** is `#soloPrecio` (es-ES "216.724,25" -> Decimal 216724.25;
     "50.400" -> 50400). It is a subasta (judicial auction) *reference* value
     for these REO assets, but it is the real published figure.
  5. **Surface** is `.caracteristicas li.icono.superficie .valor` ("97 m²").
     Rooms/baths are NOT published on these auction listings (the "Ver más
     características" block is empty) — parsed defensively (label-based) so a
     future listing that DOES carry them is picked up, but None here rather
     than fabricated.
  6. **Photos** are `/estaticos/activos/inmuebles/fotos/grandes/<dd>/<id>_<n>.jpg`
     URLs. A detail page ALSO embeds a "también te puede interesar" carousel
     with OTHER listings' photos, so URLs are filtered to those whose filename
     starts with THIS listing's numeric id — otherwise a listing would inherit
     a neighbour's gallery (the same class of bug fixed for Aliseda in #266).
     Stored as absolute URLs (the page serves them root-relative).
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from bs4 import BeautifulSoup

from etl.connectors.altamira_mapping import map_operation, map_property_type
from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)

_ASSET_HOST = "https://www.altamirainmuebles.com"

# Detail URLs end `.../<REF>/<numeric-id>/1` (the trailing "1" is the photo
# index). The external_id is that numeric id — the last all-digit path segment,
# tolerating an optional trailing short numeric segment and/or slash. The REF
# slug itself carries digits but also underscores/letters, so `\d{4,}` never
# matches it.
_EXTERNAL_ID_RE = re.compile(r"/(\d{4,})(?:/\d+)?/?$")

# The URL type slug + location: `/venta-de-<tipo>/<provincia>/<municipio>/`.
_URL_SHAPE_RE = re.compile(
    r"/(?P<op>venta|alquiler)-de-(?P<tipo>[a-z0-9-]+)"
    r"/(?P<provincia>[a-z0-9-]+)/(?P<municipio>[a-z0-9-]+)/",
    re.IGNORECASE,
)

# On-page reference label ("Ref: 9186_1001_PE0001") and the URL slug form
# ("9186-1001-pe0001"). Both normalise to the underscored, uppercased canonical
# reference.
_REFERENCE_TEXT_RE = re.compile(
    r"Ref:?\s*([0-9]+[_-][0-9]+[_-][A-Za-z0-9]+)", re.IGNORECASE
)

# Full-resolution listing photos on Altamira's asset path. Root-relative in the
# rendered page; made absolute in _photos().
_PHOTO_RE = re.compile(r"/estaticos/activos/inmuebles/fotos/grandes/\d+/(\d+)_\d+\.jpg")

_DESC_LABEL_RE = re.compile(r"^\s*Descripci[oó]n\s*", re.IGNORECASE)


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _clean_ws(text: str | None) -> str | None:
    """Normalise the capture's escaped-whitespace serialisation.

    The browser-extension capture writes literal `\\n` / `\\t` / `\\r` two-char
    sequences into text nodes rather than real control characters (see module
    docstring). Undo those, collapse runs of whitespace, and trim. Returns None
    for an empty result so callers can treat "nothing there" uniformly.
    """
    if text is None:
        return None
    t = text.replace("\\n", " ").replace("\\t", " ").replace("\\r", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t or None


def _es_price_to_decimal(text: str | None) -> Decimal | None:
    """Parse an es-ES price like "216.724,25" -> 216724.25, "50.400" -> 50400.

    Altamira renders Spanish locale (dot = thousands, comma = decimal). Unlike
    surface/room counts, a price CAN carry meaningful cents here (these are
    judicial-auction reference figures), so the decimal comma is preserved.
    """
    if not text:
        return None
    m = re.search(r"[\d.]+(?:,\d+)?", text)
    if not m:
        return None
    number = m.group(0).replace(".", "").replace(",", ".")
    return _to_decimal(number)


def _es_int(text: str | None) -> int | None:
    """First integer in an es-ES value like "97 m²" / "3 hab." -> 97 / 3.

    Strips a thousands dot; ignores any decimal tail (surfaces/counts don't
    carry meaningful cents in the fields this parses).
    """
    if not text:
        return None
    m = re.search(r"\d[\d.]*", text)
    if not m:
        return None
    digits = m.group(0).split(",")[0].replace(".", "")
    return int(digits) if digits.isdigit() else None


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _slug_to_title(slug: str | None) -> str | None:
    """A URL slug segment ("alhama-de-murcia") -> a display string
    ("Alhama De Murcia"). Best-effort title-casing for the location fields."""
    if not slug:
        return None
    return " ".join(part for part in slug.split("-") if part).title() or None


def _street_from_title(title: str | None) -> str | None:
    """Lift the street from a title like "Ático en venta en Progreso, Nº10".

    Strips the "<Tipo> en <operación> en " lead. Returns the remainder
    ("Progreso, Nº10") or None if the pattern doesn't hold — the full title is
    always preserved in raw_extra regardless.
    """
    if not title:
        return None
    m = re.search(r"\ben\s+(?:venta|alquiler)\s+en\s+(.+)$", title, re.IGNORECASE)
    if m:
        return m.group(1).strip() or None
    return None


def _feature_value(soup: BeautifulSoup, *keywords: str) -> str | None:
    """The `.valor` text of the `.caracteristicas` `li.icono.*` whose class or
    label text matches any of `keywords`. None if no such feature is present
    (e.g. rooms/baths on an auction listing that doesn't publish them)."""
    block = soup.select_one(".caracteristicas")
    if block is None:
        return None
    for li in block.select("li.icono"):
        cls = " ".join(li.get("class", [])).lower()
        label = _clean_ws(li.get_text(" ")) or ""
        haystack = f"{cls} {label}".lower()
        if any(k in haystack for k in keywords):
            valor = li.select_one(".valor")
            if valor is not None:
                return _clean_ws(valor.get_text(" "))
    return None


def _photos(html: str, external_id: str | None) -> tuple[str, ...]:
    """Absolute gallery photo URLs for THIS listing, in page order, deduped.

    Filters the page's `.../grandes/<dd>/<id>_<n>.jpg` URLs to those whose
    filename starts with this listing's numeric id — the detail page also
    embeds a "también te puede interesar" carousel carrying OTHER listings'
    photos, and without the filter a listing would inherit its neighbours'
    galleries (#266's lesson). No id => no photos (honest degradation), never a
    wrong gallery.
    """
    if not external_id:
        return ()
    ordered: list[str] = []
    seen: set[str] = set()
    for m in _PHOTO_RE.finditer(html):
        if m.group(1) != external_id:
            continue
        url = _ASSET_HOST + m.group(0)
        if url not in seen:
            seen.add(url)
            ordered.append(url)
    return tuple(ordered)


class AltamiraConnector(Connector):
    name = "altamira"
    # Never crawls — capture-only (see module docstring). The rate limiter /
    # circuit breaker the base class configures are inert here since
    # scope_key() always returns None before either would be exercised. Same
    # posture as Idealista/Aliseda.
    supports_discovery = False
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError(
            "altamira discover: not supported — capture-only connector (see "
            "module docstring / D-027). scope_key() returning None should have "
            "stopped the orchestrator from ever calling this."
        )

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise ConnectorError(
            "altamira fetch_detail: not supported — this connector never makes "
            "a live network request (D-027: Akamai WAF 403 on every path). "
            "Listings arrive via POST /api/extension/capture, processed by "
            "etl/capture.py, which calls normalize() directly."
        )

    @staticmethod
    def external_id_from_url(url: str) -> str | None:
        match = _EXTERNAL_ID_RE.search(url)
        return match.group(1) if match else None

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw.get("html", "")
        url = raw.raw.get("url") or ""
        soup = BeautifulSoup(html, "html.parser")

        # ── URL-derived structured fields (richest, most reliable source) ──
        shape = _URL_SHAPE_RE.search(url)
        url_tipo = shape.group("tipo") if shape else None
        url_op = shape.group("op") if shape else None
        province = _slug_to_title(shape.group("provincia")) if shape else None
        city = _slug_to_title(shape.group("municipio")) if shape else None

        # ── title (OpenGraph / DOM) ────────────────────────────────────────
        h2 = soup.select_one("h2.titulo")
        title = (
            _clean_ws(h2.get_text(" "))
            if h2 is not None
            else _og_meta(soup, "og:title")
        )

        # ── property type / operation ──────────────────────────────────────
        property_type = map_property_type(url_tipo or title)
        operation = map_operation(url_op or title)

        # ── reference code ─────────────────────────────────────────────────
        # On-page "Ref: …" label is authoritative; fall back to the URL slug.
        reference_code: str | None = None
        m = _REFERENCE_TEXT_RE.search(html)
        if m is None and shape is not None:
            # URL slug ref sits between "segunda-mano/" and the numeric id.
            m = re.search(r"/([0-9]+[_-][0-9]+[_-][A-Za-z0-9]+)/\d{4,}", url)
        if m is not None:
            reference_code = m.group(1).replace("-", "_").upper()

        # ── price ──────────────────────────────────────────────────────────
        price_el = soup.select_one("#soloPrecio")
        current_price = (
            _es_price_to_decimal(_clean_ws(price_el.get_text(" ")))
            if price_el is not None
            else None
        )

        # ── surface / rooms / baths ────────────────────────────────────────
        m2_built = _to_decimal(
            _es_int(_feature_value(soup, "superficie", "construidos"))
        )
        rooms = _es_int(_feature_value(soup, "habitacion", "dormitor"))
        bathrooms = _es_int(_feature_value(soup, "bano", "baño", "aseo"))

        # ── address ────────────────────────────────────────────────────────
        address = _street_from_title(title)

        # ── description ────────────────────────────────────────────────────
        desc_el = soup.select_one(".descripcion")
        description = (
            _DESC_LABEL_RE.sub("", _clean_ws(desc_el.get_text(" ")) or "") or None
            if desc_el is not None
            else _og_meta(soup, "og:description")
        )

        # ── photos ─────────────────────────────────────────────────────────
        photo_urls = _photos(html, raw.external_id)

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind="agency",  # Altamira is a servicer/REO portal — every
            # listing is the servicer's own bank-owned asset, never a private
            # seller.
            status="active",  # A captured page is one the owner was just
            # viewing — "active" is the only status this connector can honestly
            # assert (it never revisits to detect a status change). Same rule as
            # idealista.py / aliseda.py.
            current_price=current_price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=None,  # REO portal: no private-seller contact to store,
            # and owner-contact PII must never be persisted (issue #266).
            reference_code=reference_code,
            address=address,
            lat=None,  # No per-listing coordinates in the captured markup.
            lon=None,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=None,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,  # Not exposed as a labelled feature on the real pages.
            has_elevator=None,
            year_built=None,
            energy_rating=None,  # The energy block shows "en trámite" (class
            # tipo_T), not a letter grade, on these auction listings — left None
            # rather than mapping a non-grade.
            city=city,
            province=province,
            postal_code=None,  # Not published in the captured markup; the URL
            # carries municipio/provincia but no postal code.
            m2_plot=None,
            features=(),
            operation=operation,
            cadastral_ref=None,
            raw_extra={
                "capture_source": "browser-extension",
                # Provenance the whole point of this issue leans on: this row
                # arrived via guided extension capture, not an automated fetch.
                "capture_portal": "altamira",
                "title": title,
            },
        )
