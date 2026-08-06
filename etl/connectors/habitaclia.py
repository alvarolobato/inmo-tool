"""habitaclia.com connector — Spain's #4 generalist portal (issue #79).

## Feasibility spike (2026-08, honest UA, robots.txt + live fetch)

habitaclia.com PASSED the spike. `robots.txt` (HTTP 200) disallows a long
list of query-string filters (`*ordenar=`, `*pag=`, `*geo=`, …) and ajax
endpoints, but NOT the base search page (`viviendas-<slug>.htm`) or the
listing detail page (`/comprar-...-i<id>.htm`) this connector uses. Live
fetches returned normal HTTP 200 server-rendered HTML: the barcelona search
page (~300 KB, real listing links) and a real detail page (~400 KB). The
`captcha` strings on the page are a Google reCAPTCHA-enterprise badge for
the phone-reveal flow (`/dotnet/solicitud/vertelefono`, itself
robots-disallowed and never touched here), NOT a challenge wall gating page
access.

## Adevinta-reuse hypothesis: checked, FALSE

Issue #79 flagged that habitaclia is Adevinta-owned like Fotocasa and its
payload "may resemble Fotocasa's". It does not. habitaclia is a classic,
older ASP.NET `.htm` stack with `*DTO` inline-JS config objects and NO
Fotocasa-style `__initial_props__` blob — and, contrary to
property_web_scraper's `es_habitaclia.json` (which maps every field via
`jsonLdPath`), the live detail page carries NO JSON-LD at all. So no
Fotocasa code path is reused, and the reference mapping's JSON-LD strategy
is stale. Fields come from bespoke HTML + a coordinate regex.

## Discover + detail (unlike pisos.com's search-only path)

The search page carries listing ids and a price/characteristics card, but
NO per-listing coordinates — and the estimator/dedup value of this source
is its geolocated listings. Coordinates live only on the detail page (as
`VGPSLat`/`VGPSLon` inside a StreetView config object). So this connector
IS a detail-fetching connector:

- `discover()` fetches one `viviendas-<slug>.htm` search page, extracts each
  `/comprar-...-i<id>.htm` listing link, stashes the full detail URL keyed
  by id (the id alone can't rebuild the slug-bearing URL — same "stash at
  discovery, read per-listing" pattern as unicaja.py), and returns the ids.
- `fetch_detail()` fetches that detail URL (a real request).
- `normalize()` parses the detail HTML: `.price` (subject-scoped away from
  the `.sim-price` similar-listings carousel — the contamination trap
  docs/skills/connectors.md documents), the "Distribución" feature article
  (rooms/baths/surface), the "Referencia del anuncio" line, and
  `VGPSLat`/`VGPSLon` for coordinates. Property type + city come from the
  URL slug (habitaclia_mapping.py).

## Coverage: page-1 only, hence discovers_full_inventory = False

`discover()` reads a single unfiltered `viviendas-<slug>.htm` page; robots
disallows the `*pag=` pagination parameter, so this connector never sees
habitaclia's full inventory for a scope — withdrawal-from-absence stays
disabled, same as Fotocasa/pisos.

## Born disabled — operator opt-in required

Registered `enabled = false` (#100): a scope expansion (issue #79) whose
live per-listing crawl is an operator decision, not a default. See D-072.
"""

from __future__ import annotations

import html as html_module
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import requests
from bs4 import BeautifulSoup

from etl.connectors.base import (
    LISTING_GONE_HTTP_STATUSES,
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    Throttle,
)
from etl.connectors.extraction import (
    strip_price_punctuation,
    text_to_int,
    underscore_city_slug,
)
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
from etl.connectors.habitaclia_mapping import city_from_url, map_property_type

logger = logging.getLogger("etl.connectors.habitaclia")

_USER_AGENT = "Mozilla/5.0 (compatible; inmo-tool/0.1; +https://github.com/alvarolobato/inmo-tool)"
_BASE_URL = "https://www.habitaclia.com"
_REQUEST_TIMEOUT_SECONDS = 15

# habitaclia's search-URL slug is the accent-stripped, underscore-joined
# municipality name (`viviendas-dos_hermanas.htm`), derived mechanically
# from the resolved gazetteer name by `underscore_city_slug` — NOT a
# hand-maintained per-city table. Issue #369: the previous table simply had
# no entry for `dos hermanas` (or most real profile cities), so every such
# scope resolved to "uncovered" and never crawled habitaclia at all even
# though `viviendas-dos_hermanas.htm` exists and serves real listings (the
# hyphenated `viviendas-dos-hermanas.htm` 404s; the underscore form is what
# habitaclia serves — live-verified 2026-08). pisos.com uses the identical
# convention, so the slug helper is shared (see `underscore_city_slug`).

# Listing detail links on a search page:
# `/comprar-piso-en_venta_..._-barcelona-i4737003828090.htm`. The trailing
# `i<digits>` is the external id.
_DETAIL_LINK_RE = re.compile(r"(/comprar-[a-z0-9_-]*-i(\d+)\.htm)", re.IGNORECASE)

# Coordinates live in a StreetView config object as `VGPSLat`/`VGPSLon`,
# usually unicode-escaped (`"VGPSLat":41.4056`). Match the key then
# the next signed decimal, tolerant of the escaped-or-plain quoting around it.
_VGPS_LAT_RE = re.compile(r"VGPSLat\W{0,8}(-?\d+\.\d+)")
_VGPS_LON_RE = re.compile(r"VGPSLon\W{0,8}(-?\d+\.\d+)")

# "Referencia del anuncio habitaclia/VB2606024" -> "VB2606024".
_REFERENCE_RE = re.compile(r"Referencia del anuncio\s*(?:habitaclia/)?([A-Za-z0-9_-]+)")

_ROOMS_RE = re.compile(r"(\d+)\s*habitaci", re.IGNORECASE)
_BATHS_RE = re.compile(r"(\d+)\s*ba[nñ]o", re.IGNORECASE)
_SURFACE_RE = re.compile(r"Superficie\s*([\d.]+)", re.IGNORECASE)


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """ConnectorScope -> habitaclia URL slug, or None. Same contract as
    fotocasa.py/pisos.py: free-text `scope.geography` wins; else resolve
    `scope.center` via the gazetteer and derive the slug mechanically with
    `underscore_city_slug` (issue #369) so any resolved municipality is
    covered, not only those in a hand-maintained table; raises
    UnresolvableGeographyError (uncaught) when center matches nothing.
    Returns None only when there is nothing to resolve at all (no center,
    no geography string) — a city whose derived slug habitaclia happens not
    to serve is NOT None here; discover() turns that into a clean uncovered
    result via the 404 it gets back."""
    if scope.geography:
        return scope.geography
    place = resolve_place(scope)
    if place is None:
        return None
    return underscore_city_slug(place.name)


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = html_module.unescape(re.sub(r"\s+", " ", value)).strip()
    return cleaned or None


def _extract_latlon(html: str) -> tuple[Decimal | None, Decimal | None]:
    lat_m = _VGPS_LAT_RE.search(html)
    lon_m = _VGPS_LON_RE.search(html)
    return (
        _to_decimal(lat_m.group(1)) if lat_m else None,
        _to_decimal(lon_m.group(1)) if lon_m else None,
    )


def _parse_price(soup: BeautifulSoup) -> Decimal | None:
    """Subject price from the summary `.price` element.

    Deliberately NOT the similar-listings carousel: those cards carry class
    `sim-price` (a distinct token from `price`), so the `.price` selector
    never matches them — the exact carousel-contamination guard
    docs/skills/connectors.md documents (Vivantial/Servihabitat/Solvia). The
    element text is like "Oportunidad 425.000 € Avísame si baja"; the
    es-ES-aware `strip_price_punctuation` drops the label words and thousands
    dots, leaving 425000."""
    el = soup.select_one(".price")
    if el is None:
        return None
    m = re.search(r"([\d.]+)\s*€", el.get_text(" ", strip=True))
    if not m:
        return None
    digits = strip_price_punctuation(m.group(1))
    return _to_decimal(digits) if digits else None


def _parse_distribution(
    soup: BeautifulSoup,
) -> tuple[int | None, int | None, Decimal | None]:
    """rooms, baths, m² from the 'Distribución' feature article.

    `<article class="has-aside"><h3>Distribución</h3><ul><li>1 habitación
    </li><li>Superficie 61 m2</li><li>1 Baño</li></ul></article>` — matched
    by the article's own heading, so a different article's `<li>`s can't
    contaminate it. Each figure is keyed by its own word, since order and
    presence vary per listing."""
    rooms = baths = None
    m2: Decimal | None = None
    for article in soup.select("article"):
        heading = article.find(["h2", "h3"])
        if not heading or "distribuci" not in heading.get_text().lower():
            continue
        for li in article.select("li"):
            text = li.get_text(" ", strip=True)
            if rooms is None and _ROOMS_RE.search(text):
                rooms = text_to_int(_ROOMS_RE.search(text).group(1))
            if baths is None and _BATHS_RE.search(text):
                baths = text_to_int(_BATHS_RE.search(text).group(1))
            if m2 is None and _SURFACE_RE.search(text):
                m2 = _to_decimal(_SURFACE_RE.search(text).group(1).replace(".", ""))
        break
    return rooms, baths, m2


class HabitacliaConnector(Connector):
    name = "habitaclia"
    # Per-listing detail crawl (unlike pisos.com's single search request),
    # so this genuinely paces each fetch_detail. Conservative default for a
    # newly-added site; pages loaded cleanly for the honest UA during the
    # spike, but a real safe rate is a production measurement (mirroring how
    # Milanuncios' rate was measured, not guessed — D-017).
    rate_limit_per_minute = 6

    # Page-1-only search → never the full inventory for a scope (robots
    # disallows the *pag= pagination param). Gates withdrawal detection.
    discovers_full_inventory = False

    supported_filters: tuple[str, ...] = ()

    def __init__(self) -> None:
        # {external_id: detail_url}, stashed by discover() (the id alone
        # can't rebuild the slug-bearing detail URL — see module docstring).
        # Reset per discover() call so a scope that fails partway never
        # leaves a prior scope's URLs behind.
        self._detail_urls: dict[str, str] = {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Resolved slug IS the dedup/coverage key. Must never raise: an
        UnresolvableGeographyError becomes a sentinel key (discover() runs
        and fails as a real result); a plain None (no slug) skips the scope."""
        try:
            return _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)

    def _search_url(self, geography: str) -> str:
        return f"{_BASE_URL}/viviendas-{geography}.htm"

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        self._detail_urls = {}

        geography = _resolve_geography(scope)
        if geography is None:
            # Now that the slug is derived mechanically from any resolved
            # municipality (issue #369), None here means only "no center and
            # no geography string to resolve at all".
            raise ConnectorError(
                "habitaclia discover: scope has neither a resolvable center "
                "nor an explicit geography string — nothing to discover, not "
                "defaulting to a hardcoded city"
            )

        url = self._search_url(geography)
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            # Issue #369: an HTTP 404 means habitaclia has no search page for
            # this city — it simply isn't on this portal (or the derived slug
            # isn't the one it uses). That is a CLEAN "uncovered" outcome, not
            # a connector failure: return [] so the run status stays healthy
            # instead of marking the whole profile 'failed' for a geography
            # this portal doesn't serve. Safe because
            # discovers_full_inventory=False, so an empty sweep never
            # auto-withdraws anything. Any other transport/HTTP error is a
            # genuine failure and still raises.
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status == 404:
                logger.info(
                    "habitaclia discover: %s returned HTTP 404 — habitaclia "
                    "has no search page for this city (geography=%s); treating "
                    "as uncovered (empty result), not a failure",
                    url,
                    geography,
                )
                return []
            raise ConnectorError(
                f"habitaclia discover: request failed for {url}: {exc}"
            ) from exc

        detail_urls = self._parse_search_links(response.text)
        if not detail_urls:
            # A real habitaclia search page always carries listing links.
            # Zero on an HTTP 200 means the link markup changed or this is a
            # block/interstitial page — raise rather than return [], so an
            # empty result can't be misread as "everything withdrawn".
            raise ConnectorError(
                f"habitaclia discover: found 0 listing links on {url} — the "
                "'/comprar-...-i<id>.htm' link markup may have changed, or "
                "this is a block/interstitial page"
            )

        self._detail_urls = detail_urls
        logger.info(
            "habitaclia discover: geography=%s found %d listing links on page 1",
            geography,
            len(detail_urls),
        )
        return sorted(detail_urls)

    @staticmethod
    def _parse_search_links(html: str) -> dict[str, str]:
        urls: dict[str, str] = {}
        for path, external_id in _DETAIL_LINK_RE.findall(html):
            urls.setdefault(external_id, f"{_BASE_URL}{path}")
        return urls

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = self._detail_urls.get(external_id)
        if url is None:
            # id was in a prior discover() but not the current stash — it
            # reordered/withdrew off page 1. Clean skip, not a run error.
            raise ListingUnavailableError(
                f"habitaclia fetch_detail: external_id={external_id} not in the "
                "last discover() payload — reordered/withdrawn off page 1"
            )
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            gone_status = getattr(getattr(exc, "response", None), "status_code", None)
            if gone_status in LISTING_GONE_HTTP_STATUSES:
                raise ListingUnavailableError(
                    f"habitaclia fetch_detail: external_id={external_id} returned "
                    f"HTTP {gone_status} — listing removed/withdrawn at source "
                    "between discovery and fetch"
                ) from exc
            raise ConnectorError(
                f"habitaclia fetch_detail: request failed for "
                f"external_id={external_id}: {exc}"
            ) from exc

        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"url": response.url, "html": response.text},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw["html"]
        url = raw.raw.get("url")
        soup = BeautifulSoup(html, "html.parser")

        lat, lon = _extract_latlon(html)
        rooms, baths, m2 = _parse_distribution(soup)
        price = _parse_price(soup)

        ref_m = _REFERENCE_RE.search(html)
        reference_code = ref_m.group(1) if ref_m else None

        desc_el = soup.select_one(
            'meta[name="description"], meta[property="og:description"]'
        )
        description = _clean(desc_el.get("content")) if desc_el else None

        og_img = soup.select_one('meta[property="og:image"]')
        photo_urls: tuple[str, ...] = ()
        if og_img and og_img.get("content"):
            src = og_img["content"]
            if src.startswith("//"):
                src = "https:" + src
            photo_urls = (src,)

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=url,
            listing_kind=None,  # No live-confirmed particular/agency signal.
            status="active",
            current_price=price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=None,
            address=city_from_url(url),
            lat=lat,
            lon=lon,
            property_type=map_property_type(url),
            m2_built=m2,
            m2_useful=None,
            rooms=rooms,
            bathrooms=baths,
            floor=None,  # not reliably structured on the detail page.
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=city_from_url(url),
            province=None,
            postal_code=None,
            m2_plot=None,
            features=(),
            operation="sale",  # discover() only ever surfaces /comprar- URLs.
            reference_code=reference_code,
            raw_extra={"reference_raw": reference_code},
        )
