"""Fixture-based tests for FotocasaRentalConnector (issue #211).

No live network calls — discover() is exercised by monkeypatching
requests.get to return saved fixture HTML (mirroring
test_connector_fotocasa.py's pattern), and fetch_detail()/normalize() are
driven purely off the record discover() stashes, with no network at all.

The point these tests pin is the whole reason this connector exists (D-066):
the estimator (dashboard/lib/analytics/rent-estimate.ts) hard-requires
lat/lon + m2_built + property_type on the ingested property, and this
connector produces all of them from the SEARCH payload alone — without
ever fetching a (potentially anti-bot-walled) detail page.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import (
    CanonicalListingVersion,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
)
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.fotocasa_rental import FotocasaRentalConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.fotocasa.es/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def _discover(connector: FotocasaRentalConnector, geography: str = "madrid-capital"):
    html = _read_fixture("fotocasa_rental_sample_search.html")
    with patch(
        "etl.connectors.fotocasa_rental.requests.get",
        return_value=_mock_response(html),
    ) as mock_get:
        ids = connector.discover(
            ConnectorScope(geography=geography), throttle=lambda: None
        )
    return ids, mock_get


def _normalize_one(connector: FotocasaRentalConnector, external_id: str):
    """discover() then fetch_detail()+normalize() for one id — the full
    offline pipeline, no network on the fetch (the record is served from
    discover()'s stash)."""
    _discover(connector)
    raw = connector.fetch_detail(external_id, throttle=lambda: None)
    return connector.normalize(raw)


# ── identity / safety attributes ──────────────────────────────────────


def test_has_its_own_source_name_distinct_from_the_sale_connector():
    assert FotocasaRentalConnector.name == "fotocasa_rental"
    assert FotocasaRentalConnector.name != FotocasaConnector.name


def test_does_not_claim_full_inventory_coverage():
    """Page-1-only search → never sees Fotocasa's full rental inventory;
    declared explicitly on this class so it can't silently depend on the
    parent keeping its own value False."""
    assert FotocasaRentalConnector.discovers_full_inventory is False
    assert "discovers_full_inventory" in vars(FotocasaRentalConnector)


def test_declares_skip_if_seen_off_explicitly_not_inherited():
    """FotocasaConnector sets min_refetch_interval_seconds to 24h; this
    class must NOT inherit that (a re-fetch here is free — no network — so
    there is no reason to skip). Declared in this class's own __dict__ so a
    silent inheritance regression is caught."""
    assert FotocasaRentalConnector.min_refetch_interval_seconds == 0
    assert "min_refetch_interval_seconds" in vars(FotocasaRentalConnector)


# ── discover() ────────────────────────────────────────────────────────


class TestDiscover:
    def test_requests_the_rental_search_url_not_the_sale_one(self):
        _, mock_get = _discover(FotocasaRentalConnector())
        url = mock_get.call_args.args[0]
        assert "/es/alquiler/viviendas/madrid-capital/todas-las-zonas/l" in url
        assert "/comprar/" not in url

    def test_returns_all_external_ids_from_the_search_payload(self):
        ids, _ = _discover(FotocasaRentalConnector())
        assert ids == ["188990001", "189725317", "190014264"]

    def test_center_based_scope_resolves_to_the_matching_city(self):
        """Same live-URL-construction guard as the sale connector's own
        test — a Sevilla-centered scope must build a Sevilla URL, not
        default to Madrid."""
        html = _read_fixture("fotocasa_rental_sample_search.html")
        with patch(
            "etl.connectors.fotocasa_rental.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            FotocasaRentalConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        url = mock_get.call_args.args[0]
        assert "sevilla" in url
        assert "madrid" not in url

    def test_raises_on_soft_block_page_not_empty_list(self):
        """Fotocasa's interruption page (HTTP 200, no __initial_props__
        tag) must raise so the orchestrator's withdrawal reconciliation
        never misreads it as 'every listing disappeared'. Reuses the sale
        connector's own block-page fixture — it's site-wide, not
        category-specific."""
        html = _read_fixture("fotocasa_sample_block_page.html")
        with (
            patch(
                "etl.connectors.fotocasa_rental.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__initial_props__"),
        ):
            FotocasaRentalConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

    def test_raises_without_defaulting_to_a_hardcoded_city(self):
        with pytest.raises(ConnectorError, match="nothing to discover"):
            FotocasaRentalConnector().discover(ConnectorScope(), throttle=lambda: None)

    def test_bare_disallowed_city_slug_is_rejected(self):
        """robots.txt disallows the bare '/madrid/' path segment — same
        guard as the parent, restated because it protects a live request."""
        with pytest.raises(ConnectorError, match="robots.txt"):
            FotocasaRentalConnector().discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )


# ── fetch_detail() makes no network request ───────────────────────────


class TestFetchDetailIsOffline:
    def test_fetch_detail_makes_no_http_request(self):
        """The whole #211 point: fetch_detail() must NOT touch the network
        (that path is the anti-bot-walled one). It serves the record
        discover() already stashed."""
        connector = FotocasaRentalConnector()
        _discover(connector)
        with patch("etl.connectors.fotocasa_rental.requests.get") as mock_get:
            raw = connector.fetch_detail("190014264", throttle=lambda: None)
        mock_get.assert_not_called()
        assert raw.source == "fotocasa_rental"
        assert raw.raw["search_record"]["id"] == 190014264
        assert raw.raw["url"].endswith("/190014264/d")

    def test_fetch_detail_does_not_call_throttle(self):
        """No live request means nothing to pace — calling throttle() would
        make the orchestrator's rate limiter block a free operation."""
        connector = FotocasaRentalConnector()
        _discover(connector)
        throttle = Mock()
        connector.fetch_detail("190014264", throttle=throttle)
        throttle.assert_not_called()

    def test_id_absent_from_last_discover_is_a_clean_skip(self):
        connector = FotocasaRentalConnector()
        _discover(connector)
        with pytest.raises(ListingUnavailableError, match="reordered/withdrawn"):
            connector.fetch_detail("999999999", throttle=lambda: None)


# ── normalize(): the four estimator-required fields + rent ────────────


class TestNormalizeProducesEstimatorFields:
    def test_populates_lat_lon_m2_type_and_rent_price(self):
        """The four fields rent-estimate.ts's comp query hard-requires on
        the property (lat, lon, m2_built, property_type) plus a positive
        rent current_price — all from the SEARCH payload, no detail
        fetch."""
        cv = _normalize_one(FotocasaRentalConnector(), "190014264")
        assert isinstance(cv, CanonicalListingVersion)
        assert cv.lat == Decimal("40.43970952626037")
        assert cv.lon == Decimal("-3.68982940025934")
        assert cv.m2_built == Decimal(75)
        assert cv.property_type == "piso"
        assert cv.current_price == Decimal(1200)
        assert cv.operation == "rent"

    def test_derives_operation_rent(self):
        cv = _normalize_one(FotocasaRentalConnector(), "189725317")
        assert cv.operation == "rent"

    def test_maps_a_second_building_type(self):
        """Penthouse → 'atico' via the shared map_property_type — proves
        the connector isn't hardcoding 'piso'."""
        cv = _normalize_one(FotocasaRentalConnector(), "188990001")
        assert cv.property_type == "atico"
        assert cv.m2_built == Decimal(110)

    def test_infers_agency_and_private_listing_kinds(self):
        agency = _normalize_one(FotocasaRentalConnector(), "190014264")
        private = _normalize_one(FotocasaRentalConnector(), "189725317")
        assert agency.listing_kind == "agency"
        assert private.listing_kind == "particular"

    def test_carries_rooms_bathrooms_city_province_postal_and_photos(self):
        cv = _normalize_one(FotocasaRentalConnector(), "190014264")
        assert cv.rooms == 2
        assert cv.bathrooms == 1
        assert cv.city == "Madrid"
        assert cv.province == "Madrid"
        assert cv.postal_code == "28046"
        assert cv.photo_urls and all(u.startswith("https://") for u in cv.photo_urls)

    def test_status_is_active(self):
        cv = _normalize_one(FotocasaRentalConnector(), "190014264")
        assert cv.status == "active"
