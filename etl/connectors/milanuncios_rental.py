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

## Rate limit: below the sale connector's measured, evidence-based value
## (Opus review correction, PR #199 — this section originally said "half
## of 20", written before issue #179/#205 measured the sale connector's
## real rate)

`rate_limit_per_minute = 1` (vs. `MilanunciosConnector`'s `2`, itself a
measured, evidence-based value per D-017 — NOT the `20` this file
originally compared itself against). The original "half the sale
connector's rate" reasoning was written and merged before #179/#205's live
measurement dropped the sale connector from `20` to `2`; left unchanged,
this connector's `10` became FIVE TIMES the only Milanuncios rate D-017's
live measurement ever found non-catastrophic (`20` and `6`/min both
tripped the identical GeeTest wall within ~5 requests — see
`milanuncios.py`'s own module docstring). `1` is the smallest value
strictly below `2` a `rate_limit_per_minute: int` class attribute can
hold — not itself measured (this connector's OWN cumulative tolerance
still isn't; see the live-verification section above), but it can no
longer be read as "half of a number that was never real."

Both connectors hit the *same domain, same IP* with **independent** rate
limiters and circuit breakers — the orchestrator has no cross-connector
budget concept, so nothing here actually keeps the two connectors' request
volumes from simply adding up on the wire. That is precisely why this
connector must not run unattended alongside the sale connector by
default: see "Disabled by default" below.

## Disabled by default — operator opt-in required (Opus review must-fix,
## PR #199)

Every connector is born with `connector_config.enabled = false`
(`etl/orchestrator.sync_connector_registry`, issue #100 — "todos
desactivados hasta que defina los filtros de búsqueda") and this connector
relies on exactly that same generic mechanism; it does nothing here to
special-case itself further. What makes that generic protection matter
MORE for this connector than most others: `MilanunciosConnector` (the
sale connector) is the single most important connector in this codebase —
it's the core product's primary sale-listing source — and this rental
connector shares its exact domain/IP anti-bot budget with independent,
uncoordinated rate limiting (previous section). An operator who enables
this connector without accounting for that is not adding a nice-to-have
signal for free; they are spending some of the sale connector's own
tolerance. Turn this on deliberately, not reflexively, and watch
`milanuncios` (the sale connector)'s own circuit-breaker trip rate after
doing so — see `etl/tests/test_connector_registry_sync.py`'s
`test_new_connector_is_seeded_disabled_and_ingests_nothing` for the
mechanism this relies on, and
`test_milanuncios_rental_is_seeded_disabled_by_default` below for the
same guarantee proven against this specific connector, not just the
generic case.

## What this connector does NOT unblock (Opus review, PR #199)

`fetch_detail()` (inherited, see "Live verification" above) hits the same
GeeTest wall the sale connector does — ~5 successes per run, city-wide,
a COUNT-based trigger `discover()`'s success doesn't change (D-017). That
means a realistic run yields on the order of 5 new rental listings
city-wide, not 5 per neighbourhood — the comparable-rent estimator's
`MIN_HIGH_CONFIDENCE_SAMPLE_SIZE = 8` gate
(`dashboard/lib/analytics/rent-estimate.ts`) is reachable in principle but
not, realistically, in the sample volume this connector alone can
currently produce for any one property's size/location band. This PR's
estimator is real, correct machinery — it just doesn't yet have a data
source that reliably feeds it. See issue #211 (linked from D-015) tracking
a viable rental data source; that, not this estimator, is #31's actual
remaining blocker.
"""

from __future__ import annotations

import logging

import requests

from etl.connectors.base import (
    ConnectorError,
    ConnectorScope,
    SearchPreview,
    Throttle,
)
from etl.connectors.geography import UnresolvableGeographyError
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

    # Strictly below MilanunciosConnector's measured rate_limit_per_minute
    # (2, per D-017) — see module docstring's "Rate limit" section for why
    # this used to say 10 ("half of 20") and why that became indefensible
    # once #205 measured the sale connector down to 2.
    rate_limit_per_minute = 1

    # Same reasoning as MilanunciosConnector (inherited docstring applies
    # verbatim: discover() only reads page 1 of one category, robots.txt
    # disallows pagination) — restated explicitly here rather than relying
    # on inheritance alone, since discovers_full_inventory is exactly the
    # kind of per-connector safety property that should never depend on a
    # parent class keeping its own value unchanged.
    discovers_full_inventory = False

    # Skip-if-seen stays OFF here (0 = the base `Connector` default: always
    # re-fetch), stated explicitly rather than inherited — Opus review,
    # PR #225. Exactly the same reasoning as `discovers_full_inventory`
    # immediately above: a per-connector risk property must never depend on
    # a parent class keeping its own value unchanged. `MilanunciosConnector`
    # turned this on at 24h in issue #179, and because this class subclasses
    # it, that change would have silently switched skip-if-seen on for the
    # rental source too.
    #
    # Why 0 and not the parent's 24h — the honest answer is "no evidence,
    # so no change". Every fact behind the parent's decision (D-028) is
    # `source='milanuncios'`: 18 circuit-open runs byte-identical at
    # `discovered=41 fetched=5 errors=5`, 24 distinct ids across ~90
    # fetch attempts, 38h of production `connector_run_results`. NONE of it
    # is `milanuncios_rental`, which has its own source, its own
    # `connector_config` row, its own circuit-breaker instance and a
    # different rate limit (1/min vs 2). It has also never run unattended
    # in production — it is seeded DISABLED (see "Disabled by default"
    # in the module docstring), so there is no run history to reason from
    # at all. Adopting the parent's window here would be inferring a
    # site-imposed fetch cap for a category nobody has measured.
    #
    # There is a second, connector-specific reason not to guess: these
    # listings feed the comparable-rent estimator (D-015,
    # `dashboard/lib/analytics/rent-estimate.ts`), where a stale asking
    # rent silently biases an *estimate* other decisions are made from,
    # rather than just showing a stale price on one card. That is a
    # different staleness cost from the sale connector's, and it deserves
    # its own analysis rather than the sale connector's conclusion.
    #
    # When to revisit: once this connector has actually been enabled and
    # has produced its own `connector_run_results` showing the same
    # fetched≈5 / errors≈5 / circuit_open pathology D-028 documents, turn
    # this on at 24h and cite that data here. Do not flip it on the sale
    # connector's evidence.
    min_refetch_interval_seconds = 0

    def _rental_search_url(self, geography: str) -> str:
        """The rental sale-category entry URL — the same "-en-<geo>-<geo>"
        convention as the sale connector, with the `alquiler-de-pisos`
        segment. Shared by discover() and search_previews()."""
        return f"{_BASE_URL}/alquiler-de-pisos-en-{geography}-{geography}/"

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """Reuses `_rental_search_url()` — the exact helper discover() uses."""
        try:
            geography = _resolve_geography(scope)
        except UnresolvableGeographyError:
            geography = None
        if geography is None:
            return [
                SearchPreview(
                    label="Milanuncios (alquiler)",
                    url=None,
                    kind="search_page",
                    tunable=True,
                    notes="El perfil no resuelve a una geografía que este conector cubra.",
                )
            ]
        return [
            SearchPreview(
                label=f"Milanuncios (alquiler) — {geography}",
                url=self._rental_search_url(geography),
                kind="search_page",
                tunable=True,
            )
        ]

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
