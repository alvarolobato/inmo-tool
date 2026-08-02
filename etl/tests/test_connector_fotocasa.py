"""Fixture-based tests for the Fotocasa connector (issue #12, Phase 1.4).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, so this suite
doesn't depend on network access and won't break the moment Fotocasa
changes its markup (only the fixtures + the parsing code need updating
together, deliberately, not silently via a flaky live test).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

from etl.connectors.base import ConnectorScope, RawListing
from etl.connectors.fotocasa import FotocasaConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.fotocasa.es/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


class TestDiscover:
    def test_discover_finds_unique_external_ids_from_search_page(self):
        html = _read_fixture("fotocasa_sample_search.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # Three distinct listings in the fixture; one linked twice (main
        # card + similar-listings widget) and one gallery-thumbnail href
        # with a query string that must NOT match (see fixture comments).
        assert sorted(ids) == ["190011971", "190022222", "190033333"]


class TestNormalize:
    def test_normalize_matches_expected_fixture(self):
        """EC-3: fetch_detail + normalize on a saved fixture produce the exact expected output."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.external_id == "190011971"
        assert canonical.source == "fotocasa"
        assert canonical.current_price == Decimal(205000)
        assert canonical.property_type == "piso"
        assert canonical.rooms == 3
        assert canonical.bathrooms == 1
        assert canonical.m2_built == Decimal(74)
        assert canonical.floor == "3"
        assert canonical.energy_rating == "G"
        assert canonical.lat == Decimal("40.382233")
        assert canonical.lon == Decimal("-3.6102757")
        assert canonical.listing_kind == "agency"  # clientUrl contains /inmobiliaria-
        assert canonical.address == "Santa Eugenia, Villa de Vallecas, Madrid Capital"
        assert len(canonical.photo_urls) == 2
        assert canonical.raw_extra["buildingType_raw"] == "Flat"

    def test_normalize_infers_particular_when_no_agency_signal(self):
        raw = RawListing(
            external_id="999",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Juan Perez",
                        "clientUrl": None,
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.listing_kind == "particular"

    def test_normalize_does_not_fabricate_year_built_from_antiquity_bucket(self):
        """antiquity is a coded bucket, not a literal year — must stay None, not guessed."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.year_built is None
        assert canonical.raw_extra["antiquity"] == 7


class TestPriceChangeHistory:
    def test_price_change_between_fetches_produces_different_canonical_prices(self):
        """EC-4 (connector half): two fetches of the same external_id with a
        changed price normalize to two different current_price values — the
        orchestrator (tested separately in test_orchestrator.py against real
        Postgres) is what turns that into an appended listing_price_history
        row rather than an overwrite; this test only proves the connector
        surfaces the real change for the orchestrator to act on.
        """
        connector = FotocasaConnector()
        html_before = _read_fixture("fotocasa_sample_detail.html")
        html_after = _read_fixture("fotocasa_sample_detail_price_changed.html")

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_before),
        ):
            price_before = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price
        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_after),
        ):
            price_after = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price

        assert price_before == Decimal(205000)
        assert price_after == Decimal(195000)
        assert price_before != price_after
