"""A configurable in-memory Connector for orchestrator tests (issue #11 EC-1/EC-2).

No network, no real site — just enough to exercise the framework's
discover -> fetch_detail -> normalize -> persist cycle and its failure path.
"""

from __future__ import annotations

from decimal import Decimal

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    SoftBlockError,
    Throttle,
)


class DummyConnector(Connector):
    def __init__(
        self,
        name: str = "dummy",
        external_ids: tuple[str, ...] = ("dummy-1", "dummy-2", "dummy-3"),
        failing_ids: frozenset[str] = frozenset(),
        gone_ids: frozenset[str] = frozenset(),
        db_error_ids: frozenset[str] = frozenset(),
        # Issue #270 (D-047): ids whose fetch_detail() raises a SoftBlockError
        # (site rate-throttling) rather than a genuine ConnectorError — used to
        # exercise the soft-block-vs-fatal classification. Distinct from
        # `failing_ids` (fatal) so a test can mix both.
        soft_block_ids: frozenset[str] = frozenset(),
        rate_limit_per_minute: int = 6000,  # fast for tests — not what's under test here
        circuit_breaker_error_rate: float = 0.30,
        circuit_breaker_min_attempts: int = 2,
        circuit_breaker_soft_block_error_rate: float | None = None,
        price: int = 150000,
        discovers_full_inventory: bool = True,
        min_refetch_interval_seconds: int = 0,
    ) -> None:
        self.name = name
        self.rate_limit_per_minute = rate_limit_per_minute
        self.circuit_breaker_error_rate = circuit_breaker_error_rate
        self.circuit_breaker_min_attempts = circuit_breaker_min_attempts
        self.circuit_breaker_soft_block_error_rate = (
            circuit_breaker_soft_block_error_rate
        )
        self.discovers_full_inventory = discovers_full_inventory
        # Issue #143: 0 (default) matches every connector's original
        # behaviour — always fetch — so every pre-#143 test using this
        # fixture is unaffected unless it explicitly opts in.
        self.min_refetch_interval_seconds = min_refetch_interval_seconds
        # Mutable on purpose (not frozen at construction like the other
        # params) — task 1.4's withdrawal-detection and price-history tests
        # need a single DummyConnector instance whose discover() result /
        # fetch price can change between successive run_all_connectors()
        # calls, simulating successive real-world sweeps.
        self.external_ids = external_ids
        self.price = price
        self._failing_ids = failing_ids
        self._soft_block_ids = soft_block_ids
        # Issue #291: ids whose fetch_detail() raises ListingUnavailableError
        # (the source returned HTTP 404/410 — listing removed between
        # discovery and fetch). Distinct from `failing_ids`: those simulate a
        # genuine fetch/parse failure that must still count as a run error,
        # while these must be reclassified as a clean skip (not an error).
        self._gone_ids = gone_ids
        # IDs that fetch/normalize fine but fail at persist time — simulates
        # a mid-transaction DB error (as opposed to `failing_ids`, which
        # simulates a connector-side failure before persistence is ever
        # attempted). Encoded as an invalid `property_type` so it trips
        # the real `property_type` CHECK constraint in etl/schema/init.sql.
        self._db_error_ids = db_error_ids
        # Issue #71: lets orchestrator tests assert on exactly which
        # ConnectorScope(s) run_all_connectors actually called discover()
        # with (e.g. "was this the Sevilla-derived scope, not Madrid"),
        # without this connector caring about scope content itself.
        self.scopes_seen: list[ConnectorScope] = []
        # Issue #143: lets a test simulate a connector whose discover()
        # already carries a per-listing price signal (like Fotocasa's real
        # rawPrice) — {} (default) means "no discovery-time price signal",
        # same as the base Connector.discovered_prices() default. Mutable
        # for the same reason `price`/`external_ids` are: a test needs to
        # change it between successive run_all_connectors() calls.
        self.discovery_price_overrides: dict[str, int] = {}
        # Issue #143: every external_id fetch_detail() was actually called
        # for, in call order — lets a skip-if-seen test assert exactly what
        # was (not) fetched, independent of what ends up in the database
        # (which a DB-error id, for instance, would never reach).
        self.fetch_calls: list[str] = []

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        self.scopes_seen.append(scope)
        return list(self.external_ids)

    def discovered_prices(self) -> dict[str, Decimal]:
        return {
            external_id: Decimal(str(price))
            for external_id, price in self.discovery_price_overrides.items()
        }

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        self.fetch_calls.append(external_id)
        if external_id in self._soft_block_ids:
            raise SoftBlockError(f"simulated soft-block for {external_id}")
        if external_id in self._gone_ids:
            raise ListingUnavailableError(
                f"simulated HTTP 404 (listing gone) for {external_id}"
            )
        if external_id in self._failing_ids:
            raise ConnectorError(f"simulated fetch failure for {external_id}")
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"price": self.price, "address": f"Test address {external_id}"},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        is_db_error_id = raw.external_id in self._db_error_ids
        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=f"https://example.test/{raw.external_id}",
            listing_kind="particular",
            status="active",
            current_price=Decimal(str(raw.raw["price"])),
            description="A dummy listing for tests.",
            photo_urls=(),
            contact_raw=None,
            address=raw.raw["address"],
            lat=None,
            lon=None,
            # Not a real value in the property_type CHECK constraint —
            # deliberately invalid so persistence fails mid-transaction.
            property_type="not-a-real-property-type" if is_db_error_id else "piso",
            m2_built=None,
            m2_useful=None,
            rooms=None,
            bathrooms=None,
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
        )


class DiscoverFailsConnector(Connector):
    """A connector whose discover() itself raises — the pre-fetch failure path."""

    name = "broken-discover"
    rate_limit_per_minute = 6000

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError("discover() is broken")

    def fetch_detail(
        self, external_id: str, throttle: Throttle
    ) -> RawListing:  # pragma: no cover — unreachable
        raise NotImplementedError

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:  # pragma: no cover
        raise NotImplementedError


class DiscoverSoftBlocksConnector(Connector):
    """A connector whose discover() raises a SoftBlockError — the site
    rate-throttling us at discovery time (issue #270, D-047, e.g. Milanuncios'
    GeeTest wall). Must be recorded as a clean "waited for budget" outcome, not
    a failure."""

    name = "soft-block-discover"
    rate_limit_per_minute = 6000

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise SoftBlockError(
            "soft-block/interruption page detected (rate-throttling) — backing off"
        )

    def fetch_detail(
        self, external_id: str, throttle: Throttle
    ) -> RawListing:  # pragma: no cover — unreachable
        raise NotImplementedError

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:  # pragma: no cover
        raise NotImplementedError
