"""Idealista connector — capture-only, no live network fetch (issue #75).

Task 1.4's feasibility spike already established Idealista returns an
immediate CAPTCHA/bot-detection challenge to every direct HTTP request,
regardless of User-Agent — not a robots.txt restriction, a hard wall (see
fotocasa.py's module docstring for the full comparison; Fotocasa became the
default connector instead). Bypassing that would mean CAPTCHA-solving or a
JS-executing headless browser, both explicitly out of scope per issue #1
§15 (this is a personal tool, not a scraping operation).

The answer this project settled on (matching a working pattern
`RealEstateWebTools/property_web_scraper` already ships, see
browser-extension/NOTICE.md): a browser extension captures the *rendered*
HTML of a listing page the owner is already looking at in their own
browser, and submits it for parsing — no automated fetch to Idealista ever
happens anywhere in this path.

This connector therefore:
  - `scope_key()` always returns None — the orchestrator's normal
    profile-driven sweep (etl.orchestrator.run_all_connectors) treats every
    scope as "no coverage" and skips straight past this connector without
    ever calling discover()/fetch_detail() (see the etl.orchestrator
    scope_key docstring for why that's a skip, not a failure). Registering
    it in etl.connectors.register_all() anyway keeps CONNECTORS as the one
    place every known site lives, and self-documents that Idealista support
    exists, even though its real entry point is elsewhere.
  - `discover()`/`fetch_detail()` exist only because `Connector` requires
    them; both raise immediately if ever actually called, as a defensive
    invariant (they never should be, given scope_key() above) rather than
    silently doing nothing.
  - The real entry point is `normalize()`, called directly by
    etl/capture.py's pending-capture poll with a `RawListing` built from
    HTML a human's browser rendered and the extension in browser-extension/
    submitted via POST /api/extension/capture (dashboard) ->
    extension_capture table (etl/schema/init.sql) -> here.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)
from etl.connectors.extraction import first_present
from etl.connectors.idealista_mapping import (
    map_property_type,
    parse_floor,
    parse_has_elevator,
    parse_year_built,
    split_address,
)

_REFERENCE_INPUT_RE = re.compile(
    r'<input[^>]+name=["\']adId["\'][^>]+value=["\'](\d+)["\']', re.IGNORECASE
)
_PROPERTY_ID_FALLBACK_RE = re.compile(r"propertyId:\s*(\d+)")


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
        return int(value)
    except (TypeError, ValueError):
        return None


def _strip_thousands_separators(text: str | None) -> str | None:
    """Locale-agnostic digit extraction for whole-number listing
    prices/areas — deliberately NOT etl.connectors.extraction's
    strip_price_punctuation, which is es-ES-specific (comma = decimal,
    dot = thousands), correct for Fotocasa/Milanuncios but wrong here: the
    only real Idealista sample available to verify against renders in
    English locale ("3,600,000", comma = thousands, per this fixture's
    provenance — see module docstring), and idealista.com can plausibly
    also render in Spanish locale for a Spain-based owner's browser
    ("3.600.000", dot = thousands) — this connector can't assume which.
    Real-estate listing prices/areas don't carry meaningful decimal cents
    either way, so simply discarding every `,`/`.` and keeping only
    digits is correct under BOTH locales, without needing to detect which
    one a given capture came from."""
    if not text:
        return None
    digits = re.sub(r"[^\d]", "", text)
    return digits or None


class IdealistaConnector(Connector):
    name = "idealista"
    # Never actually crawls (see module docstring) — the rate limiter/
    # circuit breaker the base Connector class configures are inert for
    # this connector in practice, since scope_key() always returns None
    # before either would ever be exercised. Left at the class defaults
    # rather than removed: a future genuinely-automated Idealista path
    # (unlikely, but not this connector's call to foreclose) would need
    # them, and there's no harm in configuring something that's never used.
    discovers_full_inventory = False  # No discover() sweep ever runs at all
    # (not even a partial one) — see EC-relevant note in
    # docs/architecture/connectors.md: withdrawal auto-transition
    # (etl.orchestrator._reconcile_missed_discoveries) never applies to a
    # capture-only source; a captured listing's status only ever changes
    # if the owner captures the same URL again later and it shows
    # different content (e.g. a "no longer available" page — out of scope
    # for this task, no such detection exists yet).

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError(
            "idealista discover: not supported — this connector is "
            "capture-only (see module docstring). scope_key() returning "
            "None should have stopped the orchestrator from ever calling "
            "this; if you're seeing this error, that invariant broke."
        )

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise ConnectorError(
            "idealista fetch_detail: not supported — this connector never "
            "makes a live network request (see module docstring). Listings "
            "arrive via POST /api/extension/capture, processed by "
            "etl/capture.py, which calls normalize() directly."
        )

    @staticmethod
    def external_id_from_url(url: str) -> str | None:
        """Idealista listing URLs are `.../inmueble/<digits>/` — the
        canonical id also appears as `adId`/`propertyId` inside the page,
        but the URL is available before any HTML parsing, and is what
        etl/capture.py uses to build the RawListing this connector's
        normalize() then processes."""
        match = re.search(r"/inmueble/(\d+)/", url)
        return match.group(1) if match else None

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw.get("html", "")
        soup = BeautifulSoup(html, "html.parser")

        title_el = soup.select_one(".main-info__title-main")
        title = (
            title_el.get_text(strip=True)
            if title_el is not None
            else first_present(
                lambda: _og_meta(soup, "og:title"),
                lambda: soup.title.get_text(strip=True) if soup.title else None,
                field="title",
            )
        )

        address_el = soup.select_one(".main-info__title-minor")
        address_string = (
            address_el.get_text(strip=True) if address_el is not None else None
        )
        address, city = split_address(address_string)

        reference_code = first_present(
            lambda: _reference_from_input(html),
            lambda: _reference_from_script(html),
            field="reference_code",
        )

        price_el = soup.select_one(".info-data-price .txt-bold")
        current_price = (
            _to_decimal(_strip_thousands_separators(price_el.get_text(strip=True)))
            if price_el is not None
            else None
        )

        description_el = soup.select_one(".adCommentsLanguage")
        description = first_present(
            lambda: (
                description_el.get_text(strip=True)
                if description_el is not None
                else None
            ),
            lambda: _og_meta(soup, "og:description"),
            field="description",
        )

        basic_features_text = _basic_features_text(soup)

        rooms = first_present(
            lambda: _count_from_features_li(soup, "bedroom"),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: _count_from_features_li(soup, "bathroom"),
            field="bathrooms",
        )
        m2_built = first_present(
            lambda: _area_from_features_li(soup),
            field="m2_built",
        )

        main_image = _og_meta(soup, "og:image")
        photo_urls = (main_image,) if main_image else ()

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=None,  # No reliable particular/agency signal found
            # in the sample page (unlike Fotocasa's clientUrl/-Name pattern,
            # see fotocasa_mapping.infer_listing_kind) — left undetermined
            # rather than guessed.
            status="active",  # A captured listing is, by construction,
            # a page the owner was just looking at right now — "active" is
            # the only status this connector can honestly assert; it never
            # revisits a listing to detect a status change (see
            # discovers_full_inventory's comment above).
            current_price=current_price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=None,  # No agency/contact name found in the sample
            # page structure this connector was built against.
            reference_code=reference_code,
            address=address,
            lat=None,  # No coordinates found anywhere in the sample page —
            # unlike Fotocasa/Milanuncios, which expose real
            # realEstate.coordinates/ad.location JSON. This is a real
            # limitation, not an oversight: it means a captured Idealista
            # property can't use the dedup engine's address_coords signal
            # (etl/dedup/signals/address_coords.py) at all, only
            # reference_code/phone-in-description/photo-hash/fuzzy. Worth a
            # follow-up if geocoding the address string client-side (in the
            # extension, before capture) or server-side ever becomes worth
            # the added complexity.
            lon=None,
            property_type=map_property_type(title),
            m2_built=m2_built,
            m2_useful=None,  # No separate built-vs-useful distinction found.
            rooms=rooms,
            bathrooms=bathrooms,
            floor=parse_floor(basic_features_text),
            has_elevator=parse_has_elevator(basic_features_text),
            year_built=parse_year_built(basic_features_text),
            energy_rating=None,  # Investigated: the sample page's energy
            # certificate block has numeric kWh/CO2 values and a "b" class
            # suffix on the certificate image markup (icon-energy-c-b,
            # left-b/right-b) that might encode a letter grade, but a
            # single sample isn't enough to confirm which class actually
            # varies by grade vs. which is static styling — left None
            # rather than guess. Revisit once a second real capture is
            # available to compare against.
            city=city,
            province=None,  # No structured province field found; the
            # compound address string (split_address) doesn't reliably
            # separate one out either.
            postal_code=None,
            m2_plot=None,  # No plot-size field found (expected: this
            # sample is a flat, not a plot-having property type).
            features=(),
            operation="sale",  # es_idealista.json's own mapping derives
            # this from an `operation: 'sale'|'rent'` key in the page's
            # embedded JS object (see property_web_scraper's booleanFields
            # section) — not implemented here since the trimmed fixture
            # this connector was built against only has 'sale' to verify
            # against; the JSON key itself (`operation:`) is straightforward
            # to extract via regex if/when a real 'rent' sample is
            # available to confirm the value format against.
            raw_extra={
                "capture_source": "browser-extension",
                # No `title` column exists on `property`/`listing` (this
                # schema uses `address`/`description` instead) — kept here
                # purely so etl/capture.py can show something readable in
                # the extension popup's result card without inventing a
                # new canonical field just for that one UI need.
                "title": title,
            },
        )


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _reference_from_input(html: str) -> str | None:
    match = _REFERENCE_INPUT_RE.search(html)
    return match.group(1) if match else None


def _reference_from_script(html: str) -> str | None:
    match = _PROPERTY_ID_FALLBACK_RE.search(html)
    return match.group(1) if match else None


def _basic_features_text(soup: BeautifulSoup) -> str | None:
    """Join every `.details-property_features` block's text — rooms,
    bathrooms, area, floor, elevator, and year-built all live somewhere in
    these blocks as plain `<li>` text (see idealista_mapping.py's parsers),
    not one single reliably-labelled element each."""
    blocks = soup.select(".details-property_features")
    if not blocks:
        return None
    return "\n".join(block.get_text(separator="\n") for block in blocks)


def _count_from_features_li(soup: BeautifulSoup, keyword: str) -> int | None:
    """`.details-property_features li` items like "4 bedrooms"/"5 bathrooms" —
    property_web_scraper's own mapping locates these by fixed list index
    (cssCountId "1"/"2"), which is fragile to a block gaining/losing an
    item above it. Matching on the keyword text itself instead is
    positionally robust, at the cost of depending on the English label
    wording holding (or a Spanish "habitaciones"/"baños" equivalent if a
    listing renders in Spanish — not yet handled, since the only sample
    available to verify against renders in English)."""
    for li in soup.select(".details-property_features li"):
        text = li.get_text(strip=True)
        if keyword in text.lower():
            match = re.match(r"\d+", text)
            if match:
                return _to_int(match.group(0))
    return None


def _area_from_features_li(soup: BeautifulSoup) -> Decimal | None:
    for li in soup.select(".details-property_features li"):
        text = li.get_text(strip=True)
        if "m²" in text or "m2" in text.lower():
            match = re.match(r"[\d.,]+", text)
            if match:
                return _to_decimal(_strip_thousands_separators(match.group(0)))
    return None
