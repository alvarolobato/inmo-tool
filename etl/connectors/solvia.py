"""Solvia connector (issue #116) — bank/fund REO portal, Intrum-owned.

Feasibility spike (2026-08-02, live), per docs/skills/connectors.md and the
discipline set by #12/#15. Findings, with the evidence they rest on:

robots.txt (fetched live, full contents):

    User-agent: *
    Disallow: /api/
    Disallow: /ajax/
    Sitemap: https://www.solvia.es/sitemap.xml

Unusually permissive — neither the search tree (`/es/comprar/...`) nor the
detail tree (`/es/propiedades/comprar/...`) is disallowed. `/api/` IS
disallowed, which matters concretely: Solvia's own front-end paginates by
calling `/api/`, so this connector must NOT use that endpoint even though
it would be the convenient path. Everything below works purely off
server-rendered pages. (`sitemap.xml` itself returned a Cloudflare 502 at
spike time, so it is not relied on.)

No bot-hostility observed: HTTP 200 on every request, no CAPTCHA, no
interstitial, no JS-only shell. The site is Angular Universal (SSR) and
ships a complete `<script id="ng-state" type="application/json">` payload
containing a 75-field `propertyBasicDetail` object — richer, and far more
stable, than scraping rendered markup.

Coverage reality, which is why `discovers_full_inventory = False`:
  * 6,375 homes listed for sale nationally at spike time.
  * A search page renders exactly 20 detail links server-side.
  * Query-param pagination does not work on the SSR path: `?pagina=2` and
    `?page=2` both returned byte-identical first results to page 1
    (verified). Real pagination goes through the robots-disallowed `/api/`.
  * Geography narrows genuinely — `/viviendas/alicante/torrevieja` reported
    61 homes vs. 6,375 nationally — but still renders only its first 20.
So a sweep sees at most 20 listings per configured geography. Withdrawal
detection must stay off (a listing absent from a 20-of-61 slice tells you
nothing), exactly the Fotocasa lesson in Connector.discovers_full_inventory.

What Solvia publishes that the consumer portals generally do not:
  * `caracteristicas.refCatastral` — the cadastral reference, on all five
    live spot-checks. This is the dedup engine's highest-confidence signal
    (issue #1 §6 signal 1) and has had no real data source until now;
    issue #42 was cancelled on the reasonable assumption we would never
    obtain one. See solvia_mapping.extract_cadastral_ref.
  * `importeIbi` / `importeGastosComunidad` — annual property tax and
    monthly community fees, the carrying costs Phase 5's net-yield maths
    (#33) would otherwise have to assume.
  * Structured `reformar` / `estado` condition flags (#26 input).
"""

from __future__ import annotations

import json
import logging
import re
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
from etl.connectors.extraction import first_present
from etl.connectors.geography import nearest_city
from etl.connectors.solvia_mapping import (
    _named,
    _to_decimal,
    _to_int,
    extract_address,
    extract_cadastral_ref,
    extract_features,
    extract_investment_extras,
    extract_m2_built,
    extract_m2_plot,
    extract_operation,
    extract_photo_urls,
    map_property_type,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://www.solvia.es"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research; "
    "contact: github.com/alvarolobato/inmo-tool)"
)

# Angular Universal transfer state. Both discover() and fetch_detail() read
# this same blob — the search page carries `seoProvinciasResponse`/nav data,
# the detail page carries `propertyBasicDetail`.
_NG_STATE_RE = re.compile(
    r'<script id="ng-state" type="application/json">(.*?)</script>', re.DOTALL
)

# Detail URLs are absolute in the SSR markup:
# https://www.solvia.es/es/propiedades/comprar/piso-illescas-3-dormitorios-147621-184464
# The trailing "<idPromocion>-<idVivienda>" pair is the stable identity; the
# leading slug is descriptive and changes whenever the title does (room count,
# municipality renaming, type reclassification).
#
# external_id is therefore the numeric pair ALONE, not the full slug. `listing`
# is keyed on (source, external_id), so a slug-derived id would make a retitled
# listing look like a brand-new property: a duplicate `listing` row for one
# flat, which then pollutes dedup rather than updating in place (#138 review).
#
# This is safe because Solvia serves the detail page from a placeholder slug —
# verified live during the review: /es/propiedades/comprar/x-147621-184464
# returns HTTP 200 with byte-identical `propertyBasicDetail` (idVivienda
# 184464, idPromocion 147621, same price/address/refCatastral) to the real
# slug. Fotocasa's connector relies on the same trick.
# The trailing (?![\w-]) matters: hrefs appear both bare and inside tracking
# URLs ("...-64377-160385&url=https://..."), and without the boundary the
# numeric pair would be re-matched mid-string against the embedded copy.
_DETAIL_HREF_RE = re.compile(
    r"https://www\.solvia\.es/es/propiedades/comprar/[a-z0-9-]+?-(\d+-\d+)(?![\w-])"
)

# Any non-empty slug works; "x" mirrors Fotocasa's placeholder convention.
_DETAIL_PATH_TEMPLATE = "/es/propiedades/comprar/x-{external_id}"

# (provincia, municipio) path segments per known city centroid. An explicit
# table, not a slugify() of the centroid name: Solvia's provincia slugs are
# not always the city name (e.g. Palma sits under `balears-illes`), so
# guessing would produce 404s that look like empty results. Verified against
# live hrefs on the national search page at spike time.
_CITY_SLUGS: dict[str, tuple[str, str]] = {
    "madrid": ("madrid", "madrid"),
    "sevilla": ("sevilla", "sevilla"),
    "barcelona": ("barcelona", "barcelona"),
    "valencia": ("valencia", "valencia"),
}


def _resolve_geography(scope: ConnectorScope) -> tuple[str, str] | None:
    """Translate a profile's (center, radius_km) into Solvia path segments.

    Returns None when the scope resolves to no city this connector knows —
    the orchestrator then skips it as a coverage gap rather than treating it
    as a failure (issue #99).
    """
    if scope.geography:
        parts = scope.geography.strip("/").split("/")
        if len(parts) == 2 and all(parts):
            return parts[0], parts[1]
        return None
    if scope.center is None:
        return None
    city = nearest_city(scope.center, scope.radius_km)
    if city is None:
        return None
    return _CITY_SLUGS.get(city)


def _parse_ng_state(html: str, *, context: str) -> dict[str, Any]:
    """Extract and parse the Angular transfer-state blob.

    Raises ConnectorError (counted toward the circuit breaker) rather than
    returning empty on absence: a page without ng-state is a structural
    change or a soft-block, not a page with zero listings, and silently
    treating it as the latter is how a connector starts marking real
    inventory withdrawn.
    """
    match = _NG_STATE_RE.search(html)
    if match is None:
        raise ConnectorError(
            f'solvia {context}: no <script id="ng-state"> found — page '
            f"structure may have changed, or this is a soft-block page"
        )
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ConnectorError(
            f"solvia {context}: ng-state is not valid JSON: {exc}"
        ) from exc
    if not isinstance(parsed, dict):
        raise ConnectorError(
            f"solvia {context}: ng-state parsed to {type(parsed).__name__}, "
            f"expected an object"
        )
    return parsed


def _get(url: str, throttle: Throttle, *, context: str) -> str:
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
            f"solvia {context}: request failed for {url}: {exc}"
        ) from exc
    return response.text


class SolviaConnector(Connector):
    """Intrum-owned REO portal. Angular SSR, whole-payload transfer state."""

    name = "solvia"
    # Deliberately below the framework default (30/min): this is a single
    # servicer's site being crawled by a personal tool, and issue #1 §15's
    # good-neighbour stance argues for taking the slower option when the
    # inventory per geography is only 20 pages deep anyway.
    rate_limit_per_minute = 20

    # See the module docstring's coverage section: a sweep sees at most 20
    # of a geography's listings (61 in the verified Torrevieja case), so
    # absence from a sweep proves nothing about withdrawal.
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        resolved = _resolve_geography(scope)
        if resolved is None:
            return None
        return f"{resolved[0]}/{resolved[1]}"

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        resolved = _resolve_geography(scope)
        if resolved is None:
            raise ConnectorError(
                f"solvia discover: scope {scope!r} resolves to no known Solvia "
                f"geography — this should have been skipped via scope_key()"
            )
        provincia, municipio = resolved
        url = f"{_BASE_URL}/es/comprar/viviendas/{provincia}/{municipio}"
        html = _get(url, throttle, context="discover")

        # Validate the page really is a Solvia SSR page before trusting an
        # empty result set (same reasoning as _parse_ng_state).
        _parse_ng_state(html, context="discover")

        external_ids = sorted({m.group(1) for m in _DETAIL_HREF_RE.finditer(html)})
        logger.info(
            "solvia discover: geography=%s/%s found %d external_ids "
            "(page-1 only, see discovers_full_inventory)",
            provincia,
            municipio,
            len(external_ids),
        )
        return external_ids

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_BASE_URL}{_DETAIL_PATH_TEMPLATE.format(external_id=external_id)}"
        html = _get(url, throttle, context="fetch_detail")
        state = _parse_ng_state(html, context="fetch_detail")
        detail = state.get("propertyBasicDetail")
        if not isinstance(detail, dict) or not detail:
            raise ConnectorError(
                f"solvia fetch_detail: ng-state has no propertyBasicDetail for "
                f"{external_id}"
            )
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"propertyBasicDetail": detail, "url": url, "html": html},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        detail = raw.raw.get("propertyBasicDetail")
        if not isinstance(detail, dict):
            raise ConnectorError(
                f"solvia normalize: missing propertyBasicDetail for {raw.external_id}"
            )
        html = raw.raw.get("html") or ""

        raw_extra: dict[str, Any] = extract_investment_extras(detail)
        # Goes to the canonical `cadastral_ref` field (issue #140), which the
        # orchestrator writes to property.cadastral_ref and the dedup engine
        # reads as its definitive signal. Previously stashed in raw_extra
        # because no canonical column was wired through.
        cadastral_ref = extract_cadastral_ref(detail)
        for key in ("idVivienda", "idPromocion", "fichaMacro", "segmento"):
            value = detail.get(key)
            if value not in (None, ""):
                raw_extra[key] = value

        # Price: the structured field is authoritative, but a renamed key
        # would otherwise yield None silently — fall back to the rendered
        # price in the SSR markup. `mostrarPrecio == 'N'` means Solvia
        # deliberately withholds the price ("consultar precio"), which is a
        # real state, not a parse failure, so no fallback is attempted then.
        def _price_from_state() -> Any:
            if str(detail.get("mostrarPrecio", "S")).upper() == "N":
                return None
            return _to_decimal(detail.get("precio"))

        def _price_from_markup() -> Any:
            if str(detail.get("mostrarPrecio", "S")).upper() == "N":
                return None
            # `data-price` is an explicit attribute, safe to search document-
            # wide. The bare "123.456 €" pattern is NOT: a detail page also
            # renders "similar properties" cards, and an unscoped search
            # happily returns a neighbour's price. The Vivantial connector
            # (#139) shipped exactly that bug — 310.000 € read off an
            # adjacent card instead of the listing's real 288.000 € — so
            # restrict the text pattern to the main price container.
            match = re.search(r'data-price="([0-9]+(?:\.[0-9]+)?)"', html)
            if match is None:
                price_block = re.search(
                    r'<[^>]+class="[^"]*\b(?:price|precio)\b[^"]*"[^>]*>(.{0,400}?)</',
                    html,
                    re.DOTALL | re.IGNORECASE,
                )
                if price_block is not None:
                    match = re.search(
                        r"([0-9]{1,3}(?:\.[0-9]{3})+)\s*€", price_block.group(1)
                    )
            if match is None:
                return None
            return _to_decimal(match.group(1).replace(".", ""))

        current_price = first_present(
            _price_from_state, _price_from_markup, field="current_price"
        )

        # Rooms: structured first, then the descriptive slug, which encodes
        # the room count ("...-3-dormitorios-...").
        #
        # The slug is read from `og:url` in the document, not from
        # raw.external_id — external_id is now the bare numeric pair, and
        # fetch_detail requests a placeholder slug. Verified live: under a
        # placeholder fetch `rel="canonical"` echoes the placeholder back
        # ("x-147621-184464") but `og:url` still carries the real slug
        # ("piso-illescas-3-dormitorios-147621-184464"), so og:url is the
        # only fallback source that survives our own URL construction.
        def _rooms_from_state() -> Any:
            return _to_int(detail.get("totalDormitorios"))

        def _rooms_from_og_url_slug() -> Any:
            match = re.search(r'og:url"\s+content="[^"]*?-(\d+)-dormitorios?-', html)
            return int(match.group(1)) if match else None

        rooms = first_present(_rooms_from_state, _rooms_from_og_url_slug, field="rooms")

        raw_property_type = first_present(
            lambda: _named(detail.get("tipoVivienda")),
            lambda: _named(detail.get("categoriaTipoVivienda")),
            field="property_type",
        )
        property_type = map_property_type(raw_property_type)
        if raw_property_type:
            # Keep the source vocabulary: the map is lossy by design
            # (Bajo/Estudio/Dúplex all collapse to 'piso', Trastero has no
            # schema equivalent at all), and the original is the only way to
            # tell those apart later or to notice an unmapped value appearing.
            raw_extra["tipo_vivienda_raw"] = raw_property_type

        city = first_present(
            lambda: _named(detail.get("poblacion")),
            lambda: _named(detail.get("promocion")),
            field="city",
        )

        postal_code = detail.get("cp")
        postal_code = (
            str(postal_code).strip() if postal_code not in (None, "") else None
        )

        description = detail.get("textoDescripcion")
        description = (
            description.strip()
            if isinstance(description, str) and description.strip()
            else None
        )

        reserved = raw_extra.get("reservado") is True

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=raw.raw.get("url"),
            # Solvia is the selling entity on every listing — it is a
            # servicer disposing of bank-owned stock, not a classifieds
            # site carrying third-party private sellers. 'agency' is the
            # honest value; it also correctly keeps the phone-match dedup
            # signal in suggestion-only mode (#16), which is right, since
            # every Solvia listing shares one corporate phone number.
            listing_kind="agency",
            status="reserved" if reserved else "active",
            current_price=current_price,
            description=description,
            photo_urls=extract_photo_urls(detail),
            contact_raw=None,
            address=extract_address(detail),
            # Not published anywhere in the payload or markup — verified
            # across five live listings. The address_coords dedup signal
            # therefore cannot fire for Solvia; postal_code + address +
            # cadastral_ref carry the matching instead.
            lat=None,
            lon=None,
            property_type=property_type,
            m2_built=extract_m2_built(detail),
            m2_useful=None,
            rooms=rooms,
            bathrooms=_to_int(detail.get("totalBanyos")),
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            raw_extra=raw_extra,
            city=city,
            province=_named(detail.get("provincia")),
            postal_code=postal_code,
            m2_plot=extract_m2_plot(detail),
            features=extract_features(detail),
            operation=extract_operation(detail),
            reference_code=(
                str(detail.get("id")).strip() if detail.get("id") else None
            ),
            cadastral_ref=cadastral_ref,
        )
