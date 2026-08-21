"""Servihabitat connector — CaixaBank / Lone Star servicer portal.

Feasibility spike, 2026-08-02 (issue #115). All findings below are from
live requests with an identifying User-Agent, spaced several seconds
apart; none are assumed.

robots.txt (readable, HTTP 200 — no Incapsula/hCaptcha wall, unlike Sareb
in #121):

    Disallow: /en/
    Disallow: /venta
    Disallow: /alquiler
    Disallow: /*?numerohabitaciones=   (and ~15 more query-string filters)
    Disallow: /*?p_p_id=              (Liferay portlet params)
    User-agent: Scrapy
    Disallow: /
    Sitemap: https://www.servihabitat.com/sitemap.xml

The `Disallow: /venta` line looks fatal at a glance and is not: every real
listing lives under `/es/venta/...`, and robots.txt path matching is a
literal prefix match from the start of the path (RFC 9309), so `/venta`
does not match `/es/venta/...`. Verified two ways — with a matcher written
against the documented spec, and empirically: bare `/venta` and `/es/venta`
both return 404, i.e. the disallowed path is a legacy/defensive rule over
a page that does not exist. (Deliberately not verified with `protego`,
whose 0.5.0 pattern quoting silently drops a literal `?` — a real bug found
during the Fotocasa spike, issue #65.)

Note `User-agent: Scrapy / Disallow: /`: they name a scraping framework
explicitly. We are not Scrapy and the `*` group governs us, but it is a
clear statement of posture — hence conservative rate limiting below, and
sitemap-based discovery rather than crawling search pages.

Discovery therefore uses the **sitemap**, which robots.txt itself
advertises, rather than search-results pages:

    /sitemap.xml -> /es/sitemap-es.xml -> 56 per-province sitemaps

This sidesteps the disallowed query-string filters entirely — every
faceted search parameter (`?numerohabitaciones=`, `?order=`, `?metrosMin=`
…) is disallowed, so a filter-partitioning strategy like Fotocasa's
zone-slug approach (#65) is not available here. The sitemap is both the
sanctioned and the only compliant enumeration route.

Coverage sampled 2026-08-02 (total entries / residential):
    madrid 360/59, barcelona 1464/272, valencia 448/33, alicante 277/82
Across 56 province sitemaps that extrapolates to roughly 10-15k entries,
of which a minority are residential — the portfolio is dominated by
garages, commercial premises and land (Madrid: 178 of 360 are garages).
`discover()` filters to residential segments for that reason.

Worth stating plainly, because the batch tracking issue (#132) implied the
opposite: Servihabitat is **portfolio-rich but portal-poor**. It services
Sareb, CaixaBank and some Kutxabank stock, which is why it was expected to
be the batch's richest target -- but that is portfolio *value*, not public
listing count. 59 residential listings in Madrid is thin beside Solvia's
6,375 nationally (#116).

Of the four provinces sampled, only three are reachable today: a scope is
resolved through `etl.connectors.geography.resolve_place` against the full
~8,124-municipality gazetteer (issue #169), so geography resolution itself
is no longer the limit — the gap is this connector's own
`_PROVINCE_SITEMAP_SLUGS` table below, which doesn't have an Alicante entry
yet (only Madrid/Sevilla/Barcelona/Valencia/Malaga are mapped to a sitemap
slug). The Alicante figures above are therefore informational, not
reachable, until that table grows — a deliberate per-connector coverage
gap (issue #169's "known municipality this connector doesn't cover" case),
not a geography-resolution failure.

Fields NOT available, checked explicitly against the batch checklist in
issue #132 and confirmed absent on a real listing page:
  - **No `referencia catastral`.** Unlike Solvia (#116), which publishes
    one and thereby gave issue #1 §6's highest-confidence dedup signal its
    first real data source. Servihabitat does not.
  - **No IBI / community-fee carrying costs** (Solvia publishes both;
    they feed #33's net-yield maths).
  - **No lat/lon anywhere.** Same as Solvia and Vivantial — so the
    `address_coords` dedup signal (issue #16 signal 2) can never fire for
    this source either. Dedup here leans on the reference code (#72) and
    fuzzy address/price/size matching.
Absence is asserted in tests rather than left as a silent gap, so a future
site change that starts publishing them shows up as a failing test.
"""

from __future__ import annotations

import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    SearchParam,
    SearchPreview,
    SearchUrlGrammar,
    Throttle,
)
from etl.connectors.extraction import (
    first_present,
    scoped_text,
    strip_price_punctuation,
    text_to_int,
)
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
from etl.connectors.servihabitat_mapping import (
    is_residential,
    map_property_type,
    parse_location_slug,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://www.servihabitat.com"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research tool; "
    "contact via github.com/alvarolobato/inmo-tool)"
)
_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

# The subject property's own characteristics block.
_SUBJECT_FEATURES_SELECTOR = "#product_features"

# "Inmuebles similares" carousel subtrees. Their cards render their own
# price/m2/rooms/baths into page text, so any unscoped scan can attribute a
# neighbour's figures to the subject property. See
# `etl.connectors.extraction.scoped_text` for the full writeup and the three
# connectors that independently hit this.
_SIMILAR_LISTING_SELECTORS = (
    ".container-similares",
    ".marco-InmueblesSimilares",
    ".similar-destacato",
    ".caja-destacado",
)

# province name (etl.connectors.geography.Place.province values) -> this
# site's own per-province sitemap slug. Live-verified: each of these returns
# HTTP 200 with real <loc> entries.
#
# Issue #169 fix, not just an extension: this table used to be keyed by
# *city* name (coincidentally identical to province name for the original
# four, since Madrid/Sevilla/Barcelona/Valencia are all provincial capitals
# sharing their province's name) even though Servihabitat's sitemap is
# organised by *province*, not municipality. That coincidence hid a real
# bug — a scope centered on any non-capital town (Estepona, in Malaga
# province) would resolve to a city name ("estepona") this dict had no key
# for, permanently reading as "no coverage" even though Servihabitat's
# Malaga *province* sitemap does cover Estepona. Now keyed by
# `Place.province` so every municipality in a covered province resolves
# correctly, not just the province's own namesake capital.
_PROVINCE_SITEMAP_SLUGS: dict[str, str] = {
    "Madrid": "madrid",
    "Sevilla": "sevilla",
    "Barcelona": "barcelona",
    "Valencia": "valencia",
    # Costa del Sol (issue #169 course-correction v1 market) — confirmed
    # HTTP 200 with real <loc> entries covering Mijas/Alora/Manilva etc.
    "Malaga": "malaga",
}


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's province sitemap slug, or None.

    `scope.geography` (the free-text escape hatch) wins when set, for tests
    and manual construction. Otherwise resolve `scope.center` via the shared
    gazetteer (issue #169) and look up its *province* (not municipality —
    see `_PROVINCE_SITEMAP_SLUGS`'s docstring for why that distinction is
    the actual fix, not just a rename). No hardcoded default (issue #71): a
    province this connector's own table doesn't cover means "nothing to
    discover here", not "assume Madrid".

    Can raise `UnresolvableGeographyError` (from `resolve_place`) — see
    fotocasa.py's `_resolve_geography` docstring for why that's deliberate.
    """
    if scope.geography:
        return scope.geography
    place = resolve_place(scope)
    if place is None:
        return None
    return _PROVINCE_SITEMAP_SLUGS.get(place.province)


# Issue #495: Servihabitat is honestly LIMITED. Its faceted search is
# robots.txt-disallowed (see the class docstring and `discovers_full_inventory
# = False`), so the ONLY URL that round-trips is the province sitemap discover()
# actually reads. The grammar therefore inverts just `sitemap-es-<province>.xml`
# — and `reject_reasons` turns any owner-pasted faceted-search URL (a
# servihabitat.com URL carrying a query string, the faceted search's tell) into
# a REASONED block that explains the robots limit, rather than a silent
# no-match. `_sitemap_url()` delegates to `build()` (anti-drift).
_SEARCH_URL_GRAMMAR = SearchUrlGrammar(
    build_template=f"{_BASE_URL}/es/sitemap-es-{{province}}.xml",
    parse_pattern=(
        r"^https?://(?:www\.)?servihabitat\.com/es/sitemap-es-"
        r"(?<province>[^./]+)\.xml$"
    ),
    params={"province": {"label": "Provincia (sitemap)", "source": "profile"}},
    reject_reasons=(
        {
            "pattern": r"^https?://(?:www\.)?servihabitat\.com/[^?]*\?",
            "reason": "robots-faceted-search",
        },
    ),
)


def _sitemap_url(province: str) -> str:
    """The province sitemap discover() sweeps for `province`. Shared by
    discover() and search_previews() so the preview can't drift.

    Delegates to `_SEARCH_URL_GRAMMAR.build()` (issue #495) so the swept URL and
    the published grammar stay pinned together (anti-drift)."""
    return _SEARCH_URL_GRAMMAR.build({"province": province})


def _get(url: str, throttle: Throttle) -> requests.Response:
    throttle()
    try:
        response = requests.get(
            url,
            headers={"User-Agent": _USER_AGENT},
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise ConnectorError(f"servihabitat: request failed for {url}: {exc}") from exc
    return response


def _sitemap_locs(xml_text: str) -> list[str]:
    """Extract every <loc> from a sitemap or sitemap index."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ConnectorError(f"servihabitat: sitemap is not valid XML: {exc}") from exc
    return [
        el.text.strip()
        for el in root.iter(f"{_SITEMAP_NS}loc")
        if el.text and el.text.strip()
    ]


def parse_listing_path(url_or_path: str) -> dict[str, str | None]:
    """Split a listing URL/path into its meaningful segments.

    Two real shapes exist:
        /es/venta/vivienda/<location-slug>/<id>
        /es/venta/promociones/vivienda/<location-slug>/<id>
    ("promociones" = a development/new-build grouping.)
    """
    path = urlsplit(url_or_path).path if "://" in url_or_path else url_or_path
    parts = [p for p in path.split("/") if p]
    # Expect: es, venta, [promociones,] <type>, <location>, <id>
    if len(parts) < 5 or parts[0] != "es":
        return {"type_segment": None, "location_slug": None, "listing_id": None}
    operation_idx = 1
    rest = parts[operation_idx + 1 :]
    is_promocion = rest and rest[0] == "promociones"
    if is_promocion:
        rest = rest[1:]
    if len(rest) < 3:
        return {"type_segment": None, "location_slug": None, "listing_id": None}
    return {
        "type_segment": rest[0],
        "location_slug": rest[1],
        "listing_id": rest[2],
        "operation_segment": parts[operation_idx],
        "is_promocion": "true" if is_promocion else "false",
    }


class ServihabitatConnector(Connector):
    name = "servihabitat"

    # Conservative relative to the other connectors (Fotocasa/Milanuncios
    # default to 30/min). Two reasons: a sitemap sweep is a large burst of
    # detail fetches rather than one search page, and robots.txt names a
    # scraping framework with a blanket Disallow — a clear signal to be a
    # quiet guest even where the `*` group permits access.
    rate_limit_per_minute = 12

    # Discovery reads the province sitemap, which is the site's own complete
    # enumeration for that province — so this could arguably claim True.
    # Deliberately False: completeness is *unverifiable* here, because every
    # faceted-search query parameter is robots.txt-disallowed, so there is no
    # compliant way to cross-check the sitemap's count against a search-result
    # total. Claiming full inventory on an unverifiable basis risks the
    # orchestrator mass-marking real listings `withdrawn` on any sitemap
    # hiccup (the Fotocasa lesson) — the safe direction is to under-claim.
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved province slug IS the coverage key: two scopes
        resolving to the same province fetch the identical sitemap.

        `UnresolvableGeographyError` (issue #169) must become a sentinel key
        here rather than `None` — this method must never raise itself, see
        fotocasa.py's `scope_key` docstring for the full reasoning."""
        try:
            return _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)

    # Issue #478: an owner-pinned servihabitat URL is this connector's recall
    # source for a profile. Issue #513: discover() now CONSUMES
    # `scope.override_url` (fetches it verbatim as the entry point). Only a
    # province sitemap URL round-trips the grammar; a faceted-search URL is
    # rejected at save time (robots reason), so a pin here is always a sitemap.
    override_host_suffix = "servihabitat.com"
    supports_search_override = True

    # Issue #495: published to connector_registry.search_url_grammar. Only the
    # province sitemap round-trips; a pasted faceted-search URL is rejected with
    # the robots reason (the dashboard blocks saving it). `_sitemap_url()`
    # delegates to `build()` — the anti-drift contract.
    search_url_grammar = _SEARCH_URL_GRAMMAR

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses `_sitemap_url()` — the exact province sitemap discover()
        enters from. `kind="sitemap"`: discovery enumerates the province's
        listings from that sitemap."""
        try:
            province = _resolve_geography(scope)
        except UnresolvableGeographyError:
            province = None
        if province is None:
            return [
                SearchPreview(
                    label="Servihabitat",
                    url=None,
                    kind="sitemap",
                    tunable=True,
                    notes="El perfil no resuelve a una provincia que este conector cubra.",
                )
            ]
        # Issue #495: the only param that reaches this connector is the province
        # (it selects the sitemap). No faceted filters travel — robots.txt
        # disallows the faceted search entirely — so the honest note below and
        # the grammar's reject_reasons keep the row from implying more.
        params: tuple[SearchParam, ...] = (
            SearchParam(
                key="province",
                label="Provincia (sitemap)",
                value=province,
                source="profile",
                in_url=True,
            ),
        )
        return [
            SearchPreview(
                label=f"Servihabitat — {province}",
                url=_sitemap_url(province),
                kind="sitemap",
                tunable=True,
                params=params,
                notes=(
                    "La búsqueda enumera el sitemap de la provincia; el filtrado "
                    "fino es por datos. La búsqueda facetada de este portal está "
                    "prohibida por robots.txt, así que solo el sitemap de "
                    "provincia es una URL válida (pegar una URL de búsqueda con "
                    "filtros se rechaza)."
                ),
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # _resolve_geography can raise UnresolvableGeographyError, left to
        # propagate uncaught (issue #169) — see fotocasa.py's discover() for
        # the full reasoning.
        # Issue #513: an owner-pinned URL is this profile's recall source — hit
        # it verbatim as the sitemap entry (province left None: it plays no part
        # beyond the log). Without an override the code path is byte-identical.
        override_url = scope.override_url if self.supports_search_override else None
        if override_url:
            province = None
            url = override_url
        else:
            province = _resolve_geography(scope)
            if province is None:
                # Reachable only if discover() is invoked directly, bypassing
                # scope_key()'s gate — see fotocasa.py's discover() docstring.
                raise ConnectorError(
                    "servihabitat discover: scope has neither a resolvable "
                    "center nor an explicit geography string, or resolves to a "
                    "province this connector's _PROVINCE_SITEMAP_SLUGS table "
                    "doesn't cover — nothing to discover, and not defaulting to "
                    "a hardcoded province (issue #71)"
                )
            url = _sitemap_url(province)

        response = _get(url, throttle)
        locs = _sitemap_locs(response.text)

        external_ids: list[str] = []
        seen: set[str] = set()
        skipped_non_residential = 0
        for loc in locs:
            parts = parse_listing_path(loc)
            if not parts["listing_id"]:
                continue
            if not is_residential(parts["type_segment"]):
                skipped_non_residential += 1
                continue
            # external_id is the URL *path*, not the bare numeric id: there is
            # no id-only canonical URL on this site (verified — both
            # /es/venta/vivienda/x/<id> and /es/inmueble/<id> return 404), so
            # fetch_detail cannot reconstruct a URL from the id alone. The
            # numeric id is still carried through as reference_code (#72), so
            # a re-slugged listing is recoverable by the dedup engine even
            # though its external_id changes.
            path = urlsplit(loc).path.lstrip("/")
            if path in seen:
                continue
            seen.add(path)
            external_ids.append(path)

        logger.info(
            "servihabitat discover: province=%s sitemap had %d entries, "
            "%d residential kept, %d non-residential skipped",
            province,
            len(locs),
            len(external_ids),
            skipped_non_residential,
        )
        return sorted(external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_BASE_URL}/{external_id.lstrip('/')}"
        response = _get(url, throttle)
        html = response.text

        soup = BeautifulSoup(html, "html.parser")
        json_ld = _extract_product_json_ld(html)

        # Both text views go through the shared `scoped_text`, which drops
        # the "inmuebles similares" carousel before flattening. Non-optional:
        # those cards render their own price/m²/rooms/baths into the same
        # page text, so an unscoped regex silently reads a *neighbouring*
        # property's figures. Confirmed live on
        # /es/venta/vivienda/madrid-.../60645658, whose page text contains
        # "48m 2 2 hab. 1 baño ... 190.000 €" from a nearby listing while the
        # subject is 80 m² at 230.000 €. Same class of bug as PR #139
        # (Vivantial) and PR #138 (Solvia) — hence the shared helper.
        features_section = soup.select_one(_SUBJECT_FEATURES_SELECTOR)

        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={
                "url": url,
                "html": html,
                "json_ld": json_ld,
                "path_parts": parse_listing_path(external_id),
                "og": _open_graph(soup),
                "referencia": _referencia_attr(soup),
                # Subject-property characteristics only. None when the page
                # has no such container (some `promociones` layouts), which
                # lets normalize()'s first_present chains fall through to the
                # whole-page view rather than seeing an empty string.
                "features_text": scoped_text(
                    soup,
                    keep=_SUBJECT_FEATURES_SELECTOR,
                    drop=_SIMILAR_LISTING_SELECTORS,
                ),
                # Reads <li> elements inside the features block, which the
                # carousel never contaminates — so it takes the element
                # directly rather than a flattened string.
                "equipamiento": _equipamiento(features_section),
                # Carousel-dropped, so safe(r) — but still only a last-resort
                # fallback behind the scoped sources above.
                "text": scoped_text(soup, drop=_SIMILAR_LISTING_SELECTORS),
            },
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        data: dict[str, Any] = raw.raw
        json_ld: dict[str, Any] = data.get("json_ld") or {}
        og: dict[str, str] = data.get("og") or {}
        parts: dict[str, Any] = data.get("path_parts") or {}
        # Subject-property scoped text; falls back to whole-page text only
        # where the scoped section is absent (some `promociones` pages use a
        # different layout). Whole-page text has already had the "similar
        # listings" carousel removed in fetch_detail.
        features_text: str = data.get("features_text") or ""
        text: str = data.get("text") or ""
        offers = json_ld.get("offers") or {}
        if isinstance(offers, list):
            offers = offers[0] if offers else {}

        city, province = parse_location_slug(parts.get("location_slug"))

        price = first_present(
            # JSON-LD Product/offers is unambiguously the subject property —
            # preferred over any text scan for exactly that reason.
            lambda: _decimal_or_none(offers.get("price")),
            lambda: _decimal_or_none(strip_price_punctuation(_first_price_text(text))),
            field="current_price",
        )
        m2_built = first_present(
            lambda: _decimal_or_none(text_to_int(_surface_text(features_text))),
            lambda: _decimal_or_none(text_to_int(_surface_text(text))),
            field="m2_built",
        )
        description = first_present(
            lambda: json_ld.get("description"),
            lambda: og.get("description"),
            field="description",
        )

        photo_urls = _photo_urls(json_ld, og)

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=data.get("url"),
            # Servihabitat is a servicer selling bank-owned stock — every
            # listing is institutional, never a private seller. Asserting
            # 'agency' (rather than leaving None) is load-bearing for the
            # phone-corroboration dedup rule in issue #16, which never
            # auto-merges when either side is an agency.
            listing_kind="agency",
            status="active",
            current_price=price,
            description=description,
            photo_urls=photo_urls,
            # Issue #628 (D-141): a constant, not extracted from any
            # per-listing field — every Servihabitat listing is the same
            # selling entity (see the listing_kind comment above), so
            # "Servihabitat" is as honest a `contact_raw` as any other
            # connector's per-listing agency name. Mirrors solvia.py.
            contact_raw="Servihabitat",
            address=_address(city, province),
            # No coordinates published anywhere on this site — see module
            # docstring. Asserted in tests so a future change surfaces.
            lat=None,
            lon=None,
            property_type=map_property_type(parts.get("type_segment")),
            # Scoped to the characteristics section only. Many Servihabitat
            # listings genuinely omit room/bath counts (the portfolio skews
            # to small/atypical units), so None here is real absence, not a
            # parse failure — and is far better than silently importing a
            # neighbouring listing's figures.
            rooms=first_present(
                lambda: text_to_int(_labelled_number(features_text, r"hab\.?")),
                lambda: text_to_int(_labelled_number(features_text, "habitacion")),
                lambda: text_to_int(_labelled_number(features_text, "dormitorio")),
                field="rooms",
            ),
            bathrooms=first_present(
                lambda: text_to_int(_labelled_number(features_text, "baño")),
                lambda: text_to_int(_labelled_number(features_text, "bano")),
                field="bathrooms",
            ),
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=first_present(
                lambda: _energy_rating(features_text),
                field="energy_rating",
            ),
            m2_built=m2_built,
            # Servihabitat renders a single surface figure with no
            # built-vs-useful distinction, so attributing it to m2_built
            # alone is the honest reading — inventing a m2_useful value
            # would fabricate precision the source doesn't provide.
            m2_useful=None,
            city=city,
            province=province,
            postal_code=None,
            features=tuple(data.get("equipamiento") or ()),
            operation="sale",
            # The trailing numeric id from the URL — this is what the site
            # itself renders as `referencia` on the page.
            reference_code=first_present(
                lambda: data.get("referencia"),
                lambda: parts.get("listing_id"),
                field="reference_code",
            ),
            raw_extra={
                "listing_id": parts.get("listing_id"),
                "type_segment": parts.get("type_segment"),
                "location_slug": parts.get("location_slug"),
                "is_promocion": parts.get("is_promocion"),
                "json_ld_name": json_ld.get("name"),
            },
        )


def _extract_product_json_ld(html: str) -> dict[str, Any] | None:
    """Return the schema.org Product block, ignoring BreadcrumbList etc."""
    for block in re.findall(
        r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", html, re.DOTALL
    ):
        try:
            parsed = json.loads(block.strip())
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict) and parsed.get("@type") == "Product":
            return parsed
    return None


def _open_graph(soup: BeautifulSoup) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in soup.find_all("meta"):
        prop = tag.get("property") or ""
        if prop.startswith("og:") and tag.get("content"):
            out[prop[3:]] = tag["content"]
    return out


def _referencia_attr(soup: BeautifulSoup) -> str | None:
    """The site stamps `referencia="<id>"` on a page element."""
    node = soup.find(attrs={"referencia": True})
    if node is None:
        return None
    value = (node.get("referencia") or "").strip()
    return value or None


def _first_price_text(text: str) -> str | None:
    match = re.search(r"(\d{1,3}(?:\.\d{3})+)\s*€", text)
    return match.group(1) if match else None


def _surface_text(text: str) -> str | None:
    """Pull the surface figure out of the characteristics block.

    Rendered as "80 m 2 superficie" (the superscript 2 becomes a separate
    text node), so the pattern tolerates the space and requires the
    trailing "superficie" label where present — that label is what
    distinguishes the surface figure from the energy-certificate numbers
    ("255 kW/m 2 Año", "50 kg CO2/m 2 Año") in the same section.
    """
    match = re.search(r"(\d{1,5})\s*m\s*(?:²|2)\s*superficie", text, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r"(\d{1,5})\s*m\s*(?:²|2)(?!\s*A[ñn]o)", text, re.IGNORECASE)
    return match.group(1) if match else None


def _strip_similar_listings(soup: BeautifulSoup) -> None:
    """Remove the related-listings carousel from `soup`, in place.

    Retained for tests that assert directly on a stripped tree. Production
    extraction goes through `scoped_text(..., drop=...)` instead, which is
    non-mutating — a shared helper that silently `decompose()`d the caller's
    soup would be a trap for the next connector to reach for it.
    """
    for selector in _SIMILAR_LISTING_SELECTORS:
        for node in soup.select(selector):
            node.decompose()


def _equipamiento(features_section: Any) -> tuple[str, ...]:
    """Amenity tokens from the 'Equipamiento' sub-block, as slugs.

    The block is a `<div class="equipamiento">` holding an `<h2>` heading
    plus one `<li>` per amenity, so amenities are read from the list items
    directly rather than by splitting the container's flattened text —
    the latter yields "Equipamiento Alarma" as one blob, since the heading
    and the item are separated only by a single space once flattened.

    Emitted as short lowercase tokens (e.g. 'alarma') to match the
    `features` TEXT[] convention documented in data-model.md, which the
    GIN index and future containment queries expect — not the descriptive
    sentences the page renders.
    """
    if features_section is None:
        return ()
    block = features_section.find(attrs={"class": "equipamiento"})
    if block is None:
        return ()
    items = [li.get_text(" ", strip=True) for li in block.find_all("li")]
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        token = re.sub(r"[^a-z0-9]+", "_", item.strip().lower()).strip("_")
        if token and token not in seen and len(token) < 40:
            seen.add(token)
            out.append(token)
    return tuple(out)


def _labelled_number(text: str, label: str) -> str | None:
    """First number immediately preceding `label` (a regex fragment)."""
    match = re.search(rf"(\d+)\s*{label}", text, re.IGNORECASE)
    return match.group(1) if match else None


def _energy_rating(text: str) -> str | None:
    match = re.search(
        r"(?:certificado|calificaci[óo]n)\s+energ[ée]tic[ao][^A-G]{0,30}\b([A-G])\b",
        text,
        re.IGNORECASE,
    )
    return match.group(1).upper() if match else None


def _address(city: str | None, province: str | None) -> str | None:
    """Servihabitat publishes no street address — only the location slug.

    Returning municipality/province rather than None keeps the fuzzy
    address dedup signal (issue #16 signal 5) with *something* to compare,
    while `lat`/`lon` staying None correctly prevents the stricter
    coordinate-based signal from firing on data it doesn't have.
    """
    parts = [p for p in (city, province) if p]
    return ", ".join(parts) if parts else None


def _photo_urls(json_ld: dict[str, Any], og: dict[str, str]) -> tuple[str, ...]:
    images = json_ld.get("image")
    urls: list[str] = []
    if isinstance(images, str):
        urls = [images]
    elif isinstance(images, list):
        urls = [i for i in images if isinstance(i, str)]
    if not urls and og.get("image"):
        urls = [og["image"]]
    return tuple(
        u if u.startswith("http") else f"https:{u}" if u.startswith("//") else u
        for u in urls
        if u
    )


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
