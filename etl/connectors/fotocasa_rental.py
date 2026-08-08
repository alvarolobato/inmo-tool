"""Fotocasa RENTAL connector — issue #211 (a rental data source that can
actually feed the comparable-rent estimator at volume).

## Why this exists (the #211 problem, stated plainly)

`dashboard/lib/analytics/rent-estimate.ts` is real, correct, size-banded
comparable-rent machinery, but its `queryMarketComparableRent` query
**hard-requires `property.lat`/`property.lon`** (a padded lat/lon bounding
box ahead of an exact Haversine radius match) and bands comps by
`property.m2_built` / matches `property.property_type`. The rent value
itself comes from `listing.current_price` on an `operation='rent'` row.
So every usable rental comp needs FOUR fields on the ingested property:
`lat`, `lon`, `m2_built`, `property_type` — plus a positive
`current_price`.

`MilanunciosRentalConnector` (issue #31, D-015) cannot supply those at
volume: it inherits `fetch_detail()` from the sale connector, and that
detail-page path hits a GeeTest wall after ~5 successes per run, city-wide
(count-based, D-017). Candidate 3 in #211 — reading Milanuncios'
`discover()` search payload directly instead — was live-checked for this
issue (2026-08-05) and **ruled out for the estimator**: the Milanuncios
rental search `__INITIAL_PROPS__` payload IS rich (price, m2 via `tags`,
`category.slug` → type, on all 41 page-1 ads — richer than the trimmed
fixtures suggested), but it carries **no per-listing geolocation at all**
(0/41; only city/province). The orchestrator has no geocoding fallback
(`property.lat/lon` = `canonical.lat/lon`, `etl/orchestrator.py`), so a
Milanuncios discover-only rental lands with `lat/lon = NULL` and is
excluded from every comp query by `p.lat IS NOT NULL AND p.lon IS NOT
NULL`. The one scarce field (lat/lon) is available only via the walled
detail path; the cheap fields were never the bottleneck. See D-066.

## Why Fotocasa's rental SEARCH payload IS the answer (live-verified 2026-08-05)

`GET https://www.fotocasa.es/es/alquiler/viviendas/madrid-capital/todas-
las-zonas/l` (this connector's `discover()` URL shape) returns HTTP 200 —
with the connector's own honest `_USER_AGENT`, no CAPTCHA/interruption —
carrying `initialSearch.result.realEstates[]`: 31 rental listings on page
1, **every one** of which embeds, in the SAME `__initial_props__` JSON
blob `FotocasaConnector.discover()` already fetches for ids/prices:

- `coordinates.{latitude,longitude}`  — 31/31 (the field Milanuncios'
  search payload lacks and the estimator hard-requires)
- `rawPrice`                          — 31/31 (numeric monthly rent, e.g.
  `1200`, not the display string; `transactionTypeId == 3` = rent)
- `buildingType`                      — 31/31 (`"Flat"` → `map_property_type`
  → `"piso"`; same mapping the sale `normalize()` already uses)
- `features[]` with a `surface` entry — 31/31 (m² built), plus `rooms`
  (31/31) and `bathrooms` (30/31)
- `address` (district/neighborhood/municipality/province/zipCode) — 31/31

So all four estimator-required property fields + a real price come from
the search page alone — **no detail-page fetch, and therefore no anti-bot
wall to hit**. Servicer/bank portals (Solvia, Aliseda) were the natural
"sitemap-driven, avoid detail fetch" candidate-1 sites, but every one of
them publishes NO coordinates at all (verified in their own connectors'
`normalize()` — `lat=None`), which disqualifies them for the exact same
lat/lon reason Milanuncios' discover-only path is disqualified. Fotocasa
is the one site that both (a) has a live, non-walled rental search
endpoint and (b) publishes per-listing coordinates in that endpoint's own
JSON.

`robots.txt` was re-checked live for this exact path (2026-08-05): the
`User-agent: *` group disallows `/*clientId=*/alquiler/*`,
`/*/alquiler/terrenos/*`, and `/*/alquiler/edificios/*` — none of which
match `/es/alquiler/viviendas/{geo}/todas-las-zonas/l` (dwellings, no
clientId query param). The sale connector already fetches the symmetric
`/es/comprar/viviendas/...` path under the same group.

## How it works — discover captures everything, fetch_detail makes no request

This is the Fotocasa analogue of `Connector.discovered_prices()`'s
"read it off the page discover() already fetched" trick, extended from
just the price to the full per-listing record:

- `discover()` fetches the one rental search page, parses
  `initialSearch.result.realEstates[]`, **stashes each full record on
  `self._search_records` keyed by external_id**, and returns the ids.
  This is the ONLY live HTTP request this connector ever makes per scope
  per run.
- `fetch_detail()` returns the stashed record wrapped in a `RawListing`
  **without any network I/O** — and deliberately does NOT call
  `throttle()`, because there is nothing to pace (mirrors the
  capture-only connectors' zero-request `fetch_detail`, except the payload
  came from `discover()`'s own search fetch rather than an extension POST).
  The orchestrator does not itself rate-limit `fetch_detail` (it relies on
  the connector's own `throttle()` call as the pacing mechanism —
  `etl/orchestrator.py`, "No limiter.acquire() here"), so skipping it here
  is correct, not a leak.
- `normalize()` maps the SEARCH `realEstates[]` shape (different from the
  DETAIL `realEstate` shape the parent's `normalize()` reads — flat
  `features[]` list, `rawPrice`, top-level `coordinates`/`address`) to the
  canonical shape, with `operation="rent"`.

Net anti-bot footprint: exactly ONE Fotocasa request per scope per run,
vs. the sale connector's baseline-page + per-zone sweep. It shares
Fotocasa's IP with the sale connector (independent limiters, no
cross-connector budget), but adds only that single request.

## Volume: page-1 today; the zone sweep is the documented follow-up

`discover()` reads a single unfiltered `todas-las-zonas` page (~31
city-wide listings/run). The estimator needs 8+ comps within a 1.5 km
radius AND ±35% size band of one target, so page-1-city-wide density may
not clear that gate for every property on its own; the accumulation of
`last_seen_at`-fresh rows across daily runs helps, but the real volume
lever is the SAME per-neighbourhood zone sweep the sale connector already
does (`FotocasaConnector._discover_zone_slugs` + the zone loop, against
the `/es/alquiler/...` path). That is deliberately NOT wired in here: it
multiplies the per-run request count (re-introducing a real, if smaller,
shared-IP anti-bot footprint), and tuning it needs a live measurement of
real per-zone rental density + Fotocasa's tolerance that only the owner's
production run can provide. Shipping the minimal one-request version first
keeps this PR reviewable and the born-disabled connector's footprint
provably tiny. See D-066's "owner-gated next steps".

## Disabled by default — operator opt-in required

Born disabled via the generic `connector_config.enabled = false` mechanism
every connector gets (`etl/orchestrator.sync_connector_registry`, issue
#100). Even though its per-run footprint is a single request, it shares
Fotocasa's anti-bot budget with the sale connector (the core product), so
enabling it is an operator decision, not a default.
"""

from __future__ import annotations

import logging

import requests

from etl.connectors.base import (
    CanonicalListingVersion,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    SearchPreview,
    Throttle,
)
from etl.connectors.fotocasa import (
    _BASE_URL,
    _REQUEST_TIMEOUT_SECONDS,
    _ROBOTS_DISALLOWED_BARE_GEOGRAPHIES,
    _USER_AGENT,
    _ZONE_SLUG_ALL,
    FotocasaConnector,
    _extract_initial_props,
    _resolve_geography,
    _to_decimal,
    _to_int,
)
from etl.connectors.fotocasa_mapping import infer_listing_kind, map_property_type
from etl.connectors.geography import (
    UnresolvableGeographyError,
    unresolvable_scope_key,
)

logger = logging.getLogger("etl.connectors.fotocasa_rental")


class FotocasaRentalConnector(FotocasaConnector):
    # Distinct `source` from "fotocasa" (the sale connector) — own
    # connector_runs/connector_config/connector_run_results rows, own rate
    # limiter + circuit breaker instance, own operator on/off switch, and a
    # `(source, external_id)` identity that can never collide with a sale
    # row even though both draw ids from Fotocasa's one global ad-id space.
    name = "fotocasa_rental"

    # Only ONE live request happens per scope per run — discover()'s single
    # search page (fetch_detail() makes no network call; see module
    # docstring). So this value only ever gates that single request; it is
    # not a per-listing pace like the sale connector's. Kept at the sale
    # connector's own proven-safe 3/min rather than anything higher: the two
    # share Fotocasa's IP with independent limiters, and 3/min is already
    # far more headroom than one-request-per-run needs.
    rate_limit_per_minute = 3

    # Page-1 only (single unfiltered search page), so this connector never
    # sees Fotocasa's full rental inventory for a scope — declared
    # explicitly (not inherited) because it is a per-connector safety
    # property that gates withdrawal detection
    # (etl.orchestrator._reconcile_missed_discoveries) and must not silently
    # depend on the parent keeping its own value False.
    discovers_full_inventory = False

    # Skip-if-seen OFF (0 = base default, always "re-fetch"). Declared
    # explicitly rather than inherited from FotocasaConnector's 24h: a
    # re-fetch here is free (no network — it just re-reads the record
    # discover() already stashed), so there is no fetch-economy reason to
    # skip, and re-reading every run keeps current_price as fresh as the
    # latest discover() sweep. Same "never inherit a per-connector risk/behaviour
    # property silently" rule the other explicit attributes here follow.
    min_refetch_interval_seconds = 0

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """The resolved geography slug IS the dedup/coverage key — two
        scopes resolving to the same city hit the identical rental search
        URL. Unlike the parent, `rooms` is NOT folded in: this connector's
        discover() ignores room filters (always `todas-las-zonas`, no
        `-habitaciones` segment), so two scopes differing only in room
        count cover the identical page and must dedupe to one crawl target.

        Must never raise (the orchestrator calls it without try/except):
        an `UnresolvableGeographyError` becomes a distinct sentinel key so
        discover() still runs and fails there as a real result, while a
        plain `None` (no coverage) puts the scope on the skip path — same
        contract as the parent's scope_key.
        """
        try:
            return _resolve_geography(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)

    def _rental_search_url(self, geography: str) -> str:
        """The single unfiltered rental search page discover() enters from —
        distinct signature from the sale connector's `_search_url()`."""
        return f"{_BASE_URL}/es/alquiler/viviendas/{geography}/{_ZONE_SLUG_ALL}/l"

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses `_rental_search_url()` — the exact helper discover() uses."""
        try:
            geography = _resolve_geography(scope)
        except UnresolvableGeographyError:
            geography = None
        if geography is None:
            return [
                SearchPreview(
                    label="Fotocasa (alquiler)",
                    url=None,
                    kind="search_page",
                    tunable=True,
                    notes="El perfil no resuelve a una geografía que este conector cubra.",
                )
            ]
        return [
            SearchPreview(
                label=f"Fotocasa (alquiler) — {geography}",
                url=self._rental_search_url(geography),
                kind="search_page",
                tunable=True,
            )
        ]

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # Reset before this scope's own sweep — a scope that raises partway
        # through must not leave a prior scope's records for fetch_detail()
        # to misattribute (same reasoning as the parent's
        # _last_discovery_prices reset).
        self._search_records: dict[str, dict] = {}

        geography = _resolve_geography(scope)
        if geography is None:
            # Reachable only if discover() is called directly, bypassing
            # scope_key()'s gate — normally scope_key() already returned
            # None and the orchestrator skipped this scope.
            raise ConnectorError(
                "fotocasa_rental discover: scope has neither a resolvable "
                "center nor an explicit geography string, or resolves to a "
                "municipality this connector's slug table doesn't cover — "
                "nothing to discover, not defaulting to a hardcoded city "
                "(see issue #71)"
            )
        if geography in _ROBOTS_DISALLOWED_BARE_GEOGRAPHIES:
            # Same robots.txt guard as the parent: the bare "/madrid/" path
            # segment is disallowed, but the hyphenated "madrid-capital"
            # slug is not.
            raise ConnectorError(
                f"fotocasa_rental discover: geography={geography!r} is "
                f"disallowed by robots.txt (bare city-name path) — use a "
                f"hyphenated slug like '{geography}-capital' instead"
            )

        url = self._rental_search_url(geography)
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
                f"fotocasa_rental discover: request failed for {url}: {exc}"
            ) from exc

        # Raises FotocasaSoftBlockError (a ConnectorError the circuit
        # breaker counts) if the page is a soft-block/interruption lacking
        # the __initial_props__ tag — same as the parent.
        props = _extract_initial_props(response.text)
        real_estates = ((props.get("initialSearch") or {}).get("result") or {}).get(
            "realEstates"
        )
        if not isinstance(real_estates, list):
            raise ConnectorError(
                "fotocasa_rental discover: initialSearch.result.realEstates "
                "missing or not a list — page structure changed, or this is "
                "not a real search-results page"
            )

        records: dict[str, dict] = {}
        for item in real_estates:
            if isinstance(item, dict) and item.get("id") is not None:
                records[str(item["id"])] = item
        self._search_records = records

        logger.info(
            "fotocasa_rental discover: geography=%s found %d rental listings "
            "on page 1 (search-payload extraction, no detail fetch)",
            geography,
            len(records),
        )
        return sorted(records)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        # No network request: the full per-listing record was captured by
        # discover() in this same run (see module docstring). Deliberately
        # does NOT call throttle() — there is no live request to pace, and
        # the orchestrator does not rate-limit fetch_detail itself.
        record = getattr(self, "_search_records", {}).get(external_id)
        if record is None:
            # The id was in a prior discover() but isn't in the current
            # stash — it reordered/withdrew off page 1 between discover()
            # and this fetch. A clean skip (issue #291), not a run error,
            # exactly like the parent's HTTP 404/410 branch.
            raise ListingUnavailableError(
                f"fotocasa_rental fetch_detail: external_id={external_id} not "
                "present in the last discover() payload — reordered/withdrawn "
                "off page 1 between discovery and fetch"
            )

        detail = record.get("detail") or {}
        url = None
        if isinstance(detail, dict):
            path = detail.get("es-ES") or next(iter(detail.values()), None)
            if path:
                url = f"{_BASE_URL}{path}" if str(path).startswith("/") else str(path)
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"url": url, "search_record": record},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        record = raw.raw["search_record"]
        coords = record.get("coordinates") or {}
        address_block = record.get("address") or {}
        # Fotocasa's SEARCH shape carries features as a flat list of
        # {key, value, ...} dicts (the DETAIL shape the parent reads uses a
        # dict + a separate featuresList) — flatten to {key: value}.
        features = {
            f.get("key"): f.get("value")
            for f in (record.get("features") or [])
            if isinstance(f, dict) and f.get("key")
        }
        multimedia = record.get("multimedia") or []
        photo_urls = tuple(
            m["src"]
            for m in multimedia
            if isinstance(m, dict) and m.get("type") == "image" and m.get("src")
        )

        address_parts = [
            address_block.get("district"),
            address_block.get("neighborhood"),
            address_block.get("municipality") or address_block.get("city"),
        ]
        address = ", ".join(p.strip() for p in address_parts if p and p.strip()) or None

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=infer_listing_kind(
                record.get("clientUrl"),
                record.get("clientAlias"),
                record.get("clientId"),
            ),
            status="active",  # A search-result listing is one Fotocasa is
            # actively showing — the only status this connector can honestly
            # assert. discovers_full_inventory=False means it never
            # auto-transitions to withdrawn from absence alone.
            current_price=_to_decimal(record.get("rawPrice")),
            description=record.get("description"),
            photo_urls=photo_urls,
            contact_raw=record.get("clientAlias"),
            address=address,
            lat=_to_decimal(coords.get("latitude")),
            lon=_to_decimal(coords.get("longitude")),
            property_type=map_property_type(record.get("buildingType")),
            m2_built=_to_decimal(features.get("surface")),
            m2_useful=None,  # search `surface` doesn't distinguish built vs.
            # useful — same as the parent's detail normalize().
            rooms=_to_int(features.get("rooms")),
            bathrooms=_to_int(features.get("bathrooms")),
            floor=None,  # search `features.floor` is an integer code, not a
            # human-readable storey — mapping it would fabricate precision
            # (the parent reads featuresList for the readable value, absent
            # from the search shape). Left None rather than guessed.
            has_elevator=None,  # search `features.elevator` is a coded flag
            # not verified to be a clean boolean here — left None rather than
            # guessed; the estimator doesn't read it.
            year_built=None,
            energy_rating=None,  # no clean A-G rating in the search shape
            # (only coded conservationStatus/antiquity); left None.
            city=(address_block.get("city") or "").strip() or None,
            province=(address_block.get("province") or "").strip() or None,
            postal_code=(address_block.get("zipCode") or "").strip() or None,
            m2_plot=None,
            features=(),
            operation="rent",  # discover() only ever requests /es/alquiler/
            # URLs, and the record's own transactionTypeId == 3 (rent)
            # corroborates it per live data — unlike the sale connector's
            # hardcoded "sale", this rests on both the URL scope AND a real
            # per-listing JSON field.
            reference_code=None,  # the search shape's realEstateAdId is an
            # opaque UUID, not the seller-assigned "Referencia" code — left
            # None rather than storing a non-reference as one.
            raw_extra={
                "buildingType_raw": record.get("buildingType"),
                "buildingSubtype_raw": record.get("buildingSubtype"),
                "transactionTypeId": record.get("transactionTypeId"),
                "clientTypeId": record.get("clientTypeId"),
                "zipCode": address_block.get("zipCode"),
            },
        )
