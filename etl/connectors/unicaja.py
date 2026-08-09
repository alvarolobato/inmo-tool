"""Unicaja Inmuebles connector — Unicaja Banco's own REO portal (issue #119).

Feasibility spike, 2026-08-05. All findings below are from live requests
with an identifying User-Agent, spaced several seconds apart; none assumed.

Domain: `unicajainmuebles.com` (issue #119 also lists it). `www.` 301-
redirects to the apex; both resolve, HTTP 200, no WAF challenge, no CAPTCHA.
robots.txt is a Cloudflare "content-signals" file with **no** `User-agent`/
`Disallow`/`Sitemap` directives at all — nothing is disallowed, and there is
no sitemap to lean on (a `/sitemap.xml` fetch 404s). The footer copyright is
"Gestión de Inmuebles Adquiridos, S.L." and the social handles are
`inmueblesgia` — confirming the GIA / Unicaja ownership issue #119 names.

This is a classic server-rendered Java/Struts app (`*.do` actions), not a
JSON/SPA site, so there is no embedded `__NEXT_DATA__`/`utag_data` blob —
the data is in the server-rendered HTML. Two sources, both live-verified:

  - **Search results** (`listadoPromocion.do`): the pagination form's own
    action. Called with the site's own params (`definitionName=busqueda`,
    `tipoInmueble=0` = the VIVIENDA residential category, `tipoOperacion=1` =
    COMPRA/sale, `provincia=<INE code>`, `pagina=<n>`, `paginando=true`). Each
    page renders up to 10 result CARDS as labelled `label.titulo`/
    `label.valor` pairs carrying provincia, municipio, **código postal**,
    tipo, superficie construida, habitaciones, reference code and a short
    description. Pagination is next-only (no total count in the markup), so
    discover() walks pages until one yields no NEW reference.

  - **Detail page** (`fichainmueble.do?referencia=<ref>`): adds what the card
    lacks — **coordinates** (server-injected `var coordX`/`var coordY` JS;
    coordX=lat, coordY=lon — Unicaja is the second REO connector in this
    batch, after Diglo, to publish real lat/lon for issue #16's dedup),
    bathrooms, useful surface, the full title/street, and the photo gallery.
    The "Viviendas cercanas" carousel is loaded via a separate AJAX call
    (`listaInmueblesCercanosAJAX.do`), so it is NOT in the static HTML — the
    carousel-contamination trap that Diglo/Servihabitat/Vivantial each had to
    scope around does not exist here.

The card carries the **postal code** and the detail page does not, so the
connector keeps the card (stashed in discover) and merges it with the detail
fetch — the postal code would otherwise be lost. This is the same
"stash discover-time data on self, read it in the per-listing step" pattern
the base class endorses for `discovered_prices()`.

Fields NOT available, checked against the issue #132 checklist and confirmed
absent on real listing pages (asserted None in tests so a future site change
surfaces): **no referencia catastral**, **no energy-rating letter** (the
efficiency certificate is a pop-up image / frequently "Incidencia", not a
machine-readable A–G grade). `discovered_prices()` is left at the default:
the card price exists but renders inconsistently (some cards show only the
"Compra*" label with no figure), so it is not a reliable discovery-time
signal — price comes from the detail page, which always carries it.
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
    SearchParam,
    SearchPreview,
    SearchUrlGrammar,
    Throttle,
)
from etl.connectors.extraction import first_present
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
from etl.connectors.unicaja_mapping import (
    ine_code_to_province,
    is_residential,
    map_property_type,
    parse_es_price,
    parse_es_surface,
    parse_int,
    parse_search_cards,
    province_to_ine_code,
    refcodes_in_search,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://unicajainmuebles.com"
_SEARCH_ACTION = f"{_BASE_URL}/listadoPromocion.do"
_DETAIL_ACTION = f"{_BASE_URL}/fichainmueble.do"
_REQUEST_TIMEOUT_SECONDS = 30
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research tool; "
    "contact via github.com/alvarolobato/inmo-tool)"
)

# The site returns up to this many result cards per page; a page with fewer
# is the last page. Used only as the "keep paginating" signal — the real
# stop condition is "no new reference on this page" (defensive against a
# page that repeats the previous one).
_PAGE_SIZE = 10
# Hard cap so a pathological pagination (a page that never stops yielding
# new refs, e.g. a param the server ignores) can't loop forever. Comfortably
# above any single province's real inventory on this small portal.
_MAX_PAGES = 300

# tipoInmueble=0 is the site's VIVIENDA (residential dwelling) category;
# tipoOperacion=1 is COMPRA (sale). Fixed for this sale-only residential
# connector.
_TIPO_VIVIENDA = "0"
_TIPO_COMPRA = "1"


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
        raise ConnectorError(f"unicaja: request failed for {url}: {exc}") from exc
    return response


# Issue #494: the invertible search-URL grammar for `listadoPromocion.do`. This
# is a query-param search, so the grammar's build_template IS the full query
# string in the FIXED order `urlencode` used to emit (dict-insertion order) —
# `_search_url()` now delegates to `build()` so the two can never drift, and the
# per-connector round-trip contract plus a `parse_qs`↔grammar property test pin
# them together.
#
# The named groups are EVERY tunable field the site's search form exposes —
# provincia, municipio, precioMin/Max, codigoPostal, numDormitorios,
# superficieMin, pagina — even though discover() today only sets `provincia`
# (and mechanically re-paginates). The rest are captured so an owner who edits
# `precioMax=200000` into the URL sees it inferred, tagged "no consumido aún":
# Unicaja is the flotilla's strongest candidate to honour native URL filters,
# but announcing a filter the server may ignore is worse than not (the
# BuildingCenter lesson), so consumption is gated on a live spike (issue #494
# Phase 2). The truly fixed fields (definitionName/tipoInmueble/tipoOperacion/
# zona/antiguedadAlta/codRef/soloFotos/paginando/orden) stay literal in both
# halves. Every value is digits / -1 / empty / `false`, none needs percent-
# encoding, so a hand-written template reproduces `urlencode`'s output exactly
# (the anti-drift test asserts it). No `reject_reasons`: robots.txt disallows
# nothing here (see the module docstring).
_SEARCH_URL_GRAMMAR = SearchUrlGrammar(
    build_template=(
        f"{_SEARCH_ACTION}?definitionName=busqueda"
        f"&tipoInmueble={_TIPO_VIVIENDA}&tipoOperacion={_TIPO_COMPRA}"
        "&provincia={provincia}&municipio={municipio}&zona=-1&antiguedadAlta=-1"
        "&precioMin={precioMin}&precioMax={precioMax}&codRef=&codigoPostal={codigoPostal}"
        "&soloFotos=false&numDormitorios={numDormitorios}&superficieMin={superficieMin}"
        "&pagina={pagina}&paginando=true&orden="
    ),
    parse_pattern=(
        r"^https?://(?:www\.)?unicajainmuebles\.com/listadoPromocion\.do"
        r"\?definitionName=busqueda&tipoInmueble=0&tipoOperacion=1"
        r"&provincia=(?<provincia>[^&]*)&municipio=(?<municipio>[^&]*)"
        r"&zona=-1&antiguedadAlta=-1"
        r"&precioMin=(?<precioMin>[^&]*)&precioMax=(?<precioMax>[^&]*)"
        r"&codRef=&codigoPostal=(?<codigoPostal>[^&]*)"
        r"&soloFotos=false&numDormitorios=(?<numDormitorios>[^&]*)"
        r"&superficieMin=(?<superficieMin>[^&]*)"
        r"&pagina=(?<pagina>[^&]*)&paginando=true&orden=$"
    ),
    params={
        "provincia": {"label": "Provincia (INE)", "source": "profile"},
        "municipio": {"label": "Municipio", "source": "constant", "consumed": False},
        "precioMin": {"label": "Precio mín.", "source": "constant", "consumed": False},
        "precioMax": {"label": "Precio máx.", "source": "constant", "consumed": False},
        "codigoPostal": {
            "label": "Código postal",
            "source": "constant",
            "consumed": False,
        },
        "numDormitorios": {
            "label": "Dormitorios",
            "source": "constant",
            "consumed": False,
        },
        "superficieMin": {
            "label": "Superficie mín.",
            "source": "constant",
            "consumed": False,
        },
        "pagina": {"label": "Página", "source": "derived", "consumed": False},
    },
)


def _search_url(ine_code: str, page: int) -> str:
    """The `listadoPromocion.do` search page discover() paginates over.

    Delegates to `_SEARCH_URL_GRAMMAR.build()` (issue #494) so the derived URL
    and the published grammar stay pinned together (anti-drift). Only `provincia`
    and `pagina` vary; every other field is a fixed default (the site's own
    empty/`-1` search-form values)."""
    return _SEARCH_URL_GRAMMAR.build(
        {
            "provincia": ine_code,
            "municipio": "-1",
            "precioMin": "",
            "precioMax": "",
            "codigoPostal": "",
            "numDormitorios": "-1",
            "superficieMin": "",
            "pagina": str(page),
        }
    )


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def extract_coords(html: str) -> tuple[Decimal | None, Decimal | None]:
    """Return (lat, lon) from the detail page's server-injected JS vars.

    The page assigns `var coordX = 0; var coordY = 0;` first (an
    initialisation placeholder), then the real quoted values
    `var coordX = '36.6591842'; var coordY = '-4.5750888';`. Take the LAST
    quoted assignment for each — coordX is latitude, coordY longitude. The
    unquoted `0` placeholders are ignored (only quoted assignments match).
    """
    xs = re.findall(r"var\s+coordX\s*=\s*'([^']+)'", html)
    ys = re.findall(r"var\s+coordY\s*=\s*'([^']+)'", html)
    lat = _decimal_or_none(xs[-1]) if xs else None
    lon = _decimal_or_none(ys[-1]) if ys else None
    # A '0'/'0.0' pair is the placeholder with no real geocode — treat as
    # absent rather than publishing the origin of the Gulf of Guinea.
    if lat == 0 and lon == 0:
        return None, None
    return lat, lon


def _label_text_pairs(html: str) -> dict[str, str]:
    """The detail page's `<span class="label">X:</span><span class="text">Y`
    pairs, as a {label-without-colon: value} dict."""
    out: dict[str, str] = {}
    for lab, txt in re.findall(
        r'<span class="label">\s*([^<]*?)\s*</span>\s*'
        r'<span class="text">\s*(.*?)\s*</span>',
        html,
        re.DOTALL,
    ):
        value = re.sub(r"<[^>]+>", "", txt)
        value = re.sub(r"\s+", " ", value).strip()
        key = lab.strip().rstrip(":").strip()
        if key and key not in out:
            out[key] = value
    return out


def _detail_price(html: str) -> str | None:
    """The subject's own price, scoped to the `#columnaprecio` block.

    Scoping to that block (not a whole-page € scan) keeps the mortgage-
    simulator figures (Importe/Cuota mensual, also rendered in €) from being
    mistaken for the sale price.
    """
    match = re.search(
        r'id="columnaprecio".*?<span>\s*([\d.,]+)\s*(?:&euro;|€)',
        html,
        re.DOTALL,
    )
    return parse_es_price(match.group(1)) if match else None


def _detail_title(html: str) -> str | None:
    match = re.search(r'id="columnatitulo"[^>]*>\s*(.*?)\s*</div>', html, re.DOTALL)
    if not match:
        return None
    title = re.sub(r"<[^>]+>", "", match.group(1))
    title = re.sub(r"\s+", " ", title).strip()
    return title or None


def _detail_description(html: str) -> str | None:
    """The subject's descriptive paragraph.

    The body copy lives in a `containerdescriptex` div, itself following a
    "Descripción:" title. Read that div's text; it is subject-scoped (the
    nearby-listings carousel is AJAX-loaded and absent from the static HTML),
    so no de-contamination is needed.
    """
    match = re.search(r'class="containerdescriptex"[^>]*>(.*?)</div>', html, re.DOTALL)
    if match:
        text = re.sub(r"<[^>]+>", " ", match.group(1))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            return text
    return None


def _place_from_description(description: str | None, key: str) -> str | None:
    """Pull "provincia de X" / "municipio de Y" out of the boilerplate lead
    sentence the site generates ("Casa con 2 habitaciones en la provincia de
    Málaga, en el municipio de Alhaurin de la torre, en la calle RIPARIO.")."""
    if not description:
        return None
    match = re.search(rf"{key} de\s+(.+?)(?:,|\.|$)", description, re.IGNORECASE)
    return match.group(1).strip() if match else None


def _photo_urls(html: str) -> tuple[str, ...]:
    """Full-size subject photos.

    Photos live at `/unicaja/datos/BaseInmueble--<id>/<n>/<photoid>[_WxH].png`.
    The site renders thumbnails (`_250x150`, `_42x32`); the full-size asset is
    the same path with no size suffix. Strip any `_WxH` suffix, de-duplicate,
    and absolutise. Only the subject's own `BaseInmueble` id appears in the
    static HTML (the nearby-listings carousel is AJAX-loaded), so no refcode
    filtering is needed to keep neighbours out.
    """
    urls: list[str] = []
    seen: set[str] = set()
    for src in re.findall(
        r'(/unicaja/datos/BaseInmueble[^"\'\s]+?\.(?:png|jpe?g))', html, re.IGNORECASE
    ):
        full = re.sub(r"_\d+x\d+(\.(?:png|jpe?g))$", r"\1", src, flags=re.IGNORECASE)
        url = _BASE_URL + full
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return tuple(urls)


class UnicajaConnector(Connector):
    name = "unicaja"

    # Conservative: a province sweep is a burst of search-page fetches plus a
    # detail fetch per listing, on a low-traffic bank portal we want to be a
    # quiet guest on. Matches Diglo/Servihabitat.
    rate_limit_per_minute = 12

    # discover() paginates the province search to the last page (no cap other
    # than the pathological-loop guard), so it enumerates every active
    # residential sale listing for the scope's province — the honest
    # full-inventory shape (like Diglo/BuildingCenter). Guarded by discover()
    # raising rather than returning [] on an unrecognised/empty first page, so
    # a fetch glitch can't read as "the whole province was withdrawn".
    discovers_full_inventory = True

    # Issue #478: an owner-pinned unicaja URL is this connector's recall source
    # for a profile. Issue #513: discover() now CONSUMES `scope.override_url` —
    # it fetches the pinned search page verbatim as the single entry point (no
    # pagination), so a pin actually changes what the next ETL run fetches.
    override_host_suffix = "unicajainmuebles.com"
    supports_search_override = True

    # Issue #494: published to connector_registry.search_url_grammar so the
    # dashboard infers params from an owner-edited URL in the browser with the
    # same grammar (one implementation, zero per-connector TS). `_search_url()`
    # delegates to `build()` — the anti-drift contract.
    search_url_grammar = _SEARCH_URL_GRAMMAR

    def __init__(self) -> None:
        # Card data captured during the most recent discover(), keyed by
        # reference. fetch_detail() reads it to recover the postal code (and
        # province/municipio/description fallbacks) the detail page omits.
        # Rebuilt from scratch each discover() call so stale cross-scope data
        # never leaks.
        self._cards: dict[str, dict[str, Any]] = {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved INE province code IS the coverage key: two scopes in
        the same province search the identical listing. Must never raise
        (the orchestrator calls it with no try/except)."""
        try:
            code = self._scope_ine_code(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        return f"unicaja-prov:{code}" if code else None

    @staticmethod
    def _scope_ine_code(scope: ConnectorScope) -> str | None:
        """Resolve a scope to a Unicaja INE province code, or None if unmapped.

        `scope.geography` (the free-text escape hatch) wins when set, for
        tests/manual construction — treated as a province name. Otherwise
        resolve `scope.center` via the shared gazetteer and map its province
        name to the site's INE code. No hardcoded default (issue #71): a point
        that resolves to no known place raises UnresolvableGeographyError from
        resolve_place; a resolved place whose province isn't in the code table
        yields None (skipped as no-coverage, not a failure).
        """
        if scope.geography:
            return province_to_ine_code(scope.geography)
        place = resolve_place(scope)
        if place is None:
            return None
        return province_to_ine_code(place.province)

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses the module-level `_search_url()` — the exact helper discover()
        builds its first search page (`pagina=1`) from."""
        try:
            ine_code = self._scope_ine_code(scope)
        except UnresolvableGeographyError:
            ine_code = None
        if ine_code is None:
            return [
                SearchPreview(
                    label="Unicaja",
                    url=None,
                    kind="search_page",
                    tunable=True,
                    notes="El perfil no resuelve a una provincia que este conector cubra.",
                )
            ]
        # Issue #494: the params discover() builds the URL from, plus the native
        # search-form fields the URL carries but the connector does NOT act on
        # yet (consumed=False). `provincia` is the only consumed one (the sweep
        # sets it); the empty precio/dormitorios/superficie/municipio/CP fields
        # are surfaced so the owner sees Unicaja supports them in its URL, tagged
        # "no consumido aún" pending the live spike (Phase 2). `pagina` is
        # mechanical (the sweep re-paginates from 1). The province chip resolves
        # the bare INE code to a legible "INE 29 · Málaga".
        province_name = ine_code_to_province(ine_code)
        province_label = (
            f"INE {ine_code} · {province_name}" if province_name else f"INE {ine_code}"
        )
        params: tuple[SearchParam, ...] = (
            SearchParam(
                key="provincia",
                label="Provincia (INE)",
                value=province_label,
                source="profile",
                in_url=True,
            ),
            SearchParam(
                key="operation",
                label="Operación",
                value="COMPRA",
                source="constant",
                in_url=True,
            ),
            SearchParam(
                key="tipoInmueble",
                label="Tipo",
                value="VIVIENDA",
                source="constant",
                in_url=True,
            ),
            SearchParam(
                key="precioMin",
                label="Precio mín.",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector todavía no lo aplica (ver spike, issue #494).",
            ),
            SearchParam(
                key="precioMax",
                label="Precio máx.",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector todavía no lo aplica (ver spike, issue #494).",
            ),
            SearchParam(
                key="numDormitorios",
                label="Dormitorios",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector todavía no lo aplica (ver spike, issue #494).",
            ),
            SearchParam(
                key="superficieMin",
                label="Superficie mín.",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector todavía no lo aplica (ver spike, issue #494).",
            ),
            SearchParam(
                key="municipio",
                label="Municipio",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector barre toda la provincia (no consumido aún).",
            ),
            SearchParam(
                key="codigoPostal",
                label="Código postal",
                value=None,
                source="constant",
                in_url=True,
                consumed=False,
                notes="El portal lo admite en su URL; el conector todavía no lo aplica (ver spike, issue #494).",
            ),
            SearchParam(
                key="pagina",
                label="Página",
                value="1",
                source="derived",
                in_url=True,
                consumed=False,
                notes="Se pagina hasta agotar; el valor de la URL es solo la página de entrada.",
            ),
        )
        return [
            SearchPreview(
                label=f"Unicaja — provincia {province_label}",
                url=_search_url(ine_code, 1),
                kind="search_page",
                tunable=True,
                params=params,
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # Issue #513: an owner-pinned URL is this profile's recall source — hit
        # it verbatim as the single entry page (no pagination), running the same
        # refcode/card extraction so fetch_detail() still finds its cards.
        # Without an override the code path below is byte-identical.
        override_url = scope.override_url if self.supports_search_override else None
        if override_url:
            self._cards = {}
            external_ids: list[str] = []
            html = _get(override_url, throttle).text
            cards = parse_search_cards(html)
            for ref in refcodes_in_search(html):
                card = cards.get(ref, {})
                if not is_residential(card.get("property_type_raw")):
                    continue
                self._cards[ref] = card
                external_ids.append(ref)
            logger.info(
                "unicaja discover: pinned override URL %s -> %d residential "
                "listings (single entry page, no pagination)",
                override_url,
                len(external_ids),
            )
            return sorted(external_ids)

        ine_code = self._scope_ine_code(scope)
        if ine_code is None:
            raise ConnectorError(
                "unicaja discover: scope has neither a resolvable center nor a "
                "known province — nothing to discover, and not defaulting to a "
                "hardcoded province (issue #71)"
            )

        self._cards = {}
        external_ids: list[str] = []
        seen: set[str] = set()
        skipped_non_residential = 0
        pages_walked = 0
        for page in range(1, _MAX_PAGES + 1):
            response = _get(_search_url(ine_code, page), throttle)
            html = response.text
            pages_walked += 1
            page_refs = refcodes_in_search(html)
            if page == 1 and not page_refs:
                # A first page with zero results could be a genuine
                # empty-province OR a broken search action / changed markup.
                # An empty province is real on this small portal, so only
                # raise if the page ALSO doesn't look like a results page at
                # all (the search form/marker is absent) — otherwise return
                # []. This mirrors Diglo's "refuse to invent a mass
                # withdrawal" guard without false-positiving an empty province.
                if "listadoInmuebles" not in html and "listadoPromocion" not in html:
                    raise ConnectorError(
                        "unicaja discover: first search page did not look like a "
                        "results page (no listing container) — the search action "
                        "or markup likely changed; refusing to report an empty "
                        "catalogue"
                    )
                break
            new_refs = [r for r in page_refs if r not in seen]
            if not new_refs:
                # Page repeated the previous one (or the server ignored the
                # page param) — stop rather than loop.
                break
            cards = parse_search_cards(html)
            for ref in new_refs:
                seen.add(ref)
                card = cards.get(ref, {})
                if not is_residential(card.get("property_type_raw")):
                    # Belt-and-braces: the VIVIENDA server category should
                    # already exclude non-dwellings, but never let one slip in.
                    skipped_non_residential += 1
                    continue
                self._cards[ref] = card
                external_ids.append(ref)
            if len(page_refs) < _PAGE_SIZE:
                break  # last (short) page

        logger.info(
            "unicaja discover: province_ine=%s walked %d pages, %d residential "
            "listings kept, %d non-residential skipped",
            ine_code,
            pages_walked,
            len(external_ids),
            skipped_non_residential,
        )
        return sorted(external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        url = f"{_DETAIL_ACTION}?referencia={external_id}"
        response = _get(url, throttle)
        html = response.text
        lat, lon = extract_coords(html)
        pairs = _label_text_pairs(html)
        description = _detail_description(html)
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={
                "url": url,
                "pairs": pairs,
                "title": _detail_title(html),
                "price": _detail_price(html),
                "description": description,
                "lat": str(lat) if lat is not None else None,
                "lon": str(lon) if lon is not None else None,
                "photo_urls": _photo_urls(html),
                # Card data captured at discover() time — carries the postal
                # code the detail page omits, plus province/city/description
                # fallbacks.
                "card": self._cards.get(external_id, {}),
            },
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        data: dict[str, Any] = raw.raw
        pairs: dict[str, str] = data.get("pairs") or {}
        card: dict[str, Any] = data.get("card") or {}
        description: str | None = data.get("description")

        price = first_present(
            lambda: _decimal_or_none(data.get("price")),
            lambda: _decimal_or_none(parse_es_price(card.get("price_raw"))),
            field="current_price",
        )
        built = first_present(
            lambda: parse_es_surface(pairs.get("Sup. Const")),
            lambda: parse_es_surface(card.get("m2_built_raw")),
            field="m2_built",
        )
        m2_built = Decimal(built) if built is not None else None
        useful = parse_es_surface(pairs.get("Sup. Útil"))
        m2_useful = Decimal(useful) if useful is not None else None

        rooms = first_present(
            lambda: parse_int(pairs.get("Habitaciones")),
            lambda: parse_int(card.get("rooms_raw")),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: parse_int(pairs.get("Baños")),
            field="bathrooms",
        )

        lat = _decimal_or_none(data.get("lat"))
        lon = _decimal_or_none(data.get("lon"))

        tipo_raw = first_present(
            lambda: pairs.get("Tipo"),
            lambda: card.get("property_type_raw"),
            field="property_type_raw",
        )
        property_type = map_property_type(tipo_raw)

        city = first_present(
            lambda: card.get("city"),
            lambda: _place_from_description(description, "municipio"),
            field="city",
        )
        province = first_present(
            lambda: card.get("province"),
            lambda: _place_from_description(description, "provincia"),
            field="province",
        )
        address = first_present(
            lambda: data.get("title"),
            lambda: card.get("city"),
            field="address",
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=data.get("url"),
            # GIA/Unicaja selling bank-owned stock — every listing is
            # institutional, never a private seller. 'agency' (not None) is
            # load-bearing for issue #16's phone-corroboration rule, which
            # never auto-merges when either side is an agency.
            listing_kind="agency",
            status="active",
            current_price=price,
            description=description,
            photo_urls=tuple(data.get("photo_urls") or ()),
            contact_raw=None,
            address=address,
            # Second REO connector in this batch (after Diglo) to publish real
            # coordinates — enables issue #16's address_coords dedup signal.
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
            # Postal code comes from the SEARCH CARD (the detail page omits
            # it). None only when a listing was fetched without its card
            # (not the normal flow).
            postal_code=card.get("postal_code"),
            features=(),
            operation="sale",
            reference_code=first_present(
                lambda: pairs.get("Referencia"),
                lambda: raw.external_id,
                field="reference_code",
            ),
            # No referencia catastral published (like Diglo/Servihabitat,
            # unlike Solvia). Left None; asserted in tests.
            cadastral_ref=None,
            raw_extra={
                "tipo_raw": tipo_raw,
                "card_postal_code": card.get("postal_code"),
                "card_price_raw": card.get("price_raw"),
            },
        )
