"""Escogecasa connector tests (issue #135).

Fixtures are trimmed from real pages captured live 2026-08-05 (Abanca REO
portal on escogecasa.es — the .com the issue named is a dead domain),
including the "inmuebles similares" neighbour card that is load-bearing for
the carousel-isolation regression (same class of bug PR #139/#141 hit on
Vivantial/Servihabitat). No test makes a network call: requests.Session is
monkeypatched.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.escogecasa import (
    EscogecasaConnector,
    extract_energy_rating,
    markers_from_search,
)
from etl.connectors.escogecasa_mapping import (
    bbox_from_center,
    is_residential,
    map_property_type,
    parse_es_price,
    parse_es_surface,
)
from etl.orchestrator import _upsert_canonical_listing

FIXTURES = Path(__file__).parent / "fixtures"
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

SUBJECT_ID = "detalle-piso-en-venta-en-teis-en-pontevedra/5250485/50905"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


class _R:
    def __init__(self, text: str) -> None:
        self.text = text

    def raise_for_status(self) -> None:
        return None


class _FakeSession:
    """A requests.Session stand-in returning a fixed body for get/post."""

    def __init__(self, text: str) -> None:
        self._text = text

    def get(self, *a, **k):
        return _R(self._text)

    def post(self, *a, **k):
        return _R(self._text)


def _session_factory(text: str):
    def _make():
        return _FakeSession(text)

    return _make


def _discover(scope: ConnectorScope) -> tuple[EscogecasaConnector, list[str]]:
    connector = EscogecasaConnector()
    with patch(
        "etl.connectors.escogecasa.requests.Session",
        side_effect=_session_factory(_read("escogecasa_sample_search.html")),
    ):
        ids = connector.discover(scope, throttle=lambda: None)
    return connector, ids


def _normalize_full():
    """discover() (stashes the createMarker coords/price) then fetch_detail()."""
    connector, _ = _discover(ConnectorScope(geography="42.24,-8.72,30"))
    with patch(
        "etl.connectors.escogecasa.requests.Session",
        side_effect=_session_factory(_read("escogecasa_sample_detail.html")),
    ):
        raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
    return connector.normalize(raw)


def _normalize_detail_only(html: str | None = None):
    """fetch_detail() with no prior discover() — marker stash empty."""
    connector = EscogecasaConnector()
    body = html if html is not None else _read("escogecasa_sample_detail.html")
    with patch(
        "etl.connectors.escogecasa.requests.Session",
        side_effect=_session_factory(body),
    ):
        raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
    return connector.normalize(raw)


class TestMarkersFromSearch:
    def test_parses_all_three_markers(self):
        markers = markers_from_search(_read("escogecasa_sample_search.html"))
        assert len(markers) == 3
        subject = next(m for m in markers if m["id"] == "50905")
        assert subject["path"] == SUBJECT_ID
        assert subject["lat"] == "42.2380000000"
        assert subject["lon"] == "-8.7180000000"
        assert subject["subtipo"] == "Piso"
        assert subject["price"] == "205.000"
        assert subject["m2"] == "70,00"


class TestDiscover:
    def test_keeps_residential_drops_local(self):
        _connector, ids = _discover(ConnectorScope(geography="42.24,-8.72,30"))
        # Piso + Vivienda aislada kept; the Local dropped as non-residential.
        assert ids == sorted(
            [
                SUBJECT_ID,
                "detalle-vivienda-aislada-en-venta-en-marin-en-pontevedra/9313366/50996",
            ]
        )
        assert not any("local" in i for i in ids)

    def test_center_scope_resolves_via_gazetteer(self):
        # A real point near Vigo resolves through the shared gazetteer.
        _connector, ids = _discover(
            ConnectorScope(center=(42.2406, -8.7207), radius_km=25)
        )
        assert SUBJECT_ID in ids

    def test_unresolvable_scope_raises_rather_than_defaulting(self):
        connector = EscogecasaConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_broken_response_raises_not_empty(self):
        connector = EscogecasaConnector()
        with (
            patch(
                "etl.connectors.escogecasa.requests.Session",
                side_effect=_session_factory("<html>maintenance</html>"),
            ),
            pytest.raises(ConnectorError, match="did not look like the results loader"),
        ):
            connector.discover(
                ConnectorScope(geography="42.24,-8.72,30"), throttle=lambda: None
            )

    def test_legitimately_empty_box_returns_empty_not_raises(self):
        connector = EscogecasaConnector()
        empty_loader = (
            '<html><body onload="cargar_onload();"><script>'
            "function cargar_onload(){ parent.changeH1('x'); }"
            "</script></body></html>"
        )
        with patch(
            "etl.connectors.escogecasa.requests.Session",
            side_effect=_session_factory(empty_loader),
        ):
            ids = connector.discover(
                ConnectorScope(geography="43.0,-7.0,10"), throttle=lambda: None
            )
        assert ids == []


class TestLiveCaptureRegression:
    """Issue #378 flagged Escogecasa as under-fetching ("only 1 listing").

    Verified live 2026-08-06: discover()'s marker parse and pagination are
    NOT the problem — they return the whole marker set a bbox yields. A
    Madrid/Levante scope sees ~1-2 because Abanca's REO stock is concentrated
    in Galicia/the north (a Madrid 30 km box genuinely returned 2 markers, an
    A Coruna box 5, a wide Galicia box 48, all-Spain the ~100 cap). The low
    count is real sparsity, not a dropped-results bug.

    This guards that discover() returns EVERY residential marker on a real
    multi-listing response (the fresh A Coruna capture), so a future regression
    that silently drops markers is caught. See escogecasa.py's docstring."""

    _EXPECTED = sorted(
        [
            "detalle-piso-en-venta-en-a-coruna-en-a-coruna/1017637/50959",
            "detalle-piso-en-venta-en-a-coruna-en-a-coruna/9314155/50897",
            "detalle-piso-en-venta-en-ferrol-en-a-coruna/28234/51002",
            "detalle-vivienda-aislada-en-venta-en-a-capela-en-a-coruna/9310426/50286",
            "detalle-piso-en-venta-en-valdovino-en-a-coruna/9313373/50901",
        ]
    )

    def test_discover_returns_the_full_marker_set_not_one(self):
        connector = EscogecasaConnector()
        with patch(
            "etl.connectors.escogecasa.requests.Session",
            side_effect=_session_factory(_read("escogecasa_search_multi.html")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="43.36,-8.41,30"), throttle=lambda: None
            )
        assert ids == self._EXPECTED
        assert len(ids) == 5  # not 1 — the whole set for this box

    def test_discovered_prices_populate_for_every_marker(self):
        connector = EscogecasaConnector()
        with patch(
            "etl.connectors.escogecasa.requests.Session",
            side_effect=_session_factory(_read("escogecasa_search_multi.html")),
        ):
            connector.discover(
                ConnectorScope(geography="43.36,-8.41,30"), throttle=lambda: None
            )
        prices = connector.discovered_prices()
        assert len(prices) == 5
        assert prices[
            "detalle-piso-en-venta-en-a-coruna-en-a-coruna/1017637/50959"
        ] == Decimal(480000)


class TestNormalize:
    def test_matches_the_real_listing_values(self):
        n = _normalize_full()
        # Price/rooms/baths/surfaces come from the subject dato_* blocks, NOT
        # the search label (205.000) nor the carousel (999.000).
        assert n.current_price == Decimal(210000)
        assert n.rooms == 3
        assert n.bathrooms == 1
        assert n.m2_useful == Decimal(64)
        assert n.m2_built == Decimal(74)
        assert n.reference_code == "5250485"
        assert n.postal_code == "36207"
        assert n.address == "Travesía de Teis, 44"
        assert n.year_built == 1969
        assert n.energy_rating == "E"
        assert n.property_type == "piso"
        assert n.has_elevator is True
        assert "Ascensor" in n.features
        assert n.operation == "sale"
        assert n.listing_kind == "agency"
        assert n.status == "active"

    def test_coordinates_from_search_marker(self):
        """Escogecasa is the third REO connector in the batch to publish
        lat/lon — the detail page has none, they come from the createMarker
        payload stashed at discover() time."""
        n = _normalize_full()
        assert n.lat == Decimal("42.2380000000")
        assert n.lon == Decimal("-8.7180000000")

    def test_detail_only_has_no_coords_but_still_normalizes(self):
        """Fetched without a prior discover(): everything detail-sourced is
        present, coords (marker-only) are None — not a crash."""
        n = _normalize_detail_only()
        assert n.lat is None and n.lon is None
        assert n.current_price == Decimal(210000)
        assert n.reference_code == "5250485"

    def test_fields_this_site_does_not_publish_stay_none(self):
        n = _normalize_full()
        # No referencia catastral (like Diglo/Unicaja, unlike Solvia).
        assert n.cadastral_ref is None


class TestCarouselIsolation:
    """The bug this connector would otherwise have shipped.

    The detail page renders an "inmuebles similares" carousel whose cards use
    the UN-prefixed classes habs/bans/superficie/precio/referencia. The real
    subject is 210.000 €, 3 hab, 1 baño, ref 5250485; the neighbour card in
    the fixture reads 999.000 €, 5 hab, 4 baños, ref 9313513. Reading only the
    dato_-prefixed subject classes keeps the neighbour's figures out.
    """

    def test_subject_values_win_over_neighbour_card(self):
        html = _read("escogecasa_sample_detail.html")
        assert "999.000" in html and "9313513" in html, (
            "fixture must retain a neighbour card or this regression is retired"
        )
        n = _normalize_full()
        assert n.current_price == Decimal(210000), "read the neighbour's 999.000"
        assert n.rooms == 3, "read the neighbour's 5 habs"
        assert n.bathrooms == 1, "read the neighbour's 4 baños"
        assert n.reference_code == "5250485", "read the neighbour's ref"

    def test_photos_scoped_to_subject_internal_id(self):
        n = _normalize_full()
        assert n.photo_urls, "subject has photos"
        assert all("/50905_" in u for u in n.photo_urls)
        assert not any("/50973_" in u for u in n.photo_urls)


class TestFallbackChain:
    def test_price_falls_back_to_search_marker_when_detail_price_absent(self):
        """Strip the primary (detail dato_precio) and the price must still
        resolve from the search createMarker (205.000) — NOT the carousel."""
        import re

        html = _read("escogecasa_sample_detail.html")
        without_price = re.sub(
            r'<p class="dato_precio">.*?</p>', "", html, flags=re.DOTALL
        )
        connector, _ = _discover(ConnectorScope(geography="42.24,-8.72,30"))
        with patch(
            "etl.connectors.escogecasa.requests.Session",
            side_effect=_session_factory(without_price),
        ):
            raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
        n = connector.normalize(raw)
        assert n.current_price == Decimal(205000)

    def test_reference_falls_back_to_url_segment(self):
        import re

        html = _read("escogecasa_sample_detail.html")
        without_ref = re.sub(
            r'<p class="dato_referencia">.*?</p>', "", html, flags=re.DOTALL
        )
        n = _normalize_detail_only(without_ref)
        # Falls back to the path's second-to-last segment (the <refpublica>).
        assert n.reference_code == "5250485"


class TestScopeAndFlags:
    def test_discovers_full_inventory_is_false(self):
        # A single bbox is capped (~100 markers) and pag does not extend it.
        assert EscogecasaConnector.discovers_full_inventory is False

    def test_rate_limit_is_conservative(self):
        assert EscogecasaConnector.rate_limit_per_minute <= 12

    def test_scope_key_stable_for_geography(self):
        connector = EscogecasaConnector()
        key = connector.scope_key(ConnectorScope(geography="42.24,-8.72"))
        assert key == "escogecasa-geo:42.24,-8.72"
        assert connector.scope_key(ConnectorScope()) is None

    def test_scope_key_sentinel_for_unresolvable_center(self):
        connector = EscogecasaConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None and key.startswith("unresolvable-geography:")

    def test_discovered_prices_keyed_by_external_id(self):
        connector, _ = _discover(ConnectorScope(geography="42.24,-8.72,30"))
        prices = connector.discovered_prices()
        assert prices[SUBJECT_ID] == Decimal(205000)


class TestMapping:
    @pytest.mark.parametrize(
        "subtipo,expected",
        [
            ("Piso", "piso"),
            ("Piso dúplex", "piso"),
            ("Vivienda", "piso"),
            ("Vivienda aislada", "chalet"),
            ("Vivienda adosada", "chalet"),
            ("Vivienda pareada", "chalet"),
            ("Local", "local"),
            ("Nave", "nave"),
            ("Plaza de garaje", "garaje"),
            ("Parcela", "terreno"),
            (None, None),
        ],
    )
    def test_property_type_mapping(self, subtipo, expected):
        assert map_property_type(subtipo) == expected

    def test_residential(self):
        assert is_residential("Piso")
        assert is_residential("Vivienda aislada")
        assert not is_residential("Local")
        assert not is_residential(None)

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("80.000", "80000"),
            ("146.500 €", "146500"),
            ("1.250.000", "1250000"),
            (None, None),
        ],
    )
    def test_parse_es_price(self, text, expected):
        assert parse_es_price(text) == expected

    @pytest.mark.parametrize(
        "text,expected",
        [("69,38 m²", 69), ("753,54", 753), ("87,5", 87), ("74,77", 74), (None, None)],
    )
    def test_parse_es_surface(self, text, expected):
        assert parse_es_surface(text) == expected

    def test_bbox_from_center_brackets_the_point(self):
        lat_min, lat_max, lng_min, lng_max = bbox_from_center(42.24, -8.72, 30)
        assert lat_min < 42.24 < lat_max
        assert lng_min < -8.72 < lng_max
        # ~30km -> ~0.27deg latitude half-height.
        assert 0.2 < (lat_max - lat_min) / 2 < 0.35


class TestEnergyRating:
    def test_reads_grade_from_title_not_image_filename(self):
        """cer_G.jpg carries a title of "E" on the real page — the title
        letter is authoritative, the fixed-scale image filename is not."""
        assert extract_energy_rating(_read("escogecasa_sample_detail.html")) == "E"


class TestSchemaRoundTrip:
    """Real-Postgres round trip (skips when no DB; runs in CI)."""

    def test_normalized_listing_survives_the_schema(self, pg_conn):
        _apply_schema(pg_conn)
        n = _normalize_full()
        _upsert_canonical_listing(pg_conn, n)
        pg_conn.commit()
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT l.current_price, l.operation, p.postal_code "
                "FROM listing l JOIN property p ON l.property_id = p.id "
                "WHERE l.external_id = %s",
                (SUBJECT_ID,),
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == Decimal(210000)
        assert row[1] == "sale"
        assert row[2] == "36207"
