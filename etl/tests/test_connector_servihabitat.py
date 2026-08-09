"""Servihabitat connector tests (issue #115).

Fixtures are trimmed from a real page/sitemap captured 2026-08-02, not
synthesised — including the "similar listings" neighbour card, which is
load-bearing for the regression in TestNeighbourCardIsolation.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from bs4 import BeautifulSoup

from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
from etl.connectors.extraction import scoped_text
from etl.connectors.geography import UnresolvableGeographyError
from etl.connectors.servihabitat import (
    _SIMILAR_LISTING_SELECTORS,
    ServihabitatConnector,
    _equipamiento,
    _extract_product_json_ld,
    _open_graph,
    _referencia_attr,
    _strip_similar_listings,
    parse_listing_path,
)
from etl.connectors.servihabitat_mapping import (
    is_residential,
    map_property_type,
    parse_location_slug,
)
from etl.orchestrator import _upsert_canonical_listing

FIXTURES = Path(__file__).parent / "fixtures"
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


SUBJECT_ID = (
    "es/venta/vivienda/madrid-areametropolitanamadrid-madtetuan_cuatrocaminos/60645658"
)


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str):
    class _R:
        def __init__(self, t: str) -> None:
            self.text = t

        def raise_for_status(self) -> None:
            return None

    return _R(text)


def _normalize_fixture(html: str, external_id: str = SUBJECT_ID):
    soup = BeautifulSoup(html, "html.parser")
    _strip_similar_listings(soup)
    features_section = soup.find(id="product_features")
    raw = RawListing(
        external_id=external_id,
        source="servihabitat",
        raw={
            "url": f"https://www.servihabitat.com/{external_id}",
            "html": html,
            "json_ld": _extract_product_json_ld(html),
            "path_parts": parse_listing_path(external_id),
            "og": _open_graph(soup),
            "referencia": _referencia_attr(soup),
            "features_text": (
                features_section.get_text(" ", strip=True) if features_section else None
            ),
            "equipamiento": _equipamiento(features_section),
            "text": soup.get_text(" ", strip=True),
        },
    )
    return ServihabitatConnector().normalize(raw)


class TestNormalize:
    def test_matches_the_real_listing_values(self):
        """Values cross-checked against the live page for ref 60645658."""
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.reference_code == "60645658"
        assert n.m2_built == Decimal(80)
        assert n.current_price == Decimal(230000)
        assert n.property_type == "piso"
        assert n.city == "madtetuan_cuatrocaminos"
        assert n.province == "madrid"
        assert n.operation == "sale"
        # Servicer selling bank-owned stock — never a private seller. This is
        # load-bearing for issue #16's phone-corroboration rule, which never
        # auto-merges when either side is an agency.
        assert n.listing_kind == "agency"

    def test_equipamiento_becomes_feature_slugs(self):
        """features must be short tokens for the GIN/containment convention
        in data-model.md, not the page's descriptive text."""
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.features == ("alarma",)

    def test_subject_characteristics_are_read_from_the_features_block(self):
        """Positive cases for the three fields the scoping exists to protect.

        The neighbour card deliberately carries *different* values (3 hab.,
        2 banos, energy A) so this fails if scoping ever regresses to a
        whole-page scan that happens to hit the carousel first.
        """
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.rooms == 2
        assert n.bathrooms == 1
        assert n.energy_rating == "E"

    def test_features_text_excludes_the_neighbour_cards_values(self):
        """Asserts the mechanism, not just the outcome.

        Value assertions alone can pass by accident when the subject happens
        to appear first in document order; this checks the scoped text
        genuinely does not contain the neighbour's figures at all.
        """
        html = _read("servihabitat_sample_detail.html")
        soup = BeautifulSoup(html, "html.parser")
        features = scoped_text(
            soup, keep="#product_features", drop=_SIMILAR_LISTING_SELECTORS
        )
        assert features is not None
        for neighbour_value in ("190.000", "48m", "3 hab", "2 baños"):
            assert neighbour_value not in features

    def test_fields_this_site_does_not_publish_stay_none(self):
        """Asserted rather than left silent (issue #132 checklist): if the
        site ever starts publishing these, this test fails and prompts a
        connector update.

        No lat/lon means issue #16's `address_coords` dedup signal can never
        fire for Servihabitat listings — dedup here leans on the reference
        code (#72) and fuzzy matching instead.
        """
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.lat is None
        assert n.lon is None
        assert n.postal_code is None
        # No `referencia catastral` — unlike Solvia (#116), which does publish
        # one and thereby gave issue #1 §6's strongest dedup signal a source.
        assert "cadastral" not in (n.raw_extra or {})


class TestNeighbourCardIsolation:
    """The bug this connector would otherwise have shipped.

    A Servihabitat detail page renders a "inmuebles similares" carousel whose
    cards carry their own price/m2/rooms/baths. The real page for ref
    60645658 (80 m2, 230.000 EUR) contains a neighbour card reading
    "48m 2 2 hab. 1 baño ... 190.000 €". An unscoped regex over page text
    reads the neighbour's figures — the same class of bug PR #139 hit on
    Vivantial.
    """

    def test_subject_values_win_over_the_neighbour_card(self):
        html = _read("servihabitat_sample_detail.html")
        assert "190.000" in html and "48m" in html, (
            "fixture must retain a neighbour card or this regression is retired"
        )
        n = _normalize_fixture(html)
        assert n.m2_built == Decimal(80), "read the neighbour card's 48 m2"
        assert n.current_price == Decimal(230000), "read the neighbour's price"

    def test_strip_removes_the_carousel(self):
        soup = BeautifulSoup(_read("servihabitat_sample_detail.html"), "html.parser")
        assert soup.find(attrs={"class": "container-similares"}) is not None
        _strip_similar_listings(soup)
        assert soup.find(attrs={"class": "container-similares"}) is None
        assert "190.000" not in soup.get_text(" ", strip=True)


class TestFallbackChain:
    def test_price_falls_back_to_page_text_when_json_ld_is_absent(self):
        """Proves the fallback is real, not dead code: strip the primary
        (JSON-LD) source and the value must still resolve from page text."""
        import re

        html = _read("servihabitat_sample_detail.html")
        without_ld = re.sub(
            r"<script[^>]*application/ld\+json[^>]*>.*?</script>",
            "",
            html,
            flags=re.DOTALL,
        )
        assert _extract_product_json_ld(without_ld) is None
        n = _normalize_fixture(without_ld)
        assert n.m2_built == Decimal(80)
        # Positive assertion, not `!= 190000`. The old form passed vacuously:
        # the fallback actually returned None (no subject price existed in the
        # page body at all), and None != 190000 is trivially true, so a dead
        # fallback looked healthy (Opus review, PR #141). The fixture now
        # carries the subject's own "230.000 €" inside #product_features.
        assert n.current_price == Decimal(230000)


class TestDiscover:
    def test_filters_sitemap_to_residential_only(self):
        connector = ServihabitatConnector()
        with patch(
            "etl.connectors.servihabitat.requests.get",
            return_value=_mock_response(_read("servihabitat_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        # 3 residential (vivienda, promociones/vivienda, vivienda-casa);
        # garaje/local/terreno dropped — the portfolio is garage-heavy and
        # would otherwise swamp every candidate list with parking spaces.
        assert len(ids) == 3
        assert all("/vivienda" in i for i in ids)
        assert not any("garaje" in i or "local" in i or "terreno" in i for i in ids)

    def test_external_id_is_the_path_not_the_bare_id(self):
        """There is no id-only canonical URL (both /es/venta/vivienda/x/<id>
        and /es/inmueble/<id> 404 live), so fetch_detail cannot rebuild a URL
        from the numeric id alone."""
        connector = ServihabitatConnector()
        with patch(
            "etl.connectors.servihabitat.requests.get",
            return_value=_mock_response(_read("servihabitat_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert SUBJECT_ID in ids

    def test_unresolvable_scope_raises_rather_than_defaulting(self):
        """Issue #71: no hardcoded province fallback."""
        connector = ServihabitatConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_unresolvable_center_raises_a_distinct_error_not_empty(self):
        """Issue #169: a real center point that matches no known place in
        the shared gazetteer at all must raise UnresolvableGeographyError
        (a ConnectorError subclass) — distinct from the "no geography info
        at all" case above, and never silently absorbed into an empty
        discover() result."""
        connector = ServihabitatConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        with (
            patch("etl.connectors.servihabitat.requests.get") as mock_get,
            pytest.raises(UnresolvableGeographyError),
        ):
            connector.discover(far, throttle=lambda: None)
        mock_get.assert_not_called()

    def test_uses_pinned_override_url_as_sitemap_entry(self):
        """Issue #513: a scope carrying override_url makes discover() fetch the
        pinned province-sitemap URL verbatim, bypassing the derived one. Only a
        sitemap URL round-trips the grammar (faceted search is rejected at save
        time), so the same residential filtering still applies."""
        pinned = (
            "https://www.servihabitat.com/es/sitemap/comprar/vivienda/barcelona.xml"
        )
        connector = ServihabitatConnector()
        with patch(
            "etl.connectors.servihabitat.requests.get",
            return_value=_mock_response(_read("servihabitat_sample_sitemap.xml")),
        ) as mock_get:
            ids = connector.discover(
                ConnectorScope(
                    center=(40.4168, -3.7038), radius_km=10, override_url=pinned
                ),
                throttle=lambda: None,
            )
        assert mock_get.call_args.args[0] == pinned
        assert len(ids) == 3
        assert all("/vivienda" in i for i in ids)

    def test_declares_search_override_consumption(self):
        assert ServihabitatConnector.supports_search_override is True


class TestScopeAndFlags:
    def test_discovers_full_inventory_is_false(self):
        """Sitemap completeness is unverifiable here — every faceted-search
        query param is robots.txt-disallowed, so there is no compliant way to
        cross-check the sitemap count against a search total. Under-claiming
        avoids the orchestrator mass-marking listings `withdrawn`."""
        assert ServihabitatConnector.discovers_full_inventory is False

    def test_rate_limit_is_conservative(self):
        """robots.txt carries `User-agent: Scrapy / Disallow: /` — a clear
        anti-automation posture even though the `*` group permits us."""
        assert ServihabitatConnector.rate_limit_per_minute <= 12

    def test_scope_key_is_the_resolved_province(self):
        connector = ServihabitatConnector()
        assert connector.scope_key(ConnectorScope(geography="madrid")) == "madrid"
        assert connector.scope_key(ConnectorScope()) is None

    def test_scope_key_uses_a_sentinel_for_an_unresolvable_center(self):
        """scope_key() must never raise itself (the orchestrator calls it
        with no try/except) — an unresolvable center must still surface as
        a distinct, non-None key so discover() gets called and raises
        there (issue #169)."""
        connector = ServihabitatConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_scope_key_uses_province_not_city_for_a_non_capital_town(self):
        """Issue #169 fix: this table used to be keyed by city name, which
        coincidentally equalled province name for the original four
        (Madrid/Sevilla/Barcelona/Valencia are all provincial capitals). A
        scope centered on a non-capital town in a covered province (e.g.
        Estepona, Malaga province) must resolve via its PROVINCE, not fail
        just because "estepona" isn't a dict key."""
        connector = ServihabitatConnector()
        estepona = ConnectorScope(center=(36.42764, -5.14589), radius_km=10)
        assert connector.scope_key(estepona) == "malaga"


class TestMapping:
    @pytest.mark.parametrize(
        "segment,expected",
        [
            ("vivienda", "piso"),
            ("vivienda-piso", "piso"),
            ("vivienda-casa", "chalet"),
            ("garaje-garajecoche", "garaje"),
            ("terreno-urbanoparaconstruir", "terreno"),
            ("local", "local"),
            ("nave", "nave"),
            ("totallyunknown", None),
        ],
    )
    def test_property_type_mapping(self, segment, expected):
        assert map_property_type(segment) == expected

    def test_residential_filter(self):
        assert is_residential("vivienda-piso")
        assert not is_residential("garaje")
        assert not is_residential("terreno-rustico")
        assert not is_residential(None)

    def test_location_slug_split(self):
        city, province = parse_location_slug(
            "madrid-areametropolitanamadrid-madtetuan_cuatrocaminos"
        )
        assert province == "madrid"
        assert city == "madtetuan_cuatrocaminos"

    def test_promociones_path_shape_is_handled(self):
        parts = parse_listing_path(
            "/es/venta/promociones/vivienda/madrid-comarcasur-valdemoro/06110749"
        )
        assert parts["type_segment"] == "vivienda"
        assert parts["listing_id"] == "06110749"
        assert parts["is_promocion"] == "true"


class TestDatabaseRoundTrip:
    """Drives the real persistence path against real PostgreSQL.

    `normalize()` returns a well-formed dataclass whether or not its values
    actually satisfy the schema — `property.property_type`'s CHECK, foreign
    keys, uniqueness. PR #138 shipped a Solvia mapping that emitted
    "Apartamento" (not in the CHECK vocabulary): 19 normalize()-only tests
    passed while 100% of real ingests would have failed with CheckViolation.
    Servihabitat's vocabulary is correct, but only a round-trip can prove it,
    so this closes the same gap rather than trusting the mapping by eye.
    """

    def _insert(self, pg_conn, external_id=SUBJECT_ID):
        _apply_schema(pg_conn)
        canonical = _normalize_fixture(
            _read("servihabitat_sample_detail.html"), external_id=external_id
        )
        _upsert_canonical_listing(pg_conn, canonical)
        pg_conn.commit()
        return canonical

    def test_normalized_listing_survives_the_schema(self, pg_conn):
        self._insert(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.property_type, p.city, p.province, p.m2_built,
                       p.rooms, p.bathrooms, l.current_price, l.source,
                       l.listing_kind, l.reference_code
                  FROM listing l JOIN property p ON p.id = l.property_id
                 WHERE l.source = 'servihabitat'
                """
            )
            row = cur.fetchone()
        assert row is not None, "nothing persisted"
        (
            property_type,
            city,
            province,
            m2_built,
            rooms,
            bathrooms,
            price,
            source,
            listing_kind,
            reference_code,
        ) = row
        # The value that would have raised CheckViolation if mis-mapped.
        assert property_type == "piso"
        assert city == "madtetuan_cuatrocaminos"
        assert province == "madrid"
        assert m2_built == Decimal(80)
        assert rooms == 2
        assert bathrooms == 1
        assert price == Decimal(230000)
        assert source == "servihabitat"
        assert listing_kind == "agency"
        assert reference_code == "60645658"

    def test_reingest_updates_in_place_rather_than_duplicating(self, pg_conn):
        """external_id is the URL path and is stable across runs, so a second
        sweep must update the same row, not create a second listing."""
        self._insert(pg_conn)
        canonical = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        _upsert_canonical_listing(pg_conn, canonical)
        pg_conn.commit()
        with pg_conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM listing WHERE source='servihabitat'")
            assert cur.fetchone()[0] == 1


# --- Issue #495: sitemap grammar + honest robots limit ----------------------


def test_grammar_validates_round_trips_and_rejects_faceted_search():
    from etl.connectors import servihabitat as sh
    from etl.connectors.base import validate_grammar
    from etl.connectors.servihabitat import ServihabitatConnector
    from etl.tests.grammar_contract import (
        _servihabitat_spec,
        assert_grammar_roundtrip,
    )

    connector, cases, foreign, rejects = _servihabitat_spec()
    validate_grammar(connector)
    assert_grammar_roundtrip(
        connector.search_url_grammar,
        cases,
        foreign,
        build_real=lambda p: sh._sitemap_url(p["province"]),
        rejects=rejects,
    )
    g = ServihabitatConnector().search_url_grammar
    # Only the sitemap round-trips; a faceted-search URL is a reasoned block.
    assert g.parse(sh._sitemap_url("madrid")) == {"province": "madrid"}
    assert (
        g.rejection("https://www.servihabitat.com/es/venta/viviendas/madrid?x=1")
        == "robots-faceted-search"
    )


def test_preview_shows_province_param_and_honest_note():
    from etl.connectors.base import ConnectorScope
    from etl.connectors.servihabitat import ServihabitatConnector

    c = ServihabitatConnector()
    previews = c.search_previews(ConnectorScope(geography="sevilla"))
    assert len(previews) == 1
    params = {p.key: p for p in previews[0].params}
    assert params["province"].source == "profile"
    assert "robots" in (previews[0].notes or "").lower()
