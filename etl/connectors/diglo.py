"""Diglo connector — Banco Santander's own REO portal (issue #117).

Feasibility spike, 2026-08-05. All findings below are from live requests
with an identifying User-Agent, spaced several seconds apart; none are
assumed.

Domain: the batch (#132) and issue #117 both name `digloservicer.com`.
Confirmed: it resolves, HTTP 200, no WAF challenge. `www.diglo.com` is a
DIFFERENT entity entirely (a US hearing-aids retailer, `Allow: /` sitemap
full of `/hearing-test` / `/shop-by-brand` pages) — a name collision, not
Santander's portal. Do not point this connector at diglo.com.

robots.txt (readable, HTTP 200 — no Incapsula/Akamai wall, unlike Sareb
#121 / Altamira #122): a stock Drupal robots.txt. Only `/core/`,
`/profiles/` and `/README.txt` are disallowed; every listing path
(`/venta-pisos/...`, `/venta-casas/...`) is allowed.

## Discovery: the province buscador, NOT the sitemap (issue #378, 2026-08-06)

The original spike (#117) enumerated via `sitemap.xml`, on the belief it was
the sanctioned, complete, single-request route. **That was wrong, and it is
why this connector shipped 0 priced / all-grade-F on live data.** Re-verified
2026-08-06: the sitemap is badly STALE. 5 of 6 randomly sampled residential
detail URLs from it **302-redirect to the homepage** (the listing was
withdrawn); the live homepage/buscador, meanwhile, links ~915 currently-active
listings whose reference codes **do not appear in the sitemap at all**. So a
sitemap sweep returned a handful of dead URLs; `fetch_detail` silently
followed each 302 to the homepage and parsed *that* (whose `utag_data` is the
empty placeholder) — an "active" listing with no price and no fields.

Discovery now walks the **province buscador** (`/venta-pisos/<province>?page=N`,
paginated with `?page`), which is server-rendered and returns the province's
whole active stock across every property type (six cards per page). Every
card links a LIVE detail URL (verified HTTP 200). `fetch_detail` also guards
the residual case: a URL that 302-redirects to the site root is a listing
withdrawn between discovery and fetch, raised as `ListingUnavailableError`
(a clean skip) rather than parsed as a priceless homepage.

A detail URL's shape (see diglo_mapping.parse_listing_path):
    /venta-pisos/<province>/<municipality>/<refcode>
    /venta-casas/<subtype>/<province>/<municipality>/<refcode>
The reference code (`efe0000200053`, `ib00100180146`) is the last segment
and equals the page's own `utag_data.item_id` uppercased.

Subject-property fields come from THREE embedded sources on the detail
page, all server-rendered (no JS execution needed):
  - `window.utag_data` (the SECOND occurrence — the first is an empty `{}`
    placeholder): a clean analytics blob with `item_id`, `property_price`,
    `property_city`, `property_province`, `property_community` (region),
    `property_type`, `property_date_published`, `operation_type`, and
    `page_name` (the listing title). Authoritative and subject-scoped —
    unlike the page's `.listing-info` cards, which are the "inmuebles
    similares" carousel and carry NEIGHBOURS' figures (the same carousel-
    contamination trap Servihabitat/Vivantial/Solvia each hit).
  - `drupalSettings` JSON (`data-drupal-selector="drupal-settings-json"`):
    `yera_producto_lat` / `yera_producto_lon` — the subject's real
    coordinates. Diglo is the first REO connector in this batch to publish
    lat/lon (Servihabitat, Solvia and Vivantial all lack them), so issue
    #16's `address_coords` dedup signal can finally fire for a servicer.
  - The `.product-print-sheet` block and the description paragraph, for
    the built/useful surface split ("superficie construida de 78,30 m²
    (51,67 m² útiles)") and the icon-stat room/bath counts — both
    subject-scoped, so neither reads the similar-listings carousel.

Fields NOT available, checked explicitly against the issue #132 checklist
and confirmed absent on a real listing page:
  - **No `referencia catastral`.** (Like Servihabitat/Vivantial; unlike
    Solvia.) Asserted in tests so a future site change surfaces.
  - **No postal code** for the property (the only 5-digit code on the page
    is Santander's HQ address in the corporate JSON-LD, not the asset's).
  - **No IBI / community-fee carrying costs.**
"""

from __future__ import annotations

import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    SearchPreview,
    Throttle,
)
from etl.connectors.diglo_mapping import (
    is_residential,
    map_property_type,
    parse_listing_path,
    province_slug,
)
from etl.connectors.extraction import first_present
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://digloservicer.com"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research tool; "
    "contact via github.com/alvarolobato/inmo-tool)"
)

# The province buscador is the LIVE, sanctioned enumeration route. Its path
# type-segment (`venta-pisos`) is only an entry point: the server returns the
# whole province's active stock across every property type (confirmed live
# 2026-08-06 — a Madrid `venta-pisos` page 0 carries casas/locales/oficinas
# cards too), six cards per page, paginated with `?page=N`. discover() walks
# `?page=0,1,2,…` until a page yields no new listings.
_BUSCADOR_PATH = "/venta-{type_seg}/{province}"
# One request per page; a province tops out around a dozen pages. This guard
# only trips on a pathological server that keeps yielding fresh ids forever.
_MAX_PAGES = 60
# A Diglo detail/listing anchor: `/venta-<type>/…/<refcode>`. The buscador
# cards use `<a href="/venta-pisos/madrid/madrid/efe0000200055">`; nav/facet
# links (`/venta-pisos/cualquiera`) have no trailing refcode and are dropped
# by parse_listing_path returning refcode=None.
_HREF_RE = re.compile(r'href="(/venta-[^"?#]+)"')

# The subject property's own print-summary block. It renders the subject's
# price and "78 m² 2 Hab. 1 Baño/s" icon stats and is NOT part of the
# `.listing-info` similar-listings carousel — so scoping room/bath/surface
# reads here avoid attributing a neighbour's figures to the subject.
_SUBJECT_SUMMARY_SELECTOR = ".product-print-sheet"


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
        raise ConnectorError(f"diglo: request failed for {url}: {exc}") from exc
    return response


def buscador_listing_paths(html: str, province: str) -> list[str]:
    """Residential in-province listing paths from one buscador results page.

    Reads every `/venta-…` anchor, keeps those whose tail is a real reference
    code (`parse_listing_path` returns refcode) AND that are residential
    (`pisos`/`casas`) AND in `province` — so nav/facet links (no refcode),
    non-residential stock (locales/garajes), and the cross-province
    "destacados" cards a province page mixes in are all dropped. Order-
    preserving and de-duplicated within the page. Pure; no I/O.
    """
    out: list[str] = []
    seen: set[str] = set()
    for href in _HREF_RE.findall(html):
        parts = parse_listing_path(href)
        if not parts["refcode"]:
            continue
        if not is_residential(parts["type_segment"]):
            continue
        if parts["province_slug"] != province:
            continue
        path = urlsplit(href).path.lstrip("/")
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


def extract_utag_data(html: str) -> dict[str, Any]:
    """Return the populated `window.utag_data` analytics blob.

    The page carries TWO `utag_data` assignments: an empty `{}` placeholder
    near the top and the real, fully-populated one lower down. Iterating and
    keeping the first that actually parses to a dict with `item_id` avoids
    depending on document order. Returns `{}` if neither is found — the
    caller's `first_present` chains fall through to page-scraped fallbacks.
    """
    for block in re.findall(r"utag_data\s*=\s*(\{.*?\})\s*;", html, re.DOTALL):
        try:
            parsed = json.loads(block)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict) and parsed.get("item_id"):
            return parsed
    return {}


def extract_drupal_settings(html: str) -> dict[str, Any]:
    """Return the Drupal `drupalSettings` JSON (coords, node id/title)."""
    match = re.search(
        r'<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except (json.JSONDecodeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _open_graph(soup: BeautifulSoup) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in soup.find_all("meta"):
        prop = (tag.get("property") or "").lower()
        if prop.startswith("og:") and tag.get("content"):
            out[prop[3:]] = tag["content"]
    return out


def _subject_summary_text(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(_SUBJECT_SUMMARY_SELECTOR)
    return node.get_text(" ", strip=True) if node else None


def _description_text(soup: BeautifulSoup, og: dict[str, str]) -> str | None:
    """The subject's own descriptive paragraph.

    The full body copy contains "superficie construida de X m² (Y m²
    útiles)"; og:description is a shorter subject-scoped summary. Both are
    subject-scoped (never the carousel), so either is safe to read surface
    figures from.
    """
    node = soup.find(string=re.compile(r"superficie construida de", re.IGNORECASE))
    if node:
        parent = node.find_parent(["p", "div", "section"])
        if parent:
            text = parent.get_text(" ", strip=True)
            if text:
                return text
    return og.get("description")


def _photo_urls(
    refcode: str, og: dict[str, str], soup: BeautifulSoup
) -> tuple[str, ...]:
    """Subject photos only — scoped by the reference code in the CDN path.

    Diglo hosts asset photos at
    `storage.googleapis.com/.../activos/<region>/<province>/<REFCODE>/...`,
    and the detail page's gallery interleaves the subject's photos with the
    similar-listings carousel's (whose paths carry a DIFFERENT refcode).
    Filtering image URLs to those containing the subject's own uppercased
    refcode keeps neighbour photos out — the CDN path is a cleaner subject
    key than DOM position. og:image (always the subject's) seeds the set.
    """
    ref = refcode.upper()
    urls: list[str] = []
    seen: set[str] = set()

    def _add(u: str | None) -> None:
        if not u:
            return
        u = u.split(" ", 1)[0].strip()
        if u.startswith("//"):
            u = "https:" + u
        if u.startswith("http") and not u.endswith(".svg") and u not in seen:
            seen.add(u)
            urls.append(u)

    if og.get("image") and f"/{ref}/" in og["image"].upper():
        _add(og["image"])
    for img in soup.find_all(["img", "source"]):
        src = img.get("src") or img.get("data-src") or img.get("srcset") or ""
        if f"/{ref}/" in src.upper():
            _add(src)
    return tuple(urls)


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _es_int(text: str | None) -> int | None:
    """First integer in an es-ES surface/count string ("78,30" -> 78)."""
    if not text:
        return None
    match = re.search(r"(\d[\d.]*)", text)
    if not match:
        return None
    digits = match.group(1).split(",", 1)[0].replace(".", "")
    return int(digits) if digits else None


def _surface_built(text: str) -> int | None:
    match = re.search(r"superficie construida de\s*([\d.,]+)\s*m", text, re.IGNORECASE)
    if match:
        return _es_int(match.group(1))
    # The print-summary icon stat, "239 m²".
    match = re.search(r"([\d.,]+)\s*m[²2]\b", text)
    if match:
        return _es_int(match.group(1))
    # Description-only pages spell it out ("de 239,00 metros cuadrados") with
    # no "m²" glyph — the print-sheet is absent on some listings, so this is
    # the only surface figure there (issue #378).
    match = re.search(r"([\d.,]+)\s*metros?\s+cuadrados", text, re.IGNORECASE)
    return _es_int(match.group(1)) if match else None


def _surface_useful(text: str) -> int | None:
    match = re.search(r"\(\s*([\d.,]+)\s*m[²2]\s*[uú]tiles", text, re.IGNORECASE)
    return _es_int(match.group(1)) if match else None


def _first_price(text: str | None) -> str | None:
    """First es-ES price integer ("308.000 €" -> "308000") in a text blob."""
    if not text:
        return None
    match = re.search(r"(\d{1,3}(?:\.\d{3})+)\s*€", text)
    return match.group(1).replace(".", "") if match else None


def _labelled_number(text: str, label: str) -> int | None:
    match = re.search(rf"(\d+)\s*{label}", text, re.IGNORECASE)
    return int(match.group(1)) if match else None


class DigloConnector(Connector):
    name = "diglo"

    # Conservative, matching Servihabitat: a sitemap sweep is a burst of
    # detail fetches rather than one search page, and this is a low-traffic
    # servicer portal we want to be a quiet guest on.
    rate_limit_per_minute = 12

    # The province buscador is paginated to exhaustion (`?page=0,1,2,…` until
    # a page yields nothing), so one sweep sees the province's whole active
    # stock — a listing absent for the withdrawal threshold is a genuine
    # withdrawal, not a pagination artefact. Guarded by discover() raising
    # (not returning []) when page 0 carries no recognisable listing cards, so
    # a fetch glitch / markup change can't read as "the whole catalogue was
    # withdrawn". (Before #378 this rode on sitemap.xml, which turned out to
    # be stale — see the module docstring.)
    discovers_full_inventory = True

    # Issue #478: an owner-pinned diglo URL may become this connector's recall
    # source for a profile (discover() wiring is Phase 5).
    override_host_suffix = "digloservicer.com"

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved province slug IS the coverage key: two scopes in the
        same province filter the identical national sitemap.

        Must never raise (the orchestrator calls it with no try/except), so
        an unresolvable center becomes a sentinel key rather than
        propagating UnresolvableGeographyError — see servihabitat.py."""
        try:
            province = self._scope_province(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        return province

    @staticmethod
    def _scope_province(scope: ConnectorScope) -> str | None:
        """Resolve a scope to a Diglo province slug, or None if unmapped.

        `scope.geography` (the free-text escape hatch) wins when set, for
        tests/manual construction. Otherwise resolve `scope.center` via the
        shared gazetteer and slugify its province — no hardcoded default
        (issue #71): a point that resolves to no known place raises
        UnresolvableGeographyError from resolve_place; a resolved place just
        yields its province slug (every Spanish province appears in the
        national sitemap, so there is no per-province coverage table to
        miss, unlike Servihabitat).
        """
        if scope.geography:
            return province_slug(scope.geography)
        place = resolve_place(scope)
        if place is None:
            return None
        return province_slug(place.province)

    @staticmethod
    def _search_url(province: str, page: int) -> str:
        """The province buscador page discover() paginates over. Shared by
        discover() and search_previews() so the preview can't drift."""
        base_path = _BUSCADOR_PATH.format(type_seg="pisos", province=province)
        return f"{_BASE_URL}{base_path}?page={page}"

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses `_search_url()` — the exact helper discover()'s entry page
        (`page=0`) is built from."""
        try:
            province = self._scope_province(scope)
        except UnresolvableGeographyError:
            province = None
        if province is None:
            return [
                SearchPreview(
                    label="Diglo",
                    url=None,
                    kind="search_page",
                    tunable=True,
                    notes="El perfil no resuelve a una provincia que este conector cubra.",
                )
            ]
        return [
            SearchPreview(
                label=f"Diglo — {province}",
                url=self._search_url(province, 0),
                kind="search_page",
                tunable=True,
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        province = self._scope_province(scope)
        if province is None:
            raise ConnectorError(
                "diglo discover: scope has neither a resolvable center nor an "
                "explicit geography string — nothing to discover, and not "
                "defaulting to a hardcoded province (issue #71)"
            )

        external_ids: list[str] = []
        seen: set[str] = set()
        pages_walked = 0
        for page in range(_MAX_PAGES):
            url = self._search_url(province, page)
            response = _get(url, throttle)
            pages_walked += 1
            page_paths = buscador_listing_paths(response.text, province)
            if page == 0 and not page_paths:
                # The province's first buscador page carries no residential
                # listing card. Distinguish "the buscador markup changed / this
                # isn't a results page" (raise, so an empty result can't read
                # as a mass withdrawal for a discovers_full_inventory=True
                # connector) from "a valid results page that is genuinely empty
                # for this province" (a small province with no Diglo stock —
                # return []). The results grid / count header is the tell.
                text = response.text
                if "views-infinite-scroll" not in text and "inmueble" not in text:
                    raise ConnectorError(
                        "diglo discover: first buscador page did not look like a "
                        f"results page ({url}) — the buscador markup or path "
                        "scheme likely changed; refusing to report an empty "
                        "catalogue"
                    )
                break
            new = [p for p in page_paths if p not in seen]
            if not new:
                break  # no fresh listings on this page — pagination exhausted
            for path in new:
                seen.add(path)
                external_ids.append(path)

        logger.info(
            "diglo discover: province=%s walked %d buscador page(s), %d "
            "residential in-province listings kept",
            province,
            pages_walked,
            len(external_ids),
        )
        return sorted(external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_BASE_URL}/{external_id.lstrip('/')}"
        response = _get(url, throttle)
        # A withdrawn Diglo listing 302-redirects to the site root; requests
        # follows it, so `response.url` ends at `/` and `response.text` is the
        # homepage (empty utag_data placeholder). Parsing that yields a
        # priceless "active" listing — exactly the 0-priced / grade-F bug this
        # connector shipped (#378). Treat it as a listing removed between
        # discovery and fetch: a clean skip, not a broken active listing.
        final_url = getattr(response, "url", None)
        if final_url is not None and urlsplit(final_url).path.strip("/") == "":
            raise ListingUnavailableError(
                f"diglo fetch_detail: {url} redirected to the site root "
                f"({final_url}) — the listing was withdrawn between discovery "
                "and fetch"
            )
        html = response.text
        soup = BeautifulSoup(html, "html.parser")
        og = _open_graph(soup)
        parts = parse_listing_path(external_id)
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={
                "url": url,
                "utag": extract_utag_data(html),
                "drupal": extract_drupal_settings(html),
                "og": og,
                "path_parts": parts,
                "summary_text": _subject_summary_text(soup),
                "description": _description_text(soup, og),
                "photo_urls": _photo_urls(parts["refcode"] or "", og, soup),
            },
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        data: dict[str, Any] = raw.raw
        utag: dict[str, Any] = data.get("utag") or {}
        drupal: dict[str, Any] = data.get("drupal") or {}
        og: dict[str, str] = data.get("og") or {}
        parts: dict[str, Any] = data.get("path_parts") or {}
        summary_text: str = data.get("summary_text") or ""
        description: str | None = data.get("description")
        desc_for_surface = description or summary_text

        price = first_present(
            # utag_data.property_price is the subject's own price, unlike any
            # text scan which could hit the similar-listings carousel.
            lambda: _decimal_or_none(utag.get("property_price")),
            # Fallback: the subject's `.product-print-sheet` price. Scoped to
            # that block in fetch_detail, so it is subject-only — the carousel
            # `.listing-info` prices never reach summary_text.
            lambda: _decimal_or_none(_first_price(summary_text)),
            field="current_price",
        )
        # Try BOTH subject sources, not `description or summary_text`: the
        # `.product-print-sheet` icon-stat ("239 m²") and the description
        # ("de 239,00 metros cuadrados") each carry the surface on different
        # listings, and picking only one silently dropped m2_built on pages
        # where the chosen source lacked it (the 0-priced batch's grade-F
        # driver, alongside price — issue #378). Both are subject-scoped, so
        # neither reads the similar-listings carousel.
        m2_built = first_present(
            lambda: (
                Decimal(_surface_built(summary_text))
                if _surface_built(summary_text) is not None
                else None
            ),
            lambda: (
                Decimal(_surface_built(description))
                if description and _surface_built(description) is not None
                else None
            ),
            field="m2_built",
        )
        useful = _surface_useful(desc_for_surface)
        m2_useful = Decimal(useful) if useful is not None else None

        rooms = first_present(
            lambda: _labelled_number(summary_text, r"Hab"),
            lambda: (
                _labelled_number(description, "habitacion") if description else None
            ),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: _labelled_number(summary_text, r"Ba[ñn]o"),
            field="bathrooms",
        )

        lat = _decimal_or_none(drupal.get("yera_producto_lat"))
        lon = _decimal_or_none(drupal.get("yera_producto_lon"))

        city = first_present(
            lambda: utag.get("property_city"),
            lambda: parts.get("municipality_slug"),
            field="city",
        )
        province = first_present(
            lambda: utag.get("property_province"),
            lambda: parts.get("province_slug"),
            field="province",
        )
        address = first_present(
            # utag.page_name is the listing's own title ("VIV CALLE MENDIVIL,
            # 44 - BAJO 1") — carries the street, and unlike og:title has no
            # " en venta | Diglo" marketing suffix.
            lambda: utag.get("page_name"),
            lambda: drupal.get("node_title"),
            lambda: og.get("title"),
            field="address",
        )

        reference_code = first_present(
            lambda: utag.get("item_id"),
            lambda: (parts.get("refcode") or "").upper() or None,
            field="reference_code",
        )
        property_type = first_present(
            lambda: map_property_type(parts.get("type_segment")),
            field="property_type",
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=data.get("url"),
            # Diglo is Santander's servicer selling bank-owned stock — every
            # listing is institutional, never a private seller. 'agency'
            # (rather than None) is load-bearing for issue #16's phone-
            # corroboration rule, which never auto-merges when either side
            # is an agency.
            listing_kind="agency",
            status="active",
            current_price=price,
            description=description,
            photo_urls=tuple(data.get("photo_urls") or ()),
            contact_raw=None,
            address=address,
            # First REO connector in this batch to publish real coordinates
            # (drupalSettings.yera_producto_lat/lon) — enables issue #16's
            # address_coords dedup signal for a servicer source.
            lat=lat,
            lon=lon,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=m2_useful,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=city,
            province=province,
            # No property postal code published — the only 5-digit code on
            # the page is Santander's HQ in the corporate JSON-LD. Asserted
            # None in tests so a future change surfaces.
            postal_code=None,
            features=(),
            operation="sale",
            reference_code=reference_code,
            # No referencia catastral published (like Servihabitat/Vivantial,
            # unlike Solvia). Left None; asserted in tests.
            cadastral_ref=None,
            raw_extra={
                "refcode": parts.get("refcode"),
                "type_segment": parts.get("type_segment"),
                "subtype_segment": parts.get("subtype_segment"),
                "province_slug": parts.get("province_slug"),
                "municipality_slug": parts.get("municipality_slug"),
                "property_community": utag.get("property_community"),
                "property_type_raw": utag.get("property_type"),
                "date_published": utag.get("property_date_published"),
                "node_id": drupal.get("node_id"),
                "is_offerable": drupal.get("is_offerable"),
                "is_visitable": drupal.get("is_visitable"),
            },
        )
