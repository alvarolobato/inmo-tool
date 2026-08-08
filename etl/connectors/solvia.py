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

Coverage reality:
  * 6,375 homes listed for sale nationally at spike time.
  * A search page renders exactly 20 detail links server-side.
  * Query-param pagination does not work on the SSR path: `?pagina=2` and
    `?page=2` both returned byte-identical first results to page 1
    (verified). Real pagination goes through the robots-disallowed `/api/`.
  * Geography narrows genuinely — `/viviendas/alicante/torrevieja` reported
    61 homes vs. 6,375 nationally — but still renders only its first 20.
So a single municipality page sees at most 20 listings.

Issue #190 (partition by municipality via the sitemap): `robots.txt`
disallows only `/api/` and `/ajax/`, and its own `Sitemap:` line points at
`https://www.solvia.es/sitemap.xml` — a sitemap INDEX whose
`sitemap_comprar_viviendas.xml` child contains one `<loc>` per
municipality search page: `.../es/comprar/viviendas/<provincia>/<municipio>`.
Live-verified 2026-08-03: 1,737 municipality entries nationally, **43** under
`sevilla` and **44** under `malaga` (both v1 markets), including
`sevilla/dos-hermanas` as its own entry. `discover()` now resolves a scope
down to a **provincia** only, then sweeps every municipality page the
sitemap lists for that provincia — a center-based Sevilla scope reaches
`dos-hermanas` (and every other Sevilla town) in one sweep, without the
profile needing to name it.

This is complementary to, not a replacement for, issue #177's gazetteer
(`resolve_place`/`Place`, merged to `main` after this branch was cut, and
now the geography this module depends on — see `_PROVINCE_SLUGS` below):
the gazetteer alone already lets a scope centered exactly on Dos Hermanas
resolve there directly (0.18km, see `test_geography.py`'s
`TestDosHermanasRegression`), and per-municipality resolution is real and
useful when a profile's center happens to name a town precisely. What the
gazetteer cannot do is help a scope that *doesn't* center on the specific
town Solvia happens to have inventory in — a Sevilla-area profile has no
way to know in advance that Dos Hermanas (not, say, Alcalá de Guadaíra) is
where the 20-per-page cap actually bites. The sitemap sweep solves that
different problem: once a scope resolves to a **provincia**, every
municipality Solvia publishes for it is covered in one sweep, independent
of which one point a profile's centroid happens to land nearest to. The
two fixes stack: gazetteer resolution answers "what provincia is this
scope even about," the sitemap sweep answers "what's everywhere in it."

Live-verified derived URLs actually return listings, not just a 200 with an
empty shell (the property_web_scraper lesson: selectors that only match
hand-authored fixtures) — real fetches, 2026-08-03:
  * `sevilla/dos-hermanas`: 9 real detail links (own inventory, distinct
    from `sevilla/sevilla`).
  * `malaga/mijas`: 20 (the per-page cap, same as any other municipality).
  * `sevilla/san-nicolas-del-puerto` (a ~250-inhabitant village): 0 —
    genuinely empty, still a well-formed `ng-state` page. Proves the sitemap
    isn't padded with municipalities that have no stock, and that a
    municipality page is capable of validly reporting zero.

Sweep cost: one province sweep is now `len(municipios)` requests instead of
1 — 43 for Sevilla, 44 for Málaga — at the existing `rate_limit_per_minute`
(unchanged; see the class attribute below for why). The sitemap itself
(index + one child) is fetched at most once per `_SITEMAP_CACHE_TTL_SECONDS`
and shared across every scope/provincia in a sweep, not refetched per scope
— see `_municipios_for_provincia`.

`discovers_full_inventory` stays `False`. It is tempting to read this as
"upgraded" now that whole provinces are swept, but the per-municipality cap
is still exactly 20 and nothing on the page states a total: `ng-state` on a
real municipality page carries no result-count key (checked directly,
2026-08-03 — only `config`/`provincesResponse`/`seoProvinciasResponse`/
`homeDataResponse`, none of which carry a per-municipality total), and
no `resultados`/`total` string appears in the rendered markup either. Per
municipality, 20 may be the *entire* stock for a small town (San Nicolás
del Puerto, above) or a truncated slice for a busy one (Mijas, above) — and
there's no signal on the page to tell those apart. Claiming full coverage
without a reliable total is exactly the mistake `discovers_full_inventory`
exists to prevent (the Fotocasa lesson) — a real total would have to appear
somewhere reliable before this changes.
Withdrawal detection must therefore stay off — a listing absent from a
20-of-N slice tells you nothing about whether it's still active.

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
import time
from typing import Any
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    SearchPreview,
    Throttle,
)
from etl.connectors.extraction import first_present, scoped_text
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
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

# provincia sitemap slug per `Place.province` (etl.connectors.geography,
# issue #177's gazetteer). An explicit table, not a slugify() of the
# province name: Solvia's provincia URL slug is not always a simple
# slugify of the province's own name (Illes Balears sits under
# `balears-illes`, not `illes-balears`), so guessing would produce 404s
# that look like empty results. Verified against live hrefs on the
# national search page (issue #71's original four) and against the
# sitemap partition itself (issue #190's live sevilla/malaga counts, see
# module docstring).
#
# Issue #190 course-correction: this used to be keyed by *municipality*
# name (`Place.name`) and map to a (provincia, municipio) PAIR — the one
# municipality a scope's centroid resolves to (this is how `main` grew
# estepona/marbella/dos hermanas as individual entries after issue #169's
# gazetteer landed, in parallel with this branch). Now it's keyed by
# `Place.province` and maps to the provincia slug ALONE: discover() sweeps
# every municipality the sitemap lists for that provincia (see module
# docstring), so a specific municipio a centroid happens to name no longer
# determines reachability — a Sevilla-centered scope reaches
# `dos-hermanas` (and every other Sevilla town) by sweeping the whole
# province, regardless of whether Dos Hermanas itself has its own table
# entry. Malaga is kept here, not dropped back to the original four:
# `main`'s per-municipio table already proved live coverage of Malaga
# province (estepona/marbella/malaga capital, issue #169), and the
# sitemap's own 44-municipio count under `malaga` (module docstring)
# reconfirms it independently — omitting it here would be a real
# regression, not a simplification.
_PROVINCE_SLUGS: dict[str, str] = {
    "Madrid": "madrid",
    "Sevilla": "sevilla",
    "Barcelona": "barcelona",
    "Valencia": "valencia",
    "Malaga": "malaga",
}

_SITEMAP_INDEX_URL = f"{_BASE_URL}/sitemap.xml"
# The child sitemap's name is matched by substring, not hardcoded as the
# whole index-relative URL: robust to the index changing every other
# child's name/order, since only this one keyword actually matters here.
_MUNICIPIO_SITEMAP_KEYWORD = "comprar_viviendas"
_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
# Real page path only — excludes tracking-URL copies and anything with an
# extra segment (query string, trailing slash variant).
_MUNICIPIO_LOC_RE = re.compile(
    r"^https://www\.solvia\.es/es/comprar/viviendas/([a-z0-9-]+)/([a-z0-9-]+)$"
)
# Same threshold and reasoning as Fotocasa's _MAX_CONSECUTIVE_ZONE_FAILURES
# (#65): a persistent soft-block doesn't clear mid-sweep, so a fixed run of
# consecutive failures is a more honest stop condition than a ratio, which
# would need the whole sweep to finish before it could fire at all.
_MAX_CONSECUTIVE_MUNICIPIO_FAILURES = 3

# Sitemap changes rarely (issue #190's own spike: every real <lastmod> in a
# live pull was the same stale date, "2022-07-08", despite <changefreq>
# claiming daily) — refetching it every sweep would be 1,737 URLs' worth of
# XML for data that is for all practical purposes static. 24h mirrors
# Fotocasa's own min_refetch_interval_seconds precedent (issue #143) for
# "this doesn't need to be checked more than once a day."
_SITEMAP_CACHE_TTL_SECONDS = 24 * 60 * 60

# Module-level, not per-instance: the sitemap is one shared national
# document, identical for every SolviaConnector instance and every
# provincia — there is exactly one cache to keep, not one per scope. Reset
# via `_reset_sitemap_cache` (tests only; production never needs to clear
# it mid-process).
_sitemap_cache: dict[str, Any] = {"fetched_at": 0.0, "by_province": {}}


def _reset_sitemap_cache() -> None:
    """Test-only: force the next `_municipios_for_provincia` call to refetch.

    Production code never calls this — the TTL above is the only eviction
    path there. Tests need it because `_sitemap_cache` is module-level state
    that would otherwise leak between test functions.
    """
    _sitemap_cache["fetched_at"] = 0.0
    _sitemap_cache["by_province"] = {}


def _sitemap_locs(xml_text: str, *, context: str) -> list[str]:
    """Extract every <loc> from a sitemap or sitemap index."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ConnectorError(
            f"solvia {context}: sitemap is not valid XML: {exc}"
        ) from exc
    return [
        el.text.strip()
        for el in root.iter(f"{_SITEMAP_NS}loc")
        if el.text and el.text.strip()
    ]


def _parse_municipio_locs(locs: list[str]) -> dict[str, list[str]]:
    """Group municipality search-page URLs by provincia slug.

    Only URLs matching the exact `/es/comprar/viviendas/<provincia>/
    <municipio>` shape are kept — the child sitemap this is fed from is
    scoped to that one URL family already (see `_MUNICIPIO_SITEMAP_KEYWORD`),
    but being defensive here means a future sitemap that mixes in other
    shapes (a province-overview URL with no municipio segment, a tracking
    param) degrades to "fewer municipios found" rather than a KeyError.
    """
    by_province: dict[str, list[str]] = {}
    for loc in locs:
        match = _MUNICIPIO_LOC_RE.match(loc)
        if match is None:
            continue
        provincia, municipio = match.group(1), match.group(2)
        by_province.setdefault(provincia, []).append(municipio)
    return {
        provincia: sorted(set(municipios))
        for provincia, municipios in by_province.items()
    }


def _refresh_sitemap_cache(throttle: Throttle) -> None:
    index_xml = _get(_SITEMAP_INDEX_URL, throttle, context="sitemap index")
    index_locs = _sitemap_locs(index_xml, context="sitemap index")
    child_url = next(
        (loc for loc in index_locs if _MUNICIPIO_SITEMAP_KEYWORD in loc), None
    )
    if child_url is None:
        raise ConnectorError(
            f"solvia sitemap: no child sitemap containing "
            f"{_MUNICIPIO_SITEMAP_KEYWORD!r} found in the index — the "
            f"sitemap's own structure may have changed"
        )
    child_xml = _get(child_url, throttle, context="municipio sitemap")
    by_province = _parse_municipio_locs(
        _sitemap_locs(child_xml, context="municipio sitemap")
    )
    _sitemap_cache["by_province"] = by_province
    _sitemap_cache["fetched_at"] = time.time()
    logger.info(
        "solvia sitemap: refreshed from %s — %d provincias, %d municipality "
        "pages total",
        child_url,
        len(by_province),
        sum(len(v) for v in by_province.values()),
    )


def _municipios_for_provincia(provincia: str, throttle: Throttle) -> list[str]:
    """Every municipality slug the sitemap lists for `provincia`, cached.

    Refetches (index + child sitemap — two requests total, shared across
    every provincia/scope) only when the cache is empty or older than
    `_SITEMAP_CACHE_TTL_SECONDS`. This is what makes a province sweep NOT
    cost 1,737 extra requests per scope (issue #190's own explicit
    requirement) — only the first `discover()` call after a cold start or a
    stale cache pays for the sitemap; every subsequent scope in the same
    sweep, and every sweep within the TTL window, reads the in-memory dict.
    """
    age = time.time() - _sitemap_cache["fetched_at"]
    if not _sitemap_cache["by_province"] or age > _SITEMAP_CACHE_TTL_SECONDS:
        _refresh_sitemap_cache(throttle)
    return list(_sitemap_cache["by_province"].get(provincia, []))


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Translate a profile's (center, radius_km) into a Solvia provincia slug.

    Returns None when the scope resolves to no provincia this connector's
    own table knows — the orchestrator then skips it as a coverage gap
    rather than treating it as a failure (issue #99).

    `scope.geography`'s free-text escape hatch still accepts the old
    "provincia/municipio" shape (for existing callers/tests) but only the
    provincia segment is used now — see the module docstring for why a
    specific municipio pin is no longer meaningful once discover() sweeps
    every municipio in the resolved provincia anyway. A bare "provincia"
    string works too. This never goes through gazetteer resolution at all,
    so a malformed/empty geography string correctly returns None here
    rather than raising.

    Can raise `UnresolvableGeographyError` (from `resolve_place`) when
    `scope.center` matches nothing in the shared gazetteer at all (issue
    #169/#177) — deliberately left to propagate; see fotocasa.py's
    `_resolve_geography` docstring for the full reasoning.
    """
    if scope.geography:
        parts = [p for p in scope.geography.strip("/").split("/") if p]
        return parts[0] if parts else None
    place = resolve_place(scope)
    if place is None:
        return None
    return _PROVINCE_SLUGS.get(place.province)


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
    # inventory per geography is only 20 pages deep anyway. Issue #190 grew
    # a sweep from 1 request to len(municipios) (43 for Sevilla, 44 for
    # Málaga) — a real cost increase, stated here rather than silently
    # absorbed — but did not change this value: the feasibility spike's "no
    # bot-hostility, no CAPTCHA, plain HTTP 200s" finding was re-confirmed
    # live during #190's own verification (real municipio-page fetches at
    # this same pace, no block encountered), so there is no new evidence
    # this needs to drop. Unlike Milanuncios (#179), Solvia has shown no
    # soft-block signature at this rate.
    rate_limit_per_minute = 20

    # See the module docstring's "discovers_full_inventory stays False"
    # section — per-municipality 20-cap with no readable total anywhere on
    # the page, checked directly against ng-state and the rendered markup,
    # not assumed. Sweeping more municipalities (#190) doesn't change this:
    # every one of them still has the same unverifiable-total problem.
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved provincia IS the coverage key (issue #190): two
        scopes resolving to the same provincia now sweep the identical set
        of municipality pages, so they must dedupe against each other the
        same way Fotocasa/Servihabitat's province-level keys already do.

        `UnresolvableGeographyError` (issue #169/#177) must become a
        sentinel key here rather than `None` — this method must never raise
        itself, see fotocasa.py's `scope_key` docstring for the full
        reasoning."""
        try:
            return _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)

    # Issue #478: an owner-pinned solvia URL may become this connector's recall
    # source for a profile (discover() wiring is Phase 5).
    override_host_suffix = "solvia.es"

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """`kind="sitemap"`: discover() enumerates the provincia's municipality
        pages from the sitemap index — the same `_SITEMAP_INDEX_URL` its first
        request hits."""
        try:
            provincia = _resolve_geography(scope)
        except UnresolvableGeographyError:
            provincia = None
        if provincia is None:
            return [
                SearchPreview(
                    label="Solvia",
                    url=None,
                    kind="sitemap",
                    tunable=True,
                    notes="El perfil no resuelve a una provincia que este conector cubra.",
                )
            ]
        return [
            SearchPreview(
                label=f"Solvia — {provincia}",
                url=_SITEMAP_INDEX_URL,
                kind="sitemap",
                tunable=True,
                notes=(
                    f"Barre las páginas de municipio de la provincia "
                    f"'{provincia}' enumeradas en el sitemap; el filtrado fino "
                    f"es por datos."
                ),
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # _resolve_geography can raise UnresolvableGeographyError, left to
        # propagate uncaught (issue #169/#177) — see fotocasa.py's
        # discover() for the full reasoning.
        provincia = _resolve_geography(scope)
        if provincia is None:
            # Reachable only if discover() is invoked directly, bypassing
            # scope_key()'s gate — see fotocasa.py's discover() docstring.
            raise ConnectorError(
                f"solvia discover: scope {scope!r} resolves to no known Solvia "
                f"provincia — this should have been skipped via scope_key()"
            )

        municipios = _municipios_for_provincia(provincia, throttle)
        if not municipios:
            raise ConnectorError(
                f"solvia discover: sitemap has no municipality pages under "
                f"provincia={provincia!r} — either the sitemap's own "
                f"structure changed, or this provincia genuinely isn't in "
                f"Solvia's sitemap (unexpected for a resolved provincia — "
                f"see _PROVINCE_SLUGS)"
            )

        external_ids: set[str] = set()
        municipios_attempted = 0
        municipios_failed = 0
        municipios_empty = 0
        consecutive_failures = 0
        aborted_early = False
        for municipio in municipios:
            municipios_attempted += 1
            url = f"{_BASE_URL}/es/comprar/viviendas/{provincia}/{municipio}"
            html = self._fetch_municipio_page(url, throttle)
            if html is None:
                municipios_failed += 1
                consecutive_failures += 1
                if consecutive_failures >= _MAX_CONSECUTIVE_MUNICIPIO_FAILURES:
                    # Same reasoning as Fotocasa's zone sweep (#65): a
                    # persistent soft-block/interruption page won't clear
                    # mid-sweep, so continuing would spend the rest of the
                    # sweep hammering a site that's already refusing us.
                    # Stop and return the partial result (discovers_full_
                    # inventory=False means a short sweep is never misread
                    # as evidence of withdrawal).
                    aborted_early = True
                    logger.error(
                        "solvia discover: aborting provincia=%s sweep after "
                        "%d consecutive municipio failures (attempted %d of "
                        "%d) — likely a soft-block or structural change; "
                        "returning the partial result rather than "
                        "continuing to hammer it",
                        provincia,
                        consecutive_failures,
                        municipios_attempted,
                        len(municipios),
                    )
                    break
                continue
            consecutive_failures = 0
            ids = {m.group(1) for m in _DETAIL_HREF_RE.finditer(html)}
            if not ids:
                # A well-formed page (real ng-state) with zero listings —
                # NOT the failure signature above. San Nicolás del Puerto
                # (module docstring) proves this is a genuine, expected
                # state for a small municipality, not a parse regression.
                municipios_empty += 1
            external_ids |= ids

        if municipios_attempted and municipios_failed == municipios_attempted:
            # Every single municipio in this sweep failed — indistinguishable
            # from "the whole provincia is currently soft-blocked" or "the
            # sitemap resolved to municipio pages that no longer exist."
            # Returning [] here would look exactly like an empty provincia
            # to _reconcile_missed_discoveries, which is the one silent
            # failure mode this whole change must not introduce.
            raise ConnectorError(
                f"solvia discover: all {municipios_attempted} municipio "
                f"pages attempted for provincia={provincia!r} failed — "
                f"likely a soft-block/interruption page, or a structural "
                f"change, not a provincia with zero listings"
            )

        logger.info(
            "solvia discover: provincia=%s swept %d/%d municipality pages "
            "(%d failed, %d empty%s) -> %d external_ids",
            provincia,
            municipios_attempted,
            len(municipios),
            municipios_failed,
            municipios_empty,
            ", aborted early" if aborted_early else "",
            len(external_ids),
        )
        return sorted(external_ids)

    def _fetch_municipio_page(self, url: str, throttle: Throttle) -> str | None:
        """Fetch one municipality search page; None on any failure.

        Non-strict by design (unlike Fotocasa's base-page fetch): there is
        no single "baseline" municipio more foundational than another once
        a provincia is swept as a flat list, so every page gets the same
        tolerant treatment — a single bad page must not abort a sweep of
        ~43, but total failure across the sweep still surfaces loudly (see
        the all-failed check in discover()).
        """
        try:
            html = _get(url, throttle, context="discover")
        except ConnectorError:
            return None
        try:
            _parse_ng_state(html, context="discover")
        except ConnectorError:
            return None
        return html

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
            # `data-price` is an explicit attribute, kept as the first check
            # (unverified against the current live site during issue #144 —
            # a real fetch found no `data-price` attribute anywhere on a
            # current detail page, so this may be dead code from an earlier
            # template; left as a harmless no-op check rather than removed
            # on an unverified assumption, since #144 is scoped to the
            # neighbour-contamination fallback below, not a full price
            # re-verification).
            match = re.search(r'data-price="([0-9]+(?:\.[0-9]+)?)"', html)
            if match is not None:
                return _to_decimal(match.group(1))
            # Fallback: the price-classed element's own scoped text, via the
            # shared `scoped_text` helper (issue #144) rather than a
            # hand-rolled regex bounded to 400 characters after the first
            # `class="...price|precio..."` match. NOT a "drop a
            # similar-listings carousel" migration — issue #169's research
            # (same PR) found Solvia's real, live detail pages render no
            # server-side "similar properties" markup at all; the
            # `similarProperties` class only appears inside Angular's
            # compiled component stylesheet (a `<style>` block), never as an
            # actual element in the HTML this connector's plain HTTP fetch
            # sees — the same client-hydrated-and-therefore-absent shape
            # Fotocasa's PR #153 review already documented, checked fresh
            # here rather than assumed. `keep=` scopes to the real, single,
            # server-rendered price element instead; there being nothing
            # real to `drop=` is exactly why this migration doesn't use it.
            soup = BeautifulSoup(html, "html.parser")
            text = scoped_text(soup, keep='[class~="price"], [class~="precio"]')
            if text is None:
                return None
            euro = re.search(r"([0-9]{1,3}(?:\.[0-9]{3})+)\s*€", text)
            return _to_decimal(euro.group(1).replace(".", "")) if euro else None

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
