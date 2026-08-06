"""Fixture-based tests for PisosConnector (issue #79).

No live network: discover() is exercised by monkeypatching requests.get to
return the saved search fixture, and fetch_detail()/normalize() run purely
off the record discover() stashes (no network at all — the search-payload
path this connector shares with FotocasaRentalConnector). The fixture is a
trimmed/synthetic reconstruction of a real pisos.com search page (see its
header comment).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope, ListingUnavailableError
from etl.connectors.pisos import PisosConnector
from etl.connectors.pisos_mapping import map_property_type, type_token_from_url

_FIXTURES = Path(__file__).parent / "fixtures"
_MADRID_IDS = {"65098413759.100500", "61748204239.106400", "64250319294.280500"}


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str) -> Mock:
    resp = Mock()
    resp.text = text
    resp.raise_for_status = Mock()
    return resp


def _discover(connector: PisosConnector, geography: str = "madrid"):
    html = _read_fixture("pisos_sample_search.html")
    with patch(
        "etl.connectors.pisos.requests.get", return_value=_mock_response(html)
    ) as mock_get:
        ids = connector.discover(
            ConnectorScope(geography=geography), throttle=lambda: None
        )
    return ids, mock_get


def _normalize_one(connector: PisosConnector, external_id: str):
    _discover(connector)
    raw = connector.fetch_detail(external_id, throttle=lambda: None)
    return connector.normalize(raw)


# ── identity / safety attributes ──────────────────────────────────────


def test_connector_name_is_pisos():
    assert PisosConnector.name == "pisos"


def test_does_not_claim_full_inventory_coverage():
    assert PisosConnector.discovers_full_inventory is False
    assert "discovers_full_inventory" in vars(PisosConnector)


def test_advertises_no_unverified_filters():
    assert PisosConnector.supported_filters == ()


# ── discover ──────────────────────────────────────────────────────────


def test_discover_returns_sorted_card_ids():
    ids, _ = _discover(PisosConnector())
    assert set(ids) == _MADRID_IDS
    assert ids == sorted(ids)


def test_discover_builds_bare_city_search_url():
    _, mock_get = _discover(PisosConnector(), geography="malaga")
    called_url = mock_get.call_args[0][0]
    assert called_url == "https://www.pisos.com/venta/pisos-malaga/"


def test_discover_raises_on_empty_page_rather_than_returning_empty():
    """A guarded discover(): an HTTP 200 with zero ad-preview cards is a
    markup change or a block page, not 'no listings' — it must RAISE so an
    empty result can't be misread as mass withdrawal."""
    connector = PisosConnector()
    with (
        patch(
            "etl.connectors.pisos.requests.get",
            return_value=_mock_response("<html><body>no cards here</body></html>"),
        ),
        pytest.raises(ConnectorError),
    ):
        connector.discover(ConnectorScope(geography="madrid"), throttle=lambda: None)


def test_discover_raises_when_geography_unresolvable():
    connector = PisosConnector()
    # A center far from any pisos.com slug the connector covers resolves to
    # None → discover() (called directly, bypassing scope_key) raises.
    with pytest.raises(ConnectorError):
        connector.discover(
            ConnectorScope(center=(0.0, 0.0), radius_km=1.0), throttle=lambda: None
        )


def test_scope_key_resolves_geography_slug():
    assert PisosConnector().scope_key(ConnectorScope(geography="madrid")) == "madrid"


def test_discovered_prices_populated_from_search_cards():
    connector = PisosConnector()
    _discover(connector)
    prices = connector.discovered_prices()
    assert prices["65098413759.100500"] == Decimal(1600000)
    assert prices["61748204239.106400"] == Decimal(460000)


# ── fetch_detail: no network, served from the discover() stash ─────────


def test_fetch_detail_makes_no_network_call():
    connector = PisosConnector()
    _discover(connector)
    with patch("etl.connectors.pisos.requests.get") as mock_get:
        raw = connector.fetch_detail("65098413759.100500", throttle=lambda: None)
    mock_get.assert_not_called()
    assert raw.external_id == "65098413759.100500"


def test_fetch_detail_unknown_id_raises_listing_unavailable():
    connector = PisosConnector()
    _discover(connector)
    with pytest.raises(ListingUnavailableError):
        connector.fetch_detail("999.999", throttle=lambda: None)


# ── normalize: canonical field coverage ───────────────────────────────


def test_normalize_full_field_coverage_including_latlon():
    canonical = _normalize_one(PisosConnector(), "65098413759.100500")
    assert canonical.source == "pisos"
    assert canonical.current_price == Decimal(1600000)
    assert canonical.rooms == 3
    assert canonical.bathrooms == 3
    assert canonical.m2_built == Decimal(155)
    assert canonical.floor == "4ª planta"
    assert canonical.property_type == "piso"
    # lat/lon — the platform-critical fields — come from the per-card JSON-LD.
    assert canonical.lat == Decimal("40.4325")
    assert canonical.lon == Decimal("-3.71735")
    assert canonical.city == "Madrid Capital"
    assert canonical.province == "Madrid"
    assert canonical.operation == "sale"
    assert canonical.status == "active"
    assert canonical.url == (
        "https://www.pisos.com/comprar/piso-gaztambide-65098413759_100500/"
    )
    assert canonical.photo_urls  # at least one photo


def test_normalize_maps_type_from_url_slug_token():
    canonical = _normalize_one(PisosConnector(), "61748204239.106400")
    assert canonical.property_type == "piso"  # duplex → piso
    canonical2 = _normalize_one(PisosConnector(), "64250319294.280500")
    assert canonical2.property_type == "chalet"  # casa_adosada → chalet


def test_normalize_does_not_fabricate_listing_kind():
    """No live-confirmed particular/agency signal on the card → listing_kind
    stays None rather than guessed from the logo presence."""
    canonical = _normalize_one(PisosConnector(), "65098413759.100500")
    assert canonical.listing_kind is None


def test_card_without_all_chars_still_normalizes():
    """The Pozuelo card has no floor char — floor must be None, not an error."""
    canonical = _normalize_one(PisosConnector(), "64250319294.280500")
    assert canonical.rooms == 6
    assert canonical.bathrooms == 5
    assert canonical.m2_built == Decimal(298)
    assert canonical.floor is None


# ── mapping unit ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,expected",
    [
        ("/comprar/piso-gaztambide-65098413759_100500/", "piso"),
        ("/comprar/duplex-foo-1_2/", "piso"),
        ("/comprar/casa_adosada-bar-3_4/", "chalet"),
        ("/comprar/atico-baz-5_6/", "atico"),
        ("/comprar/garaje-qux-7_8/", "garaje"),
        ("/comprar/unknown_type-x-9_0/", None),
        (None, None),
    ],
)
def test_map_property_type_from_url(url, expected):
    assert map_property_type(url) == expected


def test_type_token_from_url_handles_absolute_url():
    assert type_token_from_url("https://www.pisos.com/comprar/atico-x-1_2/") == "atico"
