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
import string
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping
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
class SearchParam:
    """One resolved parameter a connector's discover() actually uses for a scope
    — for the "Validar filtros" page (issue #478/#491).

    A `SearchPreview.url` is a single opaque string; this is its decomposition
    into the individual, human-labelled inputs that produced it (geography,
    operation, room count, …) plus WHERE each one came from and WHETHER it
    travels in the URL at all. The page renders one chip per param with a
    source badge, so the owner can see exactly what the ETL sends — including
    the honest truth that a profile's price/size/type filters are NOT sent to
    the connector (they are applied downstream by data), which surfaces here as
    params that simply don't exist (or, for a filter a connector *does* honour,
    `in_url=True`).

    Anti-drift contract (same as `SearchPreview.url`): a connector must build
    these from the SAME resolved values / helpers its `discover()` uses — never
    a hand-written parallel description that can silently disagree with what the
    connector really does.

    - `source`: `"profile"` (from the search_profile scope, e.g. geography),
      `"connector_config"` (an operator-set native filter, e.g. rooms),
      `"constant"` (baked into the connector, e.g. operation=venta), or
      `"derived"` (computed from other inputs).
    - `in_url`: True when the value appears in the search URL (so the URL
      grammar can round-trip it); False for a param the connector uses but does
      not encode in the URL.
    """

    key: str
    label: str
    value: str | None
    source: Literal["profile", "connector_config", "constant", "derived"]
    in_url: bool
    notes: str | None = None


def _ecma_pattern_to_python(pattern: str) -> str:
    """Rewrite an ECMAScript-canonical regex so Python's `re` accepts it.

    The one syntactic difference that matters for URL grammars is named-group
    spelling: JavaScript writes `(?<name>...)`, Python `(?P<name>...)`. Grammars
    are stored in the ECMAScript form (so the browser's `RegExp` consumes them
    verbatim — the whole point of publishing the grammar, issue #491), and this
    translates them for the Python side. Only a named-group open (`(?<` followed
    by a name character) is rewritten; a lookbehind (`(?<=` / `(?<!`) is left
    untouched (and is rejected by `validate_grammar` anyway).
    """
    return re.sub(r"\(\?<(?=[A-Za-z_])", "(?P<", pattern)


@dataclass(frozen=True)
class SearchUrlGrammar:
    """A declarative, invertible description of a connector's search URL —
    issue #491.

    Two halves that round-trip:
    - `build_template`: a `str.format` template with `{placeholder}` slots, e.g.
      `https://www.pisos.com/venta/pisos-{geography}/`. `build(params)` fills it.
    - `parse_pattern`: an anchored, ECMAScript-canonical regex whose NAMED GROUPS
      are exactly the template placeholders, e.g.
      `^https?://(?:www\\.)?pisos\\.com/venta/pisos-(?<geography>[^/]+)/?$`.
      `parse(url)` returns the named groups, or None when the URL doesn't match.

    Published verbatim to `connector_registry.search_url_grammar` by
    `sync_connector_registry`, so the dashboard infers params from an
    owner-edited URL IN THE BROWSER using the same grammar — one implementation,
    zero per-connector TypeScript. `parse_pattern` is stored in ECMAScript form
    so the browser's `RegExp` uses it directly; the Python side translates it
    with `_ecma_pattern_to_python`.

    `params` carries per-placeholder metadata (label, source) mirroring the
    `SearchParam` fields, so the UI can label the inferred groups without a
    second source of truth.
    """

    build_template: str
    parse_pattern: str
    params: dict[str, dict] = field(default_factory=dict)

    def placeholders(self) -> set[str]:
        """The `{name}` slots in `build_template`."""
        return {
            field_name
            for _, field_name, _, _ in string.Formatter().parse(self.build_template)
            if field_name
        }

    def group_names(self) -> set[str]:
        """The named capture groups in `parse_pattern`."""
        return set(re.compile(_ecma_pattern_to_python(self.parse_pattern)).groupindex)

    def build(self, params: Mapping[str, str]) -> str:
        """Fill `build_template` from `params` (extra keys are ignored)."""
        return self.build_template.format(**params)

    def parse(self, url: str) -> dict[str, str] | None:
        """Return the named groups `parse_pattern` extracts from `url`, or None
        when it doesn't match (an owner-edited URL the grammar can't invert)."""
        compiled = re.compile(_ecma_pattern_to_python(self.parse_pattern))
        match = compiled.match(url)
        if match is None:
            return None
        return dict(match.groupdict())


def validate_grammar(connector: type[Connector] | Connector) -> None:
    """Assert a connector's `search_url_grammar` is a safe, self-consistent,
    ECMAScript-compatible grammar (issue #491). No-op when the connector has no
    grammar. Raises ValueError with a specific reason otherwise.

    Checks:
    1. No inline flags (`(?i)`, `(?m):`, …) — ECMAScript has none, so the same
       pattern must not rely on them (parity with the browser would break).
    2. No lookbehind (`(?<=` / `(?<!`) — kept out of the shared subset (the
       issue's "sin lookbehind variable"), and never needed for a URL grammar.
    3. The pattern compiles (after the named-group translation).
    4. Its named groups are EXACTLY the build template's placeholders — so
       `build(parse(url)) == url` can round-trip and neither half carries a
       parameter the other doesn't.
    """
    grammar = connector.search_url_grammar
    if grammar is None:
        return
    name = getattr(connector, "name", connector.__class__.__name__)
    ecma = grammar.parse_pattern
    if re.search(r"\(\?[aiLmsux]", ecma):
        raise ValueError(
            f"{name}: grammar parse_pattern uses inline flags — not ECMAScript-safe"
        )
    if "(?<=" in ecma or "(?<!" in ecma:
        raise ValueError(
            f"{name}: grammar parse_pattern uses lookbehind — outside the "
            "shared regex subset (issue #491)"
        )
    try:
        compiled = re.compile(_ecma_pattern_to_python(ecma))
    except re.error as exc:
        raise ValueError(
            f"{name}: grammar parse_pattern does not compile: {exc}"
        ) from exc
    groups = set(compiled.groupindex)
    placeholders = grammar.placeholders()
    if groups != placeholders:
        raise ValueError(
            f"{name}: grammar named groups {sorted(groups)} != build template "
            f"placeholders {sorted(placeholders)}"
        )


@dataclass(frozen=True)
class SearchPreview:
    """What discover() will actually execute for a scope — for the "Validar
    filtros" page (issue #478 P4).

    A pure, offline description of the search a connector would run for a
    given profile scope: the entry URL (or endpoint) it hits, what KIND of
    request that is, whether the connector can accept an owner-pinned URL as
    its recall source, and an honest note when there is nothing to tune.

    `search_previews()` builds these by REUSING the same `_search_url()` /
    module constants `discover()` uses, so a preview can never drift from what
    the connector actually does (that's the per-connector pytest contract).

    - `url` is None when the scope resolves to no geography this connector
      covers (a degraded row the page renders with `notes`).
    - `tunable` mirrors `supports_search_override` semantics for the page: a
      connector with a real, host-scoped search URL the owner could pin. The
      sitemap/API connectors whose recall is national/complete are `tunable
      = False` with a note explaining the filtering is by data, not by URL.
    """

    label: str
    url: str | None
    kind: Literal["search_page", "sitemap", "api"]
    tunable: bool
    notes: str | None = None
    # The resolved parameters this preview's URL is built from (issue #491) —
    # geography, operation, room count, … each with its source and whether it
    # travels in the URL. Additive with a default `()` so no existing connector
    # or test needs updating; a connector populates it from the SAME resolved
    # values `discover()`/`_search_url()` use (the anti-drift contract that
    # binds `url`). Serialised into the existing `connector_search_preview
    # .previews` JSONB by `dataclasses.asdict` — no migration.
    params: tuple[SearchParam, ...] = ()


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
    # Issue #478 P5 (D-101): an owner-pinned search URL that IS this
    # (profile × connector)'s recall source — the URL discover() hits as its
    # entry page instead of the one it would build from center/radius. Set by
    # the orchestrator (`_scopes_for_connector`) from `profile_connector_filter`
    # for a connector that declares `supports_search_override`; None for every
    # other scope. Verbatim — never re-substituted (the owner tuned it by hand;
    # it is the strongest "owner-confirmed" signal, tier 0 over D-051).
    #
    # Carried on the scope itself, same precedent as `rooms` above, so it flows
    # through the identical discover()/scope_key() path. Crucially it IS part of
    # this scope's identity here: `scope_key()` incorporates it, so an override
    # scope is never deduped against the twin (non-override) scope derived from
    # the same geography — both run, and the pinned URL is that profile's recall
    # source. A connector WITHOUT `supports_search_override` simply ignores this
    # field (no error) — the orchestrator never sets it for such a connector.
    override_url: str | None = None


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

    A plain `ConnectorError` is a FATAL failure (network error, invalid JSON,
    an HTML structure that genuinely changed). For site-side rate-throttling
    that should be treated as a clean "waited for budget" backoff rather than
    an error state, raise `SoftBlockError` instead — see below and D-047.
    """


class SoftBlockError(ConnectorError):
    """A connector hit the site's own rate-throttling / bot-mitigation wall
    (issue #270, D-047): an HTTP 200 whose listing payload is withheld, a
    CAPTCHA interstitial, or an equivalent "come back later" response.

    This is NOT a bug and NOT a sign the connector is broken — it's the site
    telling us we've spent this run's budget. Subclasses `ConnectorError` so
    existing `except ConnectorError` handlers keep working, but the
    orchestrator classifies it distinctly: it trips the circuit breaker only
    at the looser soft-block threshold, and a breaker/discover stop caused by
    it is recorded as a CLEAN run outcome (status stays 'ok', with an
    informational notice) rather than 'failed'/'circuit_open'. The failed
    fetch is still counted in `error_count` — reducing those genuine failures
    is tracked separately (issue #291). See etl.connectors.circuit_breaker and
    etl.orchestrator.
    """


# HTTP statuses a detail fetch returns when the listing itself no longer
# exists at the source — it was removed/withdrawn between the discover()
# sweep that surfaced its id and this run's detail fetch. 410 Gone is the
# explicit signal; 404 is what most listing sites actually return for a
# since-removed detail page. Kept here (not in a connector) so every
# connector classifies the same statuses, and as a bare int set so this
# module keeps its deliberate zero-`requests`-import property (see the
# module docstring) — each connector extracts the status from its own
# already-caught HTTPError and checks membership. See issue #291.
LISTING_GONE_HTTP_STATUSES = frozenset({404, 410})


class ListingUnavailableError(ConnectorError):
    """fetch_detail found that a discovered listing no longer exists at the
    source (an HTTP status in `LISTING_GONE_HTTP_STATUSES`).

    A real classifieds site turns inventory over constantly: a listing
    present in a discover() search page is routinely removed by the seller
    (or expires) in the minutes before this run's detail fetch reaches it.
    That is expected churn, not a fetch/parse failure an operator should
    chase — but before issue #291 every connector wrapped a 404 into a
    plain ConnectorError, so a handful of just-removed listings inflated
    `connector_run_results.error_count` on essentially every fotocasa /
    milanuncios scope run (the persistent `errors=7..10` the issue reports).

    A distinct subclass lets `etl.orchestrator.run_connector` treat this as
    a clean skip — not counted toward `error_count` — while still a
    ConnectorError, so a mass of them (the detail-URL shape broke, so
    *every* fetch 404s) still trips the shared circuit breaker rather than
    silently fetching nothing. Connectors raise it only for the unambiguous
    HTTP-gone case; a 200-with-no-payload page stays a generic
    ConnectorError, because that is the soft-block signature and must never
    be reclassified as "listing gone". See issue #291 and issue #66.
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
    # Issue #270 (D-047): the looser rolling-window error-rate at which
    # SOFT-BLOCK errors (site rate-throttling, `SoftBlockError`) trip the
    # breaker — kept separate from `circuit_breaker_error_rate`, which gates
    # genuine FATAL errors. None (the default) means "trip soft-blocks exactly
    # like fatal errors", a conservative no-op that changes no connector's trip
    # timing unless it opts in. A connector whose soft-block is TRANSIENT
    # (Fotocasa: a throttle burst mid-sweep that clears) raises this so a burst
    # doesn't trip the breaker and abandon the connector's other scopes for the
    # run; one whose block is a long hard lockout (Milanuncios) leaves it None
    # and trips promptly. Either way the trip is recorded as a clean
    # "waited for budget" stop, not an error. Must be >= circuit_breaker_error_rate.
    circuit_breaker_soft_block_error_rate: float | None = None

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

    # Issue #478 (Validar filtros): the host suffix an owner-pinned search URL
    # must fall under for this connector, published to `connector_registry` by
    # sync_connector_registry() so the dashboard's PUT
    # /api/profiles/[id]/connector-filters route can validate a pinned URL's
    # host server-side (never client-claimed — #476). None means this connector
    # does not accept a pinned URL at all: the capture-only portals (their
    # override lives on the TS side) and the non-tunable sitemap/API connectors
    # (cimenta2/vivantial/buildingcenter/escogecasa — national/complete recall,
    # nothing to pin) leave it None.
    override_host_suffix: str | None = None

    # Whether discover() actually CONSUMES a pinned `ConnectorScope.override_url`
    # as its entry URL. False for every connector in Phase 4 — the page can save
    # a pin against `override_host_suffix`, but the recall wiring
    # (`scope.override_url` → discover()) lands per-connector in Phase 5. Kept
    # distinct from `override_host_suffix` so a connector can advertise "you may
    # pin a URL here" before its discover() honours it.
    supports_search_override: bool = False

    # Issue #491: a declarative, invertible grammar for this connector's search
    # URL (build template + parse regex). Published to
    # `connector_registry.search_url_grammar` by sync_connector_registry so the
    # dashboard can infer params from an owner-edited URL in the browser — one
    # generic implementation, no per-connector TypeScript. None (the default)
    # means "no grammar published": the page still shows this connector's params
    # (from search_previews) but cannot re-infer them from an edited URL. A
    # grammar must satisfy `validate_grammar` and stay pinned to `_search_url()`
    # by a per-connector round-trip pytest contract.
    search_url_grammar: SearchUrlGrammar | None = None

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        """What discover() would execute for `scope`, for the Validar filtros page.

        Pure and offline — resolves geography against the local gazetteer and
        reuses the connector's own `_search_url()`/constants, issuing no network
        request. Default `[]` means "no ETL preview" (the capture-only portals,
        whose preview is produced on the TypeScript side). Every HTTP connector
        overrides this (issue #478 P4).
        """
        return []

    # Issue #143 (fetch-budget / skip-if-seen): minimum seconds between two
    # real fetch_detail() calls for the same already-known external_id.
    # 0 (default) preserves the original behaviour every connector had
    # before this — fetch_detail() runs for every discovered id, every run,
    # unconditionally. Skip-if-seen is opt-in per connector, not a global
    # switch: a 200k-listing bank-portal connector and a 3-req/min
    # Fotocasa have completely different fetch economics, and a connector
    # that hasn't been shown to need it shouldn't take on the staleness
    # risk for free. Override upward only with a real reason (see
    # fotocasa.py, the first connector to set this non-zero) — and see
    # etl.orchestrator._should_skip_fetch for the full policy, which never
    # skips a listing that has never been fetched, is missing its price,
    # or that has an unconfirmed price observation (a
    # listing_price_history row newer than last_fetched_at — recorded from
    # `discovered_prices` below; re-anchored per issue #432 / D-098),
    # regardless of this window.
    #
    # Operator-overridable per connector via `connector_config
    # .min_refetch_interval_seconds` (NULL = no override, use this
    # class-attribute default) — see etl.orchestrator._scopes_for_connector.
    min_refetch_interval_seconds: int = 0

    def discovered_prices(self) -> dict[str, Decimal]:
        """Prices observed as a side effect of the most recent discover() call.

        Issue #143: skip-if-seen's one hard requirement is that it must not
        be able to silently stop detecting a real price change (the
        product's core signal — see issue #1 §10 and docs/skills/
        connectors.md). Some sites embed each result's price in the very
        page discover() already fetches to find external_ids (Fotocasa's
        search-results JSON — confirmed live, see fotocasa.py); reading it
        there is free (no second request) and lets the orchestrator force
        a re-fetch the moment a discovered price disagrees with what's
        stored, even for a listing that would otherwise look "fresh
        enough" under `min_refetch_interval_seconds`.

        Default: empty dict, meaning "no discovery-time price signal" —
        NEVER a promise that a listing's price is unchanged. A connector
        must only override this once it has verified (against a real
        fetched page, not assumed from a reference mapping or an older
        connector's shape) that the field it would read here is both
        present and reliable — see docs/skills/connectors.md for a
        worked example of a connector that investigated this and could
        NOT confirm it (Milanuncios), and left this at the default rather
        than guess.

        Called by the orchestrator immediately after discover() returns,
        before any fetch_detail() calls for that same scope — a connector
        that overrides this should stash whatever price data it parsed
        out of discover()'s own request on `self` during discover(), and
        return it here. Keyed by the same external_id strings discover()
        returned.
        """
        return {}

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

        Issue #478 P5 (D-101): a scope carrying an owner-pinned
        `override_url` MUST resolve to a key that includes it — the default
        appends `f"override:{override_url}"` when present — so the override
        scope is never deduped by the orchestrator against the twin
        (non-override) scope derived from the same geography. A connector
        that overrides this method and supports pinned URLs must do the same
        (see pisos/habitaclia/milanuncios).
        """
        if scope.geography:
            base = f"geography:{scope.geography}"
        else:
            base = f"raw:{scope.center}:{scope.radius_km}"
        if scope.override_url:
            return f"{base}|override:{scope.override_url}"
        return base

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
