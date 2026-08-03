"""Fixture-based tests for MilanunciosRentalConnector (issue #31).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, mirroring
test_connector_milanuncios.py's pattern exactly (this connector reuses
that one's fetch_detail()/normalize() unchanged, so its own tests focus on
what's actually different: discover()'s URL, the connector's identity/
rate-limit attributes, and an end-to-end proof that a real rental page
normalizes to operation="rent" via the INHERITED normalize()).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.milanuncios import MilanunciosConnector
from etl.connectors.milanuncios_rental import MilanunciosRentalConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.milanuncios.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_milanuncios_rental_has_its_own_source_name():
    """Distinct from the sale connector's "milanuncios" — see module
    docstring's identity reasoning (own connector_runs/connector_config
    rows, own rate limiter/circuit breaker instance)."""
    assert MilanunciosRentalConnector.name == "milanuncios_rental"
    assert MilanunciosRentalConnector.name != MilanunciosConnector.name


def test_milanuncios_rental_rate_limit_is_half_the_sale_connectors():
    """Mutation check for the module docstring's stated rate-limit
    reasoning — both connectors share Milanuncios' cumulative anti-bot
    budget, so the rental connector's own limit must stay strictly below
    the sale connector's, not accidentally equal or higher."""
    assert (
        MilanunciosRentalConnector.rate_limit_per_minute
        < MilanunciosConnector.rate_limit_per_minute
    )
    assert MilanunciosRentalConnector.rate_limit_per_minute == 10


def test_milanuncios_rental_does_not_claim_full_inventory_coverage():
    assert MilanunciosRentalConnector.discovers_full_inventory is False


class TestDiscover:
    def test_discover_requests_the_rental_category_url_not_sale(self):
        """The one real behavioural difference from MilanunciosConnector:
        discover() must hit alquiler-de-pisos-en-..., never
        venta-de-pisos-en-... — a copy-paste regression here would
        silently make this connector re-ingest sale listings as rentals."""
        html = _read_fixture("milanuncios_rental_sample_search.html")
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            MilanunciosRentalConnector().discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        requested_url = mock_get.call_args.args[0]
        assert "alquiler-de-pisos-en-madrid-madrid" in requested_url
        assert "venta-de-pisos" not in requested_url

    def test_discover_finds_external_ids_from_rental_search_page(self):
        html = _read_fixture("milanuncios_rental_sample_search.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert sorted(ids) == ["511445103", "549058037", "560555908"]

    def test_center_based_scope_requests_the_matching_city_not_madrid(self):
        """Same live-URL-construction check as the sale connector's own
        test (issue #71 review finding) — must hold for this connector's
        discover() too, not just be inherited-and-assumed."""
        html = _read_fixture("milanuncios_rental_sample_search.html")
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            MilanunciosRentalConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "sevilla" in requested_url
        assert "madrid" not in requested_url

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        """Reuses the SAME site-wide block-page fixture the sale
        connector's test uses — it's not category-specific, it's what
        Milanuncios returns for any blocked request."""
        html = _read_fixture("milanuncios_sample_block_page.html")
        connector = MilanunciosRentalConnector()
        with (
            patch(
                "etl.connectors.milanuncios_rental.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__INITIAL_PROPS__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )

    def test_discover_raises_without_defaulting_to_a_hardcoded_city(self):
        connector = MilanunciosRentalConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)


class TestFetchDetailAndNormalizeInherited:
    """These exercise the INHERITED fetch_detail()/normalize() against a
    real rental page — the actual end-to-end proof that this connector
    produces operation="rent" listings without any rental-specific
    normalize() code existing anywhere (see module docstring)."""

    def test_fetch_detail_uses_the_same_generic_detail_url_as_sale(self):
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        requested_url = mock_get.call_args.args[0]
        assert requested_url == "https://www.milanuncios.com/x/x-549058037.htm"
        assert raw.source == "milanuncios_rental"

    def test_normalize_derives_operation_rent_from_the_ad_s_own_category(self):
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ):
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.operation == "rent"
        # price.cashPrice.value (900) lands in current_price -- the SAME
        # generic column the sale connector's price lands in, confirming
        # the schema decision documented in rent-estimate.ts's module
        # docstring: no separate monthly_rent column needed.
        assert canonical.current_price == Decimal(900)
        assert canonical.m2_built == Decimal(65)
        assert canonical.rooms == 2
        assert canonical.bathrooms == 1
        assert canonical.property_type is not None
        assert canonical.source == "milanuncios_rental"
        assert canonical.external_id == "549058037"

    def test_normalize_never_hardcodes_sale_for_a_rental_ad(self):
        """Mutation-style guard: if MilanunciosRentalConnector ever grew
        its own normalize() override that (by copy-paste mistake) hardcoded
        operation="sale" the way the original sale-only connectors do, this
        test catches it immediately."""
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ):
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.operation != "sale"
