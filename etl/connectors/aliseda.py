"""Aliseda connector — capture-only, no live network fetch (issue #237).

═══════════════════════════════════════════════════════════════════════════
  CAPTURE-ONLY. DRAFT SELECTORS PENDING VALIDATION AGAINST A REAL CAPTURE.
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
  HONESTY: the selectors below are UNVALIDATED. Validate before trusting.
──────────────────────────────────────────────────────────────────────────
The parse targets in this file and aliseda_mapping.py are a best-effort GUESS
at a hydrated Aliseda page's shape, built against a FABRICATED fixture
(etl/tests/fixtures/aliseda_sample_detail.html), because this project has not
(and will not) fetch the disallowed API or scrape a live rendered page. Only
the analytics-key names are grounded — D-019 observed the real page fire a
beacon carrying `ciudad`/`provincia`/`metros_cuadrados`/`habitaciones`/
`precio`, so the mapping prefers that `dataLayer` blob and treats labelled DOM
elements as a fallback.

VALIDATION CHECKLIST (do this against the owner's FIRST real capture):
  1. Confirm the detail URL shape `/inmueble/<id>` and the id format
     (`external_id_from_url` regex).
  2. Confirm whether a `dataLayer.push({...})` with the D-019 keys is really
     present in the captured (hydrated) DOM, and its exact key names.
  3. Confirm the DOM fallback selectors (`_TITLE_SEL`, `_PRICE_SEL`, …) or
     replace them with the real ones. This is a constants edit, not a
     restructure.
  4. Re-run etl/tests/test_connector_aliseda.py against a fixture rebuilt from
     the real capture (with any personal data scrubbed — public repo).
Until then, treat any Aliseda listing this produces as provisional.
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
    split_location,
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
# (e.g. `ant00030657045`, per D-019). Alphanumeric, so NOT the `\d+` Idealista
# uses. Captured before any HTML parsing and used by etl/capture.py to build
# the RawListing this connector's normalize() then processes.
_EXTERNAL_ID_RE = re.compile(r"/inmueble/([A-Za-z0-9._-]+)")

# DOM fallback selectors — UNVALIDATED (see module docstring). Grouped here so
# refining against a real capture is a one-place constants edit.
_TITLE_SEL = ".property-detail__title"
_LOCATION_SEL = ".property-detail__location"
_PRICE_SEL = ".property-detail__price-amount"
_DESCRIPTION_SEL = ".property-detail__description"
_REFERENCE_SEL = ".property-detail__reference"
_GALLERY_IMG_SEL = ".property-detail__gallery img"
_FEATURE_SURFACE_SEL = ".feature--surface .feature__value"
_FEATURE_ROOMS_SEL = ".feature--rooms .feature__value"
_FEATURE_BATHS_SEL = ".feature--baths .feature__value"
_FEATURE_FLOOR_SEL = ".feature--floor .feature__value"

_REFERENCE_TEXT_RE = re.compile(r"Referencia:?\s*([A-Za-z0-9._-]+)", re.IGNORECASE)


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
    """Parse an es-ES whole number like "148.000 €" / "78 m²" -> 148000 / 78.

    Aliseda renders Spanish locale (dot = thousands). Real-estate prices and
    surfaces don't carry meaningful decimals in the fields this parses, so we
    keep only the leading run of digits/dots and strip the dots — the same
    "discard the separator entirely" approach idealista.py justifies, but
    committed to es-ES here since (unlike a Spain-based owner's Idealista
    browser, which can render in English) Aliseda is a Spanish-only portal.
    """
    if not text:
        return None
    match = re.search(r"[\d.]+", text)
    if not match:
        return None
    digits = match.group(0).replace(".", "")
    return int(digits) if digits.isdigit() else None


def _extract_datalayer(html: str) -> dict[str, Any]:
    """Best-effort extraction of the analytics `dataLayer.push({...})` object.

    D-019 observed the real page fire an analytics beacon carrying the listing
    fields; a GTM `dataLayer.push` is the plausible carrier. Strategy: find a
    `dataLayer.push(` call, extract its balanced `{...}` argument, and
    json.loads it. A real GTM push may be a JS object literal (single quotes /
    unquoted keys) rather than strict JSON — if json.loads fails we return {}
    and normalize() falls back to DOM selectors + per-field regex, so a
    non-JSON push degrades gracefully rather than crashing. UNVALIDATED — the
    real key names/shape must be confirmed (see module docstring).
    """
    idx = html.find("dataLayer.push(")
    if idx == -1:
        return {}
    brace_start = html.find("{", idx)
    if brace_start == -1:
        return {}
    depth = 0
    for i in range(brace_start, len(html)):
        ch = html[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blob = html[brace_start : i + 1]
                try:
                    parsed = json.loads(blob)
                except (json.JSONDecodeError, ValueError):
                    return {}
                return parsed if isinstance(parsed, dict) else {}
    return {}


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
        data = _extract_datalayer(html)

        # ── reference code ──────────────────────────────────────────────
        reference_code = data.get("referencia")
        if not reference_code:
            ref_el = soup.select_one(_REFERENCE_SEL)
            if ref_el is not None:
                m = _REFERENCE_TEXT_RE.search(ref_el.get_text(strip=True))
                reference_code = m.group(1) if m else None

        # ── title / description ─────────────────────────────────────────
        title_el = soup.select_one(_TITLE_SEL)
        title = (
            title_el.get_text(strip=True)
            if title_el is not None
            else _og_meta(soup, "og:title")
        )
        desc_el = soup.select_one(_DESCRIPTION_SEL)
        description = (
            desc_el.get_text(strip=True)
            if desc_el is not None
            else _og_meta(soup, "og:description")
        )

        # ── price ───────────────────────────────────────────────────────
        current_price = _to_decimal(data.get("precio"))
        if current_price is None:
            price_el = soup.select_one(_PRICE_SEL)
            if price_el is not None:
                current_price = _to_decimal(
                    _es_number_to_int(price_el.get_text(strip=True))
                )

        # ── surface / rooms / baths / floor ─────────────────────────────
        m2_built = _to_decimal(data.get("metros_cuadrados"))
        if m2_built is None:
            m2_built = _to_decimal(_feature_number(soup, _FEATURE_SURFACE_SEL))

        rooms = _to_int(data.get("habitaciones"))
        if rooms is None:
            rooms = _feature_number(soup, _FEATURE_ROOMS_SEL)

        bathrooms = _to_int(data.get("banos"))
        if bathrooms is None:
            bathrooms = _feature_number(soup, _FEATURE_BATHS_SEL)

        floor = _clean_str(data.get("planta"))
        if floor is None:
            floor_el = soup.select_one(_FEATURE_FLOOR_SEL)
            floor = floor_el.get_text(strip=True) if floor_el is not None else None

        has_elevator = data.get("ascensor")
        has_elevator = bool(has_elevator) if isinstance(has_elevator, bool) else None

        # ── location ────────────────────────────────────────────────────
        city = _clean_str(data.get("ciudad"))
        province = _clean_str(data.get("provincia"))
        if city is None and province is None:
            loc_el = soup.select_one(_LOCATION_SEL)
            if loc_el is not None:
                city, province = split_location(loc_el.get_text(strip=True))
        # Title-case a shouty analytics value ("ESTEPONA" -> "Estepona") so it
        # renders and dedups consistently with the other connectors' cities.
        if city and city.isupper():
            city = city.title()

        address = _clean_str(data.get("direccion"))
        postal_code = _clean_str(data.get("codigo_postal"))

        lat = _to_decimal(data.get("latitud"))
        lon = _to_decimal(data.get("longitud"))

        # ── property type / operation ───────────────────────────────────
        property_type = map_property_type(data.get("tipo") or title)
        operation = map_operation(data.get("operacion"))

        # ── photos ──────────────────────────────────────────────────────
        photo_urls = tuple(
            src
            for img in soup.select(_GALLERY_IMG_SEL)
            if (src := (img.get("src") or "").strip())
        )
        if not photo_urls:
            main_image = _og_meta(soup, "og:image")
            photo_urls = (main_image,) if main_image else ()

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
            contact_raw=None,
            reference_code=reference_code,
            address=address,
            lat=lat,
            lon=lon,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=None,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=floor,
            has_elevator=has_elevator,
            year_built=None,  # Not observed in D-019's field set; left None
            # rather than guessed. Add a key/selector if a real capture has it.
            energy_rating=None,
            city=city,
            province=province,
            postal_code=postal_code,
            m2_plot=None,
            features=(),
            operation=operation,
            cadastral_ref=None,  # D-019's observed field set did not include a
            # cadastral reference. If a real capture exposes one it belongs
            # here (REO portals often publish it — a definitive dedup signal).
            raw_extra={
                "capture_source": "browser-extension",
                # Provenance the whole point of this issue leans on: this row
                # arrived via guided extension capture, not an automated fetch.
                "capture_portal": "aliseda",
                "title": title,
                # Keep the raw analytics blob for auditing / re-mapping once
                # real captures arrive — nothing downstream depends on it.
                "aliseda_datalayer": data or None,
            },
        )


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _feature_number(soup: BeautifulSoup, selector: str) -> int | None:
    el = soup.select_one(selector)
    if el is None:
        return None
    return _es_number_to_int(el.get_text(strip=True))


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None
