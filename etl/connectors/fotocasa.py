"""Fotocasa connector — the first real implementation of the Connector contract.

Chosen over the originally-planned default (Idealista) after a feasibility
spike (see PR description / issue #12 EC-0): Idealista returns an immediate
HTTP 403 DataDome CAPTCHA challenge to every request regardless of
User-Agent, before any content loads — not a robots.txt restriction, a hard
bot-detection wall. Bypassing that would mean CAPTCHA-solving or a
JS-executing headless browser, both explicitly out of scope per issue #1
§15 (this is a personal tool, not a scraping operation). Fotocasa's
robots.txt allows single-filter search and listing-detail pages for a
generic user agent, and a live test confirmed normal HTTP 200 responses
with full server-rendered content — no JS execution needed.

Data source: Fotocasa server-renders a JSON blob into every page in
`<script type="application/json" id="__initial_props__">` — plain HTML
string-extraction + json.loads gets structured data directly, no
CSS-selector fragility, for fetch_detail()/normalize(). discover() is the
exception: it still extracts listing hrefs via regex over raw HTML rather
than parsing the search page's own __initial_props__ blob, since the ids
needed are readily available as plain anchor hrefs — a reasonable
follow-up for task 2.1 to reconsider once a second connector's discover()
is being built, not a design principle this connector fully achieves today.

robots.txt constraint that shapes discover(): pagination paths
(`/*/l/2*` through `/*/l/39*`) are disallowed, and bare `/madrid/`,
`/barcelona/`, `/valencia/` path segments are disallowed (hyphenated slugs
like `madrid-capital` are fine — no literal `/madrid/` substring). This
connector therefore only fetches page 1 of search results; it does not
paginate. That caps `discover()` at whatever fits on one results page
(observed: listings are lazy-loaded via a separate API in the full site,
but the initial server-rendered HTML embeds a first batch) — acceptable
for Phase 1's job of proving the pipeline works end-to-end, not a
production-scale crawl.
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import requests
from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)
from etl.connectors.extraction import (
    first_present,
    strip_price_punctuation,
    text_to_int,
)
from etl.connectors.fotocasa_mapping import infer_listing_kind, map_property_type
from etl.connectors.geography import nearest_city

logger = logging.getLogger("etl.connectors.fotocasa")

_USER_AGENT = "Mozilla/5.0 (compatible; inmo-tool/0.1; +https://github.com/alvarolobato/inmo-tool)"
_BASE_URL = "https://www.fotocasa.es"
_REQUEST_TIMEOUT_SECONDS = 15

# .../vivienda/<geography-slug>/<feature-slug>/<external_id>/d
_DETAIL_HREF_RE = re.compile(r'"(/es/comprar/vivienda/[a-z0-9-]+/[a-z0-9-]+/(\d+)/d)"')
_INITIAL_PROPS_MARKER = 'id="__initial_props__"'

# robots.txt disallows the literal path substring "/madrid/", "/barcelona/",
# "/valencia/" (bare city name as its own path segment) — not the hyphenated
# slugs (e.g. "madrid-capital") this connector actually uses. See discover().
_ROBOTS_DISALLOWED_BARE_GEOGRAPHIES = frozenset({"madrid", "barcelona", "valencia"})

# City name (etl.connectors.geography.CITY_CENTROIDS keys) -> this site's own
# URL slug. Live-verified during issue #71 (real HTTP 200 + real
# __initial_props__ listing data, not just a non-error status) for every
# entry here. Extend alongside etl.connectors.geography.CITY_CENTROIDS when
# a profile's geography resolves to a city not yet listed.
_CITY_SLUGS: dict[str, str] = {
    "madrid": "madrid-capital",
    "sevilla": "sevilla-capital",
    "barcelona": "barcelona-capital",
    "valencia": "valencia-capital",
}


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's URL slug, or None if it can't be.

    `scope.geography` (a free-text escape hatch, see ConnectorScope's
    docstring) wins when set, for tests/manual construction. Otherwise
    resolve `scope.center` to the nearest known city and look up its
    Fotocasa slug. No hardcoded default (issue #71) — a scope this connector
    can't resolve means "nothing to discover for this scope", not "assume
    Madrid".
    """
    if scope.geography:
        return scope.geography
    if scope.center is None:
        return None
    city = nearest_city(scope.center, scope.radius_km)
    if city is None:
        return None
    return _CITY_SLUGS.get(city)


def _extract_initial_props(html: str) -> dict[str, Any]:
    """Pull the server-rendered JSON blob out of a Fotocasa page.

    Not a regex over the whole tag: real pages have been observed with
    `type="application/json" id="__initial_props__"` (type before id), so
    this only assumes `id="__initial_props__"` appears somewhere in the
    opening `<script ...>` tag, then finds the tag's closing `>` after that
    (handling any attributes before or after `id=...`, in either order),
    then takes everything up to the next `</script>`. Raises ConnectorError
    if the page structure doesn't match what this connector expects, so a
    site redesign — or a soft-block/interruption page lacking this tag
    entirely — fails loudly (counted by the circuit breaker) instead of
    silently producing an empty/wrong listing.
    """
    import json

    marker_idx = html.find(_INITIAL_PROPS_MARKER)
    if marker_idx == -1:
        raise ConnectorError(
            "fotocasa: __initial_props__ script tag not found — page structure "
            "may have changed, or this is a soft-block/interruption page"
        )
    tag_close_idx = html.find(">", marker_idx)
    if tag_close_idx == -1:
        raise ConnectorError("fotocasa: unterminated __initial_props__ script tag")
    start = tag_close_idx + 1
    end = html.find("</script>", start)
    if end == -1:
        raise ConnectorError("fotocasa: unterminated __initial_props__ script tag")
    try:
        return json.loads(html[start:end])
    except json.JSONDecodeError as exc:
        raise ConnectorError(
            f"fotocasa: __initial_props__ is not valid JSON: {exc}"
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


def _features_list_value(features_list: list[Any], label: str) -> Any:
    """Look up a value by label in Fotocasa's `featuresList` array.

    `realEstate.features` (a flat dict) has coded/enum values that don't
    map cleanly to canonical fields — e.g. `features.floor` is an integer
    code, not a literal storey (a real listing had `features.floor == 7`
    while its own human-readable label read "2ª planta"). `featuresList`
    (a list of `{label, literal, value}` dicts) carries the human-readable
    value instead — confirmed live during PR #49 review. Prefer this over
    `features` for anything where a coded value would misrepresent
    precision the site doesn't actually have.
    """
    for item in features_list:
        if isinstance(item, dict) and item.get("label") == label:
            return item.get("value")
    return None


def _to_has_elevator(elevator_value: Any) -> bool | None:
    if elevator_value == "YES":
        return True
    if elevator_value == "NO":
        return False
    return None


# CSS-selector fallback chain for the four fields property_web_scraper's
# es_fotocasa.json mapping flags as most likely to shift shape on a site
# redesign (count_bedrooms/count_bathrooms/constructed_area/price_float).
# Their own selectors (`.re-DetailHeader-rooms span span` etc., last
# checked by them 2026-02-20) no longer match anything on the live site as
# of this connector's own live spot-check (issue #77) — Fotocasa migrated
# to a Tailwind-utility-class design system with no semantic BEM classes.
# These selectors are freshly verified against real listings instead,
# anchored on SVG icon identifiers (`data-title="..."`) rather than layout
# classes, which should be materially more redesign-resistant since
# icon-name attributes tend to be tied to a component's *meaning*, not its
# current visual styling.
_STAT_NUMBER_RE = re.compile(r"\d[\d.,]*")


def _icon_stat_text(soup: BeautifulSoup, icon_title: str) -> str | None:
    """Find the numeric stat next to a named stat-row icon.

    Fotocasa renders each of rooms/bathrooms/surface/floor as
    `<li><svg data-title="{icon}">...</svg><span class="text-body-1">
    <span class="font-bold">{value}</span> {unit label}</span></li>` in a
    `<ul aria-label="Características principales">` block. Verified live
    (2026-08-02) against a real listing (id 189316512: rooms=2, bathrooms=2,
    surface=60, all matching the same listing's embedded-JSON values).

    Locates the right `<li>` via `data-title` (an icon-name attribute tied
    to the row's *meaning*, not its current visual styling) but then reads
    the number via a regex over the `<li>`'s own text rather than a
    `.font-bold` CSS class — depending on a specific Tailwind utility class
    surviving the next redesign would undercut the whole point of this
    fallback, which exists precisely because property_web_scraper's own
    class-based selectors already broke once (Opus review, PR #84).
    """
    svg = soup.select_one(f'svg[data-title="{icon_title}"]')
    if svg is None:
        return None
    li = svg.find_parent("li")
    if li is None:
        return None
    match = _STAT_NUMBER_RE.search(li.get_text())
    return match.group(0) if match else None


def _price_fallback_text(soup: BeautifulSoup) -> str | None:
    """The main price display: `<div aria-label="Precio del inmueble">
    <span>379.000 €</span></div>`. Verified live (2026-08-02) against the
    same listing referenced in `_icon_stat_text`'s docstring."""
    el = soup.select_one('div[aria-label="Precio del inmueble"] span')
    if el is None:
        return None
    return el.get_text(strip=True)


_REFERENCE_FALLBACK_RE = re.compile(r"Referencia:\s*(\S+)")


def _reference_fallback_text(soup: BeautifulSoup) -> str | None:
    """The agent-contact reference line: `<ul
    class="re-FormContactDetail-referenceAlias"><li>Referencia: NS603</li>
    </ul>`. Verified live (2026-08-02) against a real Sevilla listing
    (the same "NS603" example cited in issue #72) — matches
    `realEstate.reference` from the embedded JSON exactly. `re-*` is a
    semantic BEM-style class name Fotocasa uses for this component (not a
    Tailwind utility class like the ones that broke property_web_scraper's
    selectors), so it's a reasonable fallback anchor on its own, but the
    regex over the `<li>`'s text (rather than trusting the class survives
    forever) keeps this consistent with `_icon_stat_text`'s more defensive
    approach."""
    el = soup.select_one(".re-FormContactDetail-referenceAlias li")
    if el is None:
        return None
    match = _REFERENCE_FALLBACK_RE.search(el.get_text())
    return match.group(1) if match else None


class FotocasaConnector(Connector):
    name = "fotocasa"
    # Conservative default — issue #1 §15's "good-neighbor crawling" applies
    # to a public commercial site the same as it does to the government
    # Catastro service. Nothing about Phase 1's proof-of-pipeline goal needs
    # to run fast.
    rate_limit_per_minute = 20
    # False: discover() only ever sees page 1 of search results (robots.txt
    # disallows pagination — see the module docstring), and a live check
    # during the Phase 1 phase-level review found madrid-capital alone has
    # 11,361 listings sorted by relevance (not a stable date order), with
    # only ~30 returned per sweep — under 0.3% coverage. An active listing
    # scoring off page 1 between sweeps is a real, likely occurrence, not
    # an edge case, so 3 consecutive "misses" from this connector proves
    # nothing about whether a listing is actually still active. See
    # Connector.discovers_full_inventory's docstring for what this
    # disables (the orchestrator's withdrawal auto-transition).
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Delegate to `_resolve_geography` — the actual slug this scope
        resolves to (or None if unresolvable) IS the right dedup/coverage
        key: two scopes resolving to the same slug hit the identical URL."""
        return _resolve_geography(scope)

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        geography = _resolve_geography(scope)
        if geography is None:
            raise ConnectorError(
                "fotocasa discover: scope has neither a resolvable center "
                "(nearest known city too far away) nor an explicit geography "
                "string — nothing to discover, not defaulting to a hardcoded "
                "city (see issue #71)"
            )
        if geography in _ROBOTS_DISALLOWED_BARE_GEOGRAPHIES:
            # robots.txt disallows the literal substring "/madrid/" (and
            # "/barcelona/", "/valencia/") as a path segment — but NOT
            # hyphenated slugs like "madrid-capital" (no "/madrid/"
            # substring in "/madrid-capital/"). Only the exact bare names
            # are blocked; this isn't a general robots.txt parser, just a
            # guard against the specific disallowed values this connector
            # could otherwise be told to fetch.
            raise ConnectorError(
                f"fotocasa discover: geography={geography!r} is disallowed by "
                f"robots.txt (bare city-name path) — use a hyphenated slug "
                f"like '{geography}-capital' instead"
            )
        url = f"{_BASE_URL}/es/comprar/viviendas/{geography}/todas-las-zonas/l"
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
                f"fotocasa discover: request failed for {url}: {exc}"
            ) from exc

        if _INITIAL_PROPS_MARKER not in response.text:
            # A real search-results page always embeds __initial_props__
            # (fetch_detail relies on the same invariant). Its absence means
            # this is Fotocasa's own soft-block/interruption page (observed
            # live during PR #49 review: HTTP 200, no error status, just no
            # listing data) — NOT "zero listings for this geography". Raising
            # here, rather than returning an empty list, is what stops an
            # empty discover() result from being misread by
            # _reconcile_missed_discoveries as "every active listing just
            # vanished" (see orchestrator.py — a discover() failure here
            # short-circuits before reconciliation ever runs).
            raise ConnectorError(
                "fotocasa discover: response has no __initial_props__ — likely "
                "a soft-block/interruption page, not a real search results page"
            )

        external_ids = sorted(
            {m.group(2) for m in _DETAIL_HREF_RE.finditer(response.text)}
        )
        logger.info(
            "fotocasa discover: geography=%s found %d external_ids on page 1",
            geography,
            len(external_ids),
        )
        return external_ids

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        # The exact URL slug (geography/feature text) doesn't matter to
        # Fotocasa's routing — only the trailing numeric id does — so a
        # generic placeholder slug resolves to the same listing discover()
        # found, without needing to remember each listing's original slug.
        url = f"{_BASE_URL}/es/comprar/vivienda/x/x/{external_id}/d"
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
                f"fotocasa fetch_detail: request failed for external_id={external_id}: {exc}"
            ) from exc

        props = _extract_initial_props(response.text)
        return RawListing(
            external_id=external_id,
            source=self.name,
            # `html` is only parsed (BeautifulSoup) in normalize() if a
            # JSON-path field actually comes back empty — the fallback
            # chain's whole point is to not pay HTML-parsing cost on the
            # happy path where the embedded JSON has everything.
            raw={"url": response.url, "props": props, "html": response.text},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        props = raw.raw["props"]
        real_estate = props.get("realEstate") or {}
        features = real_estate.get("features") or {}
        features_list = real_estate.get("featuresList") or []
        address_block = real_estate.get("address") or {}
        coords = real_estate.get("coordinates") or {}
        descriptions = real_estate.get("descriptions") or {}
        multimedia = real_estate.get("multimedia") or []

        # BeautifulSoup only gets built if a JSON-path field actually comes
        # back empty (see fetch_detail's comment) — a plain mutable cell
        # rather than functools.cache since this is a one-shot per-call
        # helper, not something worth the decorator machinery for.
        _soup_cache: list[BeautifulSoup | None] = [None]

        def soup() -> BeautifulSoup:
            if _soup_cache[0] is None:
                _soup_cache[0] = BeautifulSoup(raw.raw.get("html", ""), "html.parser")
            return _soup_cache[0]

        address_parts = [
            address_block.get("upperLevel"),
            address_block.get("district"),
            address_block.get("municipality") or address_block.get("city"),
        ]
        address = ", ".join(p.strip() for p in address_parts if p and p.strip()) or None

        # multimedia mixes real photos with other asset types — a live
        # listing showed {"type": "tour-virtual", "src": "https://floorfy.com/..."}
        # alongside {"type": "image", ...} entries. Without this filter the
        # virtual-tour link lands in photo_urls, renders as a broken <img> on
        # the property detail page, and gets fed to the photo-hash dedup
        # signal, which fails to decode it (Fable phase-2 review).
        photo_urls = tuple(
            item["src"]
            for item in multimedia
            if isinstance(item, dict)
            and item.get("type") == "image"
            and item.get("src")
        )

        client_name = real_estate.get("clientName") or real_estate.get("clientAlias")
        client_url = real_estate.get("clientUrl")

        # Fallback chain (issue #77): embedded JSON is the primary strategy
        # for all four fields; a live CSS fallback (icon-anchored, see
        # _icon_stat_text/_price_fallback_text) recovers the value if the
        # JSON path is ever renamed/restructured. HTML is only parsed if
        # the JSON side comes back empty.
        rooms = first_present(
            lambda: _to_int(features.get("rooms")),
            lambda: text_to_int(_icon_stat_text(soup(), "double_bed")),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: _to_int(features.get("bathrooms")),
            lambda: text_to_int(_icon_stat_text(soup(), "bathroom_tub")),
            field="bathrooms",
        )
        # Seller/agency reference code (issue #72), e.g. "Referencia: NS603" —
        # a dedup signal (etl/dedup/signals/reference_code.py), not a unique
        # key: two different agencies can coincidentally use the same code.
        reference_code = first_present(
            lambda: (real_estate.get("reference") or "").strip() or None,
            lambda: _reference_fallback_text(soup()),
            field="reference_code",
        )
        m2_built = first_present(
            lambda: _to_decimal(features.get("surface")),
            lambda: _to_decimal(
                text_to_int(_icon_stat_text(soup(), "dimensions_block"))
            ),
            field="m2_built",
        )
        current_price = first_present(
            lambda: _to_decimal(real_estate.get("price")),
            lambda: _to_decimal(strip_price_punctuation(_price_fallback_text(soup()))),
            field="current_price",
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(
                client_url, client_name, real_estate.get("clientId")
            ),
            status="active",
            current_price=current_price,
            description=(
                descriptions.get("es-ES") or next(iter(descriptions.values()), None)
            ),
            photo_urls=photo_urls,
            contact_raw=client_name,
            reference_code=reference_code,
            address=address,
            lat=_to_decimal(coords.get("latitude")),
            lon=_to_decimal(coords.get("longitude")),
            property_type=map_property_type(real_estate.get("buildingType")),
            m2_built=m2_built,
            m2_useful=None,  # Fotocasa's `features.surface` doesn't distinguish
            # built vs. useful area in the fields observed during the
            # feasibility spike — revisit if a sampled listing shows both.
            rooms=rooms,
            bathrooms=bathrooms,
            floor=_features_list_value(features_list, "floor"),  # human-readable
            # (e.g. "2ª planta"), not `features.floor`'s integer code — see
            # _features_list_value's docstring for why the coded value would
            # be fabricated precision (verified live during PR #49 review:
            # a real listing had features.floor=7 but featuresList said
            # "2ª planta").
            has_elevator=_to_has_elevator(
                _features_list_value(features_list, "elevator")
            ),
            year_built=None,  # `features.antiquity` is a coded bucket
            # (e.g. "more than N years"), not a literal year — mapping it
            # to `year_built` would fabricate false precision. Kept raw.
            energy_rating=real_estate.get("energyCertificate"),
            # Schema superset vs. property_web_scraper (issue #76/#77): this
            # connector already parsed these into address/raw_extra and
            # discarded the structure — promoted to real columns here.
            city=(address_block.get("city") or "").strip() or None,
            province=(address_block.get("province") or "").strip() or None,
            postal_code=(address_block.get("zipCode") or "").strip() or None,
            # `0` from `features.surfaceLand` means "not a plot-having
            # property type" / unknown, not "a plot of zero square meters" —
            # treated as absent so it doesn't get COALESCE-persisted as a
            # real measurement on every revisit (Opus review, PR #84).
            m2_plot=_to_decimal(features.get("surfaceLand")) or None,
            # `features` (TEXT[] amenity slugs, e.g. terraza/trastero) is
            # deliberately left empty here — issue #77's acceptance
            # criteria only requires city/province/postal_code/m2_plot;
            # this connector's detail JSON (`realEstate.features`) doesn't
            # carry the same boolean-amenity shape property_web_scraper's
            # mapping assumes, and mapping it correctly needs its own
            # investigation (left for a follow-up, not silently invented
            # here from an unverified guess).
            operation="sale",  # This connector's discover() only ever
            # requests Fotocasa's /comprar/ (buy) search URLs, and no
            # transaction-type key was found in `realEstate`'s embedded
            # JSON during this connector's feasibility spike to derive this
            # from real data instead. Caveat (Opus review, PR #84):
            # fetch_detail()'s own URL is a placeholder slug that Fotocasa's
            # routing ignores except for the trailing id — so this rests on
            # discover() never having handed this connector a rental
            # listing's id, not on anything fetch_detail() itself can
            # verify per-listing. Revisit if a rental-aware discover() or a
            # real operation-indicating JSON key is ever found.
            raw_extra={
                "clientTypeId": real_estate.get("clientTypeId"),
                "clientId": real_estate.get("clientId"),
                "buildingType_raw": real_estate.get("buildingType"),
                "buildingSubtype_raw": real_estate.get("buildingSubtype"),
                "conservationState": features.get("conservationState"),
                "antiquity": features.get("antiquity"),
                "surfaceLand": features.get("surfaceLand"),
                "zipCode": address_block.get("zipCode"),
                "floor_code_raw": features.get("floor"),
            },
        )
