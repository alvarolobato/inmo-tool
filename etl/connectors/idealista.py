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

Batch capture pacing (issue #262, D-043): the extension can now drive a
listing/search page's detail links through the worklist automatically (open ->
activate -> auto-capture -> close -> advance). That is still real browser
navigation of pages a human asked to batch — but it MUST stay paced: the
extension keeps a jittered delay between pages precisely because Idealista sits
behind a CAPTCHA/bot wall that a burst would trip. Don't remove that pacing.
"""

from __future__ import annotations

import json
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
# Idealista embeds a Google Static Maps URL (config.multimediaCarrousel.map.src
# in the real page's inline <script>) carrying the listing's coordinates in
# its `center` query param — e.g. "center=40.42569080%2C-3.67632170". An
# earlier version of this connector was built against a fixture that had
# this region trimmed out, and incorrectly concluded no coordinates exist
# anywhere in Idealista's page structure (Opus review, PR #87). The URL
# itself sits inside a JS object literal, not a DOM attribute — matched
# directly against the raw HTML rather than via BeautifulSoup.
_STATICMAP_CENTER_RE = re.compile(
    r"staticmap\?[^\"'\s]*[?&]center=(-?\d+\.\d+)%2C(-?\d+\.\d+)"
)
# Idealista's full photo gallery is NOT in the initial DOM (only one <img> /
# the og:image thumbnail renders before the carousel hydrates — issue #282,
# where only 1 of ~95 photos was being stored). Every photo lives in the same
# inline `config.multimediaCarrousel` object this connector already reads the
# map coordinates from (see _STATICMAP_CENTER_RE / PR #87): its `multimedias`
# array holds a `{"type":"PICTURE","content":[{"src": "...", ...}]}` group
# (plus separate PLAN/MAP groups we skip). The `src` values are partial paths
# like "WEB_DETAIL/0/id.pro.es.image.master/xx/xx/xx/NNNN.jpg" — this exact
# schema is transcribed from a real captured Idealista page's per-listing
# `listingMultimediaCarrousels` blob (demo DB extension_capture id 10). We
# balance-match that JS object literal, json.loads it, and collect every
# PICTURE src, prefixing the img host onto partial paths.
_MULTIMEDIA_HOST = "https://img4.idealista.com/blur/"


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
    # Issue #100: capture-only. scope_key() always returns None, so the
    # orchestrator skips every scope for this connector by design — there
    # is no live discover() to schedule, scope, or filter. The connector
    # management UI reads this to render an explicit "capture-only" state
    # rather than geography/filter controls that could never take effect.
    supports_discovery = False
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

        # Full gallery from the embedded carousel JSON (issue #282); the
        # og:image is only the single hydration thumbnail and is used solely
        # as a fallback when the carousel object is absent/unparseable.
        gallery = _gallery_from_carousel(html)
        if gallery:
            photo_urls: tuple[str, ...] = gallery
        else:
            main_image = _og_meta(soup, "og:image")
            photo_urls = (main_image,) if main_image else ()

        coordinates = _coordinates_from_staticmap(html)
        lat, lon = coordinates if coordinates is not None else (None, None)

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
            contact_raw=_advertiser_name(soup),  # Issue #628: the primary
            # contact box's `.advertiser-info .advertiser-name` — None if
            # this capture's page lacks the block (a future markup change,
            # or the owner captured a page where it never rendered).
            reference_code=reference_code,
            address=address,
            lat=lat,  # From the embedded Google Static Maps `center` param
            # (see _coordinates_from_staticmap) — real per-listing
            # coordinates, contrary to an earlier version of this
            # connector's incorrect "no coordinates anywhere" conclusion
            # (Opus review, PR #87). None only if a given capture's page
            # genuinely lacks the map block (e.g. the owner hid the map, or
            # a future Idealista redesign moves it) — the dedup engine's
            # address_coords signal degrades gracefully to skipping this
            # property when that happens, same as any other connector.
            lon=lon,
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


def _advertiser_name(soup: BeautifulSoup) -> str | None:
    """The agency/advertiser name from the primary contact box (issue #628).

    Real markup (verified against a full real Idealista listing page fetched
    from the MIT-licensed `RealEstateWebTools/property_web_scraper` fixture
    repo this connector's original fixture was itself trimmed from — see
    `idealista_sample_detail.html`'s header comment; only the class-name
    shape below is taken from that page, the fixture's own test value is
    synthetic):

        <div id="module-contact-container">
          <section class="module-contact">
            <div class="advertiser-info">
              <p class="advertiser-name">Inmobiliaria Ejemplo</p>

    Scoped to `.advertiser-info .advertiser-name` (the primary per-listing
    contact box), not the page's OTHER `.advertiser-name`-shaped elements —
    a real captured page also carries an "about the professional" widget
    (`.about-advertiser-name`, a *different* class) that can name a
    different office/branch of the same firm; that one is deliberately not
    read here.
    """
    el = soup.select_one(".advertiser-info .advertiser-name")
    if el is None:
        return None
    text = el.get_text(" ", strip=True)
    return text or None


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _extract_js_object(text: str, key: str) -> str | None:
    """Return the raw `{...}` object literal assigned to `key:` in an inline
    <script>, or None. String-aware brace matcher so a `{`/`}` inside a
    quoted value (a URL's query string, a photo description) can't unbalance
    the scan. The matched substring is valid JSON (Idealista emits these
    objects as JSON, e.g. `multimediaCarrousel: {"map":{...}}`)."""
    match = re.search(re.escape(key) + r"\s*:\s*\{", text)
    if not match:
        return None
    start = text.index("{", match.end() - 1)
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _gallery_from_carousel(html: str) -> tuple[str, ...]:
    """Every PICTURE `src` from `config.multimediaCarrousel.multimedias`, in
    page order, deduplicated, prefixed with the img host for partial paths
    (see _MULTIMEDIA_HOST). PLAN/MAP groups are skipped — only real photos
    become photo_urls. Empty tuple if the object is absent or unparseable
    (the caller then falls back to the og:image thumbnail).

    `multimediaCarrousel` (singular) is the detail page's own object; the
    plural `listingMultimediaCarrousels` (a search page's per-listing map,
    capital-M and trailing 's') is deliberately NOT matched by the key
    regex, which anchors on the lowercase singular form ending in a colon."""
    raw = _extract_js_object(html, "multimediaCarrousel")
    if not raw:
        return ()
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return ()
    if not isinstance(data, dict):
        return ()
    urls: list[str] = []
    seen: set[str] = set()
    for group in data.get("multimedias") or []:
        if not isinstance(group, dict) or group.get("type") != "PICTURE":
            continue
        for item in group.get("content") or []:
            if not isinstance(item, dict):
                continue
            src = item.get("src")
            if not isinstance(src, str) or not src:
                continue
            url = src if src.startswith("http") else _MULTIMEDIA_HOST + src.lstrip("/")
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return tuple(urls)


def _coordinates_from_staticmap(html: str) -> tuple[Decimal, Decimal] | None:
    """(lat, lon) from the embedded Google Static Maps `center` param, or
    None if the page doesn't carry one (see _STATICMAP_CENTER_RE)."""
    match = _STATICMAP_CENTER_RE.search(html)
    if not match:
        return None
    lat, lon = _to_decimal(match.group(1)), _to_decimal(match.group(2))
    if lat is None or lon is None:
        return None
    return lat, lon


def _area_with_decimal(text: str) -> Decimal | None:
    """Parse a listing area figure, preserving a genuine decimal separator.

    Unlike price (`_strip_thousands_separators` — real-estate prices don't
    carry meaningful cents either way), area figures do carry meaningful
    decimals (e.g. "114,6 m²"), and this connector can't assume which
    locale a capture renders in (see _strip_thousands_separators'
    docstring). Naively stripping every `.`/`,` would turn "114,6" into
    1146 — a real 10x error (Opus review, PR #87), the same bug class
    already fixed for Fotocasa/Milanuncios in etl/connectors/extraction.py,
    but that helper is es-ES-specific and wrong for Idealista's ambiguous
    locale. Heuristic: exactly one separator, followed by 1-2 digits at the
    end of the number, is treated as a decimal point; anything else
    (multiple separators, or 3+ trailing digits) is a thousands separator
    and stripped entirely — real areas never have 3-digit decimal
    fractions, so this can't misfire on a genuine "3.600.000"-style
    thousands-separated whole number.
    """
    positions = [i for i, ch in enumerate(text) if ch in ".,"]
    if len(positions) == 1:
        sep = positions[0]
        decimals = text[sep + 1 :]
        if 1 <= len(decimals) <= 2 and decimals.isdigit():
            integer_part = re.sub(r"[^\d]", "", text[:sep])
            if integer_part:
                return _to_decimal(f"{integer_part}.{decimals}")
    digits = re.sub(r"[^\d]", "", text)
    return _to_decimal(digits) if digits else None


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
                return _area_with_decimal(match.group(0))
    return None
