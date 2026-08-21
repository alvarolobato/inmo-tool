"""Cimenta2 (Grupo Cooperativo Cajamar) -- sitemap discovery + config-gated detail.

`discover()` reads the public, robots-allowed sitemap and enumerates every
published Cajamar asset. `fetch_detail()` is **config-gated**: it fetches a
property's detail from a Salesforce Aura `getRecord` endpoint **only when that
endpoint is injected via configuration** (`CIMENTA2_DETAIL_ENDPOINT`). With no
endpoint configured the connector stays discovery-only and makes no request
beyond the sitemap sweep -- the public-safe default, so a clone of this public
repo without the secret cannot fetch detail.

The detail data is the site's own listing fields (price, size, address,
coordinates, energy rating, and so on). The owner reviewed it and decided it
is fine for their private tool; the endpoint value is site-specific and is
therefore **never committed to this public repo** -- it lives only in the
owner's local config / a secret and is read at runtime. See
[D-035](../../docs/decisions/D-035-cimenta2-detail-endpoint-injected.md).

What is and is not read from a fetched record
---------------------------------------------
`normalize()` reads an explicit **whitelist** of the site's public property
fields and nothing else (`cimenta2_mapping.PUBLIC_FIELD_KEYS`). Owner-contact
fields (tax ID, telephone, IBAN, a named contact) are **never read or stored**,
by construction -- they are absent from every field list this connector
touches. Bank-internal commercial fields (acquisition cost, appraisal value)
are stored in `listing.raw_extra` **only** when the operator opts in via
`CIMENTA2_INCLUDE_INTERNAL` (default off).

D-035 supersedes the earlier "sitemap-index-only / never fetch detail" stance
of [D-034](../../docs/decisions/D-034-cimenta2-sitemap-index-only.md) and the
"not buildable" stance of
[D-033](../../docs/decisions/D-033-cimenta2-not-viable-guest-api-overexposure.md)
on the single point of whether detail may be fetched at all.

Request mechanics (only exercised when an endpoint is configured)
-----------------------------------------------------------------
One GET of the site's public shell HTML scrapes the current Aura framework ids
(`fwuid` + app version marker) so a stale build id is never carried; then one
form-encoded POST of the stock `getRecord` action per asset returns the record
(`actions[0].returnValue.record`). The `getRecord` descriptor is a standard
Salesforce controller shared by every Experience Cloud community, so it is
generic, not a site-specific access recipe, and lives in code. Read-only,
honest User-Agent, framework-paced (~one request every 2-3s). A non-SUCCESS or
still-expired response raises `ConnectorError`, which the circuit breaker
counts and which stops a sweep cleanly rather than looping.

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

Fields populated
----------------
Always, from the URL slug: `external_id` (Salesforce record id), `url`,
`reference_code` (#72), `operation='sale'`, `status='active'`,
`listing_kind='agency'`.

Additionally, when a detail endpoint is configured and a record is fetched
(whitelisted public fields only): `current_price`, `address`, `city`,
`province`, `lat`, `lon`, `m2_built`, `m2_useful`, `rooms`, `bathrooms`,
`property_type`, `energy_rating`, and `url` (preferring the record's own
public web link). With no endpoint configured every one of these stays null
and the row is the discovery-only shape.

`m2_plot`, `floor`, `has_elevator`, `year_built`, `description`,
`photo_urls`, `contact_raw`, `postal_code`, `features` stay null either way:
the asset record carries no reliable source for them within the whitelist,
so they are left null rather than inferred.

Dedup value
-----------
`reference_code` is emitted for every asset regardless of detail-fetch, and
is the strongest dedup key the sitemap alone supplies (3,915 of 3,917 codes
clear `etl/dedup/signals/reference_code._MIN_CODE_LENGTH`; the two
3-character codes are ignored by that signal as too low-cardinality). With
detail fetched, a Cimenta2 property now also carries coordinates, size and
price, so its dedup matches can corroborate beyond the bare-code
uncorroborated tier and it becomes eligible to match a search profile's
geography stage rather than being invisible to it.

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

from etl import config
from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    SearchParam,
    SearchPreview,
    SoftBlockError,
    Throttle,
)
from etl.connectors.cimenta2_mapping import (
    asset_sitemap_url,
    aura_request_form,
    canonical_property_fields,
    has_soft_block_signature,
    http_status_is_soft_block,
    iter_locs,
    parse_asset_url,
    post_response_is_soft_block,
    project_internal_fields,
    project_public_fields,
    record_from_response,
    response_is_expired,
    scrape_framework_ids,
    shell_is_soft_block,
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
# Public community shell — one GET scrapes the current Aura framework ids from
# it before a detail POST. Only fetched when a detail endpoint is configured.
_SHELL_URL = f"{_BASE_URL}/inmuebles/s/"
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


def _scope_display(scope: ConnectorScope) -> str | None:
    """A human label for the scope, for the "Validar filtros" perfil chip
    (issue #496). Pure and NEVER raises — an unresolvable center degrades to
    None (a "—" chip), mirroring search_previews()'s degrade-don't-throw rule."""
    if scope.geography:
        return scope.geography
    try:
        place = resolve_place(scope)
    except UnresolvableGeographyError:
        return None
    return place.name if place else None


class Cimenta2SoftBlockError(SoftBlockError):
    """The site rate-throttled / anti-bot-blocked a shell GET or getRecord POST
    (issue #441, D-047).

    Over a full ~3.3h sweep of 3,917 detail POSTs the guest endpoint
    intermittently serves an HTTP 429/403, or an HTTP-200 challenge/interstitial
    instead of the aura JSON. Before this class every such response became a
    fatal `ConnectorError` that tripped the circuit at the tight 30% threshold
    and — because it happened during `fetch_detail`, not `discover()` — surfaced
    with `failure_classification=structure_change`, making a transient throttle
    look like the page had been redesigned (the flapping in issue #441).

    As a `SoftBlockError` it instead trips only the looser soft-block threshold
    (`circuit_breaker_soft_block_error_rate`) and any resulting stop is recorded
    as a CLEAN "waited for budget" outcome (status stays 'ok'), never
    'circuit_open'/'structure_change'. It still counts in `error_count` (#291).
    """


class Cimenta2Connector(Connector):
    """Cajamar's REO portal. Sitemap discovery; config-gated detail fetch (D-035)."""

    name = "cimenta2"

    # Issue #515: no override_host_suffix (non-tunable, national sitemap), so the
    # base default can't derive a home page — point at the public search shell the
    # owner can actually navigate.
    home_url = _SHELL_URL

    # Issue #441 (D-047): the detail-fetch throttle is TRANSIENT — a single
    # ~3.3h sweep of 3,917 guest POSTs intermittently hits the site's rate-limit
    # / anti-bot wall in a burst that clears, then full-success on the next run.
    # A cluster of soft-blocked fetches mid-sweep must NOT trip the breaker at
    # the tight 30% fatal threshold and abandon this (the largest) connector's
    # remaining assets for the whole run. Tolerate soft-blocks up to 75% of the
    # rolling window before stopping (matching Fotocasa's transient-block
    # tuning); a site that has gone FULLY into block mode still stops the run,
    # and either way the stop is a clean "waited for budget" outcome, never a
    # failure. Genuine fatal errors (network, a real structure change) keep the
    # tight 30% `circuit_breaker_error_rate`.
    circuit_breaker_soft_block_error_rate = 0.75

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
    # BuildingCenter) rather than the framework's 30/min. 20/min = ~one request
    # every 3s, the polite pacing (issue #1 §15) for the detail POSTs when an
    # endpoint is configured; a discovery-only sweep is just two requests.
    rate_limit_per_minute = 20

    def __init__(self) -> None:
        # external_id -> (detail URL, reference code), populated by
        # discover(). fetch_detail() reads its sitemap-derived values from here.
        self._assets: dict[str, tuple[str, str]] = {}
        # Aura framework ids (fwuid, app version marker), scraped from the shell
        # on the first configured detail fetch and refreshed if they expire.
        self._fwuid: str | None = None
        self._marker: str | None = None

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

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Non-tunable: the sweep is a NATIONAL sitemap enumeration identical
        for every scope (the asset URLs carry no geography), so there is no
        per-profile URL to tune — the filtering is by data. `_SITEMAP_INDEX_URL`
        is exactly discover()'s first request."""
        # Issue #496: even a non-tunable connector must show WHICH params govern
        # its recall. Cimenta2's answer is honest and minimal: the sweep is
        # national (no geography reaches any URL), and the profile only GATES it
        # (discover() confirms the scope points somewhere real, then sweeps the
        # whole sitemap). No price/size/type param exists — those are applied
        # downstream by data.
        params: tuple[SearchParam, ...] = (
            SearchParam(
                key="alcance",
                label="Alcance",
                value="nacional",
                source="constant",
                in_url=False,
                notes="Barrido nacional del sitemap; ningún parámetro entra en la URL.",
            ),
            SearchParam(
                key="perfil",
                label="Perfil",
                value=_scope_display(scope),
                source="profile",
                in_url=False,
                consumed=False,
                notes=(
                    "Solo valida que el perfil apunta a un sitio real y gatea el "
                    "barrido; los filtros del perfil se aplican después, por datos."
                ),
            ),
        )
        return [
            SearchPreview(
                label="Cimenta2 (Cajamar) — barrido nacional",
                url=_SITEMAP_INDEX_URL,
                kind="sitemap",
                tunable=False,
                params=params,
                notes=(
                    "Barrido nacional del sitemap; el scope no entra en la URL "
                    "— el filtrado es por datos."
                ),
            )
        ]

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
            self._raise_for_request_exception(url, exc)
        return response.text

    def _post_form(self, url: str, form: dict[str, str], throttle: Throttle) -> str:
        throttle()
        try:
            response = requests.post(
                url,
                data=form,
                headers={
                    "User-Agent": _USER_AGENT,
                    "Content-Type": (
                        "application/x-www-form-urlencoded; charset=UTF-8"
                    ),
                },
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            self._raise_for_request_exception(url, exc)
        return response.text

    @staticmethod
    def _raise_for_request_exception(url: str, exc: Exception) -> None:
        """Map a `requests` failure onto the right connector exception.

        Issue #441 (D-047): an HTTP 429/403 — or any error page carrying a known
        anti-bot / rate-limit signature — is the site throttling guest traffic,
        not a broken connector. It becomes a `Cimenta2SoftBlockError` (a clean
        "waited for budget" backoff that trips only the looser soft-block
        threshold), so a transient throttle burst mid-sweep no longer flaps the
        circuit as a fatal `structure_change`. Everything else (timeouts, DNS,
        connection resets, genuine 5xx) stays a fatal `ConnectorError`.
        """
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        body = getattr(response, "text", "") or ""
        if http_status_is_soft_block(status) or (
            status is not None and has_soft_block_signature(body)
        ):
            raise Cimenta2SoftBlockError(
                f"cimenta2: rate-limit / anti-bot response (HTTP {status}) for "
                f"{url} — site throttling guest traffic, backing off rather than "
                "treating this as a failure"
            ) from exc
        raise ConnectorError(f"cimenta2: request failed for {url}: {exc}") from exc

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
        """Return the raw listing for one asset, config-gated on the endpoint.

        Two modes (D-035):

        * **No endpoint configured (default).** Discovery-only: return the
          `(url, reference_code)` `discover()` already parsed from the sitemap
          slug, making **no network request** and **not** calling `throttle()`.
          The orchestrator does not acquire the rate limiter around
          `fetch_detail`; pacing is the connector's own `throttle()` call, so
          throttling 3,917 zero-request calls at 20/min would needlessly
          serialise a sweep. This mode is byte-identical to the connector's
          prior behaviour.

        * **Endpoint configured.** Fetch the record from the Aura `getRecord`
          endpoint (one shell GET to prime framework ids, then one POST),
          project it down to the whitelisted public fields, and — when the
          operator opted in — the two bank-internal commercial fields. Only
          those whitelisted keys ever leave this method; owner-contact fields
          are never read.

        A miss (an id no preceding `discover()` saw) raises: fetch_detail is
        only ever called for ids `discover()` returned, so a miss is a bug.
        """
        cached = self._assets.get(external_id)
        if cached is None:
            raise ConnectorError(
                f"cimenta2: no discovered asset for external_id={external_id!r} "
                "— fetch_detail must be preceded by a discover() that saw this id"
            )
        url, reference = cached

        endpoint = config.cimenta2_detail_endpoint()
        if not endpoint:
            # Public-safe default: discovery-only, no request, no throttle.
            return RawListing(
                external_id=external_id,
                source=self.name,
                raw={"url": url, "reference_code": reference},
            )

        record = self._fetch_record(external_id, endpoint, throttle)
        if not record:
            # SUCCESS but no record payload — fall back to the discovery-only
            # shape rather than fabricating fields.
            return RawListing(
                external_id=external_id,
                source=self.name,
                raw={"url": url, "reference_code": reference},
            )

        raw: dict[str, Any] = {
            "url": url,
            "reference_code": reference,
            "fields": project_public_fields(record),
        }
        if config.cimenta2_include_internal():
            raw["internal"] = project_internal_fields(record)
        return RawListing(external_id=external_id, source=self.name, raw=raw)

    def _fetch_record(
        self, external_id: str, endpoint: str, throttle: Throttle
    ) -> dict:
        """One read-only `getRecord` call, refreshing framework ids once on
        expiry. Raises `ConnectorError` on a non-SUCCESS/unusable response so
        the run stops cleanly through the circuit breaker instead of looping.
        """
        aura_url = _aura_url(endpoint)

        self._ensure_framework_context(throttle)
        form = aura_request_form(external_id, self._fwuid, self._marker)
        raw_text = self._post_form(aura_url, form, throttle)

        if response_is_expired(raw_text):
            logger.info("cimenta2: framework ids expired — refreshing once")
            self._fwuid = self._marker = None
            self._ensure_framework_context(throttle)
            form = aura_request_form(external_id, self._fwuid, self._marker)
            raw_text = self._post_form(aura_url, form, throttle)

        # Issue #441 (D-047): a healthy guest getRecord ALWAYS returns parseable
        # aura JSON. A non-JSON body (an HTML challenge/interstitial served with
        # HTTP 200) or a body carrying a known anti-bot signature is the site's
        # rate-limit wall, not a structure change — raise a soft-block so a
        # transient throttle burst doesn't flap the circuit as fatal
        # `structure_change`. Checked BEFORE record_from_response so its
        # JSONDecodeError (which would classify as fatal) is never reached for
        # this case. Valid JSON with an unexpected shape still falls through to
        # the fatal ConnectorError below — that IS the genuine-structure-change
        # signal.
        if post_response_is_soft_block(raw_text):
            raise Cimenta2SoftBlockError(
                f"cimenta2: detail fetch for {external_id} returned a rate-limit "
                "/ anti-bot page instead of the aura getRecord JSON — site "
                "throttling guest traffic, backing off rather than treating this "
                "as a structure change"
            )

        try:
            return record_from_response(raw_text)
        except ValueError as exc:
            raise ConnectorError(
                f"cimenta2: detail fetch for {external_id} did not return a "
                f"usable record ({exc}) — stopping rather than retrying"
            ) from exc

    def _ensure_framework_context(self, throttle: Throttle) -> None:
        """Scrape and cache the Aura `(fwuid, marker)` from the public shell."""
        if self._fwuid and self._marker:
            return
        shell = self._fetch(_SHELL_URL, throttle)
        ids = scrape_framework_ids(shell)
        if ids is None:
            # Issue #441 (D-047): a real shell on HTTP 200 always embeds the
            # Aura framework script (`auraFW`). Its absence — or an explicit
            # anti-bot signature — means the site served a rate-limit / anti-bot
            # wall, which is a transient throttle (raise a soft-block so it
            # doesn't flap the circuit as fatal `structure_change`), NOT that the
            # shell was redesigned. Only when the framework script IS present but
            # the specific ids couldn't be parsed is it a genuine structure
            # change worth a fatal ConnectorError.
            if shell_is_soft_block(shell):
                raise Cimenta2SoftBlockError(
                    "cimenta2: shell GET returned a rate-limit / anti-bot page "
                    "instead of the Aura community shell — site throttling guest "
                    "traffic, backing off rather than treating this as a "
                    "structure change"
                )
            raise ConnectorError(
                "cimenta2: could not scrape Aura framework ids from the shell "
                "HTML — the site structure may have changed or detail access "
                "withdrawn; stopping rather than guessing"
            )
        self._fwuid, self._marker = ids

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        """Map the raw shape onto the canonical row.

        When `raw` carries whitelisted detail `fields` (endpoint configured),
        the property fields are coerced from them; otherwise every detail field
        stays None — the honest discovery-only result. Fields with no reliable
        whitelisted source (`floor`, `year_built`, `description`, `photo_urls`,
        …) are always None. Owner-contact fields are never present here.
        """
        url_sitemap: str = raw.raw["url"]
        reference: str = raw.raw["reference_code"]
        fields = raw.raw.get("fields")
        internal = raw.raw.get("internal") or {}

        detail = canonical_property_fields(fields) if fields is not None else None

        def d(key: str) -> Any:
            return detail.get(key) if detail else None

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=self.name,
            url=(d("web_url") or url_sitemap),
            # Cajamar holds these assets on its own balance sheet and sells
            # them directly. 'agency' is the honest mapping of the two values
            # the schema allows — the seller is an institution, not a private
            # individual — matching vivantial.py's reasoning for the same case.
            listing_kind="agency",
            # Presence in the sitemap is the only status signal available.
            status="active",
            current_price=d("current_price"),
            description=None,
            photo_urls=(),
            # Issue #628 considered a constant selling-entity name here
            # (the pattern solvia.py/servihabitat.py now use) and rejected
            # it: unlike Solvia/Servihabitat, this connector's ONLY data
            # path is the public sitemap (D-033/D-034) — it never renders
            # or fetches a page a "selling entity" could honestly be read
            # off of, and D-033 is explicit ("don't build on it, even
            # scoped") about not reaching for anything beyond that
            # sitemap. Left None, matching every other detail-only field.
            contact_raw=None,
            address=d("address"),
            lat=d("lat"),
            lon=d("lon"),
            property_type=d("property_type"),
            m2_built=d("m2_built"),
            m2_useful=d("m2_useful"),
            rooms=d("rooms"),
            bathrooms=d("bathrooms"),
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=d("energy_rating"),
            city=d("city"),
            province=d("province"),
            postal_code=None,
            m2_plot=None,
            features=(),
            # The portal is a sales channel for repossessed stock; no rentals.
            operation="sale",
            reference_code=(d("reference_code") or reference),
            cadastral_ref=d("cadastral_ref"),
            raw_extra=_raw_extra(
                url_sitemap,
                reference,
                detail_fetched=detail is not None,
                internal=internal,
            ),
        )


def _aura_url(endpoint: str) -> str:
    """The configured endpoint with a request counter appended when it has no
    query string (`POST <endpoint>?r=1`). Any small integer works."""
    return endpoint if "?" in endpoint else f"{endpoint}?r=1"


def _raw_extra(
    url: str,
    reference: str,
    *,
    detail_fetched: bool,
    internal: dict[str, Any],
) -> dict[str, Any]:
    """Provenance so a later reader can tell a discovery-only row apart from a
    detail-fetched one. `internal_commercial` is present only when the operator
    opted into CIMENTA2_INCLUDE_INTERNAL and the record carried those fields.
    """
    extra: dict[str, Any] = {
        "detail_url": url,
        "sitemap_reference_code": reference,
        "discovery": "sitemap+detail" if detail_fetched else "sitemap-index-only",
        "detail_fetched": detail_fetched,
    }
    if not detail_fetched:
        extra["detail_unavailable_reason"] = "detail-endpoint-not-configured"
    if internal:
        extra["internal_commercial"] = internal
    return extra
