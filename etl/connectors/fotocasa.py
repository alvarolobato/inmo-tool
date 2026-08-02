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

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)
from etl.connectors.fotocasa_mapping import infer_listing_kind, map_property_type

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

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        geography = scope.geography or "madrid-capital"
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
            raw={"url": response.url, "props": props},
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

        address_parts = [
            address_block.get("upperLevel"),
            address_block.get("district"),
            address_block.get("municipality") or address_block.get("city"),
        ]
        address = ", ".join(p.strip() for p in address_parts if p and p.strip()) or None

        photo_urls = tuple(
            item["src"]
            for item in multimedia
            if isinstance(item, dict) and item.get("src")
        )

        client_name = real_estate.get("clientName") or real_estate.get("clientAlias")
        client_url = real_estate.get("clientUrl")

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(client_url, client_name),
            status="active",
            current_price=_to_decimal(real_estate.get("price")),
            description=(
                descriptions.get("es-ES") or next(iter(descriptions.values()), None)
            ),
            photo_urls=photo_urls,
            contact_raw=client_name,
            address=address,
            lat=_to_decimal(coords.get("latitude")),
            lon=_to_decimal(coords.get("longitude")),
            property_type=map_property_type(real_estate.get("buildingType")),
            m2_built=_to_decimal(features.get("surface")),
            m2_useful=None,  # Fotocasa's `features.surface` doesn't distinguish
            # built vs. useful area in the fields observed during the
            # feasibility spike — revisit if a sampled listing shows both.
            rooms=_to_int(features.get("rooms")),
            bathrooms=_to_int(features.get("bathrooms")),
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
