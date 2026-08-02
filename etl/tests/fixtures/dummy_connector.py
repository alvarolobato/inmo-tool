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
    RawListing,
    Throttle,
)


class DummyConnector(Connector):
    def __init__(
        self,
        name: str = "dummy",
        external_ids: tuple[str, ...] = ("dummy-1", "dummy-2", "dummy-3"),
        failing_ids: frozenset[str] = frozenset(),
        db_error_ids: frozenset[str] = frozenset(),
        rate_limit_per_minute: int = 6000,  # fast for tests — not what's under test here
        circuit_breaker_error_rate: float = 0.30,
        circuit_breaker_min_attempts: int = 2,
    ) -> None:
        self.name = name
        self.rate_limit_per_minute = rate_limit_per_minute
        self.circuit_breaker_error_rate = circuit_breaker_error_rate
        self.circuit_breaker_min_attempts = circuit_breaker_min_attempts
        self._external_ids = external_ids
        self._failing_ids = failing_ids
        # IDs that fetch/normalize fine but fail at persist time — simulates
        # a mid-transaction DB error (as opposed to `failing_ids`, which
        # simulates a connector-side failure before persistence is ever
        # attempted). Encoded as an invalid `property_type` so it trips
        # the real `property_type` CHECK constraint in etl/schema/init.sql.
        self._db_error_ids = db_error_ids

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        return list(self._external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        if external_id in self._failing_ids:
            raise ConnectorError(f"simulated fetch failure for {external_id}")
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"price": 150000, "address": f"Test address {external_id}"},
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
