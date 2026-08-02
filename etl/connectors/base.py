"""The connector contract every listing-site connector implements.

See docs/architecture/connectors.md and issue #1 §4. A connector's job is
`discover` (cheap: which external_ids exist for a scope), `fetch_detail`
(expensive: full page fetch for one external_id), and `normalize` (pure:
site-specific fields -> the canonical shape the orchestrator persists).

Task 1.4 implements the first real connector against this contract. This
module intentionally has zero network code and zero real-site knowledge.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

# Passed to discover()/fetch_detail() so a connector that makes more than one
# real network request per call (e.g. paginating inside discover()) can
# throttle each individual request, not just the one acquire() the
# orchestrator does around the whole call. Calling this blocks until the
# framework's rate limiter says it's safe to make one more request.
Throttle = Callable[[], None]


@dataclass(frozen=True)
class ConnectorScope:
    """What a connector should look for.

    Issue #71 closes the gap this docstring used to describe as aspirational:
    the orchestrator now derives scope from the union of active
    `search_profile` rows (`etl.orchestrator._active_profile_scopes`) instead
    of a hand-written literal. `search_profile.scope.geography` is a
    radius-from-a-point (`{center: [lat, lon], radius_km}`, see
    `dashboard/lib/profiles-schema.ts`), so that's the shape carried here too
    — `center`/`radius_km`, not a free-text city slug.

    Deliberately NOT a shared slug registry mapping (lat, lon) -> a site's
    URL-path slug: different sites encode geography completely differently
    (Fotocasa uses a hyphenated city slug, Milanuncios its own path segment;
    a future Idealista/pisos.com connector may use neither), and a shared
    registry would need updating every time a new site connector is added.
    Each connector already owns its own site-specific URL/query construction
    (that's the whole point of the `discover`/`fetch_detail`/`normalize`
    split per `docs/architecture/connectors.md`) — so translating a
    (center, radius_km) point into whatever geography encoding a given site
    needs is that connector's own job, not this module's. `geography` is
    kept as a free-text escape hatch for tests/manual construction that want
    to bypass point-based translation entirely.
    """

    geography: str = ""
    center: tuple[float, float] | None = None  # (lat, lon)
    radius_km: float | None = None
    property_types: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class RawListing:
    """The unparsed result of fetch_detail — whatever the site actually returned.

    `raw` holds the connector's native representation (parsed HTML fields,
    a JSON API response, whatever) prior to normalization. Keeping it
    separate from CanonicalListingVersion means a normalize() bug never
    loses the original fetch — replay/backfill just needs raw, not a new
    network call.
    """

    external_id: str
    source: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class CanonicalListingVersion:
    """Site-agnostic listing fields, ready to upsert into `property`/`listing`.

    Field set mirrors the `property`/`listing` columns from
    etl/schema/init.sql (Phase 1.2, issue #10) directly — the orchestrator
    maps this 1:1 onto those tables. Anything a source doesn't publish is
    None; anything the schema doesn't have a column for goes in `raw_extra`
    rather than being silently dropped (issue #1 §4).
    """

    external_id: str
    source: str
    url: str | None
    listing_kind: str | None  # 'particular' | 'agency' | None if undetermined
    status: str  # 'active' | 'reserved' | 'sold' | 'withdrawn' | 'expired'
    current_price: Decimal | None
    description: str | None
    photo_urls: tuple[str, ...]
    contact_raw: str | None
    # property-level fields (each new external_id gets its own singleton
    # `property` row at ingest time per issue #10 — see
    # docs/architecture/data-model.md)
    address: str | None
    lat: Decimal | None
    lon: Decimal | None
    property_type: str | None
    m2_built: Decimal | None
    m2_useful: Decimal | None
    rooms: int | None
    bathrooms: int | None
    floor: str | None
    has_elevator: bool | None
    year_built: int | None
    energy_rating: str | None
    raw_extra: dict[str, Any] = field(default_factory=dict)


class ConnectorError(Exception):
    """Raised by a connector's discover/fetch_detail/normalize on failure.

    The orchestrator counts these (and any other exception) toward the
    circuit breaker's error rate — connectors don't need to know the
    breaker exists, they just raise on failure like any other code.
    """


class Connector(ABC):
    """Base class every site connector subclasses.

    Class attributes (not instance state) configure the shared rate
    limiter/circuit breaker the orchestrator wraps around every connector
    — a connector never rate-limits or trips its own breaker, that's the
    framework's job (issue #11), so every connector gets it for free.

    There is deliberately no `max_concurrency`-style knob here: the
    orchestrator runs connectors sequentially, one at a time, in Phase 1 —
    an attribute implying concurrent execution exists would be a knob that
    does nothing. Add it back, wired to a real concurrent runner, if/when a
    later phase actually needs to fetch multiple listings in parallel.
    """

    name: str
    rate_limit_per_minute: int = 30
    # Circuit breaker: abort the run if this fraction of the *most recent*
    # `circuit_breaker_window` attempts fail, once at least
    # `circuit_breaker_min_attempts` attempts have happened (avoids tripping
    # on e.g. 1 failure out of 2 early attempts). See
    # docs/architecture/connectors.md for why the window is rolling, not
    # cumulative-since-run-start.
    circuit_breaker_error_rate: float = 0.30
    circuit_breaker_min_attempts: int = 10
    circuit_breaker_window: int = 20

    # Whether discover() sees the connector's *entire* active inventory for
    # its scope on every sweep, or only some subset of it (e.g. one search-
    # results page out of hundreds, when robots.txt or the source disallows
    # pagination). This gates withdrawal detection (issue #12 EC-5,
    # etl.orchestrator._reconcile_missed_discoveries): a listing missing
    # from a *partial* sweep tells you nothing about whether it's still
    # active — it may simply have scored below the cutoff of whatever
    # subset this sweep covered, especially under a relevance/recency sort
    # rather than a stable one. Treating that as "3 misses -> withdrawn"
    # would corrupt exactly the signal issue #1 §10 calls out as valuable
    # (real withdrawals, relistings-at-a-lower-price). Default True (most
    # connectors should aim for full coverage); a connector that can't
    # achieve it (like Fotocasa, page-1-only per its own docstring) must
    # override this to False and accept that its listings never
    # auto-transition to withdrawn from absence alone.
    discovers_full_inventory: bool = True

    @abstractmethod
    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        """Return external_ids that exist for this scope. Cheap; no full fetch.

        Call `throttle()` before each real network request this method
        makes. The orchestrator also calls it once before invoking
        `discover` at all, which is sufficient for a connector that issues
        a single request here — a connector that paginates internally
        (multiple requests within one `discover` call) must call `throttle`
        again before each of those, since the orchestrator has no visibility
        inside this method to do it for you.
        """

    @abstractmethod
    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        """Fetch and return the full raw listing for one external_id.

        Call `throttle()` before the request if this method's own single
        request isn't already covered by the orchestrator's per-call
        acquire — see `discover`'s docstring for the same reasoning. For a
        connector that makes exactly one request per `fetch_detail` call,
        the orchestrator's own acquire is enough and calling `throttle`
        again here is harmless (rate limiting an already-throttled call
        just costs a possible tiny extra wait, never incorrectness).
        """

    @abstractmethod
    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        """Map a RawListing to the canonical, storage-ready shape."""
