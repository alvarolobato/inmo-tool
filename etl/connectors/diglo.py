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
(`/venta-pisos/...`, `/venta-casas/...`) is allowed, and it advertises its
own sitemap:

    Sitemap: https://digloservicer.com/sitemap.xml

Discovery uses that sitemap — a single national document (2,743 <loc>
entries, of which ~987 are property detail URLs; the rest are category /
facet / editorial pages). The province search pages (`/venta-pisos/
cualquiera`) render only ~6 cards server-side and load the rest via Drupal
Views AJAX, so the sitemap is both the sanctioned and the far cleaner
enumeration route — one request yields the whole catalogue with each
property's type/province/municipality/reference-code already in the URL.

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
from xml.etree import ElementTree

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
_SITEMAP_URL = f"{_BASE_URL}/sitemap.xml"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research tool; "
    "contact via github.com/alvarolobato/inmo-tool)"
)
_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

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


def _sitemap_locs(xml_text: str) -> list[str]:
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ConnectorError(f"diglo: sitemap is not valid XML: {exc}") from exc
    return [
        el.text.strip()
        for el in root.iter(f"{_SITEMAP_NS}loc")
        if el.text and el.text.strip()
    ]


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
    # Fallback: the print-summary "78 m²" figure.
    match = re.search(r"([\d.,]+)\s*m[²2]", text)
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

    # The national sitemap is the site's own complete, single-request
    # enumeration and robots.txt is permissive (the buscador even exposes a
    # cross-checkable per-province count) — the same clean full-sweep shape
    # BuildingCenter (#118) and Cimenta2 (#136) earned True on. discover()
    # returns every active property for its scope every sweep, so a listing
    # absent for the withdrawal threshold is a genuine withdrawal, not a
    # pagination artefact. Guarded by discover() raising (not returning [])
    # on an empty or unrecognised sitemap, so a fetch glitch can't read as
    # "the whole catalogue was withdrawn".
    discovers_full_inventory = True

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

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        province = self._scope_province(scope)
        if province is None:
            raise ConnectorError(
                "diglo discover: scope has neither a resolvable center nor an "
                "explicit geography string — nothing to discover, and not "
                "defaulting to a hardcoded province (issue #71)"
            )

        response = _get(_SITEMAP_URL, throttle)
        locs = _sitemap_locs(response.text)
        if not locs:
            raise ConnectorError(
                "diglo discover: sitemap had zero <loc> entries — refusing to "
                "report an empty catalogue (would read as a mass withdrawal)"
            )

        recognised_detail_urls = 0
        external_ids: list[str] = []
        seen: set[str] = set()
        skipped_non_residential = 0
        for loc in locs:
            parts = parse_listing_path(loc)
            if not parts["refcode"]:
                continue
            recognised_detail_urls += 1
            if not is_residential(parts["type_segment"]):
                skipped_non_residential += 1
                continue
            if parts["province_slug"] != province:
                continue
            # external_id is the URL path, not the bare refcode: the detail
            # URL needs the full type/province/municipality slug and cannot
            # be rebuilt from the refcode alone. The refcode is carried
            # through as reference_code (#72) so a re-slugged listing stays
            # recoverable by the dedup engine even if its path changes.
            path = urlsplit(loc).path.lstrip("/")
            if path in seen:
                continue
            seen.add(path)
            external_ids.append(path)

        if recognised_detail_urls == 0:
            raise ConnectorError(
                "diglo discover: sitemap had entries but none matched the "
                "property-detail URL shape — the URL scheme likely changed; "
                "refusing to report an empty catalogue"
            )

        logger.info(
            "diglo discover: province=%s sitemap had %d entries, %d property "
            "URLs, %d residential in-province kept, %d non-residential skipped",
            province,
            len(locs),
            recognised_detail_urls,
            len(external_ids),
            skipped_non_residential,
        )
        return sorted(external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_BASE_URL}/{external_id.lstrip('/')}"
        response = _get(url, throttle)
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
        m2_built = first_present(
            lambda: (
                Decimal(_surface_built(desc_for_surface))
                if _surface_built(desc_for_surface) is not None
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
