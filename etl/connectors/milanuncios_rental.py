"""Milanuncios RENTAL connector — issue #31 (comparable-rental ingestion).

Subclasses `MilanunciosConnector` (etl/connectors/milanuncios.py) rather
than duplicating it: `fetch_detail()` and `normalize()` are inherited
UNCHANGED, because neither one hardcodes "sale" anywhere. `normalize()`
already derives `operation` from the ad's own `category.slug` via
`milanuncios_mapping.infer_operation` (`"venta-*" -> "sale"`,
`"alquiler-*" -> "rent"`) — it was already operation-agnostic before this
file existed; only `MilanunciosConnector.discover()` is hardcoded to the
`venta-de-pisos-en-{geo}-{geo}/` sale-category URL. This connector's only
real job is to override `discover()` to hit the rental category instead.

Deliberately NOT editing `milanuncios.py` itself — it's owned by other
in-flight work on this repo (see this PR's own body for the boundary).
Subclassing a class imported from an unedited module is not an edit to
that module.

## Why Milanuncios, not Servihabitat/Vivantial (both live-checked first)

The two sitemap-driven connectors with the cleanest track record
(docs/architecture/connectors.md: zero errors, no discovered/fetched gap)
were checked FIRST, per this issue's own brief to prefer that access
pattern where one exists — both were ruled out on real evidence, not
preference:

- **Servihabitat's own `robots.txt`** (quoted verbatim at the top of
  servihabitat.py) carries `Disallow: /alquiler` — the site's rental
  section is explicitly off-limits to any respectful crawler. Not usable
  regardless of technique.
- **Vivantial has no rental section at all** — already confirmed and
  documented in vivantial.py's own `normalize()` comment ("The sitemap and
  every sampled page are sale listings; the site has no rental section.").
  Nothing to build a discover() against.

Milanuncios was the next-best option, not a fallback of convenience: it
already has an `infer_operation()` helper in `milanuncios_mapping.py` that
recognizes `alquiler-*` category slugs (added for issue #78's
miscategorization handling, unused for discovery until now), and its
`fetch_detail()`/`normalize()` needed zero changes to work for rentals —
see above.

## Live verification (2026-08-03, this session)

`GET https://www.milanuncios.com/alquiler-de-pisos-en-madrid-madrid/`
(this connector's `discover()` URL shape for Madrid) returned HTTP 200
with a real `window.__INITIAL_PROPS__` payload containing 41 rental ads,
every one carrying `category.slug == "alquiler-de-pisos"` and a price
under the SAME `price.cashPrice.value` field the sale connector reads —
so `listing.current_price` (a generic column, not sale-specific) holds
monthly rent for these rows with no schema change. `robots.txt` was
re-checked live for this exact path and carries no matching `Disallow`
rule (the file only disallows pagination/query-string params and a
handful of unrelated paths — same conclusion milanuncios.py's own
docstring already reached for the sale category, now confirmed for the
rental one too).

`fetch_detail()`'s endpoint (`/x/x-<id>.htm`, inherited from
`MilanunciosConnector`) returned a bot-interruption/CAPTCHA challenge page
("Pardon Our Interruption") when tested from this session's sandboxed dev
environment, for BOTH a rental ad id and a freshly-discovered SALE ad id
fetched in the same session — the identical page, byte-for-byte, for
both. That rules out "this is a rental-specific block" or "this is a
regression this connector introduced": the existing, already-shipped sale
connector's own detail endpoint hit the same wall, from the same
non-residential IP, in the same few minutes. AGENTS.md is explicit that
real connector traffic runs from the owner's home residential IP
(Telefónica, Estepona), not a cloud sandbox — datacenter/cloud IPs are
exactly what anti-bot fingerprinting targets hardest, residential ones
much less so. This is documented here rather than silently assumed: verify
`fetch_detail()` from the production host before relying on it, and until
then every failure still fails loudly via the normal `ConnectorError`/
circuit-breaker path, same as any other connector — never silently.

## Rate limit: half of the sale connector's, not the same value

`rate_limit_per_minute = 10` (vs. `MilanunciosConnector`'s 20). Both
connectors hit the *same domain, same IP* — the orchestrator's rate
limiter is per-connector-instance, so running both at their own "safe"
20/min would, in total, double the request volume Milanuncios sees from
this IP versus what the original sale-only feasibility spike ever
validated. Unlike Fotocasa (whose cumulative soft-block threshold was
directly measured at ~136 fetches before tripping — see this PR's other
findings), Milanuncios' cumulative tolerance has never been measured. This
value is a conservative default given that unknown, not a measured
number — documented as tunable, same convention as every other
connector's rate limit in this codebase, once real combined-volume data
exists from production.
"""

from __future__ import annotations

import logging

import requests

from etl.connectors.base import ConnectorError, ConnectorScope, Throttle
from etl.connectors.milanuncios import (
    _BASE_URL,
    _REQUEST_TIMEOUT_SECONDS,
    _USER_AGENT,
    MilanunciosConnector,
    _extract_initial_props,
    _resolve_geography,
)

logger = logging.getLogger("etl.connectors.milanuncios_rental")


class MilanunciosRentalConnector(MilanunciosConnector):
    # Distinct `source` value from "milanuncios" (not reused) — keeps
    # rental listings in their own connector_runs/connector_run_results/
    # connector_config rows (own rate limit, own circuit breaker instance,
    # own operator on/off switch), and gives every rental `listing` row a
    # `(source, external_id)` identity that can never collide with a sale
    # row even though both draw ids from the site's one global ad-id
    # sequence (they never would collide in practice — an ad is either
    # sale or rental, never both — but a distinct source keeps the two
    # populations trivially separable in every downstream query without
    # relying on that never-in-practice guarantee).
    name = "milanuncios_rental"

    # Half of MilanunciosConnector's 20 — see module docstring's "Rate
    # limit" section for why this isn't the same value.
    rate_limit_per_minute = 10

    # Same reasoning as MilanunciosConnector (inherited docstring applies
    # verbatim: discover() only reads page 1 of one category, robots.txt
    # disallows pagination) — restated explicitly here rather than relying
    # on inheritance alone, since discovers_full_inventory is exactly the
    # kind of per-connector safety property that should never depend on a
    # parent class keeping its own value unchanged.
    discovers_full_inventory = False

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        """Same shape as `MilanunciosConnector.discover()`, targeting the
        `alquiler-de-pisos-en-{geo}-{geo}/` rental category instead of
        `venta-de-pisos-en-{geo}-{geo}/`. Reuses `_resolve_geography` and
        `_extract_initial_props` imported from milanuncios.py rather than
        redefining them — same city-slug table, same JSON extraction, only
        the URL's category segment differs.
        """
        geography = _resolve_geography(scope)
        if geography is None:
            raise ConnectorError(
                "milanuncios_rental discover: scope has neither a resolvable "
                "center (nearest known city too far away) nor an explicit "
                "geography string — nothing to discover, not defaulting to "
                "a hardcoded city (see issue #71)"
            )
        # Category slug confirmed live 2026-08-03 (module docstring) —
        # "alquiler-de-pisos-en-madrid-madrid/" returned 41 real rental ads,
        # same JSON shape and geography-slug-repeated-twice URL convention
        # as the sale category.
        url = f"{_BASE_URL}/alquiler-de-pisos-en-{geography}-{geography}/"
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
                f"milanuncios_rental discover: request failed for {url}: {exc}"
            ) from exc

        props = _extract_initial_props(response.text)
        ad_list_pagination = props.get("adListPagination") or {}
        ad_list = ad_list_pagination.get("adList") or {}
        ads = ad_list.get("ads") or []
        external_ids = sorted(
            {str(ad["id"]) for ad in ads if isinstance(ad, dict) and ad.get("id")}
        )
        logger.info(
            "milanuncios_rental discover: geography=%s found %d external_ids on page 1",
            geography,
            len(external_ids),
        )
        return external_ids

    # fetch_detail() and normalize() are inherited from MilanunciosConnector
    # unchanged — see module docstring. normalize()'s
    # operation=infer_operation(category.get("slug")) will read
    # "alquiler-de-pisos" from a rental ad's own JSON and correctly return
    # "rent", the same way it already returns "sale" for a
    # "venta-de-pisos" ad discovered by the sibling sale connector.
