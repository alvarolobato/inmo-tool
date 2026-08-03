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
connector therefore never paginates, and each search URL it fetches returns
only that slice's first ~30 server-rendered listings.

Zone partitioning (issue #65) is how it gets past that ~30 cap without
touching a disallowed path. Fotocasa's own city page embeds ~161
neighbourhood search links for madrid-capital
(`/es/comprar/viviendas/madrid-capital/chamberi/l`), none of which any
robots.txt rule disallows, and each returns its own distinct ~30-listing
slice (live-verified: Chamberí vs the unfiltered page overlapped 0%;
Chamberí vs Barrio de Salamanca overlapped 0%). Sweeping the zones and
unioning the results lifts Madrid coverage from ~30 to a few thousand.

What is deliberately NOT used, and why: query-string filters
(`minPrice`, `maxPrice`, `minRooms`, `maxRooms`, `propertySubtypeIds`,
`filter=*` bar an `isnewconstruction` carve-out) are all robots.txt
*disallowed*, even though they would slice the inventory further. Only
path segments — zone, property type, room count — are allowed. Every URL
this connector builds goes through `_search_url`, which takes no query
string at all, so that boundary is enforced structurally rather than by
convention (see test_every_constructed_url_is_robots_allowed).

Coverage is still partial, hence `discovers_full_inventory = False`: a
zone with more than ~30 active listings still only yields its first ~30,
and reaching the rest would require the disallowed pagination path.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

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
from etl.connectors.extraction import (
    first_present,
    strip_price_punctuation,
    text_to_int,
)
from etl.connectors.fotocasa_mapping import infer_listing_kind, map_property_type
from etl.connectors.geography import nearest_city

logger = logging.getLogger("etl.connectors.fotocasa")

_USER_AGENT = "Mozilla/5.0 (compatible; inmo-tool/0.1; +https://github.com/alvarolobato/inmo-tool)"
_BASE_URL = "https://www.fotocasa.es"
_REQUEST_TIMEOUT_SECONDS = 15

# .../vivienda/<geography-slug>/<feature-slug>/<external_id>/d
_DETAIL_HREF_RE = re.compile(r'"(/es/comprar/vivienda/[a-z0-9-]+/[a-z0-9-]+/(\d+)/d)"')
_INITIAL_PROPS_MARKER = 'id="__initial_props__"'

# Zone (neighbourhood) search links Fotocasa embeds in its own city page:
# `/es/comprar/viviendas/<geography>/<zone>/l`. Built per-geography in
# `_zone_href_re` so a Madrid page can't leak a Barcelona zone slug into a
# Madrid sweep (the city page does link some cross-city pages). See
# `_discover_zone_slugs` for why these are scraped rather than hardcoded.
#
# The optional `<N>-habitaciones/` segment matters: on a rooms-filtered base
# page (scope.rooms set) Fotocasa's own zone links carry the filter forward
# as `.../<zone>/2-habitaciones/l`. Without this branch the pattern matched
# nothing on those pages, so every rooms-filtered scope silently collapsed
# to the single unfiltered-page behaviour this whole change exists to
# replace — invisible, because a zero-slug sweep looked identical to a
# successful one (both bugs found together in PR #142 review).
_ZONE_HREF_TEMPLATE = (
    r'"/es/comprar/viviendas/{geography}/([a-z0-9-]+)/(?:\d+-habitaciones/)?l"'
)

# Not a real neighbourhood: the unfiltered "all zones" slice the city page
# itself represents. Included in a sweep it would just re-fetch the page we
# already have.
_ZONE_SLUG_ALL = "todas-las-zonas"

# Stop a sweep after this many zones in a row come back with no payload.
# Fotocasa's soft-block persists for minutes once triggered, so continuing
# spends the rest of a ~54min sweep hammering a site that is actively
# refusing us, for zero additional listings. 3 tolerates an isolated
# transient blip (or two) without tolerating a sustained block.
_MAX_CONSECUTIVE_ZONE_FAILURES = 3

# Alarm thresholds, deliberately asymmetric because the two signals mean
# different things. A *failed* zone (no payload) is the positive soft-block
# signature, so a low bar is right — a fifth of a sweep failing already
# warrants attention. An *empty* zone (well-formed page, zero listings) is
# normal in small neighbourhoods, so only a large majority is suspicious,
# and it indicates a parse regression rather than blocking.
_ZONE_FAILURE_ALARM_RATIO = 0.2
_ZONE_EMPTY_ALARM_RATIO = 0.8

# robots.txt disallows the literal path substring "/madrid/", "/barcelona/",
# "/valencia/" (bare city name as its own path segment) — not the hyphenated
# slugs (e.g. "madrid-capital") this connector actually uses. See discover().
_ROBOTS_DISALLOWED_BARE_GEOGRAPHIES = frozenset({"madrid", "barcelona", "valencia"})

# City name (etl.connectors.geography.CITY_CENTROIDS keys) -> this site's own
# URL slug. Live-verified during issue #71 (real HTTP 200 + real
# __initial_props__ listing data, not just a non-error status) for every
# entry here. Extend alongside etl.connectors.geography.CITY_CENTROIDS when
# a profile's geography resolves to a city not yet listed.
_CITY_SLUGS: dict[str, str] = {
    "madrid": "madrid-capital",
    "sevilla": "sevilla-capital",
    "barcelona": "barcelona-capital",
    "valencia": "valencia-capital",
}


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's URL slug, or None if it can't be.

    `scope.geography` (a free-text escape hatch, see ConnectorScope's
    docstring) wins when set, for tests/manual construction. Otherwise
    resolve `scope.center` to the nearest known city and look up its
    Fotocasa slug. No hardcoded default (issue #71) — a scope this connector
    can't resolve means "nothing to discover for this scope", not "assume
    Madrid".
    """
    if scope.geography:
        return scope.geography
    if scope.center is None:
        return None
    city = nearest_city(scope.center, scope.radius_km)
    if city is None:
        return None
    return _CITY_SLUGS.get(city)


def _discover_zone_slugs(html: str, geography: str) -> list[str]:
    """Extract this geography's neighbourhood ("zone") slugs from its own page.

    Scraped from the live page rather than hardcoded (issue #65). Fotocasa's
    city pages embed their full neighbourhood link set — ~161 for
    madrid-capital — so reading them keeps the list current as Fotocasa adds,
    renames or retires zones. A hardcoded table would silently rot: a renamed
    slug becomes a 404 that this connector would count as a failed zone
    forever, and a newly-added zone would never be swept at all.

    Scoped to `geography` in the pattern itself: city pages link to *other*
    cities' pages too, and an unscoped match would pull e.g. barcelona zones
    into a madrid sweep — each of which would 200 with real (wrong-city)
    listings, quietly polluting the geography the operator actually asked for.

    Returns a sorted list so a sweep's request order is deterministic (easier
    to correlate against logs when debugging a partial failure).
    """
    pattern = re.compile(_ZONE_HREF_TEMPLATE.format(geography=re.escape(geography)))
    slugs = {m.group(1) for m in pattern.finditer(html)}
    slugs.discard(_ZONE_SLUG_ALL)
    return sorted(slugs)


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


def _extract_search_result_prices(html: str) -> dict[str, Decimal]:
    """Best-effort per-listing prices from a Fotocasa search-results page.

    Issue #143: `initialSearch.result.realEstates` is a list of the same
    result cards `_DETAIL_HREF_RE` finds via anchor hrefs, but with real
    structured data attached — each entry carries both `id` and a numeric
    `rawPrice` (e.g. `945000`, not the display string `"945.000 €"`).
    Live-verified 2026-08-03 against two real pages (the unfiltered
    madrid-capital city page and a real zone page, /chamberi/l): on both,
    the full set of `realEstates[].id` values matched the connector's own
    href-extracted external_id set exactly (0 mismatches), and a sampled
    listing's search-page `rawPrice` matched that same listing's
    independently-fetched detail-page price exactly. Not previously
    documented anywhere in this codebase or in property_web_scraper's
    reference mapping — this connector's discover() never parsed this
    JSON at all before (see the module docstring's history), only the
    raw hrefs.

    Deliberately best-effort, unlike `_extract_initial_props`/discover()'s
    own use of it: this is a bonus price *signal*, not part of what makes
    a page usable for finding ids. If Fotocasa ever restructures this path
    (or a caller hands this something that isn't a real search page at
    all), every `.get(..., {})`/`.get(..., [])` below degrades to an empty
    dict rather than raising — a missing price signal just means
    `Connector.discovered_prices()`'s "no signal" default for whichever
    ids this call couldn't price, not a broken sweep. The one exception is
    `_extract_initial_props` itself raising on genuinely malformed JSON,
    which is caught here and treated the same way (no price data, not a
    propagated failure) — this function must never be why discover()
    fails when the id-extraction regex above it worked fine.
    """
    try:
        props = _extract_initial_props(html)
    except ConnectorError:
        return {}
    real_estates = ((props.get("initialSearch") or {}).get("result") or {}).get(
        "realEstates"
    )
    if not isinstance(real_estates, list):
        return {}
    prices: dict[str, Decimal] = {}
    for item in real_estates:
        if not isinstance(item, dict):
            continue
        external_id = item.get("id")
        if external_id is None:
            continue
        price = _to_decimal(item.get("rawPrice"))
        if price is not None:
            prices[str(external_id)] = price
    return prices


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


# CSS-selector fallback chain for the four fields property_web_scraper's
# es_fotocasa.json mapping flags as most likely to shift shape on a site
# redesign (count_bedrooms/count_bathrooms/constructed_area/price_float).
# Their own selectors (`.re-DetailHeader-rooms span span` etc., last
# checked by them 2026-02-20) no longer match anything on the live site as
# of this connector's own live spot-check (issue #77) — Fotocasa migrated
# to a Tailwind-utility-class design system with no semantic BEM classes.
# These selectors are freshly verified against real listings instead,
# anchored on SVG icon identifiers (`data-title="..."`) rather than layout
# classes, which should be materially more redesign-resistant since
# icon-name attributes tend to be tied to a component's *meaning*, not its
# current visual styling.
_STAT_NUMBER_RE = re.compile(r"\d[\d.,]*")


def _icon_stat_text(soup: BeautifulSoup, icon_title: str) -> str | None:
    """Find the numeric stat next to a named stat-row icon.

    Fotocasa renders each of rooms/bathrooms/surface/floor as
    `<li><svg data-title="{icon}">...</svg><span class="text-body-1">
    <span class="font-bold">{value}</span> {unit label}</span></li>` in a
    `<ul aria-label="Características principales">` block. Verified live
    (2026-08-02) against a real listing (id 189316512: rooms=2, bathrooms=2,
    surface=60, all matching the same listing's embedded-JSON values).

    Locates the right `<li>` via `data-title` (an icon-name attribute tied
    to the row's *meaning*, not its current visual styling) but then reads
    the number via a regex over the `<li>`'s own text rather than a
    `.font-bold` CSS class — depending on a specific Tailwind utility class
    surviving the next redesign would undercut the whole point of this
    fallback, which exists precisely because property_web_scraper's own
    class-based selectors already broke once (Opus review, PR #84).
    """
    svg = soup.select_one(f'svg[data-title="{icon_title}"]')
    if svg is None:
        return None
    li = svg.find_parent("li")
    if li is None:
        return None
    match = _STAT_NUMBER_RE.search(li.get_text())
    return match.group(0) if match else None


def _price_fallback_text(soup: BeautifulSoup) -> str | None:
    """The main price display: `<div aria-label="Precio del inmueble">
    <span>379.000 €</span></div>`. Verified live (2026-08-02) against the
    same listing referenced in `_icon_stat_text`'s docstring."""
    el = soup.select_one('div[aria-label="Precio del inmueble"] span')
    if el is None:
        return None
    return el.get_text(strip=True)


_REFERENCE_FALLBACK_RE = re.compile(r"Referencia:\s*(\S+)")


def _reference_fallback_text(soup: BeautifulSoup) -> str | None:
    """The agent-contact reference line: `<ul
    class="re-FormContactDetail-referenceAlias"><li>Referencia: NS603</li>
    </ul>`. Verified live (2026-08-02) against a real Sevilla listing
    (the same "NS603" example cited in issue #72) — matches
    `realEstate.reference` from the embedded JSON exactly. `re-*` is a
    semantic BEM-style class name Fotocasa uses for this component (not a
    Tailwind utility class like the ones that broke property_web_scraper's
    selectors), so it's a reasonable fallback anchor on its own, but the
    regex over the `<li>`'s text (rather than trusting the class survives
    forever) keeps this consistent with `_icon_stat_text`'s more defensive
    approach.

    Deliberately NOT carousel-scoped, unlike Vivantial (price, PR #139),
    Servihabitat (m2, PR #141) and Solvia (latent, PR #138). PR #153 first
    added a `drop=` for "similar properties" carousels here by analogy with
    those three, on the assumption the same contamination applied. Review
    caught that the assumption was untested — the selectors matched nothing
    but the test's own hand-authored markup — so it was checked against two
    real pages of different property types (the issue #149 trastero
    190239270, and Madrid/Chamberi vivienda 189882136), captured as
    `fotocasa_sample_detail_reference.html`:

        "Referencia:"                        x1
        ".re-FormContactDetail-referenceAlias" x1

    The reference renders exactly once. "inmuebles similares" / "anuncios
    similares" do appear, but as i18n translation *values* inside the
    embedded JSON (saved-search alert copy), not as rendered neighbour cards
    carrying reference codes. Fotocasa's related-property rails are
    client-hydrated and absent from the server HTML this connector parses.

    So there is no neighbour reference on the page for `select_one` to
    prefer, and a `drop=` here would be dead code implying coverage it does
    not have. If Fotocasa ever server-renders such a rail, `scoped_node(...,
    drop=...)` is the one-line fix — and the fixture above is what would
    show it changed.
    """
    el = soup.select_one(".re-FormContactDetail-referenceAlias li")
    if el is None:
        return None
    match = _REFERENCE_FALLBACK_RE.search(el.get_text())
    return match.group(1) if match else None


class FotocasaConnector(Connector):
    name = "fotocasa"
    # Measured, not guessed (issue #65). Zone partitioning turned a 1-request
    # sweep into ~161, which made this rate load-bearing in a way it never
    # was before, so it was characterised live:
    #
    #   20/min (3s apart)  -> first ~4 zones return full data, then every
    #                         subsequent page comes back HTTP 200 with the
    #                         `__initial_props__` payload MISSING entirely.
    #                         That is Fotocasa's soft-block page (the same
    #                         one PR #49 documented), and it persisted for
    #                         minutes after the burst stopped.
    #    3/min (20s apart) -> sustained full data (31/30/30 ids across
    #                         consecutive real zones after a cooldown).
    #
    # The soft-block is the reason this is 3 and not 20: a faster sweep does
    # not merely risk a ban, it silently returns *fewer* listings while every
    # request still looks like a success (HTTP 200). Going faster here would
    # actively defeat the coverage this whole change exists to gain.
    #
    # Cost of being correct: a full 161-request sweep takes ~54 min. See
    # `max_zones_per_sweep` for the knob that bounds it, and the PR for why
    # the follow-on fetch_detail volume needs its own decision.
    rate_limit_per_minute = 3

    # Bounds one sweep's request count (None = every discovered zone).
    # Deliberately not defaulted to a small number: silently sampling a
    # subset would make coverage look like a connector property rather than
    # an operator choice, and `discovers_full_inventory=False` already tells
    # the orchestrator not to infer withdrawal from absence. Set this when
    # the ~54min full sweep does not fit the schedule.
    #
    # NOTE: this is a class attribute, not a `connector_config` field — it
    # is not settable from the connector-management UI (#100) today, so the
    # log messages below must not tell an operator to "set" it as though it
    # were. Issue #143 added `connector_config.min_refetch_interval_seconds`
    # as the operator-facing fetch-budget lever instead (skip re-fetching
    # already-known listings, not bounding how many zones a sweep visits) —
    # deliberately scoped that way rather than also wiring this one up, to
    # keep that change reviewable. Making *this* knob configurable too is
    # still open; a small, separate follow-up, not bundled into #143.
    max_zones_per_sweep: int | None = None
    # Still False after zone partitioning (issue #65), but for a weaker
    # reason than before. Coverage went from ~30 of madrid-capital's 11,361
    # listings (<0.3%) to a measured floor of ~1,500 (~13%) by sweeping the
    # ~161 robots.txt-allowed neighbourhood slices. That is a ~50x
    # improvement,
    # but it is not complete: any zone with more than ~30 active listings
    # still yields only its first ~30, because reaching the rest needs the
    # disallowed pagination path. A listing in a busy zone can therefore
    # still be absent from a sweep while remaining perfectly active, so
    # consecutive "misses" still prove nothing about withdrawal. See
    # Connector.discovers_full_inventory's docstring for what this
    # disables (the orchestrator's withdrawal auto-transition).
    discovers_full_inventory = False

    # Issue #100: the one native site filter live-verified as real for this
    # site (issue #99) — Fotocasa's `/N-habitaciones/` URL segment, an
    # EXACT-match room count, not a minimum. Price range and property type
    # exist in Fotocasa's own sidebar UI but their URL mechanism is
    # unconfirmed (docs/architecture/connectors.md), so they're deliberately
    # absent here rather than shipped as controls that might silently no-op.
    supported_filters = ("rooms",)

    # Issue #143: this is the connector the fetch-budget problem was written
    # about (see the issue — a single sweep at 3 req/min was ~8h even before
    # zone partitioning made discover() itself heavier). 24h is a documented
    # freshness window, not an arbitrary guess: real-estate list prices and
    # statuses don't typically move sub-daily, and `discovered_prices()`
    # below (Fotocasa's search pages embed a real per-listing price already
    # — see its docstring) forces a re-fetch immediately whenever a price
    # genuinely changes, regardless of this window — so 24h bounds the
    # *worst case* for a listing whose price hasn't moved, not the actual
    # price-change detection latency for the common case. Operator-
    # overridable via `connector_config.min_refetch_interval_seconds`.
    min_refetch_interval_seconds = 24 * 60 * 60

    def __init__(self) -> None:
        # Populated by discover() as a side effect of the same request(s)
        # it already makes to find external_ids — see discovered_prices()
        # and _extract_search_result_prices(). Reset at the start of every
        # discover() call, so a scope that fails partway through never
        # leaves a previous scope's prices behind for the orchestrator to
        # misread as this scope's data.
        self._last_discovery_prices: dict[str, Decimal] = {}

    def discovered_prices(self) -> dict[str, Decimal]:
        """See Connector.discovered_prices. Fotocasa's search-results pages
        embed a real per-listing price (`initialSearch.result.realEstates
        [].rawPrice`) in the same `__initial_props__` JSON blob discover()
        already fetches — live-verified 2026-08-03 against real pages (see
        _extract_search_result_prices' docstring for the specifics): the
        `id`/`rawPrice` set matches the connector's own href-extracted
        external_ids exactly, on both the unfiltered city page and a real
        zone page, and `rawPrice` matched the same listing's detail-page
        price exactly. Populated across the whole sweep (baseline page +
        every successfully-fetched zone), not just the baseline.
        """
        return dict(self._last_discovery_prices)

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Delegate to `_resolve_geography` — the actual slug this scope
        resolves to (or None if unresolvable) IS the right dedup/coverage
        key: two scopes resolving to the same slug hit the identical URL.

        `rooms` is folded into the key (issue #99): two scopes with the
        same geography but different room-count filters hit genuinely
        different URLs (confirmed live — see docs/architecture/connectors.md),
        so they must not be deduplicated against each other in
        etl.orchestrator.run_all_connectors's seen_scope_keys tracking.
        """
        geography = _resolve_geography(scope)
        if geography is None:
            return None
        if scope.rooms is not None:
            return f"{geography}:rooms={scope.rooms}"
        return geography

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # Issue #143: reset before this scope's own sweep runs, not after —
        # a scope that raises partway through (bad geography, robots.txt
        # guard, a strict base-page fetch failure) must not leave a PRIOR
        # scope's prices sitting here for the orchestrator to read via
        # discovered_prices() and misattribute to a sweep that never
        # actually happened.
        self._last_discovery_prices = {}

        geography = _resolve_geography(scope)
        if geography is None:
            raise ConnectorError(
                "fotocasa discover: scope has neither a resolvable center "
                "(nearest known city too far away) nor an explicit geography "
                "string — nothing to discover, not defaulting to a hardcoded "
                "city (see issue #71)"
            )
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
        # Room-count filtering (issue #99): confirmed live that
        # ".../todas-las-zonas/2-habitaciones/l" returns a genuinely
        # narrower result set with its own heading ("... con 2
        # habitaciones"), not an SEO-alias page identical to the
        # unfiltered URL — see docs/architecture/connectors.md for the
        # verification. This is an EXACT-match filter, not "N or more"
        # (every result in the live sample had exactly N rooms) — hence
        # `ConnectorScope.rooms`, not `min_rooms`. Price-range/property-type
        # filters are visibly present in the site's own UI but their URL
        # mechanism wasn't observable via static fetch — not wired in here,
        # needs its own feasibility spike first (issue #99).
        rooms_segment = (
            f"{scope.rooms}-habitaciones/" if scope.rooms is not None else ""
        )
        base_url = self._search_url(geography, _ZONE_SLUG_ALL, rooms_segment)

        # The unfiltered city page serves double duty: its listings are the
        # baseline slice, and its own embedded neighbourhood links are where
        # the zone slugs come from (see _discover_zone_slugs).
        throttle()
        base_html = self._fetch_search_page(base_url, strict=True)
        external_ids: set[str] = self._parse_external_ids(base_html)
        baseline_count = len(external_ids)
        # Issue #143: free — the same request, the same JSON blob, no extra
        # fetch. See discovered_prices()/_extract_search_result_prices.
        self._last_discovery_prices.update(_extract_search_result_prices(base_html))

        zone_slugs = _discover_zone_slugs(base_html, geography)
        if not zone_slugs:
            # Zero zones means this sweep just silently reverted to the
            # pre-#65 single-page behaviour — the exact regression this
            # change exists to prevent, and the one failure mode that
            # otherwise looks *identical* to a healthy sweep (a normal
            # 200, a plausible ~30 listings, no exception). Two known
            # causes: Fotocasa changed its zone-link markup, or the
            # geography genuinely has no neighbourhood breakdown. Both
            # warrant a human looking, so this is ERROR, not a debug note.
            logger.error(
                "fotocasa discover: no zone slugs found on the %s base page "
                "— zone link markup may have changed; coverage has silently "
                "fallen back to the unfiltered page only (%d listings). "
                "Sweep aborted early: without zones there is nothing to sweep.",
                geography,
                baseline_count,
            )
            return sorted(external_ids)

        if self.max_zones_per_sweep is not None and self.max_zones_per_sweep < len(
            zone_slugs
        ):
            # Rotate the window rather than always taking the alphabetical
            # head: a fixed prefix means the tail of the city is NEVER swept,
            # so those listings would be permanently invisible instead of
            # merely delayed. Offset by day-of-year so consecutive days cover
            # different slices and the whole city is reached over time.
            # Deterministic within a day, so retries of the same run stay
            # consistent rather than re-fetching an arbitrary new slice.
            offset = (
                datetime.now(timezone.utc).timetuple().tm_yday
                * self.max_zones_per_sweep
            ) % len(zone_slugs)
            rotated = zone_slugs[offset:] + zone_slugs[:offset]
            zone_slugs = rotated[: self.max_zones_per_sweep]
        zones_failed = 0
        zones_empty = 0
        zones_attempted = 0
        consecutive_failures = 0
        aborted_early = False
        for slug in zone_slugs:
            zones_attempted += 1
            url = self._search_url(geography, slug, rooms_segment)
            throttle()
            # strict=False: one zone 404ing, timing out, or serving a
            # soft-block page must not abort a sweep of ~160 — that would
            # turn a single transient blip into total coverage loss. Failures
            # are counted and logged instead (a systematic breakage shows up
            # as a high zones_failed, not as silently halved coverage).
            zone_html = self._fetch_search_page(url, strict=False)
            if zone_html is None:
                zones_failed += 1
                consecutive_failures += 1
                if consecutive_failures >= _MAX_CONSECUTIVE_ZONE_FAILURES:
                    # Fotocasa's soft-block persists for minutes once
                    # triggered, so continuing would spend the rest of a
                    # ~54min sweep hammering a site actively refusing us —
                    # gaining nothing and being a bad citizen. Stop and
                    # surface it; the partial result is still returned
                    # (discovers_full_inventory=False means a short sweep
                    # can't be misread as evidence of withdrawal).
                    aborted_early = True
                    logger.error(
                        "fotocasa discover: aborting %s sweep after %d "
                        "consecutive zone failures — the site is likely "
                        "soft-blocking (it serves 200s with no payload once "
                        "rate-limited). Attempted %d of %d zones; returning "
                        "the partial result rather than continuing to hammer it.",
                        geography,
                        consecutive_failures,
                        zones_attempted,
                        len(zone_slugs),
                    )
                    break
                continue
            consecutive_failures = 0
            zone_ids = self._parse_external_ids(zone_html)
            # Issue #143: same free extraction as the baseline page, above.
            self._last_discovery_prices.update(_extract_search_result_prices(zone_html))
            if not zone_ids:
                # A valid-looking page (it had __initial_props__) that still
                # parsed to zero listings. Unlike a *failed* zone this is NOT
                # the throttle signature — a soft-blocked response lacks the
                # payload entirely and lands in zones_failed. So this is
                # usually a genuinely small/empty neighbourhood, and is
                # reported separately rather than folded into the block alarm.
                zones_empty += 1
            external_ids |= zone_ids

        logger.info(
            "fotocasa discover: geography=%s found %d external_ids "
            "(%d from the unfiltered page + %d of %d zones attempted, "
            "%d zones failed, %d zones empty%s)",
            geography,
            len(external_ids),
            baseline_count,
            zones_attempted,
            len(zone_slugs),
            zones_failed,
            zones_empty,
            ", sweep aborted early" if aborted_early else "",
        )

        # These two conditions are deliberately NOT combined into one
        # failed-or-empty ratio. Throttling is *positively* identifiable:
        # a soft-blocked response has no __initial_props__ payload at all,
        # so it raises and lands in zones_failed. A genuinely small
        # neighbourhood returns a well-formed page with zero listings and
        # lands in zones_empty. Folding them together (as this did before
        # PR #142's review) made a sparse geography — or, before the regex
        # fix above, any rooms-filtered scope — trigger an alarm that
        # asserted "likely rate-induced soft-blocking" about a site behaving
        # perfectly well.
        if (
            zones_attempted
            and zones_failed > zones_attempted * _ZONE_FAILURE_ALARM_RATIO
        ):
            logger.error(
                "fotocasa discover: %d/%d attempted zones for geography=%s "
                "failed to return a payload — this is the soft-block "
                "signature (measured: at 20 req/min Fotocasa starts serving "
                "200s with no payload after ~4 requests). rate_limit_per_minute "
                "is currently %d; lowering it requires a code change, as does "
                "bounding the sweep via max_zones_per_sweep (neither is "
                "operator-settable today).",
                zones_failed,
                zones_attempted,
                geography,
                self.rate_limit_per_minute,
            )
        elif (
            zones_attempted and zones_empty > zones_attempted * _ZONE_EMPTY_ALARM_RATIO
        ):
            # Not a throttle signal — these pages parsed fine and simply had
            # no listings. En masse that points at a parse regression (the
            # listing-link markup changed) rather than at the site blocking
            # us, so it gets its own message and its own remedy.
            logger.error(
                "fotocasa discover: %d/%d attempted zones for geography=%s "
                "returned well-formed pages with zero listings — real "
                "neighbourhoods reliably carry ~30, so this points at a "
                "listing-link parse regression rather than soft-blocking.",
                zones_empty,
                zones_attempted,
                geography,
            )
        return sorted(external_ids)

    def _search_url(self, geography: str, zone_slug: str, rooms_segment: str) -> str:
        """Build a search URL from path segments only.

        Deliberately takes no query-string parameters: Fotocasa's robots.txt
        disallows the filter query params (`minPrice`, `maxPrice`, `minRooms`,
        `maxRooms`, `propertySubtypeIds`, `filter=*` bar one carve-out) while
        leaving these path segments allowed. Keeping URL construction funnelled
        through one query-string-free helper is what makes that boundary
        testable — see test_every_constructed_url_is_robots_allowed.
        """
        return (
            f"{_BASE_URL}/es/comprar/viviendas/{geography}/{zone_slug}/{rooms_segment}l"
        )

    def _fetch_search_page(self, url: str, *, strict: bool) -> str | None:
        """Fetch one search page. `strict` controls failure handling.

        strict=True  -> raise ConnectorError (used for the base city page,
                        whose failure means the whole sweep is meaningless).
        strict=False -> return None (used per-zone, where one failure among
                        ~160 should degrade coverage, not abort the sweep).
        """
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            if strict:
                raise ConnectorError(
                    f"fotocasa discover: request failed for {url}: {exc}"
                ) from exc
            logger.warning(
                "fotocasa discover: zone request failed for %s: %s", url, exc
            )
            return None

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
            if strict:
                raise ConnectorError(
                    "fotocasa discover: response has no __initial_props__ — likely "
                    "a soft-block/interruption page, not a real search results page"
                )
            logger.warning(
                "fotocasa discover: zone page has no __initial_props__ "
                "(soft-block or empty zone?) for %s",
                url,
            )
            return None
        return response.text

    @staticmethod
    def _parse_external_ids(html: str) -> set[str]:
        return {m.group(2) for m in _DETAIL_HREF_RE.finditer(html)}

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
            # `html` is only parsed (BeautifulSoup) in normalize() if a
            # JSON-path field actually comes back empty — the fallback
            # chain's whole point is to not pay HTML-parsing cost on the
            # happy path where the embedded JSON has everything.
            raw={"url": response.url, "props": props, "html": response.text},
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

        # BeautifulSoup only gets built if a JSON-path field actually comes
        # back empty (see fetch_detail's comment) — a plain mutable cell
        # rather than functools.cache since this is a one-shot per-call
        # helper, not something worth the decorator machinery for.
        _soup_cache: list[BeautifulSoup | None] = [None]

        def soup() -> BeautifulSoup:
            if _soup_cache[0] is None:
                _soup_cache[0] = BeautifulSoup(raw.raw.get("html", ""), "html.parser")
            return _soup_cache[0]

        address_parts = [
            address_block.get("upperLevel"),
            address_block.get("district"),
            address_block.get("municipality") or address_block.get("city"),
        ]
        address = ", ".join(p.strip() for p in address_parts if p and p.strip()) or None

        # multimedia mixes real photos with other asset types — a live
        # listing showed {"type": "tour-virtual", "src": "https://floorfy.com/..."}
        # alongside {"type": "image", ...} entries. Without this filter the
        # virtual-tour link lands in photo_urls, renders as a broken <img> on
        # the property detail page, and gets fed to the photo-hash dedup
        # signal, which fails to decode it (Fable phase-2 review).
        photo_urls = tuple(
            item["src"]
            for item in multimedia
            if isinstance(item, dict)
            and item.get("type") == "image"
            and item.get("src")
        )

        client_name = real_estate.get("clientName") or real_estate.get("clientAlias")
        client_url = real_estate.get("clientUrl")

        # Fallback chain (issue #77): embedded JSON is the primary strategy
        # for all four fields; a live CSS fallback (icon-anchored, see
        # _icon_stat_text/_price_fallback_text) recovers the value if the
        # JSON path is ever renamed/restructured. HTML is only parsed if
        # the JSON side comes back empty.
        rooms = first_present(
            lambda: _to_int(features.get("rooms")),
            lambda: text_to_int(_icon_stat_text(soup(), "double_bed")),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: _to_int(features.get("bathrooms")),
            lambda: text_to_int(_icon_stat_text(soup(), "bathroom_tub")),
            field="bathrooms",
        )
        # Seller/agency reference code (issue #72), e.g. "Referencia: NS603" —
        # a dedup signal (etl/dedup/signals/reference_code.py), not a unique
        # key: two different agencies can coincidentally use the same code.
        reference_code = first_present(
            lambda: (real_estate.get("reference") or "").strip() or None,
            lambda: _reference_fallback_text(soup()),
            field="reference_code",
        )
        m2_built = first_present(
            lambda: _to_decimal(features.get("surface")),
            lambda: _to_decimal(
                text_to_int(_icon_stat_text(soup(), "dimensions_block"))
            ),
            field="m2_built",
        )
        current_price = first_present(
            lambda: _to_decimal(real_estate.get("price")),
            lambda: _to_decimal(strip_price_punctuation(_price_fallback_text(soup()))),
            field="current_price",
        )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(
                client_url, client_name, real_estate.get("clientId")
            ),
            status="active",
            current_price=current_price,
            description=(
                descriptions.get("es-ES") or next(iter(descriptions.values()), None)
            ),
            photo_urls=photo_urls,
            contact_raw=client_name,
            reference_code=reference_code,
            address=address,
            lat=_to_decimal(coords.get("latitude")),
            lon=_to_decimal(coords.get("longitude")),
            property_type=map_property_type(real_estate.get("buildingType")),
            m2_built=m2_built,
            m2_useful=None,  # Fotocasa's `features.surface` doesn't distinguish
            # built vs. useful area in the fields observed during the
            # feasibility spike — revisit if a sampled listing shows both.
            rooms=rooms,
            bathrooms=bathrooms,
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
            # Schema superset vs. property_web_scraper (issue #76/#77): this
            # connector already parsed these into address/raw_extra and
            # discarded the structure — promoted to real columns here.
            city=(address_block.get("city") or "").strip() or None,
            province=(address_block.get("province") or "").strip() or None,
            postal_code=(address_block.get("zipCode") or "").strip() or None,
            # `0` from `features.surfaceLand` means "not a plot-having
            # property type" / unknown, not "a plot of zero square meters" —
            # treated as absent so it doesn't get COALESCE-persisted as a
            # real measurement on every revisit (Opus review, PR #84).
            m2_plot=_to_decimal(features.get("surfaceLand")) or None,
            # `features` (TEXT[] amenity slugs, e.g. terraza/trastero) is
            # deliberately left empty here — issue #77's acceptance
            # criteria only requires city/province/postal_code/m2_plot;
            # this connector's detail JSON (`realEstate.features`) doesn't
            # carry the same boolean-amenity shape property_web_scraper's
            # mapping assumes, and mapping it correctly needs its own
            # investigation (left for a follow-up, not silently invented
            # here from an unverified guess).
            operation="sale",  # This connector's discover() only ever
            # requests Fotocasa's /comprar/ (buy) search URLs, and no
            # transaction-type key was found in `realEstate`'s embedded
            # JSON during this connector's feasibility spike to derive this
            # from real data instead. Caveat (Opus review, PR #84):
            # fetch_detail()'s own URL is a placeholder slug that Fotocasa's
            # routing ignores except for the trailing id — so this rests on
            # discover() never having handed this connector a rental
            # listing's id, not on anything fetch_detail() itself can
            # verify per-listing. Revisit if a rental-aware discover() or a
            # real operation-indicating JSON key is ever found.
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
