"""Fixture-based tests for HabitacliaConnector (issue #79).

No live network: discover() and fetch_detail() both monkeypatch
requests.get to return saved fixtures (a search page and a detail page).
normalize() runs against the trimmed/synthetic detail fixture (see its
header comment). The point pinned hardest here is the carousel-contamination
guard: the subject `.price` must be read, never the `.sim-price` neighbours.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope, ListingUnavailableError
from etl.connectors.habitaclia import HabitacliaConnector
from etl.connectors.habitaclia_mapping import (
    city_from_url,
    map_property_type,
    type_token_from_url,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_SAGRADA_ID = "4737003828090"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.habitaclia.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def _discover(connector: HabitacliaConnector, geography: str = "barcelona"):
    html = _read_fixture("habitaclia_sample_search.html")
    with patch(
        "etl.connectors.habitaclia.requests.get", return_value=_mock_response(html)
    ) as mock_get:
        ids = connector.discover(
            ConnectorScope(geography=geography), throttle=lambda: None
        )
    return ids, mock_get


def _normalize_sagrada(connector: HabitacliaConnector):
    _discover(connector)
    detail_html = _read_fixture("habitaclia_sample_detail.html")
    detail_url = (
        "https://www.habitaclia.com/comprar-piso-en_venta_en_sagrada_familia_"
        "sagrada_familia-barcelona-i4737003828090.htm"
    )
    with patch(
        "etl.connectors.habitaclia.requests.get",
        return_value=_mock_response(detail_html, url=detail_url),
    ):
        raw = connector.fetch_detail(_SAGRADA_ID, throttle=lambda: None)
    return connector.normalize(raw)


# ── identity / safety attributes ──────────────────────────────────────


def test_connector_name_is_habitaclia():
    assert HabitacliaConnector.name == "habitaclia"


def test_does_not_claim_full_inventory_coverage():
    assert HabitacliaConnector.discovers_full_inventory is False
    assert "discovers_full_inventory" in vars(HabitacliaConnector)


# ── discover ──────────────────────────────────────────────────────────


def test_discover_extracts_listing_ids_and_skips_non_listing_links():
    ids, _ = _discover(HabitacliaConnector())
    assert set(ids) == {
        "4737003828090",
        "4737003827563",
        "58991000001525",
    }
    # The "/comprar-viviendas-en-madrid.htm" nav link has no -i<id> suffix.
    assert ids == sorted(ids)


def test_discover_builds_bare_city_search_url():
    _, mock_get = _discover(HabitacliaConnector(), geography="madrid")
    assert mock_get.call_args[0][0] == "https://www.habitaclia.com/viviendas-madrid.htm"


def test_discover_raises_on_page_with_no_listing_links():
    connector = HabitacliaConnector()
    with (
        patch(
            "etl.connectors.habitaclia.requests.get",
            return_value=_mock_response("<html><body>blocked</body></html>"),
        ),
        pytest.raises(ConnectorError),
    ):
        connector.discover(ConnectorScope(geography="barcelona"), throttle=lambda: None)


def test_scope_key_resolves_geography_slug():
    assert (
        HabitacliaConnector().scope_key(ConnectorScope(geography="barcelona"))
        == "barcelona"
    )


# ── fetch_detail ──────────────────────────────────────────────────────


def test_fetch_detail_unknown_id_raises_listing_unavailable():
    connector = HabitacliaConnector()
    _discover(connector)
    with pytest.raises(ListingUnavailableError):
        connector.fetch_detail("000", throttle=lambda: None)


def test_fetch_detail_uses_stashed_detail_url():
    connector = HabitacliaConnector()
    _discover(connector)
    with patch(
        "etl.connectors.habitaclia.requests.get",
        return_value=_mock_response("<html></html>"),
    ) as mock_get:
        connector.fetch_detail(_SAGRADA_ID, throttle=lambda: None)
    called = mock_get.call_args[0][0]
    assert called.endswith("-i4737003828090.htm")
    assert called.startswith("https://www.habitaclia.com/comprar-")


# ── normalize: canonical field coverage + carousel scoping ────────────


def test_normalize_reads_subject_price_not_carousel():
    """The subject .price is 425.000 €; the .sim-price carousel is 397.000 /
    330.000 €. The connector must read the subject, never a neighbour — the
    contamination trap docs/skills/connectors.md documents."""
    canonical = _normalize_sagrada(HabitacliaConnector())
    assert canonical.current_price == Decimal(425000)


def test_normalize_full_field_coverage_including_latlon():
    canonical = _normalize_sagrada(HabitacliaConnector())
    assert canonical.source == "habitaclia"
    assert canonical.rooms == 1
    assert canonical.bathrooms == 1
    assert canonical.m2_built == Decimal(61)
    assert canonical.property_type == "piso"
    # lat/lon from the VGPSLat/VGPSLon StreetView config (no JSON-LD exists).
    assert canonical.lat == Decimal("41.4056000000")
    assert canonical.lon == Decimal("2.1825000000")
    assert canonical.reference_code == "VB2606024"
    assert canonical.city == "Barcelona"
    assert canonical.operation == "sale"
    assert canonical.status == "active"
    assert canonical.description and "PISO EXTERIOR" in canonical.description
    assert canonical.photo_urls and canonical.photo_urls[0].startswith("https://")


def test_normalize_does_not_fabricate_listing_kind():
    canonical = _normalize_sagrada(HabitacliaConnector())
    assert canonical.listing_kind is None


# ── mapping unit ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,expected",
    [
        ("/comprar-piso-en_venta_en_x-barcelona-i123.htm", "piso"),
        ("/comprar-atico-en_venta_en_y-barcelona-i456.htm", "atico"),
        ("/comprar-casa-en_venta_z-barcelona-i789.htm", "chalet"),
        ("/comprar-garaje-en_venta_z-madrid-i1.htm", "garaje"),
        ("/comprar-unknown-en_venta_z-madrid-i1.htm", None),
        (None, None),
    ],
)
def test_map_property_type_from_url(url, expected):
    assert map_property_type(url) == expected


def test_type_token_and_city_from_url():
    url = "/comprar-piso-en_venta_en_sagrada_familia-barcelona-i4737003828090.htm"
    assert type_token_from_url(url) == "piso"
    assert city_from_url(url) == "Barcelona"
