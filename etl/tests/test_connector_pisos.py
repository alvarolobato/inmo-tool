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
import requests

from etl.connectors.base import ConnectorError, ConnectorScope, ListingUnavailableError
from etl.connectors.pisos import PisosConnector
from etl.connectors.pisos_mapping import map_property_type, type_token_from_url

_FIXTURES = Path(__file__).parent / "fixtures"
_MADRID_IDS = {"65098413759.100500", "61748204239.106400", "64250319294.280500"}

# A real profile scope far from Madrid/Barcelona — the Dos Hermanas (Sevilla)
# coordinate scope that regressed in issue #369: geography='', only a
# center/radius, which the connector must resolve to pisos.com's actual
# underscore slug ("dos_hermanas"), not the hyphen form ("dos-hermanas")
# that 404s live.
_DOS_HERMANAS_SCOPE = ConnectorScope(center=(37.283689, -5.9226718), radius_km=7.0)


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str) -> Mock:
    resp = Mock()
    resp.text = text
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


def test_discover_builds_underscore_slug_for_coordinate_scope_dos_hermanas():
    """Issue #369: a real profile scope (geography='', only center/radius)
    for Dos Hermanas/Sevilla must resolve to pisos.com's UNDERSCORE slug
    `pisos-dos_hermanas/`. The pre-fix hyphen slug `pisos-dos-hermanas/`
    404s live and failed the whole run."""
    connector = PisosConnector()
    html = _read_fixture("pisos_sample_search.html")
    with patch(
        "etl.connectors.pisos.requests.get", return_value=_mock_response(html)
    ) as mock_get:
        connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)
    called_url = mock_get.call_args[0][0]
    assert called_url == "https://www.pisos.com/venta/pisos-dos_hermanas/"


def test_scope_key_resolves_coordinate_scope_to_underscore_slug():
    assert PisosConnector().scope_key(_DOS_HERMANAS_SCOPE) == "dos_hermanas"


# ── issue #478 P5 (D-101): owner-pinned URL as recall source ───────────


def test_discover_uses_pinned_override_url_as_entry_page():
    """With supports_search_override=True and a scope carrying override_url,
    discover()'s request hits the pinned URL verbatim — the derived
    /venta/pisos-<slug>/ URL is bypassed entirely."""
    pinned = "https://www.pisos.com/venta/pisos-madrid/?zona=centro"
    html = _read_fixture("pisos_sample_search.html")
    with patch(
        "etl.connectors.pisos.requests.get", return_value=_mock_response(html)
    ) as mock_get:
        PisosConnector().discover(
            ConnectorScope(
                center=(40.4168, -3.7038), radius_km=10, override_url=pinned
            ),
            throttle=lambda: None,
        )
    assert mock_get.call_args[0][0] == pinned


def test_discover_without_override_is_byte_identical():
    """The retrofit's regression guard: no override → exactly the derived URL."""
    _, mock_get = _discover(PisosConnector(), geography="malaga")
    assert mock_get.call_args[0][0] == "https://www.pisos.com/venta/pisos-malaga/"


def test_scope_key_keys_off_override_url_when_pinned():
    connector = PisosConnector()
    pinned = "https://www.pisos.com/venta/pisos-madrid/?zona=centro"
    over = ConnectorScope(
        center=(37.283689, -5.9226718), radius_km=7.0, override_url=pinned
    )
    assert connector.scope_key(over) == f"override:{pinned}"
    # Distinct from the twin (would resolve to "dos_hermanas") — never deduped.
    assert connector.scope_key(over) != connector.scope_key(_DOS_HERMANAS_SCOPE)


def test_discover_returns_empty_uncovered_on_http_404():
    """Issue #369: a city pisos.com has no search page for (HTTP 404) is a
    clean 'uncovered' result — discover() returns [] so the run stays
    healthy, never marking the profile 'failed' for a portal that simply
    doesn't serve that geography. Safe: discovers_full_inventory=False."""
    connector = PisosConnector()
    with patch(
        "etl.connectors.pisos.requests.get",
        return_value=_http_error_response(404),
    ):
        ids = connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)
    assert ids == []


def test_discover_still_raises_on_non_404_http_error():
    """A 404 is uncovered; any other HTTP/transport error is still a genuine
    failure that must surface (fail-loud discipline preserved)."""
    connector = PisosConnector()
    with (
        patch(
            "etl.connectors.pisos.requests.get",
            return_value=_http_error_response(503),
        ),
        pytest.raises(ConnectorError),
    ):
        connector.discover(_DOS_HERMANAS_SCOPE, throttle=lambda: None)


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


# ── search URL grammar (issue #491) ───────────────────────────────────


def test_search_url_delegates_to_the_grammar():
    """_search_url() IS the grammar's build() — so the derived URL and the
    published grammar can never drift apart (issue #491)."""
    c = PisosConnector()
    assert c.search_url_grammar is not None
    for geo in ("madrid", "dos_hermanas", "hospitalet_de_llobregat"):
        assert c._search_url(geo) == c.search_url_grammar.build({"geography": geo})


def test_grammar_round_trip_and_rejects_foreign_urls():
    """parse(build(geo)) == {geography: geo} for a battery of real slugs
    (including a _SLUG_OVERRIDES target); a habitaclia URL is rejected."""
    from etl.tests.grammar_contract import assert_grammar_roundtrip

    c = PisosConnector()
    cases = [
        {"geography": "madrid"},
        {"geography": "dos_hermanas"},
        {"geography": "alcala_de_guadaira"},
        {"geography": "hospitalet_de_llobregat"},
    ]
    foreign = [
        "https://www.habitaclia.com/viviendas-dos_hermanas.htm",
        "https://www.pisos.com/comprar/piso-madrid-123/",
    ]
    assert_grammar_roundtrip(
        c.search_url_grammar,
        cases,
        foreign,
        build_real=lambda p: c._search_url(p["geography"]),
    )


def test_grammar_validates():
    from etl.connectors.base import validate_grammar

    validate_grammar(PisosConnector())  # no raise


def test_search_previews_carry_geography_and_operation_params():
    """The preview exposes the exact params discover() uses — geography (from the
    profile, in the URL) and operation=venta (a constant, in the URL). The
    profile's price/size/type filters are deliberately NOT present (issue #491
    ground truth: the orchestrator never sends them to the connector)."""
    c = PisosConnector()
    preview = c.search_previews(ConnectorScope(geography="dos_hermanas"))[0]
    by_key = {p.key: p for p in preview.params}
    assert set(by_key) == {"geography", "operation"}
    assert by_key["geography"].value == "dos_hermanas"
    assert by_key["geography"].source == "profile"
    assert by_key["geography"].in_url is True
    assert by_key["operation"].value == "venta"
    assert by_key["operation"].source == "constant"
    # No downstream-only filter leaked in as a param.
    assert not {"price_min", "price_max", "size_min", "property_types"} & set(by_key)


def test_unresolved_preview_has_no_params():
    """When the scope resolves to no geography, the degraded preview carries no
    params (nothing to show), matching url=None."""
    c = PisosConnector()
    # A scope with neither a center nor a geography string resolves to None.
    preview = c.search_previews(ConnectorScope())[0]
    assert preview.url is None
    assert preview.params == ()
