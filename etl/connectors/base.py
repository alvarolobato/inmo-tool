"""The connector contract every listing-site connector implements.

See docs/architecture/connectors.md and issue #1 §4. A connector's job is
`discover` (cheap: which external_ids exist for a scope), `fetch_detail`
(expensive: full page fetch for one external_id), and `normalize` (pure:
site-specific fields -> the canonical shape the orchestrator persists).

Task 1.4 implements the first real connector against this contract. This
module intentionally has zero network code and zero real-site knowledge.
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

logger = logging.getLogger(__name__)

_VALID_OPERATIONS = ("sale", "rent")

# A Spanish "referencia catastral" is exactly 20 alphanumeric characters.
# Gating on the real format matters more here than for any other field:
# issue #140 dropped the UNIQUE constraint on property.cadastral_ref (it
# made the signal structurally unreachable), and with it went the accident
# that used to make mass-collision impossible. A portal publishing a
# placeholder — "N/A", "-", "00000000000000000000", the same dummy string
# on every listing — would now merge unrelated properties at confidence
# 1.000, the one confidence level that bypasses every corroboration rule
# the other signals have. Cheapest place to stop that is before the value
# is ever stored.
_CADASTRAL_REF_RE = re.compile(r"^[0-9A-Z]{20}$")

# Length alone is not enough, and the test for this found it out: a portal
# padding the field with `00000000000000000000` produces twenty
# alphanumeric characters and sails through the pattern above. Requiring
# both a digit and a letter is the cheapest rule that separates real
# references from degenerate padding, and it cannot reject a genuine one:
# every referencia catastral ends in two control characters that are
# letters, and every one carries digits in the parcel/municipality portion
# — for urban and rústica formats alike. A structural position-by-position
# parse would catch more, but risks rejecting valid input, and a wrongly
# rejected reference silently disables signal 1 for that portal, which
# looks exactly like "no duplicates found" and so goes unnoticed.
_HAS_DIGIT_RE = re.compile(r"[0-9]")
_HAS_LETTER_RE = re.compile(r"[A-Z]")


def normalize_cadastral_ref(value: str | None) -> str | None:
    """Upper-case and strip a cadastral reference, or return None if implausible.

    Rejects to None rather than raising, deliberately: an unparseable
    reference is missing enrichment, not a broken listing, and failing the
    whole ingest over it would lose real data to protect an optional field.
    Contrast `operation`, which raises — a wrong sale/rent value is worse
    than no value, because it silently misclassifies the listing.
    """
    if value is None:
        return None
    normalized = re.sub(r"\s+", "", value).upper()
    if not normalized:
        return None
    if (
        not _CADASTRAL_REF_RE.match(normalized)
        or not _HAS_DIGIT_RE.search(normalized)
        or not _HAS_LETTER_RE.search(normalized)
    ):
        logger.warning(
            "Discarding implausible cadastral_ref %r (expected 20 alphanumeric "
            "chars with at least one digit and one letter); it would otherwise "
            "merge unrelated properties at confidence 1.000",
            value,
        )
        return None
    return normalized


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
    # Issue #99: the one native site filter confirmed real via live
    # verification (Fotocasa's rooms-count URL path segment genuinely
    # narrows results, not just an SEO alias — see
    # docs/architecture/connectors.md). Named `rooms`, not `min_rooms`:
    # live verification (a real fetch of `.../2-habitaciones/l`, 31
    # results) showed every result had exactly 2 rooms, none 3+ — this is
    # an EXACT-match filter on Fotocasa's side, not a minimum, and calling
    # it `min_rooms` would actively mislead a caller into expecting 2+.
    # Carried on the scope itself, not a separate parameter, so it flows
    # through the same discover()/scope_key() path as center/radius_km. A
    # connector that doesn't support filtering by room count simply
    # ignores this field — it is not part of this class's identity
    # contract the way center/radius_km are (issue #96/#71's
    # coverage-resolution logic never looks at it).
    rooms: int | None = None


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
    # Schema superset vs. property_web_scraper's field model (issue #76).
    # Defaulted (unlike the fields above) so existing connectors/tests don't
    # need updating just to add this dataclass shape — populating these from
    # real connector data is the Fotocasa/Milanuncios retrofit issues' job
    # (#77/#78), not this one.
    city: str | None = None
    province: str | None = None
    postal_code: str | None = None
    m2_plot: Decimal | None = None
    features: tuple[str, ...] = field(default_factory=tuple)
    # 'sale' | 'rent' — listing-level, not property-level (see
    # etl/schema/init.sql's `listing.operation`). None (not defaulted to
    # 'sale') so the orchestrator's UPDATE-path COALESCE can tell "connector
    # didn't say" apart from "connector said sale" and fall through to the
    # existing DB value on re-visit instead of overwriting a real 'rent' back
    # to 'sale' every time a connector that doesn't set this re-fetches a
    # listing. INSERT path defaults an unset value to 'sale' explicitly.
    operation: Literal["sale", "rent"] | None = None
    # Seller/agency-assigned reference code (issue #72), e.g. Fotocasa's
    # "Referencia: NS603" — a dedup signal, not a unique key (see
    # etl/schema/init.sql's column comment). Defaulted None for the same
    # reason as the other superset fields above: existing connectors/tests
    # don't need updating for this dataclass shape to gain the field.
    reference_code: str | None = None
    # Spanish cadastral reference (`referencia catastral`) — property-level,
    # unlike reference_code above, and the dedup engine's *definitive*
    # signal rather than a probabilistic one (issue #1 §6 signal 1). Only
    # servicer/REO portals tend to publish it: they hold the asset and so
    # have the registry data, whereas a consumer portal re-listing someone
    # else's property does not. Solvia publishes it on every listing;
    # Vivantial and Servihabitat were both checked and do not (issue #140).
    # Not unique in the schema — see init.sql's column comment for why.
    cadastral_ref: str | None = None

    def __post_init__(self) -> None:
        if self.operation is not None and self.operation not in _VALID_OPERATIONS:
            raise ValueError(
                f"CanonicalListingVersion.operation must be one of "
                f"{_VALID_OPERATIONS} or None, got {self.operation!r}"
            )
        # Centralised here rather than per-connector so every connector in
        # the #132 servicer batch inherits the guard automatically — those
        # are exactly the portals that publish a cadastral reference, and
        # so exactly the ones that could publish a placeholder instead.
        # frozen=True, hence object.__setattr__.
        object.__setattr__(
            self, "cadastral_ref", normalize_cadastral_ref(self.cadastral_ref)
        )


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

    # Issue #100 (connector management UI): declarative metadata the
    # dashboard reads via connector_registry, so the UI renders what a
    # connector can actually do rather than assuming every connector is
    # configurable the same way.
    #
    # supports_discovery=False means discover() never runs for this
    # connector under any scope (Idealista — capture-only, issue #75,
    # scope_key() always returns None). Geography/filter controls for such
    # a connector would be controls that silently do nothing, so the UI
    # renders it as capture-only instead.
    supports_discovery: bool = True

    # Native site-filter keys this connector genuinely honours in
    # discover(), consumed as `ConnectorScope` fields set from
    # connector_config.filters. The UI renders one control per key here and
    # nothing at all for an empty tuple — deliberately opt-in, so a filter
    # dimension that hasn't been live-verified for a site (issue #99
    # confirmed only Fotocasa's room count; price/property-type and
    # Milanuncios' equivalent remain unconfirmed per
    # docs/architecture/connectors.md) can never ship as a control that
    # looks functional but isn't.
    supported_filters: tuple[str, ...] = ()

    def scope_key(self, scope: ConnectorScope) -> str | None:
        """Return a string identifying what this scope actually resolves to.

        The orchestrator uses this to dedupe crawling within one run: two
        scopes that resolve to the same key hit the identical target, so
        the second is skipped rather than redundantly re-crawled (issue
        #71 — two active search profiles with different exact centers can
        easily resolve to the same city). It's also used to detect a scope
        this connector has no coverage for at all: return `None` for a
        scope that can't be resolved to anything real, and the orchestrator
        skips it as unresolvable (logged, not treated as a failure) rather
        than calling `discover()` and making the connector raise for a
        target it was never going to be able to look at.

        Default: no site-specific geography resolution, so every distinct
        `(geography, center, radius_km)` combination is its own key and
        `None` is never returned — every scope is treated as both unique
        and resolvable. Override when a connector translates `scope.center`
        into a site-specific geography (see fotocasa.py/milanuncios.py's
        `_resolve_geography`, which their `scope_key` override delegates
        to directly).
        """
        if scope.geography:
            return f"geography:{scope.geography}"
        return f"raw:{scope.center}:{scope.radius_km}"

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
