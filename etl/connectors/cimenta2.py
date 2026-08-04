"""Cimenta2 (Grupo Cooperativo Cajamar) -- sitemap-index / discovery only.

**This connector deliberately never fetches a property detail page, and no
future change may make it do so.** Cimenta2's detail data is reachable only
through a misconfigured Salesforce guest endpoint that returns the asset
object's entire internal field set -- the bank's acquisition cost and
appraisal value, live offer-negotiation state, and schema fields for an
owner's tax ID, telephone and IBAN. That finding, the reasoning, and the
decision not to build on it are recorded in
[D-033](../../docs/decisions/D-033-cimenta2-not-viable-guest-api-overexposure.md);
the defect is being disclosed to Cajamar. This module therefore reads the
**public, robots-allowed sitemap and nothing else**, and
`fetch_detail()` below makes no network request at all.

If you are here to add a field this connector leaves null: the answer is
almost certainly no. Every one of those fields lives behind the channel
D-033 rules out. The sanctioned route to real detail is the
browser-extension capture path (issue #75), which captures what the site
actually renders to a human.

Why this exists at all, given D-033 concluded "not buildable"
-------------------------------------------------------------
D-033 rejected "building the connector on the sitemap alone" as
*insufficient*, on the grounds that reference codes and geography slugs
"cannot populate a `listing` row or feed #16's dedup signals". That
judgement is revisited, not overturned, in
[D-034](../../docs/decisions/D-034-cimenta2-sitemap-index-only.md): a
`listing` row **can** be populated (`listing.current_price` is nullable),
the reference-code dedup signal **is** reachable, and the enumerated URLs
are exactly the worklist the #75 capture path needs. What D-033 got right
and D-034 keeps is that this is not a substitute for detail data. See
"What this actually gets you" below for the honest, narrow value.

What discover() enumerates
--------------------------
The `ga-activo` child sitemap: **3,917 individual Cajamar-owned assets**
(live-verified 2026-08-04), each shaped
`/inmuebles/s/ga-activo/<18-char Salesforce record id>/<reference code>`.
One request for the sitemap index plus one for the child sitemap -- two
network requests per sweep, total, regardless of catalogue size.

The other object types the index publishes are deliberately NOT ingested,
and the reason is measured rather than assumed. `inv-expediente` (490
URLs) and `ga-agrupacion` (551 URLs) carry richer-looking
`type-municipality-province` slugs, and an earlier plan for this connector
was to mine `city`/`province`/`property_type` out of them. Parsing all 490
expediente slugs against the repo's own gazetteer
(`etl/connectors/geodata/es_places.csv`) resolved a province for only
**307/490 (63%)** and a municipality for only **216/490 (44%)**. The
failures are not a tuning problem:

  * Municipality and province run together with no separator in real
    slugs -- `rusticaciezamurcia`, `nave-en-librillamurcia`,
    `...sant-carles-de-la-rapitatarragona`.
  * Some expedientes span two provinces at once -- `naves-huelva-y-madrid`,
    `rusticas-varios-castellon-y-valencia` -- so any single-value
    extraction is arbitrary, not merely absent.
  * Many slugs are internal portfolio codes or bare marketing names with no
    geography at all -- `pm-9757-202-pisos-y-garaj-rsd-fairways-atarfe`,
    `trafalgar`, `triton`, `troya`, and the test records
    `expediente-prueba`, `prueba-proyecto-vivienda`.

More decisively, an expediente is a **case file covering many assets**
("promocion finalizada 24 viviendas", "44 fincas", "202 pisos y garaj"),
not a property. Ingesting one as a `property` row would assert that 202
flats are a single dwelling. And there is no key in any public URL linking
an expediente to the assets inside it, so it cannot even be used to
*enrich* the 3,917 -- that join exists only behind the endpoint D-033
forbids. Mining a 44%-reliable, occasionally-wrong municipality out of a
record that is not a property is precisely the "wrong guess presented as
data" that `docs/skills/connectors.md` warns against, so this connector
takes none of it.

Fields populated vs. left null
------------------------------
Populated, all from the URL slug: `external_id` (Salesforce record id),
`url`, `reference_code` (#72), `operation='sale'`, `status='active'`,
`listing_kind='agency'`.

Left null, every one of them because the only source is the D-033 channel:
`current_price`, `m2_built`, `m2_useful`, `m2_plot`, `rooms`, `bathrooms`,
`floor`, `has_elevator`, `year_built`, `energy_rating`, `description`,
`photo_urls`, `contact_raw`, `address`, `lat`, `lon`, `property_type`,
`city`, `province`, `postal_code`, `features`, `cadastral_ref`.

`m2_plot` deserves a specific note because issue #136 called it out (a
Cajamar portal is expected to carry rural land, and #76 added the field for
exactly that): the asset slugs encode no surface figure of any kind, so it
stays null rather than being inferred.

Price: where it comes from, since it does not come from here
------------------------------------------------------------
The owner asked for price from any source *other* than the D-033 endpoint.
Both halves of that were checked rather than assumed.

**(a) Is there any public price surface at all? No — verified, not
inferred.** A public detail page (`/ga-activo/a0v3X00000dwiQQQAY/90817`)
was fetched over plain HTTP with the honest UA on 2026-08-04. This is the
ordinary public URL, not the Aura RPC; it is the same second-step check
D-023 established for BuildingCenter. It returned 65,096 bytes with
`<title>Inmuebles</title>` and exactly two `<meta>` tags (a CSP and a
viewport). Occurrences of every price-bearing convention, counted in the
raw body: `og:price` 0, `product:price` 0, `application/ld+json` 0,
`itemprop` 0, `schema.org` 0, `"precio"`/`"Precio"` 0, `EUR` 0, `€` 0.
Also absent: the asset's own reference code (`90817`, 0 occurrences), any
municipality name, `catastral` 0, `latitude`/`longitude`/`lng` 0. The page
is a Lightning bootstrap and nothing else.

The other public surfaces were checked too, and none carries inventory:
the sitemap `<url>` entries hold `<loc>` + `<lastmod>` only (no pricing
extension namespace); `sitemap-view-1.xml` contains exactly one URL, the
site root; and the WordPress site's RSS feed (`cimenta2.com/feed/`)
returns HTTP 200 with a well-formed channel containing **zero `<item>`
elements**. The D-033 spike separately confirmed that the documented,
non-spoofing `?_escaped_fragment_=` prerender parameter returns a
byte-identical shell. There is no public price surface on this site.

**(b) So price arrives by cross-portal dedup inheritance, not from this
connector.** A Cimenta2 asset is frequently the same physical property that
a servicer or an agent also lists on a portal this repo already ingests. If
the dedup engine links the two `listing` rows onto one `property`, that
property has a price — supplied legitimately by the *other* connector,
which fetched it from a source that publishes it. This connector's job is
therefore to emit the strongest dedup key the public sitemap allows, which
is `reference_code` (#72), and to emit it for as many assets as possible:
3,915 of the 3,917 codes are at least 4 characters and so clear
`etl/dedup/signals/reference_code._MIN_CODE_LENGTH`; the two 3-character
codes (`207`, `121`) are ignored by that signal as too low-cardinality to
be evidence, which is the correct handling rather than something to work
around.

**The honest limit on (b), stated so nobody over-promises it.** A Cimenta2
pair can only ever reach the *uncorroborated* tier of that signal.
`reference_code.evaluate` upgrades a match to `decision="merge"` only with
coordinate/size/price proximity, and to the middle tier only with a shared
`contact_raw` — this connector publishes none of those four fields, by
construction. So a Cimenta2 reference-code match yields
`decision="suggest"` at confidence 0.500: a pending row a human confirms,
never an automatic merge. That is a safety property (a bare 5-digit code is
exactly the kind of value two unrelated portals could share by chance), and
it means price inheritance is a human-in-the-loop outcome, not an automatic
one.

Whether Cajamar's codes actually recur on the consumer portals is
**unverified** and deliberately not claimed here: this connector is born
disabled, so no Cimenta2 row exists yet to cross-check against. Confirming
it needs a real sweep of both sides — worth doing before anyone relies on
price inheritance in practice.

What this actually gets you -- and what it does not
---------------------------------------------------
Stated plainly so nobody over-reads the connector's value:

  * **It cannot match a search profile.** `dashboard/lib/filtering/
    scope-query.ts` opens every profile's geography stage with
    `property.lat IS NOT NULL AND property.lon IS NOT NULL AND
    <haversine> <= radius`. With no coordinates, a Cimenta2 property is
    structurally incapable of matching any profile, so these rows will not
    appear in candidates, the map, or scoring until detail arrives from
    somewhere else.
  * **It can feed exactly one dedup signal, at the weakest tier** --
    `reference_code`, which is also the route by which a price can reach
    one of these properties at all. See "Price" above for the mechanism and
    for why it stops at a human-confirmable suggestion.
  * **It is a real, complete index of Cajamar-owned stock**, with a stable
    per-asset reference code and a canonical URL -- which is what the
    browser-extension capture path (#75) needs to know where to look, and
    what lets "did Cajamar delist this asset" be answered at all.

Feasibility evidence (live, 2026-08-04, honest UA, no evasion)
--------------------------------------------------------------
`https://inmuebles.cimenta2.com/robots.txt` -> 301 to
`/inmuebles/robots.txt` -> HTTP 200, Salesforce's stock communities file:
`User-agent: *`, `Allow: /`, one unrelated `Disallow:` for a
password-reset JSP, and a `Sitemap:` pointer. Nothing this connector
touches is disallowed. The sitemap index and both asset child sitemaps
returned HTTP 200 with no challenge, CAPTCHA or interstitial.
"""

from __future__ import annotations

import logging
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
from etl.connectors.cimenta2_mapping import (
    asset_sitemap_url,
    iter_locs,
    parse_asset_url,
)
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://inmuebles.cimenta2.com"
_SITEMAP_INDEX_URL = f"{_BASE_URL}/inmuebles/s/sitemap.xml"
_ASSET_SITEMAP_DEFAULT_URL = f"{_BASE_URL}/inmuebles/s/sitemap-ga_activo__c-1.xml"
_REQUEST_TIMEOUT_SECONDS = 25
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research; "
    "contact: github.com/alvarolobato/inmo-tool)"
)

# Every resolvable scope maps to this one key, which is the whole geography
# story for this connector and is deliberately NOT the point-to-slug table
# fotocasa/milanuncios/vivantial carry.
#
# Those connectors can translate a (lat, lon) into a site-specific slug
# because their URLs *contain* a municipality. Cimenta2's asset URLs do not:
# all 3,917 were checked, and every one carries only a record id and a
# reference code (see the module docstring's expediente analysis for why the
# geography-bearing sitemaps are not usable either). There is nothing to
# resolve a point *to*, and no server-side filter to pass it to, so the
# sitemap is fetched whole and every profile sees the same national sweep.
#
# Collapsing all scopes onto one key is load-bearing rather than cosmetic:
# `etl.orchestrator.run_all_connectors` dedupes scopes by this key, so five
# active search profiles cause one sitemap sweep per run instead of five
# identical ones. Returning a per-profile key would re-fetch the same
# 556 KB document once per profile for no benefit.
_NATIONAL_SCOPE_KEY = "national"


class Cimenta2Connector(Connector):
    """Cajamar's REO portal. Sitemap-index discovery; no detail fetch, ever."""

    name = "cimenta2"

    # discover() reads the complete `ga-activo` child sitemap in a single
    # request -- no pagination to defeat, no result cap, no relevance sort.
    # The live sweep returned all 3,917 published assets with 3,917 distinct
    # record ids and zero duplicates, and the sitemap is regenerated daily
    # (`lastmod` was same-day at verification).
    #
    # `True` is therefore the honest value, on the same basis as Vivantial
    # and Servihabitat rather than as an inherited default: this connector's
    # inventory *is* the asset sitemap, it reads all of it every sweep, so an
    # asset that stops appearing has genuinely been delisted. The Fotocasa
    # lesson (a partial, relevance-sorted page-1 sweep must set this False or
    # mass-false-positive withdrawals) does not apply -- but its consequence
    # is taken seriously, which is why discover() raises rather than returns
    # an empty list whenever the sitemap is unreadable or its URL shape is
    # unrecognised. Those two guards are what keep this attribute safe.
    discovers_full_inventory = True

    supports_discovery = True

    # No native site filters exist to honour: the sitemap accepts no query
    # parameters at all.
    supported_filters = ()

    # Matches the other single-servicer connectors (Vivantial, Solvia,
    # BuildingCenter) rather than the framework's 30/min. Barely exercised
    # here -- a sweep is two requests -- but the pacing courtesy is the house
    # default (issue #1 §15) and this connector should not be the exception.
    rate_limit_per_minute = 20

    def __init__(self) -> None:
        # external_id -> (detail URL, reference code), populated by
        # discover(). fetch_detail() reads only from here; see its docstring.
        self._assets: dict[str, tuple[str, str]] = {}

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Constant for every resolvable scope -- see `_NATIONAL_SCOPE_KEY`.

        Must never raise (base.py's contract), so an unresolvable center
        becomes the shared sentinel rather than propagating: that routes the
        scope into `discover()`, whose own `resolve_place()` call raises and
        lands a real `connector_run_results` failure, instead of the silent
        "no coverage" skip issue #169 exists to eliminate.

        `scope.center is None` with no free-text geography returns None (no
        coverage, not a failure) -- there is no point to sanity-check, and
        this connector should not sweep on a scope that names nowhere.
        """
        if scope.geography:
            return _NATIONAL_SCOPE_KEY
        if scope.center is None:
            return None
        try:
            resolve_place(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        return _NATIONAL_SCOPE_KEY

    def _fetch(self, url: str, throttle: Throttle) -> str:
        throttle()
        try:
            response = requests.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise ConnectorError(f"cimenta2: request failed for {url}: {exc}") from exc
        return response.text

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        """Enumerate every published Cajamar asset from the public sitemap.

        Two requests: the sitemap index, then the asset child sitemap it
        names. `scope` is resolved only to confirm it points somewhere real
        -- the sweep itself is national and identical for every scope,
        because the asset URLs carry no geography to filter on.
        """
        if not scope.geography:
            # Deliberately uncaught, per issue #169 and every other
            # connector's discover(): an unresolvable center must surface as
            # a real failure here, not as an empty result set.
            place = resolve_place(scope)
            if place is None:
                # Only reachable by calling discover() directly, bypassing
                # scope_key()'s gate (which returns None for this case).
                raise ConnectorError(
                    "cimenta2 discover: scope has neither a center nor an "
                    "explicit geography string — nothing to sweep for"
                )

        index_xml = self._fetch(_SITEMAP_INDEX_URL, throttle)
        child_url = asset_sitemap_url(
            index_xml,
            base_url=_BASE_URL,
            default_url=_ASSET_SITEMAP_DEFAULT_URL,
        )
        if child_url is None:
            raise ConnectorError(
                "cimenta2 discover: could not determine the asset sitemap URL "
                "from the sitemap index — the index response was not usable"
            )

        sitemap_xml = self._fetch(child_url, throttle)

        locs = iter_locs(sitemap_xml)
        # Guard 1 — nothing that looks like a sitemap at all. Raising rather
        # than returning [] is what stops the orchestrator reading an error
        # page or interstitial as "the entire Cajamar catalogue was
        # withdrawn"; it matters more here than for most connectors because
        # discovers_full_inventory is True. Same guard shape as vivantial.py.
        if not locs:
            raise ConnectorError(
                f"cimenta2 discover: {child_url} contained no <loc> entries — "
                "likely an error or interstitial page rather than the real "
                "sitemap, not an empty inventory"
            )

        assets: dict[str, tuple[str, str]] = {}
        for loc in locs:
            parsed = parse_asset_url(loc)
            if parsed is None:
                continue
            record_id, reference = parsed
            assets[record_id] = (loc, reference)

        # Guard 2 — a real sitemap whose URLs we no longer recognise. This is
        # the shape a URL-scheme change takes: hundreds of <loc> entries,
        # none of them parseable. Silently returning [] would again read as a
        # total withdrawal, so this is a loud, circuit-breaker-countable
        # failure instead.
        if not assets:
            raise ConnectorError(
                f"cimenta2 discover: {child_url} had {len(locs)} <loc> entries "
                "but none matched the expected /inmuebles/s/ga-activo/"
                "<record-id>/<reference> shape — the site's URL scheme has "
                "likely changed; refusing to report an empty inventory"
            )

        self._assets = assets
        external_ids = sorted(assets)
        logger.info(
            "cimenta2 discover: %d assets from %d sitemap entries at %s "
            "(national sweep; asset URLs carry no geography to filter on)",
            len(external_ids),
            len(locs),
            child_url,
        )
        return external_ids

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        """Return what the sitemap slug already gave us. **No network I/O.**

        There is no detail fetch on this connector by design (D-033, and the
        module docstring). Everything this method can honestly return was
        already parsed out of the sitemap URL by `discover()`.

        Two consequences worth stating so they are not "fixed" later:

        * `throttle()` is deliberately NOT called. The orchestrator does not
          acquire the rate limiter around `fetch_detail` -- the connector's
          own `throttle()` call is the pacing mechanism (see
          `etl.orchestrator.run_connector`). Calling it here would serialise
          3,917 zero-request calls at 20/min, turning a two-request sweep
          into a ~3-hour run for no reason.
        * A miss raises rather than re-deriving the URL, exactly as
          `vivantial._detail_url_for` does: fetch_detail is only ever called
          for ids a preceding `discover()` returned, so a miss is a real
          bug, not a cache-warming opportunity.
        """
        cached = self._assets.get(external_id)
        if cached is None:
            raise ConnectorError(
                f"cimenta2: no discovered asset for external_id={external_id!r} "
                "— fetch_detail must be preceded by a discover() that saw this "
                "id (this connector never fetches a detail page; see D-033)"
            )
        url, reference = cached
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"url": url, "reference_code": reference},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        """Map the sitemap-derived raw shape onto the canonical row.

        Almost every field is None, and that is the honest result rather
        than an unfinished one — see the module docstring for the field-by-
        field reason. Nothing here may be filled in from the D-033 channel.
        """
        url: str = raw.raw["url"]
        reference: str = raw.raw["reference_code"]

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=url,
            # Cajamar holds these assets on its own balance sheet and sells
            # them directly. 'agency' is the honest mapping of the two values
            # the schema allows — the seller is an institution, not a private
            # individual — and it matches the reasoning vivantial.py records
            # for the same situation.
            listing_kind="agency",
            # Presence in the sitemap is the only status signal available.
            # An asset that leaves the sitemap is handled by the
            # orchestrator's withdrawal reconciliation, not here.
            status="active",
            current_price=None,
            description=None,
            photo_urls=(),
            contact_raw=None,
            address=None,
            lat=None,
            lon=None,
            property_type=None,
            m2_built=None,
            m2_useful=None,
            rooms=None,
            bathrooms=None,
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=None,
            province=None,
            postal_code=None,
            m2_plot=None,
            features=(),
            # The portal is a sales channel for repossessed stock; it has no
            # rental section.
            operation="sale",
            reference_code=reference,
            cadastral_ref=None,
            raw_extra=_raw_extra(url, reference),
        )


def _raw_extra(url: str, reference: str) -> dict[str, Any]:
    """Provenance, so a later reader can tell a sitemap-only row apart from a
    detail-fetched one without consulting this module.

    `discovery` is the load-bearing key: it records that this row is
    index-only by construction, which is what a #75 capture-path worklist
    query wants to select on.
    """
    return {
        "detail_url": url,
        "sitemap_reference_code": reference,
        "discovery": "sitemap-index-only",
        "detail_fetched": False,
        "detail_unavailable_reason": "D-033",
    }
