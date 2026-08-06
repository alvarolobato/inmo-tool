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
import requests

from etl.connectors.base import (
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    SoftBlockError,
)
from etl.connectors.habitaclia import HabitacliaConnector, _is_bot_interstitial
from etl.connectors.habitaclia_mapping import (
    city_from_url,
    map_property_type,
    type_token_from_url,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_SAGRADA_ID = "4737003828090"

# A real profile scope far from Madrid/Barcelona — the Dos Hermanas (Sevilla)
# coordinate scope that regressed in issue #369: geography='', only a
# center/radius. Before the fix habitaclia had no _CITY_SLUGS entry for it
# and skipped it as "uncovered" though `viviendas-dos_hermanas.htm` exists.
_DOS_HERMANAS_SCOPE = ConnectorScope(center=(37.283689, -5.9226718), radius_km=7.0)


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.habitaclia.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def _http_error_response(status_code: int) -> Mock:
    """A mock response whose raise_for_status() raises the HTTPError requests
    would for that status, carrying `.response.status_code` — what discover()
    inspects to treat a 404 as an uncovered (not failed) outcome."""
    resp = Mock()
    err = requests.HTTPError(f"{status_code} Client Error")
    err.response = Mock(status_code=status_code)
    resp.raise_for_status = Mock(side_effect=err)
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


def test_discover_builds_underscore_slug_for_coordinate_scope_dos_hermanas():
    """Issue #369: a real profile scope (geography='', only center/radius)
    for Dos Hermanas/Sevilla must resolve to habitaclia's UNDERSCORE slug
    `viviendas-dos_hermanas.htm` and actually crawl it — before the fix this
    city had no coverage-table entry and was skipped as 'uncovered'."""
    connector = HabitacliaConnector()
    html = _read_fixture("habitaclia_sample_search.html")
    with patch(
        "etl.connectors.habitaclia.requests.get", return_value=_mock_response(html)
    ) as mock_get:
        connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)
    assert (
        mock_get.call_args[0][0]
        == "https://www.habitaclia.com/viviendas-dos_hermanas.htm"
    )


def test_scope_key_resolves_coordinate_scope_to_underscore_slug():
    assert HabitacliaConnector().scope_key(_DOS_HERMANAS_SCOPE) == "dos_hermanas"


def test_discover_returns_empty_uncovered_on_http_404():
    """Issue #369: a city habitaclia has no search page for (HTTP 404) is a
    clean 'uncovered' result — discover() returns [] so the run stays
    healthy instead of a hard 'failed'. Safe: discovers_full_inventory=False."""
    connector = HabitacliaConnector()
    with patch(
        "etl.connectors.habitaclia.requests.get",
        return_value=_http_error_response(404),
    ):
        ids = connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)
    assert ids == []


def test_discover_still_raises_on_non_404_http_error():
    """A 404 is uncovered; any other HTTP/transport error is still a genuine
    failure that must surface (fail-loud discipline preserved)."""
    connector = HabitacliaConnector()
    with (
        patch(
            "etl.connectors.habitaclia.requests.get",
            return_value=_http_error_response(503),
        ),
        pytest.raises(ConnectorError),
    ):
        connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)


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


# ── live-capture regression (issue #378) ─────────────────────────────


_LIVE_ID = "24359000011808"
_LIVE_URL = (
    "https://www.habitaclia.com/comprar-piso-castellana-madrid-i24359000011808.htm"
)


def _normalize_live(connector: HabitacliaConnector):
    """Drive fetch_detail+normalize over the FRESH 2026-08-06 live detail
    capture (Madrid, Castellana)."""
    connector._detail_urls = {_LIVE_ID: _LIVE_URL}
    with patch(
        "etl.connectors.habitaclia.requests.get",
        return_value=_mock_response(
            _read_fixture("habitaclia_live_detail.html"), url=_LIVE_URL
        ),
    ):
        raw = connector.fetch_detail(_LIVE_ID, throttle=lambda: None)
    return connector.normalize(raw)


def test_live_capture_price_and_core_fields_populate():
    """The under-extraction #378 reported: on the live page price/m²/rooms all
    populate. (The remaining grade-F/unpriced listings were the bot
    interstitial being parsed — see the soft-block tests.)"""
    canonical = _normalize_live(HabitacliaConnector())
    assert canonical.current_price == Decimal(3025000)
    assert canonical.rooms == 4
    assert canonical.bathrooms == 5
    assert canonical.m2_built == Decimal(236)
    assert canonical.property_type == "piso"


def test_live_capture_coordinates_survive_unicode_escaped_quotes():
    """The live StreetView config unicode-escapes its quotes
    (VGPSLat":40.43…). The old regex could not cross the digit-bearing
    `0022` escape and lat/lon came back None on every real page (#378)."""
    canonical = _normalize_live(HabitacliaConnector())
    assert canonical.lat == Decimal("40.4351332000")
    assert canonical.lon == Decimal("-3.6842595000")


def test_live_capture_reference_keeps_slash_joined_servicer_code():
    """ "Referencia del anuncio habitaclia/CLK00/AM4816" — the `/`-joined
    servicer code must survive; the old char class truncated it to "CLK00"."""
    canonical = _normalize_live(HabitacliaConnector())
    assert canonical.reference_code == "CLK00/AM4816"


def test_live_capture_price_is_subject_not_sim_carousel():
    canonical = _normalize_live(HabitacliaConnector())
    # The fixture keeps a .sim-price neighbour at 2.300.000 €.
    assert canonical.current_price == Decimal(3025000)


# ── PerimeterX bot interstitial → soft block (issue #378) ─────────────


def test_bot_interstitial_is_detected():
    assert _is_bot_interstitial(_read_fixture("habitaclia_interruption.html"))
    assert not _is_bot_interstitial(_read_fixture("habitaclia_live_detail.html"))


def test_fetch_detail_soft_blocks_on_bot_interstitial():
    """An HTTP-200 'Pardon Our Interruption' page must raise SoftBlockError,
    NOT be normalized into a priceless grade-F listing (the batch's grade-F
    driver — issue #378)."""
    connector = HabitacliaConnector()
    connector._detail_urls["24359000011808"] = (
        "https://www.habitaclia.com/comprar-piso-castellana-madrid-i24359000011808.htm"
    )
    with (
        patch(
            "etl.connectors.habitaclia.requests.get",
            return_value=_mock_response(_read_fixture("habitaclia_interruption.html")),
        ),
        pytest.raises(SoftBlockError, match="Pardon Our Interruption"),
    ):
        connector.fetch_detail("24359000011808", throttle=lambda: None)


def test_discover_soft_blocks_on_bot_interstitial():
    connector = HabitacliaConnector()
    with (
        patch(
            "etl.connectors.habitaclia.requests.get",
            return_value=_mock_response(_read_fixture("habitaclia_interruption.html")),
        ),
        pytest.raises(SoftBlockError, match="Pardon Our Interruption"),
    ):
        connector.discover(ConnectorScope(geography="madrid"), throttle=lambda: None)


def test_soft_block_error_rate_is_set_for_transient_perimeterx():
    assert HabitacliaConnector.circuit_breaker_soft_block_error_rate == 0.75


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
