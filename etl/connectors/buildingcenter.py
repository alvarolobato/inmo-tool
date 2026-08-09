"""BuildingCenter connector (issue #118) — CaixaBank's REO subsidiary.

Feasibility spike (2026-08-04, live), per docs/skills/connectors.md and the
step-0-through-5 order #132 asked every remaining #118-batch spike to
follow after #123 Aliseda (D-019) and #126 Haya (D-021) both died before
any code got written:

0. **Does the domain still serve its own site?** Yes — `buildingcenter.es`
   resolves, HTTP 200, own domain, zero redirects. Unlike Haya, there is a
   real site here.
1. **Byte-diff two detail pages.** `www.buildingcenter.es/` and
   `/sitemap.xml` and `/es/compra/viviendas/sevilla` and
   `/es/compra/viviendas/malaga` are all byte-for-byte identical (MD5
   `7e70eab507c3b6f8ed70f77f767c2f7a`, 18,517 bytes each) — a bare
   client-rendered Angular "Public Store" shell, exactly the shape that
   sank Aliseda (D-019). The original #118/#132 spike's own "results pages
   look client-side-rendered" flag was correct.
2. **Find the real data host and check ITS robots.txt.** The shell's own
   `<meta name="occ-backend-base-url" content="https://apifrontend.
   buildingcenter.es">` names it directly — no runtime JS execution
   needed, this is a static meta tag already present in the fetched HTML.
   `apifrontend.buildingcenter.es/robots.txt` is a plain HTTP 404 (real
   Tomcat "Not Found" page, not a WAF interstitial) — no file published at
   all, which is a different, more permissive shape than Aliseda's
   `laravel.` host (`User-agent: * / Disallow: /`, D-019's decisive
   blocker). Nothing is declared off-limits here.
3. **Overlap sample before building.** A 5-listing live sample of Solvia's
   own Sevilla search results, cross-checked against BuildingCenter's
   Sevilla-province catalogue: 1 exact match (street "Doctor Barraquer" /
   "Dr. Barraquer", municipality Los Palacios y Villafranca, price
   90.815 € to the euro on both sides, 3 bedrooms both sides — BuildingCenter
   code `60540896`, Solvia id `182624-221244`). So BuildingCenter is
   **not** a 100%-redundant relabel of Solvia the way Haya turned out to be
   (D-021) — genuine partial overlap, genuine additive stock alongside it.
4. **Sitemap/partition.** `www.buildingcenter.es/sitemap.xml` is itself
   just the same Angular shell (not real XML) — there is no usable
   sitemap. Instead, `GET apifrontend.buildingcenter.es/rest/v2/
   publicPortal/products/search` (reverse-engineered by reading the
   shell's own statically-served, robots.txt-`Allow: /.js`'d bundle,
   `main-*.js` — a plain HTTP fetch of a JS file the site already declares
   crawlable, not runtime execution of it) returns the **entire national
   catalogue**, paginated by `currentPage`/`pageSize` only — every other
   parameter tried (`query`, `q`, `channel`, `provinceCode`) had zero
   effect on the result set. A full sweep (22 pages of 100 + an 8-item
   last page) returned exactly 2,108 unique product codes with zero
   duplicates and zero gaps, matching the server's own
   `pagination.totalResults` precisely — see `buildingcenter_mapping`'s
   module docstring for the full endpoint reverse-engineering writeup.
5. **Rate measured, not copied.** The full 22-page sweep plus ~20
   additional exploratory requests during the spike ran at roughly one
   request per 3 seconds (20/min) with zero errors, zero soft-blocks, and
   fast (~0.2-0.4s) responses throughout — this connector's
   `rate_limit_per_minute` mirrors that measured, successful pace (and
   Solvia's own single-servicer-courtesy default) rather than the
   framework's 30/min default. No attempt was made to find a faster
   ceiling (issue #1 §15's good-neighbour stance).

Andalucía volume (national catalogue, category 101 "Viviendas" only, live
2026-08-04): **759 nationally**, of which Sevilla province (postal prefix
`41`) has **53** and Málaga province (postal prefix `29`) has **5**. The
original #118/#132 spike's "Málaga plausibly comparable-or-better [than
Sevilla]" guess does not hold up against a real, complete count — Málaga is
a fraction of Sevilla's volume here, not comparable. Sevilla's 53 is close
to (not identical to — different query scope) the original spike's
Google-cache-sourced "57" figure, which corroborates rather than
contradicts this sweep.

`discovers_full_inventory = True` on positive evidence, not the class
default: this connector pages through the *entire* published national
catalogue on every `discover()` call (filtering to category + scope
in-memory afterwards, not asking the site for a subset it might silently
truncate), and the full sweep's product count matched the server's own
declared total exactly. Contrast Fotocasa (page-1-of-relevance-sorted-many
only, `False`) and Solvia (20-per-geography cap, `False`) — this
connector's coverage is structurally different from both.

`cadastral_ref` is honestly left unset — see `buildingcenter_mapping`'s
module docstring for why the one registry-style field this API does
expose (`idufir`) is a different Spanish identifier, captured in
`raw_extra` instead of misrepresented as a cadastral reference.
"""

from __future__ import annotations

import logging
import math
import unicodedata
from decimal import Decimal
from typing import Any

import requests

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    SearchParam,
    SearchPreview,
    Throttle,
)
from etl.connectors.buildingcenter_mapping import (
    CATEGORY_VIVIENDAS,
    extract_bathrooms,
    extract_bedrooms,
    extract_description,
    extract_energy_rating,
    extract_features,
    extract_full_address,
    extract_m2_built,
    extract_operation,
    extract_photo_urls,
    extract_postal_code,
    extract_price,
    extract_property_type,
    extract_province,
    extract_public_url,
    extract_reference_code,
    extract_status,
    parse_coordinate,
    raw_extra,
)
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)

logger = logging.getLogger(__name__)

_API_BASE_URL = "https://apifrontend.buildingcenter.es"
_SEARCH_URL = f"{_API_BASE_URL}/rest/v2/publicPortal/products/search"
_DETAIL_URL_TEMPLATE = f"{_API_BASE_URL}/rest/v2/publicPortal/public/products/{{code}}"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research; "
    "contact: github.com/alvarolobato/inmo-tool)"
)

# Requested search-scope fields: only what discover()'s category/geography
# filter and discovered_prices() need. Deliberately not "FULL" here (that's
# a much larger per-product payload; fine for a single fetch_detail() call,
# wasteful times ~2,100 products every discover() sweep).
_SEARCH_FIELDS = (
    "pagination(DEFAULT),products(code,address,categories,latitude,"
    "longitude,population,price(FULL),commercializedForSale,"
    "commercializedForRent)"
)
_SEARCH_PAGE_SIZE = 100
# Safety cap on pagination loops — well above the ~22 pages a 2,108-item
# catalogue needs at pageSize=100, guarding only against an API regression
# that stops reporting totalPages correctly and would otherwise loop
# forever.
_MAX_SEARCH_PAGES = 100

# No profile-carried radius (ConnectorScope.radius_km is None/0) falls back
# to this — a "same metro area" default. Not a live-verified fact the way
# the rest of this module's constants are; a reasoned default for the
# first connector in this project with real per-listing coordinates to
# filter by; documented as a design choice, not measured.
_DEFAULT_RADIUS_KM = 15.0


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in km. Deliberately a small local copy rather
    than importing etl.connectors.geography's own `_haversine_km` — that
    name is module-private there, and this connector's use (exact
    per-listing distance filtering against a profile's own scope.center)
    is different from that module's job (snapping a point to the nearest
    *named* gazetteer place)."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _normalize_text(value: str) -> str:
    """Case- and accent-insensitive comparison key.

    `scope.geography` free-text values elsewhere in this codebase are
    plain ASCII (`_CITY_SLUGS` tables use "malaga", not "Málaga"), but
    BuildingCenter's own `population` field and this module's
    `_PROVINCE_BY_POSTAL_PREFIX` table are properly accented Spanish
    ("MÁLAGA", "Málaga"). Without normalizing both sides, a real,
    correctly-spelled geography filter would silently match nothing —
    stripping combining marks (NFKD decompose, drop the combining
    characters) rather than a hand-maintained substitution table handles
    every accented Spanish letter this data uses.
    """
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def _has_category(product: dict[str, Any], code: str) -> bool:
    categories = product.get("categories")
    if not isinstance(categories, list):
        return False
    return any(isinstance(c, dict) and str(c.get("code")) == code for c in categories)


def _resolve_geography_filter(
    scope: ConnectorScope,
) -> tuple[str, str] | tuple[str, tuple[tuple[float, float], float]] | None:
    """What discover() should match products against.

    Returns `("text", needle)` for the free-text `scope.geography` escape
    hatch (matched against each product's `population`/derived province,
    case-insensitively) or `("radius", (center, radius_km))` for a real
    point-based profile scope. `None` means no coverage at all (neither a
    geography string nor a center) — mirrors every other connector's
    `scope_key()`/`discover()` contract in base.py.

    Can raise `UnresolvableGeographyError` when `scope.center` is set but
    resolves to nowhere in the gazetteer at all — this is used only as a
    validity gate here (is this scope even asking about somewhere in
    Spain?), not for the actual filter, since this connector's own
    per-listing coordinates give a more precise distance than snapping to
    a municipality centroid would. Must be allowed to propagate out of
    `discover()` uncaught, same as every other connector using
    `resolve_place` (see geography.py's `UnresolvableGeographyError`
    docstring).
    """
    if scope.geography:
        return ("text", _normalize_text(scope.geography.strip()))
    if scope.center is None:
        return None
    resolve_place(scope)  # validity gate only; raises if truly unresolvable
    radius = (
        scope.radius_km
        if (scope.radius_km and scope.radius_km > 0)
        else _DEFAULT_RADIUS_KM
    )
    return ("radius", (scope.center, radius))


def _product_matches(
    product: dict[str, Any],
    geography_filter: tuple[str, Any],
) -> bool:
    kind, value = geography_filter
    if kind == "text":
        needle: str = value
        population = _normalize_text(str(product.get("population") or ""))
        province = _normalize_text(
            extract_province(extract_postal_code(product.get("address"))) or ""
        )
        return needle in population or needle == province
    center, radius_km = value
    lat = parse_coordinate(product.get("latitude"))
    lon = parse_coordinate(product.get("longitude"))
    if lat is None or lon is None:
        return False
    return _haversine_km(center, (float(lat), float(lon))) <= radius_km


class BuildingCenterConnector(Connector):
    """CaixaBank's REO subsidiary. JSON REST API, national-sweep discovery."""

    name = "buildingcenter"

    # Measured, not copied — see module docstring's step 5. Mirrors
    # Solvia's/Vivantial's single-servicer-courtesy default rather than
    # the framework's 30/min.
    rate_limit_per_minute = 20

    # See module docstring: a full-catalogue sweep, filtered in-memory,
    # confirmed (not assumed) to match the server's own declared total
    # exactly, with zero duplicates and zero gaps.
    discovers_full_inventory = True

    supports_discovery = True

    def __init__(self) -> None:
        # code -> price, populated by discover() so discovered_prices()
        # doesn't need a second request (issue #143).
        self._discovered_prices: dict[str, Decimal] = {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Must never raise — see base.py's contract. Delegates the real
        resolution work to `_resolve_geography_filter`/`resolve_place`,
        catching `UnresolvableGeographyError` into the shared sentinel key
        (`geography.unresolvable_scope_key`) so the orchestrator still
        calls `discover()` and records a real failure, rather than
        silently treating an unresolvable center as "no coverage"."""
        if scope.geography:
            return f"geography:{_normalize_text(scope.geography.strip())}"
        if scope.center is None:
            return None
        try:
            resolve_place(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        radius = (
            scope.radius_km
            if (scope.radius_km and scope.radius_km > 0)
            else _DEFAULT_RADIUS_KM
        )
        return f"radius:{scope.center}:{radius}"

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Non-tunable: discover() POSTs to the catalogue search API and
        filters the full catalogue in memory, so there is no per-profile GET
        URL to tune — the filtering is by data. `_SEARCH_URL` is the API
        endpoint discover() calls."""
        # Issue #496: surface the params that actually govern recall — the same
        # ones `_resolve_geography_filter()` (discover()'s own helper) computes,
        # so the chips can't drift. The catalogue is fetched whole and filtered
        # in memory (the server ignores filter params — the connector's own
        # finding), by radius around a centre OR by a text needle.
        try:
            resolved = _resolve_geography_filter(scope)
        except UnresolvableGeographyError:
            resolved = None
        params: list[SearchParam] = [
            SearchParam(
                key="categoria",
                label="Categoría",
                value="Viviendas",
                source="constant",
                in_url=False,
            ),
        ]
        if resolved is not None and resolved[0] == "radius":
            center, radius = resolved[1]
            radius_from_profile = bool(scope.radius_km and scope.radius_km > 0)
            params.append(
                SearchParam(
                    key="centro",
                    label="Centro",
                    value=f"{center[0]:.5f}, {center[1]:.5f}",
                    source="profile",
                    in_url=False,
                    notes="Se filtra en memoria por distancia haversine a este centro.",
                )
            )
            params.append(
                SearchParam(
                    key="radio_km",
                    label="Radio",
                    value=f"{radius:g} km",
                    # Profile value when the profile sets a positive radius;
                    # otherwise the connector's baked-in default.
                    source="profile" if radius_from_profile else "constant",
                    in_url=False,
                    notes=(
                        None
                        if radius_from_profile
                        else f"Radio por defecto del conector ({_DEFAULT_RADIUS_KM:g} km)."
                    ),
                )
            )
        elif resolved is not None and resolved[0] == "text":
            params.append(
                SearchParam(
                    key="texto",
                    label="Texto",
                    value=str(resolved[1]),
                    source="profile",
                    in_url=False,
                    notes="Se filtra en memoria por coincidencia de este texto.",
                )
            )
        return [
            SearchPreview(
                label="BuildingCenter — catálogo completo",
                url=_SEARCH_URL,
                kind="api",
                tunable=False,
                params=tuple(params),
                notes=(
                    "Catálogo completo vía API; el servidor ignora los filtros, "
                    "se filtra en memoria por radio (o texto) — no hay URL de "
                    "búsqueda afinable."
                ),
            )
        ]

    def discovered_prices(self) -> dict[str, Decimal]:
        """Live-verified real signal (buildingcenter_mapping.extract_price's
        docstring) — a search-list `price.value` matched its own
        independently-fetched detail `price.value` exactly on a sampled
        product. Populated by the most recent `discover()` call."""
        return dict(self._discovered_prices)

    def _get(
        self, url: str, throttle: Throttle, *, params: dict[str, Any] | None = None
    ) -> Any:
        throttle()
        try:
            response = requests.get(
                url,
                params=params,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise ConnectorError(
                f"buildingcenter: request failed for {url}: {exc}"
            ) from exc
        try:
            return response.json()
        except ValueError as exc:
            raise ConnectorError(
                f"buildingcenter: non-JSON response from {url} — the shell's "
                f"client-rendered page may have been served instead of the "
                f"API's JSON (site structure change?): {exc}"
            ) from exc

    def _fetch_all_products(self, throttle: Throttle) -> list[dict[str, Any]]:
        """Page through the entire published catalogue. See module
        docstring step 4 — no server-side filter parameter this connector
        tried had any effect, so the whole catalogue is fetched and
        filtered in-memory by discover()."""
        products: dict[str, dict[str, Any]] = {}
        page = 0
        total_pages: int | None = None
        while True:
            data = self._get(
                _SEARCH_URL,
                throttle,
                params={
                    "fields": _SEARCH_FIELDS,
                    "currentPage": page,
                    "pageSize": _SEARCH_PAGE_SIZE,
                },
            )
            pagination = data.get("pagination") if isinstance(data, dict) else None
            page_products = data.get("products") if isinstance(data, dict) else None
            if not isinstance(pagination, dict) or not isinstance(page_products, list):
                raise ConnectorError(
                    "buildingcenter discover: search response missing "
                    "'pagination'/'products' — API shape may have changed"
                )
            if page == 0 and pagination.get("totalResults", 0) == 0:
                # discovers_full_inventory=True means an empty result here
                # would mass-withdraw every known listing — the Fotocasa/
                # Vivantial guard against exactly this failure mode.
                raise ConnectorError(
                    "buildingcenter discover: search reports 0 total "
                    "results on page 0 — likely a structural/API change, "
                    "not a genuinely empty catalogue"
                )
            for product in page_products:
                if isinstance(product, dict) and product.get("code"):
                    products[str(product["code"])] = product
            total_pages = pagination.get("totalPages")
            page += 1
            if not page_products or total_pages is None or page >= total_pages:
                break
            if page >= _MAX_SEARCH_PAGES:
                logger.warning(
                    "buildingcenter discover: hit safety cap of %d pages "
                    "(totalPages=%s) — stopping early",
                    _MAX_SEARCH_PAGES,
                    total_pages,
                )
                break
        return list(products.values())

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # _resolve_geography_filter can raise UnresolvableGeographyError,
        # left to propagate uncaught (issue #169) — see fotocasa.py's
        # discover() for the full reasoning.
        geography_filter = _resolve_geography_filter(scope)
        if geography_filter is None:
            # Reachable only if discover() is invoked directly, bypassing
            # scope_key()'s gate — see fotocasa.py's discover() docstring.
            raise ConnectorError(
                "buildingcenter discover: scope has neither a resolvable "
                "center nor an explicit geography string — nothing to "
                "discover"
            )

        all_products = self._fetch_all_products(throttle)
        matched = [
            p
            for p in all_products
            if _has_category(p, CATEGORY_VIVIENDAS)
            and _product_matches(p, geography_filter)
        ]

        discovered_prices: dict[str, Decimal] = {}
        for product in matched:
            price = extract_price(product)
            if price is not None:
                discovered_prices[str(product["code"])] = price
        self._discovered_prices = discovered_prices

        external_ids = sorted({str(p["code"]) for p in matched})
        logger.info(
            "buildingcenter discover: scope=%s matched %d of %d "
            "national Viviendas listings (%d total catalogue products)",
            geography_filter,
            len(external_ids),
            sum(1 for p in all_products if _has_category(p, CATEGORY_VIVIENDAS)),
            len(all_products),
        )
        return external_ids

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = _DETAIL_URL_TEMPLATE.format(code=external_id)
        data = self._get(url, throttle, params={"fields": "FULL"})
        if not isinstance(data, dict) or str(data.get("code")) != str(external_id):
            raise ConnectorError(
                f"buildingcenter fetch_detail: unexpected response shape "
                f"for {external_id} — missing/mismatched 'code' (page "
                f"structure may have changed, or the listing no longer "
                f"exists)"
            )
        return RawListing(external_id=external_id, source=self.name, raw=data)

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        detail = raw.raw
        postal_code = extract_postal_code(detail.get("address"))

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=extract_public_url(detail, base_url="https://www.buildingcenter.es"),
            # CaixaBank's own REO subsidiary sells its own repossessed
            # stock directly (`society.name` is literally "Buildingcenter
            # S.A.U" on every sampled listing) — a principal seller, not a
            # broker acting for a private individual. Same reasoning as
            # Vivantial's 'agency' mapping.
            listing_kind="agency",
            status=extract_status(detail),
            current_price=extract_price(detail),
            description=extract_description(detail),
            photo_urls=extract_photo_urls(detail, base_url=_API_BASE_URL),
            contact_raw=None,
            address=extract_full_address(detail),
            lat=parse_coordinate(detail.get("latitude")),
            lon=parse_coordinate(detail.get("longitude")),
            property_type=extract_property_type(detail),
            m2_built=extract_m2_built(detail),
            m2_useful=None,
            rooms=extract_bedrooms(detail),
            bathrooms=extract_bathrooms(detail),
            floor=detail.get("floor") or None,
            has_elevator=None,
            year_built=None,
            energy_rating=extract_energy_rating(detail),
            city=(detail.get("population") or None),
            province=extract_province(postal_code),
            postal_code=postal_code,
            m2_plot=None,
            features=extract_features(detail),
            operation=extract_operation(detail),
            reference_code=extract_reference_code(detail),
            # No referenciaCatastral on the public detail endpoint — see
            # buildingcenter_mapping's module docstring for why idufir
            # (captured in raw_extra below) is not substituted here.
            cadastral_ref=None,
            raw_extra=raw_extra(detail),
        )
