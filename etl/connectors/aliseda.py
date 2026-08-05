"""Aliseda connector — capture-only, no live network fetch (issue #237).

═══════════════════════════════════════════════════════════════════════════
  CAPTURE-ONLY. SELECTORS CALIBRATED AGAINST REAL CAPTURES (issue #266).
═══════════════════════════════════════════════════════════════════════════

D-019 (docs/decisions/D-019-aliseda-not-viable-disallowed-api.md) established,
with live reconnaissance, that Aliseda is NOT buildable as an automated
connector:

  - `www.alisedainmobiliaria.com` (the public consumer site) is a bare
    Angular shell — every URL returns a byte-identical app skeleton with zero
    server-rendered listing content over plain HTTP. A `discover()` /
    `fetch_detail()` implementation would have nothing to parse.
  - The one host that DOES serve real listing data,
    `laravel.alisedainmobiliaria.com`, is robots.txt `User-agent: * /
    Disallow: /` — an unqualified blanket disallow this project treats as
    binding and has never fetched.

D-019 explicitly left "route Aliseda to the #75 browser-extension capture
path" as an owner call. Issue #237 is that call being made: a human legit-
imately viewing `/inmueble/<id>` in their own browser (the `www` host, whose
own robots.txt does NOT disallow that path) captures the *rendered* DOM the
Angular app produced, and this connector parses it — exactly the Idealista
model (etl/connectors/idealista.py), for the same reason (real content only
exists after client-side hydration in a real browser).

This connector therefore mirrors IdealistaConnector precisely:
  - `scope_key()` always returns None — the orchestrator's profile-driven
    sweep skips it every time; discover()/fetch_detail() are never called.
  - `discover()`/`fetch_detail()` exist only to satisfy the Connector ABC and
    raise immediately as a defensive invariant.
  - The real entry point is `normalize()`, called by etl/capture.py with a
    RawListing built from HTML a human's browser rendered and the extension
    POSTed to /api/extension/capture.

──────────────────────────────────────────────────────────────────────────
  GROUND TRUTH: three real hydrated captures (issue #266).
──────────────────────────────────────────────────────────────────────────
The parse targets below were calibrated against three real captured Aliseda
detail pages (`/inmueble/vtr0200319552`, `/inmueble/vtr0200319563`,
`/inmueble/vpa41007120399`), preserved as trimmed fixtures under
etl/tests/fixtures/aliseda_detail_*.html. What the real pages actually expose:

  1. **Embedded JSON-LD is primary** (per docs/skills/connectors.md "embedded
     JSON over HTML"). Two `application/ld+json` blocks are present; the one
     carrying the property is a schema.org `Product` with a top-level
     `"price"` (the nested `offers.price` is a decoy `0`), a `name` /
     `description` that embed the street + `"<postal>, <city>, <province>"`
     tail, and an `sku` matching the URL reference. The captured DOM serialises
     the JSON-LD with escaped `\\n`, so json.loads is retried after unescaping.
  2. **Feature block** `.detail-header__features .feature` — each `.feature`
     pairs a `.feature__data-name` label ("Superficie total" / "Habitaciones"
     / "Baños") with a `.feature__data-quantity` value ("87 m²" / "2" / "1").
     Used as the CSS fallback for m²/rooms/baths that shift shape least.
  3. **Photos** are `storage.googleapis.com/aliseda/ImagenesActivos/.../<REF>/
     <n>.jpg` URLs (the `FrontWeb/...` bucket is chrome/logos and is excluded
     by the path). A detail page ALSO embeds a "también te puede interesar"
     carousel with OTHER listings' photos, so URLs are filtered to those whose
     `<REF>` path segment matches THIS listing's reference — otherwise a
     listing would inherit a neighbour's gallery.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from bs4 import BeautifulSoup

from etl.connectors.aliseda_mapping import (
    map_operation,
    map_property_type,
)
from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)

# Aliseda detail URLs are `.../inmueble/<id>` — the id is the asset reference
# (e.g. `vtr0200319552`). Alphanumeric, so NOT the `\d+` Idealista uses.
# Captured before any HTML parsing and used by etl/capture.py to build the
# RawListing this connector's normalize() then processes.
_EXTERNAL_ID_RE = re.compile(r"/inmueble/([A-Za-z0-9._-]+)")

# Full-resolution photo URLs on Aliseda's public asset bucket. Only the
# `ImagenesActivos` prefix is a listing photo — `FrontWeb/...` is site chrome
# (logos, banners, icons) and is excluded by not matching this path. The
# rendered <img> wraps these in a `alisedaassets.com/cdn-cgi/image/...width=…/`
# transform prefix; this regex captures only the clean origin URL after it.
_PHOTO_RE = re.compile(
    r"https://storage\.googleapis\.com/aliseda/ImagenesActivos/[^\s\"'\\)]+\.jpg"
)

# The JSON-LD `name`/`description` embed the address as
# "<street> <5-digit-postal>, <city>, <province>". Captures the four parts;
# the street still carries the "<Tipo> en <operación> en " lead, stripped next.
_LOCATION_TAIL_RE = re.compile(
    r"(?P<street>.+?)\s*(?P<postal>\d{5}),\s*(?P<city>[^,]+?),\s*(?P<province>[^,.]+)"
)
_STREET_LEAD_RE = re.compile(
    r"^\s*(?:vivienda|piso|casa|d[uú]plex|[aá]tico|apartamento|estudio|chalet|"
    r"adosado|pareado|local|nave|garaje|plaza\s+de\s+garaje|trastero|terreno|"
    r"suelo|parcela|solar|edificio)\s+en\s+(?:venta|alquiler)\s+en\s+",
    re.IGNORECASE,
)

_REFERENCE_TEXT_RE = re.compile(r"Ref:?\s*([A-Za-z0-9._-]+)", re.IGNORECASE)
_DESC_LABEL_RE = re.compile(r"^\s*Descripci[oó]n\s*", re.IGNORECASE)


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _es_number_to_int(text: str | None) -> int | None:
    """Parse an es-ES whole number like "148.000 €" / "87 m²" -> 148000 / 87.

    Aliseda renders Spanish locale (dot = thousands). Real-estate prices and
    surfaces don't carry meaningful decimals in the fields this parses, so we
    keep the leading run of digits/dots and strip the dots.
    """
    if not text:
        return None
    match = re.search(r"[\d.]+", text)
    if not match:
        return None
    digits = match.group(0).replace(".", "")
    return int(digits) if digits.isdigit() else None


def _unescape_jsonish(text: str) -> str:
    """Undo the escaped-newline serialisation the captured DOM applies.

    The browser-extension capture serialises `<script>` bodies with literal
    `\\n`/`\\t` (and sometimes `\\/`) two-char sequences rather than real
    control characters. json.loads rejects a literal backslash-n that sits
    *outside* a string, so a first raw parse is retried on this unescaped form.
    """
    return (
        text.replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\r", "")
        .replace("\\/", "/")
    )


def _iter_ldjson_objects(soup: BeautifulSoup) -> list[dict[str, Any]]:
    """Yield every object from every `application/ld+json` block.

    Each block is a JSON array or object. Parse the raw text first (works when
    the capture kept real newlines); on failure retry the unescaped form (the
    escaped-`\\n` capture format). Blocks that parse as neither are skipped —
    a malformed analytics blob never crashes normalize().
    """
    objects: list[dict[str, Any]] = []
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = tag.string or tag.get_text() or ""
        for candidate in (raw, _unescape_jsonish(raw)):
            try:
                parsed = json.loads(candidate)
            except (json.JSONDecodeError, ValueError):
                continue
            items = parsed if isinstance(parsed, list) else [parsed]
            objects.extend(o for o in items if isinstance(o, dict))
            break
    return objects


def _find_product(objects: list[dict[str, Any]]) -> dict[str, Any]:
    """The property/offer JSON-LD object — a schema.org `Product` — as opposed
    to the site-wide Organization / LocalBusiness / BreadcrumbList blocks."""
    for obj in objects:
        if obj.get("@type") == "Product":
            return obj
    return {}


def _features(soup: BeautifulSoup) -> dict[str, str]:
    """The `.detail-header__features` block as a {label: value} map.

    Labels are the desktop `.feature__data-name` ("Superficie total",
    "Habitaciones", "Baños"); values the `.feature__data-quantity` ("87 m²",
    "2", "1"). Only the detail header's own block is read — the similar-listing
    cards use a different (abbreviated) markup and must not leak in.
    """
    out: dict[str, str] = {}
    for feat in soup.select(".detail-header__features .feature"):
        name_el = feat.select_one(".feature__data-name")
        qty_el = feat.select_one(".feature__data-quantity")
        if name_el is not None and qty_el is not None:
            out[name_el.get_text(strip=True).lower()] = qty_el.get_text(strip=True)
    return out


def _split_location(
    name: str | None,
) -> tuple[str | None, str | None, str | None, str | None]:
    """(street, postal_code, city, province) from a JSON-LD name/description.

    e.g. "Vivienda en venta en calle Samuel Morse 41010, Sevilla, Sevilla" ->
    ("calle Samuel Morse", "41010", "Sevilla", "Sevilla"). Returns Nones for
    any part not present rather than guessing.
    """
    if not name:
        return None, None, None, None
    m = _LOCATION_TAIL_RE.match(name)
    if m is None:
        return None, None, None, None
    street = _STREET_LEAD_RE.sub("", m.group("street")).strip() or None
    postal = m.group("postal")
    city = m.group("city").strip() or None
    province = m.group("province").strip() or None
    if city and city.isupper():
        city = city.title()
    if province and province.isupper():
        province = province.title()
    return street, postal, city, province


def _photos(html: str, reference: str | None) -> tuple[str, ...]:
    """Gallery photo URLs for THIS listing, in page order, deduped.

    Filters the page's `ImagenesActivos/.../<REF>/…jpg` URLs to those whose
    `<REF>` path segment matches this listing's reference — the detail page
    also embeds a "también te puede interesar" carousel carrying OTHER
    listings' photos, and without the filter a listing would inherit its
    neighbours' galleries. No reference => no photos (honest degradation on an
    unhydrated shell), never a wrong gallery.
    """
    if not reference:
        return ()
    needle = f"/{reference.upper()}/"
    ordered: list[str] = []
    seen: set[str] = set()
    for url in _PHOTO_RE.findall(html):
        if needle in url.upper() and url not in seen:
            seen.add(url)
            ordered.append(url)
    return tuple(ordered)


class AlisedaConnector(Connector):
    name = "aliseda"
    # Never crawls — capture-only (see module docstring). The rate limiter /
    # circuit breaker the base class configures are inert here since
    # scope_key() always returns None before either would be exercised. Same
    # posture as IdealistaConnector.
    supports_discovery = False
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError(
            "aliseda discover: not supported — capture-only connector (see "
            "module docstring / D-019). scope_key() returning None should have "
            "stopped the orchestrator from ever calling this."
        )

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise ConnectorError(
            "aliseda fetch_detail: not supported — this connector never makes "
            "a live network request (D-019: the data host is robots.txt "
            "Disallow: /). Listings arrive via POST /api/extension/capture, "
            "processed by etl/capture.py, which calls normalize() directly."
        )

    @staticmethod
    def external_id_from_url(url: str) -> str | None:
        match = _EXTERNAL_ID_RE.search(url)
        return match.group(1) if match else None

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw.get("html", "")
        soup = BeautifulSoup(html, "html.parser")
        product = _find_product(_iter_ldjson_objects(soup))

        # ── reference code ──────────────────────────────────────────────
        # The URL slug is the reference (uppercased); the JSON-LD `sku`
        # corroborates it. Fall back to the on-page "Ref: …" label only if
        # both are absent (a partial capture).
        reference_code = raw.external_id or product.get("sku")
        if not reference_code:
            ref_text = soup.get_text(" ", strip=True)
            m = _REFERENCE_TEXT_RE.search(ref_text)
            reference_code = m.group(1) if m else None
        if reference_code:
            reference_code = reference_code.upper()

        # ── title / property type / operation ───────────────────────────
        title_el = soup.select_one(".detail-header__title")
        product_name = product.get("name")
        title = (
            title_el.get_text(strip=True)
            if title_el is not None
            else (product_name or _og_meta(soup, "og:title"))
        )
        property_type = map_property_type(title or product_name)
        operation = map_operation(title or product_name)

        # ── price ───────────────────────────────────────────────────────
        # JSON-LD top-level `price` (445000); `offers.price` is a decoy 0.
        current_price = _to_decimal(product.get("price"))
        if not current_price:  # None or 0 -> DOM fallback
            price_el = soup.select_one(".detail-header__price, .property-price")
            if price_el is not None:
                current_price = _to_decimal(
                    _es_number_to_int(price_el.get_text(strip=True))
                )

        # ── surface / rooms / baths (DOM feature block) ─────────────────
        feats = _features(soup)
        m2_built = _to_decimal(_es_number_to_int(feats.get("superficie total")))
        rooms = _es_number_to_int(feats.get("habitaciones"))
        bathrooms = _es_number_to_int(feats.get("baños"))

        # ── location (from JSON-LD name) ────────────────────────────────
        address, postal_code, city, province = _split_location(
            product_name or _og_meta(soup, "og:title")
        )

        # ── description ─────────────────────────────────────────────────
        desc_el = soup.select_one(".description")
        if desc_el is not None:
            description = (
                _DESC_LABEL_RE.sub("", desc_el.get_text(" ", strip=True)) or None
            )
        else:
            description = _clean_str(product.get("description")) or _og_meta(
                soup, "og:description"
            )

        # ── photos ──────────────────────────────────────────────────────
        photo_urls = _photos(html, reference_code)

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind="agency",  # Aliseda is a servicer/REO portal — every
            # listing is the servicer's own asset, never a private seller.
            status="active",  # A captured page is one the owner was just
            # viewing — "active" is the only status this connector can honestly
            # assert (it never revisits to detect a status change). Same rule
            # as idealista.py.
            current_price=current_price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=None,  # REO portal: no private-seller contact to store,
            # and owner-contact PII must never be persisted (issue #266).
            reference_code=reference_code,
            address=address,
            lat=None,  # No per-listing coordinates in the captured markup — the
            # map is a lazy Angular component absent from the hydrated snapshot.
            lon=None,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=None,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,  # Not exposed as a labelled feature on the real pages.
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=city,
            province=province,
            postal_code=postal_code,
            m2_plot=None,
            features=(),
            operation=operation,
            cadastral_ref=None,
            raw_extra={
                "capture_source": "browser-extension",
                # Provenance the whole point of this issue leans on: this row
                # arrived via guided extension capture, not an automated fetch.
                "capture_portal": "aliseda",
                "title": title,
            },
        )


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None
