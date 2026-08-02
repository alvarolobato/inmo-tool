"""Fixture-based tests for the Milanuncios connector (issue #15, Phase 2.1).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, mirroring
test_connector_fotocasa.py's pattern.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.milanuncios import MilanunciosConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.milanuncios.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_milanuncios_does_not_claim_full_inventory_coverage():
    """Same reasoning as Fotocasa (see docs/architecture/connectors.md):
    discover() only reads page 1 of one sale category (robots.txt disallows
    pagination here too), against inventory in the thousands."""
    assert MilanunciosConnector.discovers_full_inventory is False


class TestDiscover:
    def test_discover_finds_external_ids_from_search_page(self):
        html = _read_fixture("milanuncios_sample_search.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert sorted(ids) == ["700000001", "700000002", "700000003"]

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        html = _read_fixture("milanuncios_sample_block_page.html")
        connector = MilanunciosConnector()
        with (
            patch(
                "etl.connectors.milanuncios.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__INITIAL_PROPS__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )


class TestNormalize:
    def test_normalize_matches_expected_fixture(self):
        """EC-1: fetch_detail + normalize on a saved fixture produce the exact expected output."""
        html = _read_fixture("milanuncios_sample_detail.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000001", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.external_id == "700000001"
        assert canonical.source == "milanuncios"
        assert canonical.current_price == Decimal(1683000)
        assert canonical.property_type == "piso"
        assert canonical.rooms == 4
        assert canonical.bathrooms == 3
        assert canonical.m2_built == Decimal(353)
        assert canonical.floor == "bajo"
        assert canonical.listing_kind == "agency"  # sellerType.isPrivate is False
        assert canonical.lat == Decimal("40.45765381")
        assert canonical.lon == Decimal("-3.65063234")
        assert canonical.address == "Madrid, Madrid"
        assert len(canonical.photo_urls) == 2
        assert canonical.photo_urls[0].startswith("https://")
        assert canonical.raw_extra["origin"]["provider"] == "fotocasa_pro"

    def test_normalize_infers_particular_from_explicit_boolean(self):
        """Unlike Fotocasa, Milanuncios publishes sellerType.isPrivate directly
        — no URL/name heuristic needed (see milanuncios_mapping.py)."""
        html = _read_fixture("milanuncios_sample_detail_private_with_phone.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000099", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.listing_kind == "particular"

    def test_normalize_captures_full_description_including_embedded_phone(self):
        """Private-seller listings often embed a real phone number in free
        text (confirmed live: 4/17 sampled listings during the feasibility
        spike) — normalize() must not truncate description, since task 2.2's
        dedup phone-extraction signal depends on the full text being there."""
        html = _read_fixture("milanuncios_sample_detail_private_with_phone.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000099", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert "685451010" in (canonical.description or "")

    def test_normalize_uses_raw_numeric_value_not_formatted_string_for_m2(self):
        """Regression test for a real bug found during implementation:
        attribute_value() prefers valueFormatted ("353 m2"), which Decimal()
        can't parse — m2_built silently came back None. Fixed by adding
        attribute_numeric_value() for numeric fields. See
        etl/connectors/milanuncios_mapping.py."""
        html = _read_fixture("milanuncios_sample_detail.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000001", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.m2_built is not None
        assert canonical.m2_built == Decimal(353)


class TestPriceChangeHistory:
    def test_price_change_between_fetches_produces_different_canonical_prices(self):
        """EC (connector half, mirroring task 1.4's equivalent test): two
        fetches of the same external_id with a changed price normalize to
        two different current_price values — the orchestrator (already
        tested against real Postgres in test_orchestrator.py using
        DummyConnector) is what turns that into an appended
        listing_price_history row."""
        connector = MilanunciosConnector()
        html_before = _read_fixture("milanuncios_sample_detail.html")
        html_after = _read_fixture("milanuncios_sample_detail_price_changed.html")

        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html_before),
        ):
            price_before = connector.normalize(
                connector.fetch_detail("700000001", throttle=lambda: None)
            ).current_price
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html_after),
        ):
            price_after = connector.normalize(
                connector.fetch_detail("700000001", throttle=lambda: None)
            ).current_price

        assert price_before == Decimal(1683000)
        assert price_after == Decimal(1650000)
        assert price_before != price_after
