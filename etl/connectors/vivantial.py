"""Vivantial connector — sitemap-driven discovery.

Operator: **INVERSIÓN EN ACTIVOS BANCARIOS, PK, S.L.** (CIF B87052635,
trading as OKUANT), Madrid. Established from the site's own privacy policy
during the issue #120 feasibility spike, because the public-facing pages
never name a legal entity. OKUANT buys distressed real-estate portfolios
*from* banks and developers and resells them directly — so this is a
fund-owned REO seller, not a bank-owned one. Worth stating plainly: it
belongs in the bank/fund batch (#132) on the strength of the inventory,
but it is not "a bank's portal" the way Servihabitat or Diglo are.

Feasibility spike (2026-08-02), all live-verified:

- `robots.txt` disallows exactly one path (`/Contacto/`) and publishes a
  sitemap. Nothing this connector touches is disallowed.
- **The sitemap is the whole inventory**: 1,833 URLs, of which 1,825 are
  `/Inmuebles/<slug>_<id>` detail pages. This is the important structural
  win — there is no pagination to defeat, so unlike Fotocasa (page-1 only,
  ~30 of 11,000+, permanently capped by its own robots.txt — issue #65)
  this connector genuinely sees everything the site publishes.
- Detail pages are plain server-rendered HTML (no JS execution needed, no
  JSON payload) at ~25KB. 4 listings sampled across Madrid, Murcia, Lugo
  and Valencia all parsed consistently.
- Observed asking prices spanned 12.000 € - 288.000 €, i.e. genuinely
  distressed/low-ticket stock, which is squarely the low-cost/high-yield
  inventory issue #1 §3 describes as a target thesis.
- No coordinates are published anywhere (see `vivantial_mapping`'s
  docstring for the dedup consequence).

Scope handling: the sitemap is national, and the city/province live in each
URL slug, so `discover()` fetches the sitemap once and filters by the
scope's resolved city rather than issuing a per-city search request. That
keeps it to a single request per sweep regardless of how many listings
match — cheaper on the origin than the search-page crawl the other
connectors do.
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal
from typing import Any

import requests

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)
from etl.connectors.geography import nearest_city
from etl.connectors.vivantial_mapping import (
    extract_address,
    extract_bathrooms,
    extract_city_province,
    extract_m2_built,
    extract_photo_urls,
    extract_price,
    extract_reference_code,
    extract_rooms,
    extract_title,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://www.vivantial.es"
_SITEMAP_URL = f"{_BASE_URL}/sitemap.xml"
_REQUEST_TIMEOUT_SECONDS = 25
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research; "
    "contact: github.com/alvarolobato/inmo-tool)"
)

# The slug segment each city appears as in a detail URL. Derived from the
# live sitemap, not guessed: Vivantial lowercases and strips punctuation,
# so "Sagunto/Sagunt" becomes "saguntosagunt". Only the four cities
# `geography.CITY_CENTROIDS` knows about are mapped, matching the other
# connectors' coverage.
_CITY_SLUGS: dict[str, str] = {
    "madrid": "madrid",
    "sevilla": "sevilla",
    "barcelona": "barcelona",
    "valencia": "valencia",
}

_DETAIL_URL_RE = re.compile(
    r"<loc>\s*(https://www\.vivantial\.es/Inmuebles/[^<\s]+)\s*</loc>", re.IGNORECASE
)
_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's city slug, or None.

    Same contract as the Fotocasa/Milanuncios equivalents: the free-text
    `scope.geography` escape hatch wins for tests/manual construction,
    otherwise resolve `scope.center` to the nearest known city. No
    hardcoded default — an unresolvable scope means "nothing to discover
    here", never "assume Madrid" (issue #71).
    """
    if scope.geography:
        return scope.geography
    if scope.center is None:
        return None
    city = nearest_city(scope.center, scope.radius_km)
    if city is None:
        return None
    return _CITY_SLUGS.get(city)


def _detail_url_for(
    external_id: str, sitemap_urls: dict[str, str] | None = None
) -> str:
    """Best-known detail URL for an id.

    The slug carries city/province, so it can't be reconstructed from the id
    alone — `discover()` caches the mapping and `fetch_detail` reuses it.
    """
    if sitemap_urls and external_id in sitemap_urls:
        return sitemap_urls[external_id]
    return f"{_BASE_URL}/Inmuebles/{external_id}"


class VivantialConnector(Connector):
    name = "vivantial"

    # The sitemap is the site's own complete published inventory, and this
    # connector reads all of it (filtering by city locally, not by asking
    # the site for a subset). So a listing that stops appearing genuinely
    # has been removed, and the orchestrator's absence-based withdrawal
    # transition is trustworthy here — unlike Fotocasa, which sees a
    # relevance-sorted page-1 slice and must set this False.
    discovers_full_inventory = True

    supports_discovery = True

    def __init__(self) -> None:
        # external_id -> full detail URL, populated by discover() so
        # fetch_detail doesn't have to re-derive a slug it can't reconstruct.
        self._url_cache: dict[str, str] = {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Resolved city slug — see FotocasaConnector.scope_key for why the
        resolved value (not the raw scope) is the right dedup key."""
        return _resolve_geography(scope)

    def _fetch(self, url: str, throttle: Throttle) -> str:
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise ConnectorError(f"vivantial: request failed for {url}: {exc}") from exc
        return response.text

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        geography = _resolve_geography(scope)
        if geography is None:
            raise ConnectorError(
                "vivantial discover: scope has neither a resolvable center "
                "(nearest known city too far away) nor an explicit geography "
                "string — nothing to discover, not defaulting to a hardcoded "
                "city (see issue #71)"
            )

        sitemap = self._fetch(_SITEMAP_URL, throttle)

        # A sitemap that parses to zero <loc> entries at all means we got
        # something other than the real sitemap (an error page, a WAF
        # interstitial). Raising rather than returning [] is what stops the
        # orchestrator reading an empty discover() as "every active listing
        # just vanished" and mass-marking withdrawals — the same guard the
        # Fotocasa/Milanuncios connectors use for their marker checks, and
        # it matters more here because this connector claims full inventory.
        if not _LOC_RE.search(sitemap):
            raise ConnectorError(
                "vivantial discover: sitemap response contained no <loc> "
                "entries — likely an error/interstitial page rather than the "
                "real sitemap, not an empty inventory"
            )

        external_ids: list[str] = []
        for url in _DETAIL_URL_RE.findall(sitemap):
            city, _province = extract_city_province(url)
            if city is None or city.lower() != geography.lower():
                continue
            match = re.search(r"_(\d+)$", url.rstrip("/"))
            if match is None:
                continue
            external_id = match.group(1)
            self._url_cache[external_id] = url
            external_ids.append(external_id)

        deduped = sorted(set(external_ids))
        logger.info(
            "vivantial discover: geography=%s matched %d of %d sitemap listings",
            geography,
            len(deduped),
            len(_DETAIL_URL_RE.findall(sitemap)),
        )
        return deduped

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = _detail_url_for(external_id, self._url_cache)
        page = self._fetch(url, throttle)

        # Every real detail page carries the reference element. Its absence
        # means this isn't a listing page (removed listing, redirect to a
        # search page, interstitial) — surface it rather than silently
        # normalising an empty listing into the database.
        if "referencia" not in page.lower():
            raise ConnectorError(
                f"vivantial fetch_detail: no reference marker on {url} — page "
                "structure may have changed, or the listing was removed"
            )

        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"html": page, "url": url},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        page: str = raw.raw["html"]
        url: str = raw.raw["url"]
        city, province = extract_city_province(url)

        m2_built: Decimal | None = extract_m2_built(page)

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=url,
            # Vivantial states on its own "Nosotros" page that it owns most
            # of the stock and sells directly without commission. That is a
            # principal seller, not a private individual and not a broker
            # acting for one — 'agency' is the honest mapping of the two
            # values the schema allows, and it also keeps issue #16's
            # phone-corroboration rule conservative (agency-side phone
            # matches never auto-merge).
            listing_kind="agency",
            status="active",
            current_price=extract_price(page),
            description=extract_title(page),
            photo_urls=extract_photo_urls(page),
            contact_raw=None,
            address=extract_address(page),
            # No coordinates published anywhere on the site — see the
            # mapping module docstring. This permanently excludes Vivantial
            # listings from issue #16's address_coords dedup signal.
            lat=None,
            lon=None,
            property_type="piso",
            m2_built=m2_built,
            m2_useful=None,
            rooms=extract_rooms(page),
            bathrooms=extract_bathrooms(page),
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=city,
            province=province,
            postal_code=None,
            m2_plot=None,
            features=(),
            # The sitemap and every sampled page are sale listings; the site
            # has no rental section.
            operation="sale",
            reference_code=extract_reference_code(page),
            raw_extra=_raw_extra(url),
        )


def _raw_extra(url: str) -> dict[str, Any]:
    return {"detail_url": url}
