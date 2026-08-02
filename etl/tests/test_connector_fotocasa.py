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

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
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

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        """PR #49 review finding: Fotocasa's interruption page returns HTTP
        200 with no __initial_props__ tag — discover() must raise, not
        return []. An empty list would be misread by the orchestrator's
        withdrawal reconciliation as "every listing just disappeared"."""
        html = _read_fixture("fotocasa_sample_block_page.html")
        connector = FotocasaConnector()
        with (
            patch(
                "etl.connectors.fotocasa.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__initial_props__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

    def test_discover_rejects_robots_txt_disallowed_bare_geography(self):
        """robots.txt disallows the literal "/madrid/" path segment (not the
        hyphenated "madrid-capital" this connector's default uses) — a
        caller passing the bare city name must be rejected before any
        request is made, not silently sent."""
        connector = FotocasaConnector()
        with (
            patch("etl.connectors.fotocasa.requests.get") as mock_get,
            pytest.raises(ConnectorError, match="robots.txt"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        mock_get.assert_not_called()


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
        # Human-readable value from featuresList, NOT the coded
        # features.floor=3 integer (that would be fabricated precision —
        # see docs/skills/connectors.md and the fixture's own comment).
        assert canonical.floor == "2ª planta"
        assert canonical.has_elevator is True
        assert canonical.energy_rating == "G"
        assert canonical.raw_extra["floor_code_raw"] == 3
        assert canonical.lat == Decimal("40.382233")
        assert canonical.lon == Decimal("-3.6102757")
        assert canonical.listing_kind == "agency"  # clientUrl contains /inmobiliaria-
        assert canonical.address == "Santa Eugenia, Villa de Vallecas, Madrid Capital"
        assert len(canonical.photo_urls) == 2
        assert canonical.raw_extra["buildingType_raw"] == "Flat"

    def test_normalize_leaves_listing_kind_none_without_a_positive_agency_signal(self):
        """PR #49 review finding: defaulting to 'particular' whenever a name/
        URL exists at all (but neither agency signal matched) was itself an
        unverified guess. Absence of an agency signal must yield None, not
        an inferred 'particular'."""
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
        assert canonical.listing_kind is None

    def test_normalize_still_infers_agency_from_client_url(self):
        raw = RawListing(
            external_id="998",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Some Agency SL",
                        "clientUrl": "/es/inmobiliaria-some-agency/comprar/l",
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
        assert canonical.listing_kind == "agency"

    def test_normalize_has_elevator_none_when_featuresList_lacks_the_label(self):
        raw = RawListing(
            external_id="997",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "featuresList": [{"label": "floor", "value": "Bajo"}],
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.has_elevator is None
        assert canonical.floor == "Bajo"

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
