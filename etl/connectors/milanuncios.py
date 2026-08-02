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

Issue #78 retrofit spike (2026-08, 3 fresh real listings beyond the
original Phase 2.1 sample): confirmed Milanuncios detail pages embed a
`<script type="application/ld+json">` block, but it's a `BreadcrumbList`
navigation schema only — no `Accommodation`/`Apartment` schema.org data
(`_has_usable_jsonld_property_schema` below codifies this as an executable
check, not just a comment claim — if a future site update adds real
JSON-LD listing data, that function starts returning True and the
fallback chains below should gain a JSON-LD getter). Also confirmed the
site renders its visible "N hab · N baños · N m²" stats client-side from
this same JSON (not present in the raw server HTML at all), so — unlike
Fotocasa — there's no CSS-selector fallback available for those stats.

What the retrofit *does* use as a fallback (Opus review, PR #85, must-fix:
the original retrofit had zero fallback for rooms/bathrooms/m2_built):
Milanuncios' free-text `ad.description` routinely spells the same stats
out in prose (e.g. "353 m2 construidos distribuidos en 4 habitaciones y 3
banios", confirmed in the committed fixture) — `_description_stat` below
regex-extracts these as a second source if the primary `ad.attributes`
JSON shape is ever renamed. Also found real, previously-unmined data for:
an `energyCertificate` attribute (missed by the original spike's smaller
sample — present on 2 of 3 fresh listings) and `heating`/`hotWater`
attributes, now surfacing into `energy_rating` and `features`
respectively.
"""

from __future__ import annotations

import json
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
from etl.connectors.extraction import first_present, text_to_int
from etl.connectors.geography import nearest_city
from etl.connectors.milanuncios_mapping import (
    attribute_numeric_value,
    attribute_value,
    energy_rating_value,
    extra_features,
    infer_listing_kind,
    infer_operation,
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
        # `value` was genuinely present but not parseable -- worth a log,
        # unlike the `value is None` case above which is normal/expected
        # for an unset attribute (Opus review, PR #85, mirroring #77's
        # extraction.first_present logging discipline).
        logger.warning("milanuncios: could not parse %r as Decimal", value)
        return None


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        logger.warning("milanuncios: could not parse %r as int", value)
        return None


# Fallback source for rooms/bathrooms/m2_built when `ad.attributes` doesn't
# carry them (issue #78 must-fix) -- Milanuncios' free-text description
# routinely spells these stats out in prose, e.g. "353 m2 construidos
# distribuidos en 4 habitaciones y 3 banios".
_ROOMS_DESC_RE = re.compile(r"(\d+)\s*habitaci(?:o|ó)n", re.IGNORECASE)
# Handles every real spelling variant seen across this codebase's fixtures
# and real Spanish text: "baño"/"baños" (proper), "bano"/"banos" (accent
# stripped), "banio"/"banios" (this project's own fixtures' transliteration,
# e.g. milanuncios_sample_detail.html's attribute fieldFormatted="banios").
_BATHROOMS_DESC_RE = re.compile(r"(\d+)\s*ba[ñn]?i?os?\b", re.IGNORECASE)
_M2_DESC_RE = re.compile(r"(\d[\d.,]*)\s*m(?:2|²)\b", re.IGNORECASE)

# Deliberately no price-from-description fallback: unlike a room/bathroom/m2
# count, a price mentioned in free text is often negotiable/approximate
# ("negociable", a previous price being referenced, a monthly-installment
# figure) rather than the actual listing price, and misreading one would
# feed a wrong number straight into an investment decision. The JSON price
# field is also core to the site's own display, making it a much lower-risk
# field to rename than a descriptive attribute -- revisit if it ever proves
# to actually go missing in practice.


def _description_stat(pattern: re.Pattern[str], description: str | None) -> str | None:
    """Regex-extract a stat from the free-text description (fallback source
    when `ad.attributes` is renamed/restructured)."""
    if not description:
        return None
    match = pattern.search(description)
    return match.group(1) if match else None


_JSONLD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def _has_usable_jsonld_property_schema(html: str) -> bool:
    """Check whether the page's JSON-LD carries schema.org property/listing
    data, not just a `BreadcrumbList` navigation schema.

    Confirmed False on real Milanuncios pages during issue #78's retrofit
    spike (3 fresh listings, 2026-08) -- this makes that a real, executable
    check instead of a comment-only claim (Opus review, PR #85). If a
    future site update adds real listing data here, this starts returning
    True and the fallback chains in `normalize()` should gain a JSON-LD
    getter ahead of the description-text fallback.
    """
    for block in _JSONLD_RE.findall(html):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if isinstance(entry, dict) and entry.get("@type") not in (
                None,
                "BreadcrumbList",
            ):
                return True
    return False


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

        description = ad.get("description")

        # Fallback chain (issue #78 must-fix): `ad.attributes`' embedded
        # JSON is the primary source; the free-text description (see
        # `_description_stat`) recovers the value if that JSON structure is
        # ever renamed. No CSS-selector fallback exists here, unlike
        # Fotocasa -- confirmed live these stats render client-side from
        # this same JSON, not present in the raw server HTML at all.
        rooms = _to_int(
            first_present(
                lambda: attribute_numeric_value(attributes, "bedrooms"),
                lambda: text_to_int(_description_stat(_ROOMS_DESC_RE, description)),
                field="rooms",
            )
        )
        bathrooms = _to_int(
            first_present(
                lambda: attribute_numeric_value(attributes, "bathrooms"),
                lambda: text_to_int(_description_stat(_BATHROOMS_DESC_RE, description)),
                field="bathrooms",
            )
        )
        m2_built = _to_decimal(
            first_present(
                lambda: attribute_numeric_value(attributes, "squareMeters"),
                lambda: text_to_int(_description_stat(_M2_DESC_RE, description)),
                field="m2_built",
            )
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(ad.get("sellerType")),
            status="active",
            current_price=_to_decimal(cash_price.get("value")),
            description=description,
            photo_urls=photo_urls,
            contact_raw=author.get("userName"),
            address=address,
            lat=_to_decimal(geolocation.get("latitude")),
            lon=_to_decimal(geolocation.get("longitude")),
            property_type=map_property_type(category.get("slug")),
            m2_built=m2_built,
            m2_useful=None,  # not distinguished from squareMeters in the
            # attributes observed during the feasibility spike — revisit if
            # a sampled listing shows both built and useful area separately.
            rooms=rooms,
            bathrooms=bathrooms,
            floor=attribute_value(attributes, "floor"),  # human-readable
            # (valueFormatted, e.g. "bajo") via attribute_value's own
            # valueFormatted-first lookup — see milanuncios_mapping.py.
            has_elevator=None,  # no elevator attribute observed across the
            # combined sample (17 listings, Phase 2.1 spike + 3 more,
            # issue #78) — left None rather than guessed; revisit if a
            # future listing/category shows one.
            year_built=None,  # no construction-year attribute observed
            # across the same combined sample — same reasoning as
            # has_elevator.
            energy_rating=first_present(
                lambda: energy_rating_value(attributes),
                field="energy_rating",
            ),
            # A real `energyCertificate` attribute (2/3 fresh sampled
            # listings, issue #78) — missed by the original Phase 2.1
            # spike's smaller sample, not actually absent from the site.
            # `energy_rating_value` prefers a bare A-G letter over
            # Milanuncios' own formatting, which can be a non-letter state
            # like "En trámite"/"Exento" — see milanuncios_mapping.py.
            # JSON-LD was live-checked as a second source (issue #78's own
            # acceptance criterion) and confirmed to carry only a
            # `BreadcrumbList` nav schema (`_has_usable_jsonld_property_
            # schema` codifies this check) — not usable for this or any
            # other field. Wrapped in `first_present` anyway (not called
            # directly) so a second real source, if one is ever found,
            # slots in as an added getter rather than a rewrite.
            city=(location.get("city") or {}).get("name"),
            province=(location.get("province") or {}).get("name"),
            postal_code=None,  # no postal/zip field observed anywhere in
            # `ad.location` across the sample (issue #78) — Milanuncios
            # only ever publishes city/province granularity, unlike
            # Fotocasa's `zipCode`. Confirmed absent, not unmapped.
            m2_plot=None,  # no plot/land-area attribute observed for the
            # `venta-de-pisos` (flat/apartment) category this connector's
            # discover() is scoped to — `venta-de-terrenos`/`venta-de-
            # fincas` (land/rural-estate categories, already present in
            # CATEGORY_SLUG_MAP for future use) are the categories where
            # a plot size would actually apply; out of scope until
            # discover() covers those categories too.
            features=extra_features(attributes),
            operation=infer_operation(category.get("slug")),
            # Not cross-checked against raw.raw["url"] (Opus review, PR #85,
            # considered and rejected): fetch_detail()'s request URL is the
            # fully generic "/x/x-<id>.htm" (the title/category slug is a
            # literal placeholder, confirmed by fetch_detail's own docstring
            # -- "No redirect needed... this URL shape returns the real ad's
            # HTML directly"), so raw.raw["url"] never carries real category
            # info to cross-check against, unlike Fotocasa's canonical-slug
            # redirect. category.slug (already used above) remains the only
            # real source for this.
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
