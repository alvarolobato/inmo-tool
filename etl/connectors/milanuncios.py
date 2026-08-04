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

Issue #179 rate measurement (live, 2026-08-03): production was tripping
the circuit breaker every run at `rate_limit_per_minute = 20` (5
successes then a permanent block within ~15s — the comment this replaced
called 20 "the same conservative default as Fotocasa", which stopped
being true when Fotocasa dropped to 3, #65). Measured directly rather than
copied by analogy:

  20/min (3s apart)  -> matches production: ~5 fetch_detail successes,
                        then every subsequent request returns HTTP 200
                        with __INITIAL_PROPS__ missing, permanently for
                        the rest of the run.
   6/min (10s apart) -> IDENTICAL signature: 5 successes, then blocked.
                        A 3.3x slower pace made no difference at all —
                        this rules out the entire 6-20/min range and
                        disproves "just ease off a bit" as a fix.

Both failures are the exact same real page: a GeeTest CAPTCHA challenge
("Pardon Our Interruption" / `noindex, nofollow` / `#captcha-box`,
captured live and trimmed into milanuncios_sample_soft_block_page.html —
see MilanunciosSoftBlockError below), served with HTTP 200 and no
Set-Cookie header at all (checked directly — there is no session-cookie
escape hatch a persistent `requests.Session()` could exploit; this is a
server-side block, not a client-side JS challenge with a bypassable
exemption cookie). Once tripped it did not clear for over 60 minutes of
continuous observation (vs. Fotocasa's documented "persists for minutes")
— dramatically more punishing than Fotocasa's equivalent wall, which is
why this connector's final rate is set BELOW Fotocasa's 3, not equal to
it. `discover()`'s search-page endpoint stayed fully open the entire time
fetch_detail() was blocked — the wall is scoped to (at least primarily)
the detail-page path, not the whole site.

**What was NOT established, and why**: whether a pace slower than 10s
(e.g. 20-60s) raises the ~5-request trip threshold at all, or whether the
block is a fixed per-session request count largely independent of pace in
that range. Both live-measured data points (3s and 10s) show identical
behaviour, which is consistent with a count-based trigger rather than a
rate-based one — but a genuinely slower cadence remains untested, because
each additional live test costs another 60+-minute lockout on the
owner's real home connection (Telefónica, issue #179's own considerateness
requirement), and this investigation had already spent over an hour
confirming the block does not self-clear on its own within a session that
kept checking it (which may itself have kept resetting any decay timer —
a methodological lesson for whoever runs the follow-up measurement:
stop probing entirely and check back once, after a long gap, rather than
polling). `rate_limit_per_minute = 2` below is therefore a conservative,
evidence-informed value — genuinely below the two rates proven to fail,
not copied from Fotocasa by analogy — but it is NOT proven to sustain a
full 41-listing run the way Fotocasa's 3/min was proven to sustain a
161-request sweep. Revisit with a slower-cadence live test once enough
time has passed for the current lockout to be confirmed clear.
"""

from __future__ import annotations

import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit

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
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
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

# Issue #179: literal strings from a REAL captured soft-block/interruption
# page (milanuncios_sample_soft_block_page.html — fetched live 2026-08-03
# while measuring this connector's safe rate; see rate_limit_per_minute's
# own comment for the full measurement). Any one of these appearing means
# "Milanuncios' own bot-mitigation wall (a GeeTest CAPTCHA challenge, HTTP
# 200 with ~95KB of static challenge markup)", not "the site redesigned
# this page" or "this specific ad was removed" — two failures that used to
# produce an identical, undifferentiated ConnectorError. Distinguishing
# them matters because they call for opposite responses (module docstring,
# issue #66): a soft block means back off further; anything else missing
# the marker is a genuine parsing/structure problem worth a human looking
# at. This does NOT resolve #66 itself (a removed-ad page still isn't
# distinguishable from "some other reason the marker is missing" without
# its own real captured sample) — it only carves the one signature that
# is now positively confirmed out of the generic bucket.
_SOFT_BLOCK_MARKERS = (
    "Pardon Our Interruption",
    "Tu visita a Milanuncios se ha interrumpido",
    'id="captcha-box"',
)


class MilanunciosSoftBlockError(ConnectorError):
    """__INITIAL_PROPS__ was missing AND the page carries Milanuncios' own
    confirmed bot-mitigation signature. Subclasses ConnectorError so the
    orchestrator's circuit breaker keeps counting it exactly as before —
    this is a narrower diagnosis, not a different failure category."""


def _has_soft_block_signature(html: str) -> bool:
    return any(marker in html for marker in _SOFT_BLOCK_MARKERS)


# Municipality name (etl.connectors.geography.Place.name values) -> this
# site's own geography path segment. Milanuncios's URL just repeats the
# municipality name itself for the original four (see discover()), so this
# started as an identity mapping — kept as an explicit table anyway (not
# resolve_place()'s result used directly) so a future municipality whose
# Milanuncios path segment differs from its gazetteer name doesn't require
# touching discover()'s logic, only this table. That divergence is real, not
# hypothetical: verified live during issue #169 that
# "venta-de-pisos-en-marbella-marbella" does NOT work (redirects to a
# geography-less nationwide results page — a same-shape trap to Fotocasa's
# "similar-listings carousel that only exists in test HTML", just discovered
# before it was shipped) — Marbella is deliberately NOT in this table.
# Live-verified (real HTTP 200 + real ad-list data via __INITIAL_PROPS__,
# not just a non-error status) for every entry actually present here.
_CITY_SLUGS: dict[str, str] = {
    "madrid": "madrid",
    "sevilla": "sevilla",
    "barcelona": "barcelona",
    "valencia": "valencia",
    # Costa del Sol (issue #169 course-correction v1 market): only the
    # provincial capital verified so far. Marbella confirmed NOT to follow
    # the identity pattern (see comment above) and the other Costa del Sol
    # towns weren't individually re-tried this round — leaving them out is
    # a legitimate "no coverage for this connector yet" rather than a
    # guessed slug that might silently crawl the wrong (or no) geography.
    "malaga": "malaga",
}


def _resolve_geography(scope: ConnectorScope) -> str | None:
    """Turn a ConnectorScope into this site's geography path segment, or None.

    Same contract as fotocasa.py's `_resolve_geography` — `scope.geography`
    wins when set (tests/manual construction), otherwise resolve
    `scope.center` via the shared gazetteer (issue #169). No hardcoded
    default (issue #71): a municipality this connector's own table doesn't
    cover means "nothing to discover", not "assume Madrid".

    Can raise `UnresolvableGeographyError` (from `resolve_place`) — see
    fotocasa.py's `_resolve_geography` docstring for why that's deliberate.
    """
    if scope.geography:
        return scope.geography
    place = resolve_place(scope)
    if place is None:
        return None
    return _CITY_SLUGS.get(place.name)


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
        if _has_soft_block_signature(html):
            raise MilanunciosSoftBlockError(
                "milanuncios: soft-block/interruption page detected (GeeTest "
                "CAPTCHA challenge signature present) — this is rate-induced "
                "throttling, not a page-structure change; back off rather "
                "than treat this as a parsing bug"
            )
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


# Issue #206 / D-020: the CDN behind `ad.images` 404s "Rule parameter not
# Found" without an explicit `?rule=<preset>` query parameter — see
# `normalize()`'s own comment on `photo_urls` for the full live investigation
# (both hosts, both failure/success bodies). Hoisted to module level (out of
# `normalize()`'s old local closure) for two reasons:
#
# 1. Issue #210: PR #209 only fixed this at ingest time. The 795 URLs already
#    sitting in `listing.photo_urls` before that deploy needed a one-off
#    backfill migration (`etl/schema/init.sql`'s "Backfill: Milanuncios photo
#    URLs..." block) — matching that migration's SQL against this exact rule
#    is the whole point of pulling it out somewhere importable/testable
#    instead of leaving it trapped inside `normalize()`.
# 2. `test_connector_milanuncios.py::test_migration_sql_matches_add_photo_rule_if_missing`
#    (DB-backed) runs the real SQL UPDATE against a battery of URLs and
#    asserts it produces byte-identical output to this function on the same
#    inputs — the practical version of "the migration calls the same helper"
#    a pure-SQL `init.sql` block can offer: one Python source of truth for
#    the rule, one test that fails the moment the two drift.
PHOTO_RULE = "detail_640x480"


def add_photo_rule_if_missing(url: str) -> str:
    """Append `?rule=<PHOTO_RULE>` (or `&rule=...` if *url* ends in a bare
    `?`) when *url* carries no non-empty query string; otherwise return it
    unchanged.

    Byte-for-byte what `normalize()`'s photo-URL pipeline needs after the
    scheme has already been normalized to `http(s)://` (see `normalize()` —
    this function does not itself handle scheme-relative/bare-hostname
    input, since every already-stored `listing.photo_urls` value predates
    this split already carries a full scheme). Also what the init.sql
    backfill migration's SQL reimplements — see the comment on `PHOTO_RULE`
    above and `test_migration_sql_matches_add_photo_rule_if_missing`.
    """
    if urlsplit(url).query:
        return url
    separator = "&" if url.endswith("?") else "?"
    return f"{url}{separator}rule={PHOTO_RULE}"


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
    # Measured live, 2026-08-03 (issue #179) — see the module docstring for
    # the full write-up. 20/min and 6/min both failed identically (~5
    # fetch_detail successes then a soft-block lasting 60+ minutes), which
    # rules out the entire 6-20/min range but does not pin the exact safe
    # floor — a slower cadence remains untested (each test costs another
    # long lockout on the owner's real connection). Set below Fotocasa's
    # independently-measured 3/min (#65) rather than equal to it, because
    # Milanuncios showed an equal-or-worse block at a pace Fotocasa
    # actually survives (10s here vs. Fotocasa's proven-safe 20s). This is
    # a conservative, evidence-informed value, not a fully validated
    # sustained-safe rate — flagged for a follow-up slower-pace
    # measurement once the current lockout is confirmed clear.
    rate_limit_per_minute = 2
    # False: like Fotocasa, discover() only reads page 1 of one sale category
    # (robots.txt disallows pagination params here too), against inventory
    # that's realistically in the thousands for a whole province. Same
    # reasoning as fotocasa.py — see Connector.discovers_full_inventory's
    # docstring and docs/architecture/connectors.md. Not independently
    # re-derived per connector; inherited by default until a connector can
    # honestly claim full coverage.
    discovers_full_inventory = False

    # Issue #143: does NOT override discovered_prices() or set
    # min_refetch_interval_seconds above 0 (the base default — always
    # re-fetch). Investigated, not assumed: this connector's discover()
    # already parses `adListPagination.adList.ads[]` for `id`, and the
    # trimmed test fixtures (milanuncios_sample_search*.html — trimmed to
    # only fields the parsing code actually reads, per this project's own
    # fixture convention) show each `ad` entry carrying `category`,
    # `sellerType`, `origin`, but no price field. A live re-check to
    # confirm the *real* site's `ad` shape (attempted 2026-08-03, same
    # session as Fotocasa's search-page price verification) got a
    # `noindex`/"Pardon Our Interruption" bot-block page instead of real
    # search results — a different failure signature from Fotocasa's
    # silent-200-no-payload block, but a block all the same, and not
    # retried (issue #1 §15 — don't lean harder on a source that just
    # pushed back). So there is no live evidence either way for this
    # connector, unlike Fotocasa's confirmed `rawPrice`. Shipping a guess
    # here risks exactly the failure mode issue #143 warns about — a
    # silently-wrong discovery price would make skip-if-seen trust a
    # signal that isn't real, which is worse than having no signal at
    # all. Revisit once a real search-page fetch succeeds and its `ad`
    # shape can be checked directly — see docs/skills/connectors.md.
    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Delegate to `_resolve_geography` — see FotocasaConnector.scope_key
        for why the resolved slug itself is the right dedup/coverage key,
        and for why an `UnresolvableGeographyError` (issue #169) must be
        translated into a sentinel key here rather than `None` — this
        method must never raise itself."""
        try:
            return _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # _resolve_geography can raise UnresolvableGeographyError, left to
        # propagate uncaught (issue #169) — see fotocasa.py's discover() for
        # the full reasoning.
        geography = _resolve_geography(scope)
        if geography is None:
            # Reachable only if discover() is invoked directly, bypassing
            # scope_key()'s gate — see fotocasa.py's discover() docstring.
            raise ConnectorError(
                "milanuncios discover: scope has neither a resolvable center "
                "nor an explicit geography string, or resolves to a "
                "municipality this connector's _CITY_SLUGS table doesn't "
                "cover — nothing to discover, not defaulting to a "
                "hardcoded city (see issue #71)"
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
        #
        # Issue #206: that bare URL is also *unfetchable as-is* for a real
        # share of listings, not just schemeless. Live evidence, 2026-08-04:
        # `ad.images` entries for some listings resolve through
        # images.milanuncios.com/api/v1/ma-ad-media-pro/images/<uuid> — a
        # named image-transform proxy (the "ma-ad-media-pro" rule engine),
        # not a plain object store. Fetching that URL bare returns HTTP 404
        # "Rule parameter not Found" (a real Varnish response body, byte for
        # byte the production symptom this issue reports) — confirmed this
        # is a required *query parameter*, not a header problem: neither
        # Referer nor Origin nor Accept changes the outcome, but appending
        # `?rule=<preset-name>` does (verified against a live ad both ways).
        # The site's own rendered <img> tags always carry this param
        # (`?rule=hw396_70`, `?rule=detail_640x480`, etc. depending on
        # display context) — `ad.images` itself never includes it; the
        # frontend adds it at render time, so this connector has to as well.
        # `detail_640x480` was picked from the confirmed-valid set (also
        # includes `hw396`/`hw396_70`/`detail_432x320`; `thumb`/`original`
        # are NOT valid on this host and still 404) as a reasonably large,
        # non-cropped size — good for the photo_hash dedup signal
        # (etl/dedup/signals/photo_hash.py), which is the actual consumer
        # this bug broke (see docs/architecture/connectors.md's Milanuncios
        # section and D-019 for the full investigation).
        #
        # The older images-re.milanuncios.com/images/ads/<uuid> host (still
        # used by other listings) does NOT require this parameter — it
        # serves the original asset either way — but accepts the same
        # `?rule=` resize hint harmlessly (live-verified), so applying it
        # unconditionally is safe rather than needing per-host branching.
        # Mirrors what etl/connectors/fotocasa.py already does: Fotocasa's
        # own `multimedia[].src` values already arrive with `?rule=original`
        # baked in server-side (both sites share the same Adevinta media
        # backend, per this module's docstring on `origin.provider =
        # "fotocasa_pro"` syndication) — Milanuncios just doesn't put the
        # parameter in the JSON, so this connector adds it instead of
        # storing a URL nothing downstream can actually fetch.
        #
        # The rule-appending itself is `add_photo_rule_if_missing` (module
        # level, above) rather than inline here — issue #210 needed it
        # importable from both a test that pins it against the init.sql
        # backfill migration's SQL and (potentially) from that migration's
        # own tooling. See that function's docstring/PHOTO_RULE's comment.
        def _to_photo_url(img: str) -> str:
            if img.startswith(("http://", "https://")):
                url = img
            elif img.startswith("//"):
                url = f"https:{img}"
            else:
                url = f"https://{img}"
            return add_photo_rule_if_missing(url)

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
