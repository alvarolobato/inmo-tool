"""Milanuncios connector — task 2.1 (#15), the second real Connector implementation.

Chosen per issue #15's own guidance: task 1.4 already took Fotocasa, so this
task needed a genuinely different site with more private-seller density
(private sellers are more likely to cross-list and to leave a phone number
in free text — exactly what task 2.2's dedup phone-extraction signal needs
real data to validate against). Milanuncios is a general classifieds site
(not real-estate-specific), not merely "Fotocasa again": a feasibility spot
check found 17 of 41 sampled Madrid listings were `sellerType.isPrivate`,
and 4 of those had a real Spanish mobile number embedded in the free-text
description (confirmed live during the Phase 2.1 spike, 2026-08-02).

Interesting, undocumented-elsewhere finding from that same spike: some
Milanuncios listings carry `origin.provider = "fotocasa_pro"` — Milanuncios
and Fotocasa are both Adevinta-group sites and syndicate some professional
listings between them. That's a real, already-existing "duplicate" case
task 2.2's dedup engine will see on day one, not a hypothetical.

Feasibility spike (issue #15 EC-0-equivalent, mirroring task 1.4's own):
robots.txt disallows pagination params (`*pagina=`, `*?pag`, `*&pag`) and a
handful of other query-string patterns, but not the base sale-category
search or detail paths this connector uses. Live requests (any User-Agent)
returned normal HTTP 200 with full server-rendered content — no CAPTCHA
wall, no bot-block encountered during the spike (unlike Idealista in task
1.4). Go.

Data source: same embedded-JSON pattern as Fotocasa, but a different
transport shape — `window.__INITIAL_PROPS__ = JSON.parse("...")` where the
argument is a *JSON-encoded string of JSON* (the whole payload is escaped
once more than Fotocasa's raw `<script type="application/json">` tag), so
extraction needs an extra `json.loads` pass — see `_extract_initial_props`.
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal, InvalidOperation
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
from etl.connectors.milanuncios_mapping import (
    attribute_numeric_value,
    attribute_value,
    infer_listing_kind,
    map_property_type,
)

logger = logging.getLogger("etl.connectors.milanuncios")

_USER_AGENT = "Mozilla/5.0 (compatible; inmo-tool/0.1; +https://github.com/alvarolobato/inmo-tool)"
_BASE_URL = "https://www.milanuncios.com"
_REQUEST_TIMEOUT_SECONDS = 15
_INITIAL_PROPS_MARKER = 'window.__INITIAL_PROPS__ = JSON.parse("'

# City name (etl.connectors.geography.CITY_CENTROIDS keys) -> this site's own
# geography path segment. Milanuncios's URL just repeats the city name
# itself (see discover()), so this is currently an identity mapping — kept
# as an explicit table anyway (not scope.center's nearest_city() result used
# directly) so a future city whose Milanuncios path segment differs from its
# geography.py key name doesn't require touching discover()'s logic, only
# this table. Live-verified during issue #71 (real HTTP 200 + real ad-list
# data) for every entry here.
_CITY_SLUGS: dict[str, str] = {
    "madrid": "madrid",
    "sevilla": "sevilla",
    "barcelona": "barcelona",
    "valencia": "valencia",
}


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's geography path segment, or None.

    Same contract as fotocasa.py's `_resolve_geography` — `scope.geography`
    wins when set (tests/manual construction), otherwise resolve
    `scope.center` to the nearest known city. No hardcoded default (issue
    #71): unresolvable means "nothing to discover", not "assume Madrid".
    """
    if scope.geography:
        return scope.geography
    if scope.center is None:
        return None
    city = nearest_city(scope.center, scope.radius_km)
    if city is None:
        return None
    return _CITY_SLUGS.get(city)


# Note: the feasibility spike (module docstring) confirmed real phone numbers
# turn up in Milanuncios free-text descriptions, using an ad-hoc regex check
# that never became part of this connector. Task 2.2 owns the real
# phone-extraction signal; this connector's only job is to make sure
# `description` is captured in full so 2.2 has something to extract from
# (see normalize()).


def _extract_initial_props(html: str) -> dict[str, Any]:
    """Pull the server-rendered JSON out of a Milanuncios page.

    Different transport than Fotocasa's `_extract_initial_props`: the value
    after `JSON.parse(` is itself a *JSON string literal* (backslash-escaped
    quotes and all), not a bare JSON object in a `<script type=...>` tag.
    Scans character-by-character honouring `\\`-escapes to find the closing
    unescaped `"`, decodes that JSON *string* first (unescaping it), then
    decodes the resulting text as JSON *again*. Raises ConnectorError if the
    marker is missing (soft-block/interruption page or a site redesign) or
    either JSON decode fails, so those fail loudly (circuit-breaker fodder)
    instead of silently producing an empty/wrong listing.
    """
    start = html.find(_INITIAL_PROPS_MARKER)
    if start == -1:
        raise ConnectorError(
            "milanuncios: __INITIAL_PROPS__ marker not found — page structure "
            "may have changed, or this is a soft-block/interruption page"
        )
    i = start + len(_INITIAL_PROPS_MARKER)
    n = len(html)
    while i < n:
        if html[i] == "\\":
            i += 2
            continue
        if html[i] == '"':
            break
        i += 1
    else:
        raise ConnectorError(
            "milanuncios: unterminated __INITIAL_PROPS__ string literal"
        )

    raw_escaped = html[start + len(_INITIAL_PROPS_MARKER) : i]
    try:
        # First decode: this raw text is itself the *contents* of a JSON
        # string literal (missing its surrounding quotes) — wrap it to
        # unescape \", \\, \uXXXX, etc. into the real JSON text.
        inner_json_text = json.loads('"' + raw_escaped + '"')
        return json.loads(inner_json_text)
    except json.JSONDecodeError as exc:
        raise ConnectorError(
            f"milanuncios: __INITIAL_PROPS__ is not valid JSON: {exc}"
        ) from exc


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


class MilanunciosConnector(Connector):
    name = "milanuncios"
    rate_limit_per_minute = 20  # same conservative default as Fotocasa — issue #1 §15
    # False: like Fotocasa, discover() only reads page 1 of one sale category
    # (robots.txt disallows pagination params here too), against inventory
    # that's realistically in the thousands for a whole province. Same
    # reasoning as fotocasa.py — see Connector.discovers_full_inventory's
    # docstring and docs/architecture/connectors.md. Not independently
    # re-derived per connector; inherited by default until a connector can
    # honestly claim full coverage.
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Delegate to `_resolve_geography` — see FotocasaConnector.scope_key
        for why the resolved slug itself is the right dedup/coverage key."""
        return _resolve_geography(scope)

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        geography = _resolve_geography(scope)
        if geography is None:
            raise ConnectorError(
                "milanuncios discover: scope has neither a resolvable center "
                "(nearest known city too far away) nor an explicit geography "
                "string — nothing to discover, not defaulting to a hardcoded "
                "city (see issue #71)"
            )
        # "-en-<geo>-<geo>" matches the canonical sale-category URL observed
        # live (e.g. "venta-de-pisos-en-madrid-madrid") — the province/city
        # slug repeated. Confirmed during the feasibility spike this returns
        # *only* the sale category (no rentals/shared-rooms mixed in), unlike
        # the shorter "/pisos-en-<geo>/" category-overview URL.
        url = f"{_BASE_URL}/venta-de-pisos-en-{geography}-{geography}/"
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise ConnectorError(
                f"milanuncios discover: request failed for {url}: {exc}"
            ) from exc

        props = _extract_initial_props(response.text)
        ad_list_pagination = props.get("adListPagination") or {}
        ad_list = ad_list_pagination.get("adList") or {}
        ads = ad_list.get("ads") or []
        external_ids = sorted(
            {str(ad["id"]) for ad in ads if isinstance(ad, dict) and ad.get("id")}
        )
        logger.info(
            "milanuncios discover: geography=%s found %d external_ids on page 1",
            geography,
            len(external_ids),
        )
        return external_ids

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        # Confirmed live during the feasibility spike: Milanuncios resolves
        # a detail URL from the trailing numeric id alone, same as Fotocasa —
        # the leading category/title slug can be a placeholder. No redirect
        # needed (unlike Fotocasa's canonical-slug 301); this URL shape
        # returns the real ad's HTML directly with a 200.
        url = f"{_BASE_URL}/x/x-{external_id}.htm"
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise ConnectorError(
                f"milanuncios fetch_detail: request failed for external_id={external_id}: {exc}"
            ) from exc

        props = _extract_initial_props(response.text)
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"url": response.url, "props": props},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        props = raw.raw["props"]
        ad = props.get("ad") or {}
        attributes = ad.get("attributes") or []
        location = ad.get("location") or {}
        geolocation = location.get("geolocation") or {}
        price = ad.get("price") or {}
        cash_price = price.get("cashPrice") or {}
        author = ad.get("author") or {}
        category = ad.get("category") or {}
        images = ad.get("images") or []

        address_parts = [
            (location.get("city") or {}).get("name"),
            (location.get("province") or {}).get("name"),
        ]
        # Only the city/province level is ever published — Milanuncios (like
        # Fotocasa) doesn't expose a street address on the public listing.
        address = ", ".join(p.strip() for p in address_parts if p and p.strip()) or None

        # `images` entries are bare hostnames/paths, not full URLs (e.g.
        # "images-re.milanuncios.com/images/ads/<uuid>") — confirmed live;
        # normalize to an https:// URL rather than storing an unusable
        # schemeless fragment.
        def _to_photo_url(img: str) -> str:
            if img.startswith(("http://", "https://")):
                return img
            if img.startswith("//"):
                return f"https:{img}"
            return f"https://{img}"

        photo_urls = tuple(
            _to_photo_url(img) for img in images if isinstance(img, str) and img
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(ad.get("sellerType")),
            status="active",
            current_price=_to_decimal(cash_price.get("value")),
            description=ad.get("description"),
            photo_urls=photo_urls,
            contact_raw=author.get("userName"),
            address=address,
            lat=_to_decimal(geolocation.get("latitude")),
            lon=_to_decimal(geolocation.get("longitude")),
            property_type=map_property_type(category.get("slug")),
            m2_built=_to_decimal(attribute_numeric_value(attributes, "squareMeters")),
            m2_useful=None,  # not distinguished from squareMeters in the
            # attributes observed during the feasibility spike — revisit if
            # a sampled listing shows both built and useful area separately.
            rooms=_to_int(attribute_numeric_value(attributes, "bedrooms")),
            bathrooms=_to_int(attribute_numeric_value(attributes, "bathrooms")),
            floor=attribute_value(attributes, "floor"),  # human-readable
            # (valueFormatted, e.g. "bajo") via attribute_value's own
            # valueFormatted-first lookup — see milanuncios_mapping.py.
            has_elevator=None,  # no elevator attribute observed on sampled
            # listings during the spike — left None rather than guessed;
            # revisit if a future listing/category shows one.
            year_built=None,  # no construction-year attribute observed
            energy_rating=None,  # no energy-certificate attribute observed
            # on sampled listings — Milanuncios may simply not require/show
            # this for private-seller listings; revisit with more data.
            raw_extra={
                "category_slug": category.get("slug"),
                "seller_type_raw": ad.get("sellerType"),
                "origin": ad.get("origin"),  # see module docstring —
                # some listings carry origin.provider="fotocasa_pro"
                # Deliberately NOT retained: ad["contactMethods"] and
                # author["id"] — persistent personal identifiers for private
                # sellers with no current consumer (task 2.2's dedup engine
                # extracts phone numbers from free-text `description`, not
                # from a structured contact field). Per issue #1 §15's
                # minimization stance, don't accumulate identifiers nothing
                # reads yet.
            },
        )
