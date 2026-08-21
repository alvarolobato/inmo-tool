"""pisos.com connector — a search-payload-primary generalist portal (issue #79).

## Feasibility spike (2026-08, honest UA, robots.txt + live fetch)

pisos.com PASSED the spike cleanly. `GET https://www.pisos.com/robots.txt`
(HTTP 200) disallows only `/busqueda/$` (exact), `/*.aspx`, `/WS/`,
`/mapa/`, `/PriceDrop/`, `/alquiler-temporada/` and the non-`es` language
trees — the `/venta/...` search path and `/comprar/...` detail path this
connector uses are both allowed for `User-Agent: *`. A live fetch of
`https://www.pisos.com/venta/pisos-madrid/` returned HTTP 200 with ~280 KB
of normal server-rendered HTML — no DataDome/PerimeterX/Cloudflare
challenge, no CAPTCHA interstitial. The bare-city slug convention
(`/venta/pisos-<city>/`) was live-verified for madrid, malaga, barcelona
and sevilla (all HTTP 200, ~280 KB).

## Search-payload-primary, PLUS one detail fetch for reference/agency (D-141)

The pisos.com SEARCH page is far richer than its detail page for every
field except two, so this connector still reads price/rooms/baths/m²/
floor/coordinates/photos off the search results, but — since issue #628
(D-141, revising the original "no detail fetch" framing of D-071) —
additionally makes ONE real request per listing to the detail page to
recover `reference_code` and `contact_raw` (agency name), which a live
2026-08 spike confirmed are NOT published anywhere in the search card or
its JSON-LD (0/30 cards on a real madrid search page carried either). See
D-141 for the full rationale, including why this is safe given the
connector's born-disabled default. Each `<div class="ad-preview"
id="{id}">` search card carries, live-verified 2026-08 (30/30 cards on the
madrid page):

- `contact-box[data-ad-price]`     — raw numeric price (e.g. `1600000`)
- `.ad-preview__char` items        — "3 habs." / "3 baños" / "155 m²" /
                                     "4ª planta" (rooms/baths/m²/floor)
- `.ad-preview__title` / `__subtitle` — title + neighbourhood/municipality
- `.ad-preview__description`       — free-text teaser
- `data-lnk-href`                  — the `/comprar/<type>-<slug>-<id>/`
                                     detail URL (its first token is the
                                     property type — see pisos_mapping.py)
- `<img>` `src`/`data-src`         — photo URLs

plus ONE `<script type="application/ld+json">` block per card (keyed by the
same `@id` as the card's `id`) carrying `geo.latitude`/`geo.longitude`
(30/30) and `address.addressLocality`/`addressRegion`. The DETAIL page
carries NO JSON-LD at all (live-checked) and is strictly poorer than the
search card for every OTHER field — but it is the only place
`features__feature` (labelled "Referencia:") and `owner-info__name` live;
see `pisos_mapping.extract_reference_code`/`extract_agency_name`.

## Coverage: page-1 only, hence discovers_full_inventory = False

`discover()` reads a single unfiltered `/venta/pisos-<city>/` page (~30
cards). Pagination (a `/N/` path segment) exists but is deliberately not
walked in this first version — same page-1-only stance as Fotocasa's own
sale connector, and the same reason (`discovers_full_inventory = False`):
a listing absent from a page-1-only sweep says nothing about whether it is
still active, so withdrawal-from-absence must stay disabled.

## Born disabled — operator opt-in required

Registered `enabled = false` via the generic connector_config mechanism
(#100). This is a scope expansion (issue #79) beyond the original
Fotocasa/Milanuncios target set; enabling a new site's live crawl is an
operator decision, not a default. See D-071.
"""

from __future__ import annotations

import html as html_module
import json
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
    SearchParam,
    SearchPreview,
    SearchUrlGrammar,
    Throttle,
)
from etl.connectors.extraction import underscore_city_slug
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
from etl.connectors.pisos_mapping import (
    extract_agency_name,
    extract_reference_code,
    map_property_type,
)

logger = logging.getLogger("etl.connectors.pisos")

_USER_AGENT = "Mozilla/5.0 (compatible; inmo-tool/0.1; +https://github.com/alvarolobato/inmo-tool)"
_BASE_URL = "https://www.pisos.com"
_REQUEST_TIMEOUT_SECONDS = 15

# pisos.com's search-URL slug is the accent-stripped, underscore-joined
# municipality name (`/venta/pisos-dos_hermanas/`), derived mechanically
# from the resolved gazetteer name by `underscore_city_slug` — NOT a
# hand-maintained per-city table. Issue #369: the previous table mapped
# `dos hermanas` -> `dos-hermanas` (hyphen), but pisos.com serves
# `pisos-dos_hermanas/` (underscore) and 404s the hyphen form, so every
# multi-word city the profile scopes actually hit failed a run. The
# underscore rule was live-verified 2026-08 for dos_hermanas (626 real
# cards), alcala_de_guadaira and mairena_del_aljarafe (all HTTP 200); see
# `underscore_city_slug`.
#
# Verified per-city exceptions where the naive slug 404s live on pisos.com
# (the site drops the leading article) go here; anything not listed falls
# through to `underscore_city_slug(place.name)`. A city whose derived slug
# pisos.com still doesn't serve is handled by discover() catching the 404 as
# a clean "not on this portal" result, never a hard failure — so this table
# stays SMALL (only genuinely live-verified fixes) rather than trying to
# pre-enumerate coverage.
_SLUG_OVERRIDES: dict[str, str] = {
    # Live-verified 2026-08: pisos.com drops the "l'" article ->
    # `/venta/pisos-hospitalet_de_llobregat/` (HTTP 200); the naive
    # `l_hospitalet_de_llobregat` 404s.
    "l'hospitalet de llobregat": "hospitalet_de_llobregat",
}

_CARD_SELECTOR = "div.ad-preview[id]"

# Issue #491: the reference URL grammar. pisos.com's search URL is the simplest
# in the fleet — a single geography slug in a fixed `/venta/pisos-<slug>/` path
# — which is why it's the first connector to publish one. `_search_url()`
# delegates to `build()` below, so the grammar is not a parallel description that
# can drift from what discover() builds: it IS what discover() builds. The
# per-connector round-trip pytest contract pins the two together. Stored in
# ECMAScript-canonical form (`(?<geography>…)`) so the dashboard's browser-side
# `RegExp` consumes `parse_pattern` verbatim; the Python side translates it.
_SEARCH_URL_GRAMMAR = SearchUrlGrammar(
    build_template=f"{_BASE_URL}/venta/pisos-{{geography}}/",
    parse_pattern=r"^https?://(?:www\.)?pisos\.com/venta/pisos-(?<geography>[^/]+)/?$",
    params={"geography": {"label": "Municipio", "source": "profile"}},
)

# Characteristics are a flat list of short strings on each card
# (".ad-preview__char"): "3 habs.", "3 baños", "155 m²", "4ª planta". Order
# is not guaranteed and not every card has all four, so each is matched by
# its own keyword rather than by position.
_ROOMS_RE = re.compile(r"(\d+)\s*hab", re.IGNORECASE)
_BATHS_RE = re.compile(r"(\d+)\s*ba[nñ]o", re.IGNORECASE)
_M2_RE = re.compile(r"(\d[\d.]*)\s*m", re.IGNORECASE)


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into pisos.com's URL slug, or None if it can't be.

    `scope.geography` (a free-text escape hatch — see ConnectorScope's
    docstring) wins when set, for tests/manual construction. Otherwise
    resolve `scope.center` via the shared gazetteer and derive its pisos.com
    slug mechanically with `underscore_city_slug` (issue #369): every
    resolved municipality yields a slug, so this covers arbitrary cities
    rather than only those in a hand-maintained table. `_SLUG_OVERRIDES`
    supplies the handful of live-verified exceptions where the naive slug
    404s. Returns None only when there is nothing to resolve at all (no
    center and no geography string) — a scope whose derived slug pisos.com
    happens not to serve is NOT None here; discover() turns that into a
    clean uncovered result via the 404 it gets back.

    Can raise `UnresolvableGeographyError` (from `resolve_place`) when
    `scope.center` is set but matches no place in the gazetteer at all —
    deliberately NOT caught here (same contract as fotocasa.py).
    """
    if scope.geography:
        return scope.geography
    place = resolve_place(scope)
    if place is None:
        return None
    return _SLUG_OVERRIDES.get(place.name) or underscore_city_slug(place.name)


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


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = html_module.unescape(value).strip()
    return cleaned or None


def _parse_m2(chars: list[str]) -> Decimal | None:
    for c in chars:
        if "m" in c and ("²" in c or "m2" in c.lower() or c.strip().endswith("m")):
            m = _M2_RE.search(c)
            if m:
                # pisos surfaces are plain integers ("155 m²"); strip any
                # es-ES thousands dot defensively.
                return _to_decimal(m.group(1).replace(".", ""))
    return None


class PisosConnector(Connector):
    name = "pisos"
    # One search request per scope per run PLUS one detail request per
    # listing (issue #628, D-141 — fetch_detail() now makes a real
    # request, unlike the original search-payload-only design; see the
    # module docstring). Kept conservative; pisos.com served a clean
    # HTTP 200 to the honest UA during the spike, but a new site gets a
    # gentle default until a real rate is measured in production.
    rate_limit_per_minute = 6

    # Page-1-only search → this connector never sees pisos.com's full
    # inventory for a scope. Declared explicitly (gates withdrawal detection
    # in etl.orchestrator._reconcile_missed_discoveries): a listing absent
    # from a partial sweep proves nothing about withdrawal.
    discovers_full_inventory = False

    # Issue #628/#629 (Opus review, B4): fetch_detail() can backfill a
    # NULL reference_code with a real request — see
    # Connector.backfills_missing_reference_code's own docstring for what
    # this actually changes in etl.orchestrator._should_skip_fetch.
    backfills_missing_reference_code = True

    # No native site-filter is live-verified for this connector yet, so none
    # are advertised (an unverified filter that silently no-ops is worse than
    # none — see base.Connector.supported_filters).
    supported_filters: tuple[str, ...] = ()

    # Issue #478: the owner may pin a pisos.com search URL as this connector's
    # recall source for a profile. Since Phase 5 (D-101) discover() consumes
    # that pinned URL (`scope.override_url`) as its entry page.
    override_host_suffix = "pisos.com"
    supports_search_override = True

    # Issue #491: published to connector_registry.search_url_grammar so the
    # dashboard can invert an owner-edited URL back to params in the browser.
    search_url_grammar = _SEARCH_URL_GRAMMAR

    def __init__(self) -> None:
        # Populated by discover() as a side effect of the single search
        # request it makes; read back by fetch_detail() (which, per D-141,
        # ALSO makes its own real detail request per listing for
        # reference_code/contact_raw only) and by discovered_prices().
        # Reset at the start of every discover() call so a scope that
        # fails partway through never leaves a prior scope's data behind
        # for the orchestrator to misread.
        self._search_records: dict[str, dict[str, Any]] = {}
        self._last_discovery_prices: dict[str, Decimal] = {}

    def discovered_prices(self) -> dict[str, Decimal]:
        """See Connector.discovered_prices. pisos.com's search cards embed a
        raw numeric per-listing price (`contact-box[data-ad-price]`) in the
        same page discover() already fetches — live-verified 30/30 on the
        madrid search page 2026-08. Free (no extra request), so it powers
        the skip-if-seen price-change safety net for any future opt-in."""
        return dict(self._last_discovery_prices)

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved slug IS the dedup/coverage key — two scopes resolving
        to the same slug hit the identical search URL. Must never raise (the
        orchestrator calls it without try/except): an
        UnresolvableGeographyError becomes a distinct sentinel key so
        discover() still runs and fails there as a real result, while a
        plain None (no slug) puts the scope on the skip path.

        Issue #478 P5 (D-101): an owner-pinned `override_url` IS the target —
        geography resolution is irrelevant to it — so it keys purely off the
        URL. This makes the key distinct from the twin (non-override) scope so
        the orchestrator never dedupes them, and always resolvable (discover()
        hits the pinned URL directly, even when the profile's geography would
        not resolve)."""
        if scope.override_url:
            return f"override:{scope.override_url}"
        try:
            geography = _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        return geography

    def _search_url(self, geography: str) -> str:
        # Delegates to the grammar (issue #491) so the derived URL and the
        # grammar can never drift apart — the grammar IS the URL builder, and
        # the round-trip pytest contract pins parse(build(x)) == x.
        return self.search_url_grammar.build({"geography": geography})

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses `_search_url()` (the exact helper discover() builds its entry
        URL from), so the preview cannot drift from the real request."""
        try:
            geography = _resolve_geography(scope)
        except UnresolvableGeographyError:
            geography = None
        if geography is None:
            return [
                SearchPreview(
                    label="Pisos.com",
                    url=None,
                    kind="search_page",
                    tunable=True,
                    notes="El perfil no resuelve a una geografía que este conector cubra.",
                )
            ]
        return [
            SearchPreview(
                label=f"Pisos.com — {geography}",
                url=self._search_url(geography),
                kind="search_page",
                tunable=True,
                # Issue #491: the exact params discover() uses for this scope,
                # built from the SAME resolved geography the URL is (anti-drift).
                # `operation` is a constant baked into every /venta/ URL this
                # connector requests (see normalize()'s operation="sale"). Note
                # that the profile's price/size/type filters are deliberately
                # ABSENT here — the orchestrator never passes them to the
                # connector; they are applied downstream by data.
                params=(
                    SearchParam(
                        key="geography",
                        label="Municipio",
                        value=geography,
                        source="profile",
                        in_url=True,
                    ),
                    SearchParam(
                        key="operation",
                        label="Operación",
                        value="venta",
                        source="constant",
                        in_url=True,
                    ),
                ),
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # Reset before this scope's own sweep — a scope that raises partway
        # through must not leave a prior scope's records/prices behind.
        self._search_records = {}
        self._last_discovery_prices = {}

        # Issue #478 P5 (D-101): an owner-pinned URL is this profile's recall
        # source — hit it verbatim as the entry page, skipping the derived slug
        # entirely (geography left None: it plays no part, but the log/404
        # branches below tolerate it). Without an override the code path is
        # byte-identical to before.
        override_url = scope.override_url if self.supports_search_override else None
        if override_url:
            geography = None
            url = override_url
        else:
            geography = _resolve_geography(scope)
            if geography is None:
                # Reachable only if discover() is invoked directly, bypassing
                # scope_key()'s gate (a test, or a future caller) — normally
                # scope_key() already returned None and the orchestrator skipped
                # this scope. Now that the slug is derived mechanically from any
                # resolved municipality (issue #369), None here means only "no
                # center and no geography string to resolve at all".
                raise ConnectorError(
                    "pisos discover: scope has neither a resolvable center nor an "
                    "explicit geography string — nothing to discover, not "
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
            # Issue #369: an HTTP 404 means pisos.com has no search page for
            # this city — the city simply isn't on this portal (or the
            # derived slug isn't the one it uses). That is a CLEAN "uncovered"
            # outcome, not a connector failure: return [] so the run status
            # stays healthy instead of marking the whole profile 'failed' for
            # a geography this portal doesn't serve. Safe because
            # discovers_full_inventory=False, so an empty sweep never
            # auto-withdraws anything. Any other transport/HTTP error is a
            # genuine failure and still raises.
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status == 404:
                logger.info(
                    "pisos discover: %s returned HTTP 404 — pisos.com has no "
                    "search page for this city (geography=%s); treating as "
                    "uncovered (empty result), not a failure",
                    url,
                    geography,
                )
                return []
            raise ConnectorError(
                f"pisos discover: request failed for {url}: {exc}"
            ) from exc

        records = self._parse_search_page(response.text)
        if not records:
            # A real pisos.com search page ALWAYS carries ad-preview cards
            # (30 on the verified madrid page). Zero parsed cards on an HTTP
            # 200 means either the card markup changed or this is an
            # interstitial/block page — raise rather than return [], so an
            # empty result can never be misread by the orchestrator as "every
            # active listing just vanished" (the fail-loud discipline in
            # docs/skills/connectors.md).
            raise ConnectorError(
                f"pisos discover: parsed 0 listing cards from {url} — the "
                "'div.ad-preview' markup may have changed, or this is a "
                "block/interstitial page, not a real search-results page"
            )

        self._search_records = records
        self._last_discovery_prices = {
            ext: rec["price"] for ext, rec in records.items() if rec.get("price")
        }

        logger.info(
            "pisos discover: geography=%s found %d listings on page 1 "
            "(search-payload extraction; reference_code/contact_raw come "
            "from a per-listing detail fetch instead, see D-141; %d with "
            "a price)",
            geography,
            len(records),
            len(self._last_discovery_prices),
        )
        return sorted(records)

    def _parse_search_page(self, html: str) -> dict[str, dict[str, Any]]:
        """Parse ad-preview cards + per-card JSON-LD into records keyed by id.

        Pure (no I/O) so it is unit-testable against a saved fixture with no
        network. The card markup carries every field except coordinates; the
        JSON-LD block (keyed by the same `@id`) supplies geo + locality.
        """
        soup = BeautifulSoup(html, "html.parser")
        geo_by_id = _extract_ld_json_by_id(html)

        records: dict[str, dict[str, Any]] = {}
        for card in soup.select(_CARD_SELECTOR):
            external_id = card.get("id")
            if not external_id:
                continue
            href = card.get("data-lnk-href")
            url = f"{_BASE_URL}{href}" if href and href.startswith("/") else href

            price = None
            contact_box = card.select_one(".contact-box[data-ad-price]")
            if contact_box is not None:
                price = _to_decimal(contact_box.get("data-ad-price"))
            if price is None:
                price_el = card.select_one(".ad-preview__price")
                if price_el is not None:
                    digits = re.sub(r"[^\d]", "", price_el.get_text())
                    price = _to_decimal(digits) if digits else None

            chars = [
                c.get_text(" ", strip=True) for c in card.select(".ad-preview__char")
            ]
            rooms = None
            baths = None
            floor = None
            for c in chars:
                if rooms is None and _ROOMS_RE.search(c):
                    rooms = _to_int(_ROOMS_RE.search(c).group(1))
                if baths is None and _BATHS_RE.search(c):
                    baths = _to_int(_BATHS_RE.search(c).group(1))
                if floor is None and "planta" in c.lower():
                    floor = c
            m2 = _parse_m2(chars)

            title_el = card.select_one(".ad-preview__title")
            subtitle_el = card.select_one(".ad-preview__subtitle")
            desc_el = card.select_one(".ad-preview__description")
            photos = tuple(
                dict.fromkeys(
                    src
                    for img in card.select("img")
                    for src in (img.get("src"), img.get("data-src"))
                    if src and src.startswith("http")
                )
            )
            # A professional/agency card carries a logo block
            # (".ad-preview__inline--has-logo"); a card without one is
            # PLAUSIBLY a private seller, but that was not live-confirmed
            # against a labelled example during the spike, so listing_kind is
            # left None (not guessed) and the flag is kept in raw_extra for a
            # future verified pass. See docs/skills/connectors.md's
            # "don't fabricate precision" rule.
            has_logo = card.select_one(".ad-preview__inline--has-logo") is not None

            g = geo_by_id.get(external_id, {})
            geo = g.get("geo") or {}
            address = g.get("address") or {}

            records[external_id] = {
                "external_id": external_id,
                "url": url,
                "price": price,
                "rooms": rooms,
                "baths": baths,
                "m2": m2,
                "floor": _clean_text(floor),
                "title": _clean_text(title_el.get_text(" ", strip=True))
                if title_el
                else None,
                "subtitle": _clean_text(subtitle_el.get_text(" ", strip=True))
                if subtitle_el
                else None,
                "description": _clean_text(desc_el.get_text(" ", strip=True))
                if desc_el
                else None,
                "photos": photos,
                "lat": _to_decimal(geo.get("latitude")),
                "lon": _to_decimal(geo.get("longitude")),
                "locality": _clean_text(address.get("addressLocality")),
                "region": _clean_text(address.get("addressRegion")),
                "has_logo": has_logo,
            }
        return records

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        # Issue #628 (D-141): the per-listing record from discover()'s
        # search-page parse still supplies price/rooms/baths/m2/floor/
        # coordinates/photos with no extra request, but reference_code and
        # contact_raw (agency) are ONLY on the detail page (see module
        # docstring) -- so this now makes ONE real request per listing,
        # unlike the original search-payload-only design.
        record = self._search_records.get(external_id)
        if record is None:
            # The id was in a prior discover() but isn't in the current stash
            # -- it reordered/withdrew off page 1 between discovery and this
            # fetch. A clean skip (issue #291), not a run error.
            raise ListingUnavailableError(
                f"pisos fetch_detail: external_id={external_id} not present in "
                "the last discover() payload -- reordered/withdrawn off page 1 "
                "between discovery and fetch"
            )
        url = record.get("url")
        reference_code: str | None = None
        agency_name: str | None = None
        if url:
            throttle()
            try:
                response = requests.get(
                    url,
                    headers={"User-Agent": _USER_AGENT},
                    timeout=_REQUEST_TIMEOUT_SECONDS,
                )
                response.raise_for_status()
            except requests.RequestException as exc:
                gone_status = getattr(
                    getattr(exc, "response", None), "status_code", None
                )
                if gone_status in LISTING_GONE_HTTP_STATUSES:
                    raise ListingUnavailableError(
                        f"pisos fetch_detail: external_id={external_id} returned "
                        f"HTTP {gone_status} -- listing removed at source between "
                        "discovery and fetch"
                    ) from exc
                # Opus review of #628/#629 (B5): any OTHER failure (a WAF
                # block, a timeout, a 5xx) must NOT be swallowed into a
                # quiet search-card-only success -- that reported as a
                # clean run (fetched += 1, breaker.record_success()) with
                # reference_code/contact_raw permanently None, defeating
                # D-047/D-069's whole point (a broken run must not read as
                # green). Raising ConnectorError here matches every other
                # connector's fetch_detail failure handling (e.g.
                # milanuncios.py) -- it counts as a run error and can trip
                # the circuit breaker like any other fetch failure.
                raise ConnectorError(
                    f"pisos fetch_detail: detail request failed for "
                    f"external_id={external_id}: {exc}"
                ) from exc
            reference_code = extract_reference_code(response.text)
            agency_name = extract_agency_name(response.text)
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={
                "url": url,
                "search_record": record,
                "reference_code": reference_code,
                "contact_raw": agency_name,
            },
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        record = raw.raw["search_record"]
        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=record.get("url"),
            listing_kind=None,  # No live-confirmed particular/agency signal
            # in the search card — see _parse_search_page's has_logo note.
            status="active",  # A search-result listing is one pisos.com is
            # actively showing — the only status this connector can honestly
            # assert. discovers_full_inventory=False means it never
            # auto-transitions to withdrawn from absence alone.
            current_price=record.get("price"),
            description=record.get("description"),
            photo_urls=record.get("photos") or (),
            contact_raw=raw.raw.get("contact_raw"),  # Issue #628 (D-141): from
            # the detail page's `owner-info__name` block, fetch_detail() above
            # — None if the detail request failed or the block was absent.
            address=record.get("subtitle"),
            lat=record.get("lat"),
            lon=record.get("lon"),
            property_type=map_property_type(record.get("url")),
            m2_built=record.get("m2"),
            m2_useful=None,  # pisos surfaces don't distinguish built vs useful.
            rooms=record.get("rooms"),
            bathrooms=record.get("baths"),
            floor=record.get("floor"),  # human-readable ("4ª planta").
            has_elevator=None,
            year_built=None,
            energy_rating=None,  # not in the search card.
            city=record.get("locality"),
            province=record.get("region"),
            postal_code=None,  # not in the search card (JSON-LD address has
            # no postalCode field on pisos.com).
            m2_plot=None,
            features=(),
            operation="sale",  # discover() only ever requests /venta/ URLs.
            reference_code=raw.raw.get("reference_code"),  # Issue #628
            # (D-141): from the detail page's "Referencia:" features block,
            # fetch_detail() above — the search card's own numeric id is the
            # ad id, not a seller reference, so it was never a substitute.
            raw_extra={
                "type_token_raw": (record.get("url") or "").split("/comprar/")[-1][:40]
                or None,
                "has_agency_logo": record.get("has_logo"),
                "title": record.get("title"),
            },
        )


def _extract_ld_json_by_id(html: str) -> dict[str, dict[str, Any]]:
    """Return the per-card JSON-LD objects keyed by their `@id` (== card id).

    pisos.com emits one `<script type="application/ld+json">` block per
    listing card, each a `SingleFamilyResidence` whose `@id` equals the
    card's `id` attribute — so the two are joined on that key. Best-effort:
    a malformed block is skipped, never fatal (coordinates are enrichment,
    not what makes a card usable — the card markup alone yields a valid
    listing minus lat/lon).
    """
    out: dict[str, dict[str, Any]] = {}
    for block in re.findall(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.DOTALL
    ):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if (
                isinstance(item, dict)
                and item.get("@type") == "SingleFamilyResidence"
                and item.get("@id")
            ):
                out[str(item["@id"])] = item
    return out
