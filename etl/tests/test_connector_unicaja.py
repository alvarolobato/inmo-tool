"""Unicaja Inmuebles connector tests (issue #119).

Fixtures are trimmed from REAL pages captured live 2026-08-05, not
synthesised: `unicaja_sample_detail.html` is the detail page for ref
0017922090 ("ALTA, Teba"), and `unicaja_sample_search.html` is a
`listadoPromocion.do` results page whose cards include that SAME listing
(so the card→detail merge is exercised end-to-end on one real property)
plus a second residential card and a real non-residential (Garaje) card the
residential filter must drop. No test makes a network call: the HTTP layer
is monkeypatched.
"""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.unicaja import (
    UnicajaConnector,
    extract_coords,
)
from etl.connectors.unicaja_mapping import (
    is_refcode,
    is_residential,
    map_property_type,
    parse_es_price,
    parse_es_surface,
    parse_search_cards,
    province_to_ine_code,
)
from etl.orchestrator import _upsert_canonical_listing

FIXTURES = Path(__file__).parent / "fixtures"
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

SUBJECT_ID = "0017922090"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _mock_response(text: str):
    class _R:
        def __init__(self, t: str) -> None:
            self.text = t

        def raise_for_status(self) -> None:
            return None

    return _R(text)


def _page_sequence(*texts: str):
    """A requests.get side_effect that returns each page text in turn, then a
    terminating empty-but-valid results page for any further calls."""
    responses = [_mock_response(t) for t in texts]
    terminator = _mock_response('<html><div class="listadoInmuebles"></div></html>')

    def _side_effect(*_a, **_k):
        return responses.pop(0) if responses else terminator

    return _side_effect


def _discover_then_normalize(external_id: str = SUBJECT_ID):
    """Run the real discover() (so the card is stashed) then fetch/normalize
    the subject — the full merge path a live run takes."""
    connector = UnicajaConnector()
    with patch(
        "etl.connectors.unicaja.requests.get",
        side_effect=_page_sequence(_read("unicaja_sample_search.html")),
    ):
        connector.discover(ConnectorScope(geography="malaga"), throttle=lambda: None)
    with patch(
        "etl.connectors.unicaja.requests.get",
        return_value=_mock_response(_read("unicaja_sample_detail.html")),
    ):
        raw = connector.fetch_detail(external_id, throttle=lambda: None)
    return connector.normalize(raw)


class TestNormalize:
    def test_matches_the_real_listing_values(self):
        """Cross-checked against the live page/card for ref 0017922090."""
        n = _discover_then_normalize()
        assert n.current_price == Decimal(46500)
        assert n.reference_code == "0017922090"
        assert n.property_type == "chalet"  # site "Casa" -> canonical chalet
        assert n.operation == "sale"
        assert n.address == "ALTA , Teba"
        assert n.city == "Teba"
        assert n.province == "Málaga"
        # GIA/Unicaja selling bank-owned stock — never a private seller.
        # Load-bearing for issue #16's phone-corroboration rule.
        assert n.listing_kind == "agency"
        assert n.status == "active"

    def test_surface_split_built_and_useful(self):
        """Detail datos block: "171.14 m2" built, "148.81 m2" useful — note
        the site uses a DOT decimal for surfaces (unlike its price format)."""
        n = _discover_then_normalize()
        assert n.m2_built == Decimal(171)
        assert n.m2_useful == Decimal(148)

    def test_rooms_and_baths(self):
        n = _discover_then_normalize()
        assert n.rooms == 4
        assert n.bathrooms == 2

    def test_coordinates_from_server_injected_js(self):
        """Unicaja is the batch's second REO connector (after Diglo) to
        publish real lat/lon — enables issue #16's address_coords signal."""
        n = _discover_then_normalize()
        assert n.lat == Decimal("36.9833293")
        assert n.lon == Decimal("-4.9188665")

    def test_photos_are_full_size_and_deduplicated(self):
        """Thumbnails (_250x150, _42x32) collapse to their bare full-size URL
        and de-duplicate."""
        n = _discover_then_normalize()
        assert n.photo_urls
        assert all(u.startswith("https://unicajainmuebles.com/") for u in n.photo_urls)
        # No size-suffixed thumbnail survives.
        assert not any(re.search(r"_\d+x\d+\.(png|jpe?g)$", u) for u in n.photo_urls)
        assert len(n.photo_urls) == len(set(n.photo_urls))


class TestPostalCodeFromCard:
    """The postal code is on the search CARD, not the detail page — the merge
    is what recovers it. This is the reason discover() stashes card data."""

    def test_postal_comes_from_the_search_card(self):
        n = _discover_then_normalize()
        assert n.postal_code == "29327"

    def test_detail_page_alone_has_no_postal_code(self):
        """Without the card (a fetch of a listing discover() didn't surface),
        postal_code is honestly None — proving it isn't coming from the
        detail HTML."""
        connector = UnicajaConnector()
        with patch(
            "etl.connectors.unicaja.requests.get",
            return_value=_mock_response(_read("unicaja_sample_detail.html")),
        ):
            raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
        n = connector.normalize(raw)
        assert n.postal_code is None
        # City/province still resolve from the description boilerplate.
        assert n.city == "Teba"
        assert n.province == "Málaga"


class TestFieldsThisSiteDoesNotPublish:
    def test_no_cadastral_ref_or_energy_rating(self):
        """Asserted rather than left silent (issue #132 checklist): if the
        site starts publishing these, this fails and prompts an update."""
        n = _discover_then_normalize()
        assert n.cadastral_ref is None
        assert n.energy_rating is None


class TestFallbackChain:
    def test_price_falls_back_to_card_when_detail_price_absent(self):
        """Strip the detail page's own price block and the price must still
        resolve from the search card's price — proves the fallback is real."""
        connector = UnicajaConnector()
        with patch(
            "etl.connectors.unicaja.requests.get",
            side_effect=_page_sequence(_read("unicaja_sample_search.html")),
        ):
            connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        detail = _read("unicaja_sample_detail.html")
        without_price = re.sub(
            r'<div id="columnaprecio".*?</div>\s*</div>', "", detail, flags=re.DOTALL
        )
        with patch(
            "etl.connectors.unicaja.requests.get",
            return_value=_mock_response(without_price),
        ):
            raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
        n = connector.normalize(raw)
        # Card price for 0017922090 is 46.500,00 € -> 46500.
        assert n.current_price == Decimal(46500)

    def test_property_type_falls_back_to_card_tipo(self):
        """Remove the detail datos "Tipo" pair; the card's Tipo drives it."""
        connector = UnicajaConnector()
        with patch(
            "etl.connectors.unicaja.requests.get",
            side_effect=_page_sequence(_read("unicaja_sample_search.html")),
        ):
            connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        detail = _read("unicaja_sample_detail.html")
        without_tipo = re.sub(
            r'<span class="label">\s*Tipo\s*:?\s*</span>\s*'
            r'<span class="text">.*?</span>',
            "",
            detail,
            flags=re.DOTALL,
        )
        with patch(
            "etl.connectors.unicaja.requests.get",
            return_value=_mock_response(without_tipo),
        ):
            raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
        n = connector.normalize(raw)
        assert n.property_type == "chalet"


class TestDiscover:
    def test_keeps_residential_drops_non_residential(self):
        """The search fixture has a Casa, a Piso and a Garaje; only the two
        residential listings are returned, the garaje is filtered out."""
        connector = UnicajaConnector()
        with patch(
            "etl.connectors.unicaja.requests.get",
            side_effect=_page_sequence(_read("unicaja_sample_search.html")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        assert ids == ["0012837647", "0017922090"]
        assert "0037609409" not in ids  # the garaje

    def test_stashes_cards_for_the_kept_listings(self):
        connector = UnicajaConnector()
        with patch(
            "etl.connectors.unicaja.requests.get",
            side_effect=_page_sequence(_read("unicaja_sample_search.html")),
        ):
            connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        assert connector._cards["0017922090"]["postal_code"] == "29327"
        assert "0037609409" not in connector._cards  # non-residential not stashed

    def test_pagination_stops_on_a_short_page(self):
        """A single results page with <10 cards is the last page; discover
        must not fetch a second page (the terminator would raise if it did
        loop unbounded, but a short first page ends it cleanly)."""
        calls = {"n": 0}

        def _count(*_a, **_k):
            calls["n"] += 1
            if calls["n"] == 1:
                return _mock_response(_read("unicaja_sample_search.html"))
            return _mock_response('<html><div class="listadoInmuebles"></div></html>')

        connector = UnicajaConnector()
        with patch("etl.connectors.unicaja.requests.get", side_effect=_count):
            connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        assert calls["n"] == 1  # short first page => no second fetch

    def test_unresolvable_scope_raises_rather_than_defaulting(self):
        """Issue #71: no hardcoded province fallback."""
        connector = UnicajaConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_empty_province_returns_empty_not_raises(self):
        """A first page that looks like a results page but has no cards is a
        legitimately empty province, not an error."""
        connector = UnicajaConnector()
        empty = '<html><div class="contenedorlistadoInmuebles"></div></html>'
        with patch(
            "etl.connectors.unicaja.requests.get",
            return_value=_mock_response(empty),
        ):
            ids = connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )
        assert ids == []

    def test_non_results_page_raises_not_returns_empty(self):
        """discovers_full_inventory=True: a broken/changed search action
        (a page with no listing container and no cards) must raise, not
        silently report an empty catalogue."""
        connector = UnicajaConnector()
        with (
            patch(
                "etl.connectors.unicaja.requests.get",
                return_value=_mock_response("<html><body>Error</body></html>"),
            ),
            pytest.raises(ConnectorError, match="did not look like a results page"),
        ):
            connector.discover(
                ConnectorScope(geography="malaga"), throttle=lambda: None
            )


class TestScopeAndFlags:
    def test_discovers_full_inventory_is_true(self):
        assert UnicajaConnector.discovers_full_inventory is True

    def test_rate_limit_is_conservative(self):
        assert UnicajaConnector.rate_limit_per_minute <= 12

    def test_scope_key_is_the_resolved_province_code(self):
        connector = UnicajaConnector()
        assert (
            connector.scope_key(ConnectorScope(geography="Malaga")) == "unicaja-prov:29"
        )
        assert connector.scope_key(ConnectorScope()) is None

    def test_scope_key_uses_a_sentinel_for_an_unresolvable_center(self):
        connector = UnicajaConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_scope_key_resolves_a_town_to_its_province_code(self):
        """A center on a Málaga-province town resolves to the province code
        29 via the shared gazetteer."""
        connector = UnicajaConnector()
        estepona = ConnectorScope(center=(36.42764, -5.14589), radius_km=10)
        assert connector.scope_key(estepona) == "unicaja-prov:29"


class TestExtractors:
    def test_extract_coords_takes_the_real_quoted_pair(self):
        coords = extract_coords(_read("unicaja_sample_detail.html"))
        assert coords == (Decimal("36.9833293"), Decimal("-4.9188665"))

    def test_extract_coords_ignores_placeholder_zeros(self):
        """Only the unquoted `var coordX = 0` placeholders present -> no real
        geocode -> (None, None), not the origin."""
        html = "<script>var coordX = 0; var coordY = 0;</script>"
        assert extract_coords(html) == (None, None)

    def test_extract_coords_zero_quoted_pair_is_absent(self):
        html = "<script>var coordX = '0'; var coordY = '0';</script>"
        assert extract_coords(html) == (None, None)

    def test_parse_search_cards_reads_labelled_fields(self):
        cards = parse_search_cards(_read("unicaja_sample_search.html"))
        casa = cards["0017922090"]
        assert casa["postal_code"] == "29327"
        assert casa["property_type_raw"] == "Casa"
        assert casa["city"] == "Teba"
        assert casa["province"] == "Málaga"


class TestMapping:
    @pytest.mark.parametrize(
        "tipo,expected",
        [
            ("Piso", "piso"),
            ("Ático", "atico"),
            ("Casa", "chalet"),
            ("Chalet adosado", "chalet"),
            ("Estudio", "piso"),
            ("Local", "local"),
            ("Oficina", "local"),
            ("Garaje", "garaje"),
            ("Solar", "terreno"),
            ("Nave", "nave"),
            ("Edificio", "edificio"),
            ("Trastero", None),
        ],
    )
    def test_property_type_mapping(self, tipo, expected):
        assert map_property_type(tipo) == expected

    def test_residential_predicate(self):
        assert is_residential("Casa")
        assert is_residential("Piso")
        assert is_residential("Ático")
        assert not is_residential("Garaje")
        assert not is_residential("Solar")
        assert not is_residential(None)

    @pytest.mark.parametrize(
        "name,code",
        [
            ("Malaga", "29"),
            ("Málaga", "29"),
            ("MÁLAGA", "29"),  # the site's own upper-case label
            ("Alicante", "3"),
            ("Ciudad Real", "13"),
            # gazetteer forms that differ from the site's labels:
            ("Bizkaia", "48"),
            ("Coruna", "15"),
            ("Castello", "12"),
            ("Illes Balears", "7"),
            ("Gipuzkoa", "20"),
            ("Araba / Alava", "1"),
        ],
    )
    def test_province_to_ine_code(self, name, code):
        assert province_to_ine_code(name) == code

    def test_unknown_province_is_none(self):
        assert province_to_ine_code("Lisboa") is None
        assert province_to_ine_code(None) is None

    @pytest.mark.parametrize(
        "value,ok",
        [
            ("0017922090", True),
            ("0001234854", True),
            ("cualquiera", False),
            ("", False),
        ],
    )
    def test_is_refcode(self, value, ok):
        assert is_refcode(value) is ok

    def test_parse_es_price_thousands_and_decimals(self):
        assert parse_es_price("169.400,00 €") == "169400"
        assert parse_es_price("46.500,00") == "46500"
        assert parse_es_price("Compra*") is None

    def test_parse_es_surface_dot_decimal(self):
        assert parse_es_surface("53.23 m2") == 53
        assert parse_es_surface("171.14 m") == 171
        assert parse_es_surface("169.0m2") == 169
        assert parse_es_surface(None) is None


class TestSchemaRoundTrip:
    """Real-Postgres round trip (skips when no DB configured; runs in CI).

    Proves the normalized listing persists into property/listing without a
    CHECK/type violation — the class of bug a mocked-DB unit test misses
    (D-041 spirit)."""

    def test_normalized_listing_survives_the_schema(self, pg_conn):
        _apply_schema(pg_conn)
        n = _discover_then_normalize()
        _upsert_canonical_listing(pg_conn, n)
        pg_conn.commit()
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT current_price, operation, postal_code "
                "FROM listing l JOIN property p ON p.id = l.property_id "
                "WHERE l.external_id = %s",
                (SUBJECT_ID,),
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == Decimal(46500)
        assert row[1] == "sale"
        # Postal code came from the search card, not the detail page — prove
        # it survives the merge all the way into the property row.
        assert row[2] == "29327"
