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
string-extraction + json.loads gets structured data directly, no HTML
scraping/CSS-selector fragility involved.

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
_INITIAL_PROPS_MARKER = 'id="__initial_props__">'


def _extract_initial_props(html: str) -> dict[str, Any]:
    """Pull the server-rendered JSON blob out of a Fotocasa page.

    Not a regex over the whole tag (attribute order isn't guaranteed) —
    find the id marker, then take everything up to the next `</script>`.
    Raises ConnectorError if the page structure doesn't match what this
    connector expects, so a site redesign fails loudly (counted by the
    circuit breaker) instead of silently producing an empty/wrong listing.
    """
    import json

    start_marker_idx = html.find(_INITIAL_PROPS_MARKER)
    if start_marker_idx == -1:
        raise ConnectorError(
            "fotocasa: __initial_props__ script tag not found — page structure "
            "may have changed"
        )
    start = start_marker_idx + len(_INITIAL_PROPS_MARKER)
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


class FotocasaConnector(Connector):
    name = "fotocasa"
    # Conservative default — issue #1 §15's "good-neighbor crawling" applies
    # to a public commercial site the same as it does to the government
    # Catastro service. Nothing about Phase 1's proof-of-pipeline goal needs
    # to run fast.
    rate_limit_per_minute = 20

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        geography = scope.geography or "madrid-capital"
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
            floor=(
                str(features.get("floor"))
                if features.get("floor") is not None
                else None
            ),
            has_elevator=None,  # not present in `features` on the sampled
            # listing; Fotocasa exposes amenities as a separate features
            # list on some listings — not implemented in this first pass,
            # tracked in raw_extra for now.
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
            },
        )
