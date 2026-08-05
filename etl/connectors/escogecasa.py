"""Escogecasa connector — Abanca's own REO portal (issue #135).

Feasibility spike, 2026-08-05. All findings below are from live requests with
an identifying User-Agent, spaced several seconds apart; none are assumed.

Domain: issue #135 named `escogecasa.com`, but that host no longer resolves
(authoritative DNS **SERVFAIL** from Google 8.8.8.8 and Cloudflare 1.1.1.1
alike — a decommissioned domain, not a local glitch). The canonical, live
domain is **`escogecasa.es`** (Apache/Debian, HTTP 200, no WAF/CAPTCHA). The
issue asked to confirm the domain during the spike; this is the confirmation.

robots.txt (`escogecasa.es/robots.txt`, HTTP 200) is permissive: `User-agent:
* / Allow: /`, disallowing only `/nogooglebot/` and `/print_inmueble/`. The
listing/detail paths a connector needs are all allowed.

This is a legacy server-rendered Java app (JSESSIONID, ISO-8859-1) whose
map-based search results are injected via an iframe target — the search
*results loader* is what a connector drives, not the SPA-ish result page:

  - **Search** (`/buscador/cargar_resultados.jsp`): a POST of the map form
    (`lat`/`lng`/`zoom` + the map's bounding box `lat_min`/`lat_max`/
    `lng_min`/`lng_max`, plus `tgs=1`=VIVIENDAS, `srtp=1`, `pag`). The
    response is JavaScript that calls `parent.createMarker(id, lat, lon,
    'subtipo - precio', '<card html>', estado)` once per result. That single
    payload already carries, per listing: the internal id, **real lat/lon**
    (Escogecasa is the third REO connector in this batch, after Diglo and
    Unicaja, to publish coordinates), subtipo, built surface, price, the
    detail-page URL, and a photo — a rich discovery-time signal (coords +
    price), so `discovered_prices()` is wired up (like Fotocasa).

    A single bbox is **capped at ~100 markers** and `pag` does not extend
    past it (live-verified: an all-Spain bbox returned 103 markers on page 0
    and 0 on pages 1–3) — so one `discover()` sweep over a scope's
    center/radius bbox sees only that box's first ~100 results, NOT the
    connector's whole inventory. Hence `discovers_full_inventory = False`
    (the Fotocasa lesson: a partial, relevance/zoom-capped sweep must never
    drive withdrawal detection).

  - **Detail** (`/detalle-<subtipo>-en-venta-en-<municipio>-en-<provincia>/
    <refpublica>/<idinterno>/`): server-rendered. Every SUBJECT field is in
    a `dato_`-prefixed element — `dato_precio`, `dato_habs`, `dato_banos`,
    `dato_sup_util`, `dato_sup_cons`, `dato_referencia` (the public ref, =
    the URL's `<refpublica>` segment), `dato_cp` (**postal code** — present
    here, unlike Diglo/Unicaja), `dato_direccion`, `dato_anyocons` (**year
    built**), an energy-rating certificate title, `li_ascensor`, and
    `capa_descripcion`. The page ALSO renders a "similar listings" carousel
    whose cards use the *un-prefixed* classes `habs`/`bans`/`superficie`/
    `precio`/`referencia` — so the `dato_` prefix is itself the subject
    scope, and reading only `dato_*` avoids the carousel-contamination trap
    Diglo/Servihabitat/Vivantial each had to work around.

Fields NOT published, checked against the issue #132 checklist and asserted
None in tests so a future change surfaces: **no referencia catastral**.

Overlap: Escogecasa is Abanca's own stock (ex-Novagalicia), concentrated in
Galicia and the northern coast — geographically additive to the current
Madrid/Levante-weighted fleet, and not consolidated onto any existing
connector's source (unlike Kutxabank→Servihabitat, issue #137).
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
from etl.connectors.escogecasa_mapping import (
    bbox_from_center,
    is_residential,
    map_property_type,
    parse_es_price,
    parse_es_surface,
    parse_int,
)
from etl.connectors.extraction import first_present
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://www.escogecasa.es"
_SEARCH_ACTION = f"{_BASE_URL}/buscador/cargar_resultados.jsp"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research tool; "
    "contact via github.com/alvarolobato/inmo-tool)"
)

# Default box half-size when a scope carries no radius. 30 km comfortably
# covers a city and its metropolitan ring without ballooning the ~100-marker
# cap's effective density.
_DEFAULT_RADIUS_KM = 30.0
# Hard page guard: one bbox is capped near 100 markers and `pag` does not
# extend it, so this only ever trips on a pathological server that keeps
# yielding new ids — never in normal operation.
_MAX_PAGES = 40
# tgs=1 = the site's VIVIENDAS category; srtp=1 the default sort.
_TGS_VIVIENDAS = "1"


def _get(
    url: str, throttle: Throttle, *, session: requests.Session
) -> requests.Response:
    throttle()
    try:
        response = session.get(
            url,
            headers={"User-Agent": _USER_AGENT},
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise ConnectorError(f"escogecasa: request failed for {url}: {exc}") from exc
    return response


def _post(
    url: str, data: dict[str, str], throttle: Throttle, *, session: requests.Session
) -> requests.Response:
    throttle()
    try:
        response = session.post(
            url,
            data=data,
            headers={"User-Agent": _USER_AGENT},
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise ConnectorError(f"escogecasa: request failed for {url}: {exc}") from exc
    return response


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


# A createMarker(...) call from the search-results loader. The 5 leading
# single-quoted args are id, lat, lon, 'subtipo - precio' label, then the
# card-HTML arg (which itself contains single quotes in onclick handlers, so
# it is matched non-greedily up to the ',<estado>')` tail).
_CREATE_MARKER_RE = re.compile(
    r"createMarker\('([^']*)','([^']*)','([^']*)','[^']*','(.*?)','([^']*)'\)",
    re.DOTALL,
)
_CARD_HREF_RE = re.compile(r'href="(/detalle-[^"]+?)"')
_CARD_SUBTIPO_RE = re.compile(r'map_ficha_subtipo">\s*([^<]+?)\s*<')
_CARD_SUP_RE = re.compile(r'map_ficha_sup">\s*([^<]+?)\s*<')
_CARD_PRECIO_RE = re.compile(r'map_ficha_precio">\s*([^<]+?)\s*<')
_CARD_FOTO_RE = re.compile(r'<img src="([^"]+)"')


def _path_from_href(href: str) -> str:
    """`/detalle-.../ref/id/` -> `detalle-.../ref/id` (external_id form)."""
    return href.strip().strip("/")


def markers_from_search(html: str) -> list[dict[str, Any]]:
    """Parse every createMarker(...) call in a search-results response.

    Each dict carries the discovery-time signal for one listing: the detail
    `path` (used as external_id), the internal `id`, `lat`/`lon`, `subtipo`,
    built `m2`, `price`, and `foto`. Pure; no I/O.
    """
    out: list[dict[str, Any]] = []
    for m in _CREATE_MARKER_RE.finditer(html):
        raw_id, lat, lon, card, estado = m.groups()
        href = _CARD_HREF_RE.search(card)
        if not href:
            continue
        path = _path_from_href(href.group(1))
        subtipo = _CARD_SUBTIPO_RE.search(card)
        sup = _CARD_SUP_RE.search(card)
        precio = _CARD_PRECIO_RE.search(card)
        foto = _CARD_FOTO_RE.search(card)
        out.append(
            {
                "path": path,
                # I_50996 -> 50996 (the internal id, = the URL's last segment).
                "id": raw_id.replace("I_", "", 1),
                "lat": lat or None,
                "lon": lon or None,
                "subtipo": subtipo.group(1) if subtipo else None,
                "m2": sup.group(1) if sup else None,
                "price": precio.group(1) if precio else None,
                "foto": foto.group(1) if foto else None,
                "estado": estado or None,
            }
        )
    return out


def _dato_value(html: str, css_class: str) -> str | None:
    """The `dato_value` text inside a subject `dato_<css_class>` block.

    Anchored on the `dato_`-prefixed class so it can never read a similar-
    listings carousel card (those use the un-prefixed `habs`/`bans`/
    `precio`/`referencia` classes). Each `dato_*` class occurs once for the
    subject; a `dato_label` span (e.g. "Ref: ") may sit before the value, so
    this takes the FIRST `dato_value` span AFTER the class marker.
    """
    anchor = re.search(rf'class="{re.escape(css_class)}"', html)
    if not anchor:
        return None
    value = re.search(
        r'<span class="dato_value">\s*(.*?)\s*</span>',
        html[anchor.end() :],
        re.DOTALL,
    )
    if not value:
        return None
    text = re.sub(r"<[^>]+>", "", value.group(1))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def extract_energy_rating(html: str) -> str | None:
    """The A–G energy-consumption grade from the certificate image title.

    The subject block renders `<p class="dato_efic energia">...<img ...
    title='Calificación de eficiencia energética "E"'>`. The grade letter is
    the one in quotes in that title (the `cer_<X>.jpg` image filename is a
    fixed scale graphic and does NOT track the grade — cer_G.jpg carried an
    "E" title on a real page, so the title is authoritative, the filename is
    not). Scoped to `dato_efic energia` (Consumo), not the sibling
    `dato_efic` (Emisiones), so it reads the energy grade, not the CO2 one.
    """
    m = re.search(r'class="dato_efic energia"(.*?)</p>', html, re.DOTALL)
    scope = m.group(1) if m else html
    # The grade sits right after "energética" in quotes — which a real page
    # renders as literal `"E"` (malformed-but-real) and a well-formed fixture
    # may escape as `&quot;E&quot;`. Accept either quote encoding.
    grade = re.search(
        r'energ[eé]tica\s*(?:&quot;|&#34;|")\s*([A-G])\b',
        scope,
        re.IGNORECASE,
    )
    return grade.group(1).upper() if grade else None


def extract_features(html: str) -> tuple[str, ...]:
    """Characteristic labels from the subject `capa_caracteristicas` list."""
    m = re.search(r'id="capa_caracteristicas".*?<ul>(.*?)</ul>', html, re.DOTALL)
    if not m:
        return ()
    feats: list[str] = []
    for title in re.findall(r'<li[^>]*title="([^"]+)"', m.group(1)):
        t = title.strip()
        if t and t not in feats:
            feats.append(t)
    return tuple(feats)


def extract_description(html: str) -> str | None:
    m = re.search(r'id="capa_descripcion".*?<p>(.*?)</p>', html, re.DOTALL)
    if not m:
        return None
    text = re.sub(r"<[^>]+>", " ", m.group(1))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def extract_photos(html: str, internal_id: str) -> tuple[str, ...]:
    """Full-size subject photos, filtered to the subject's own internal id.

    Photos live at `/inmuebles/fotos/<n>/<internalid>_<k>.jpg`; the similar-
    listings carousel interleaves neighbours' photos (a DIFFERENT internal
    id), so filtering the path on `/<internalid>_` keeps only the subject's.
    """
    urls: list[str] = []
    seen: set[str] = set()
    for src in re.findall(r"/inmuebles/fotos/\d+/\d+_\d+\.jpg", html):
        if f"/{internal_id}_" not in src:
            continue
        url = _BASE_URL + src
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return tuple(urls)


class EscogecasaConnector(Connector):
    name = "escogecasa"

    # Conservative, matching the other REO connectors in the batch: a bbox
    # sweep is one search POST plus a detail fetch per listing, on a legacy
    # bank portal we want to be a quiet guest on.
    rate_limit_per_minute = 12

    # One bbox is capped at ~100 markers and `pag` does not extend past it
    # (live-verified) — so a sweep sees only the first ~100 results in the
    # scope's box, NOT the connector's full inventory. Absence from a partial
    # sweep says nothing about withdrawal (the Fotocasa lesson), so this is
    # honestly False.
    discovers_full_inventory = False

    def __init__(self) -> None:
        # Discovery-time createMarker data keyed by external_id (detail path).
        # fetch_detail reads it back to recover coordinates (the detail page
        # has none) and as price/type/built-surface fallbacks. Rebuilt each
        # discover() call so stale cross-scope data never leaks.
        self._markers: dict[str, dict[str, Any]] = {}

    def discovered_prices(self) -> dict[str, Decimal]:
        """Search-page prices, keyed by external_id — a real, free signal
        (the createMarker label carries each listing's price). Enables the
        orchestrator to force a re-fetch on a price change even inside the
        refetch window."""
        out: dict[str, Decimal] = {}
        for ext_id, marker in self._markers.items():
            price = _decimal_or_none(parse_es_price(marker.get("price")))
            if price is not None:
                out[ext_id] = price
        return out

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """A stable key for the scope's box. Must never raise (the
        orchestrator calls it with no try/except)."""
        if scope.geography:
            return f"escogecasa-geo:{scope.geography}"
        try:
            place = resolve_place(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        if place is None:
            return None
        return f"escogecasa:{place.province}:{place.name}"

    def _scope_bbox(
        self, scope: ConnectorScope
    ) -> tuple[float, float, float, float, float, float, str] | None:
        """Resolve a scope to (lat, lon, lat_min, lat_max, lng_min, lng_max,
        term), or None if it carries no usable geography.

        `scope.geography` (the free-text escape hatch) is parsed as a
        "lat,lon" pair for this coordinate-native connector — clean for
        tests/manual construction. Otherwise `scope.center` is resolved via
        the shared gazetteer (validating it is a real Spanish place and
        supplying the search `term`), and a box is built from center+radius.
        No hardcoded default (issue #71).
        """
        radius = scope.radius_km or _DEFAULT_RADIUS_KM
        if scope.geography:
            parts = scope.geography.split(",")
            if len(parts) < 2:
                return None
            try:
                lat = float(parts[0])
                lon = float(parts[1])
            except ValueError:
                return None
            if len(parts) >= 3:
                try:
                    radius = float(parts[2])
                except ValueError:
                    pass
            term = ""
        elif scope.center is not None:
            place = resolve_place(scope)  # raises UnresolvableGeographyError
            if place is None:
                return None
            lat, lon = scope.center
            term = place.name
        else:
            return None
        lat_min, lat_max, lng_min, lng_max = bbox_from_center(lat, lon, radius)
        return (lat, lon, lat_min, lat_max, lng_min, lng_max, term)

    def _search_data(
        self,
        box: tuple[float, float, float, float, float, float, str],
        page: int,
        n: int,
    ) -> dict[str, str]:
        lat, lon, lat_min, lat_max, lng_min, lng_max, term = box
        return {
            "term": term,
            "lat": f"{lat:.6f}",
            "lng": f"{lon:.6f}",
            "zoom": "11",
            "lat_min": f"{lat_min:.6f}",
            "lat_max": f"{lat_max:.6f}",
            "lng_min": f"{lng_min:.6f}",
            "lng_max": f"{lng_max:.6f}",
            "pag": str(page),
            "nResults": str(n),
            "cmp": "",
            "tgs": _TGS_VIVIENDAS,
            "srtp": "1",
            "distOffset": "0",
            "ord": "",
        }

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        box = self._scope_bbox(scope)
        if box is None:
            raise ConnectorError(
                "escogecasa discover: scope has neither a resolvable center nor "
                "a parseable 'lat,lon' geography — nothing to discover, and not "
                "defaulting to a hardcoded box (issue #71)"
            )

        session = requests.Session()
        self._markers = {}
        external_ids: list[str] = []
        seen: set[str] = set()
        skipped_non_residential = 0
        pages_walked = 0
        for page in range(_MAX_PAGES):
            response = _post(
                _SEARCH_ACTION,
                self._search_data(box, page, len(seen)),
                throttle,
                session=session,
            )
            html = response.text
            pages_walked += 1
            markers = markers_from_search(html)
            if page == 0 and not markers:
                # A first page with zero markers is a genuine empty box (a
                # rural scope with no Abanca stock) UNLESS the response does
                # not look like the results loader at all (broken action /
                # changed markup) — then raise rather than invent an empty
                # catalogue. Mirrors unicaja's guard without false-positiving
                # a legitimately empty box.
                if "createMarker" not in html and "cargar_onload" not in html:
                    raise ConnectorError(
                        "escogecasa discover: first search page did not look "
                        "like the results loader (no createMarker/cargar_onload) "
                        "— the search action or markup likely changed"
                    )
                break
            new = [m for m in markers if m["path"] not in seen]
            if not new:
                break  # bbox cap reached (pag does not extend it)
            for marker in new:
                seen.add(marker["path"])
                if not is_residential(marker.get("subtipo")):
                    skipped_non_residential += 1
                    continue
                self._markers[marker["path"]] = marker
                external_ids.append(marker["path"])

        logger.info(
            "escogecasa discover: walked %d page(s), %d residential listings "
            "kept, %d non-residential skipped",
            pages_walked,
            len(external_ids),
            skipped_non_residential,
        )
        return sorted(external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_BASE_URL}/{external_id.strip('/')}/"
        session = requests.Session()
        response = _get(url, throttle, session=session)
        html = response.text
        internal_id = external_id.strip("/").split("/")[-1]
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={
                "url": url,
                "price": _dato_value(html, "dato_precio"),
                "rooms": _dato_value(html, "dato_habs"),
                "bathrooms": _dato_value(html, "dato_banos"),
                "m2_useful": _dato_value(html, "dato_sup_util"),
                "m2_built": _dato_value(html, "dato_sup_cons"),
                "reference": _dato_value(html, "dato_referencia"),
                "postal_code": _dato_value(html, "dato_cp"),
                "address": _dato_value(html, "dato_direccion"),
                "year_built": _dato_value(html, "dato_anyocons"),
                "estado": _dato_value(html, "dato_estado"),
                "energy_rating": extract_energy_rating(html),
                "features": extract_features(html),
                "description": extract_description(html),
                "photo_urls": extract_photos(html, internal_id),
                # Discovery-time createMarker data (coords, price/type/built
                # fallbacks). Empty dict if fetched outside the normal flow.
                "marker": self._markers.get(external_id, {}),
            },
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        data: dict[str, Any] = raw.raw
        marker: dict[str, Any] = data.get("marker") or {}
        features: tuple[str, ...] = tuple(data.get("features") or ())

        price = first_present(
            lambda: _decimal_or_none(parse_es_price(data.get("price"))),
            lambda: _decimal_or_none(parse_es_price(marker.get("price"))),
            field="current_price",
        )
        built = first_present(
            lambda: parse_es_surface(data.get("m2_built")),
            lambda: parse_es_surface(marker.get("m2")),
            field="m2_built",
        )
        m2_built = Decimal(built) if built is not None else None
        useful = parse_es_surface(data.get("m2_useful"))
        m2_useful = Decimal(useful) if useful is not None else None

        rooms = parse_int(data.get("rooms"))
        bathrooms = parse_int(data.get("bathrooms"))
        year_built = parse_int(data.get("year_built"))

        # Coordinates come ONLY from the search createMarker payload (the
        # detail page has none) — Escogecasa is the third REO connector in
        # this batch to publish lat/lon, enabling issue #16's address_coords
        # dedup signal.
        lat = _decimal_or_none(marker.get("lat"))
        lon = _decimal_or_none(marker.get("lon"))

        property_type = first_present(
            lambda: map_property_type(marker.get("subtipo")),
            # Fallback: the detail URL slug (`detalle-piso-en-venta-...`) or
            # the reference-code-free path token.
            lambda: map_property_type(raw.external_id.replace("-", " ")),
            field="property_type",
        )

        has_elevator = True if any("ascensor" in f.lower() for f in features) else None

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=data.get("url"),
            # Abanca selling its own REO stock — institutional, never a
            # private seller. 'agency' (not None) is load-bearing for issue
            # #16's phone-corroboration rule, which never auto-merges when
            # either side is an agency.
            listing_kind="agency",
            status="active",
            current_price=price,
            description=data.get("description"),
            photo_urls=tuple(data.get("photo_urls") or ()),
            contact_raw=None,
            address=data.get("address"),
            lat=lat,
            lon=lon,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=m2_useful,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,
            has_elevator=has_elevator,
            year_built=year_built,
            energy_rating=data.get("energy_rating"),
            city=None,
            province=None,
            # Postal code IS on the detail page (dato_cp) — unlike Diglo and
            # Unicaja, which don't publish it.
            postal_code=data.get("postal_code"),
            features=features,
            operation="sale",
            # The public reference is the detail URL's <refpublica> segment,
            # confirmed on-page by dato_referencia. Fallback: the path's
            # second-to-last segment.
            reference_code=first_present(
                lambda: data.get("reference"),
                lambda: (
                    raw.external_id.strip("/").split("/")[-2]
                    if len(raw.external_id.strip("/").split("/")) >= 2
                    else None
                ),
                field="reference_code",
            ),
            # No referencia catastral published (like Diglo/Servihabitat,
            # unlike Solvia). Left None; asserted in tests.
            cadastral_ref=None,
            raw_extra={
                "internal_id": marker.get("id")
                or raw.external_id.strip("/").split("/")[-1],
                "subtipo": marker.get("subtipo"),
                "estado": data.get("estado") or marker.get("estado"),
                "features": list(features),
            },
        )
