"""Fixture-based tests for the Vivantial connector (issue #120).

Fixtures are **complete, unmodified pages** captured live from
vivantial.es. PR #139's review replaced the earlier hand-trimmed 917-byte
fixture: trimming had dropped the hidden coordinate spans and the entire
"Características" block, which is precisely why the original spike
concluded (wrongly, and asserted in a test) that the site publishes no
coordinates. A real page can't silently omit markup the parser should
have been reading.

Includes a real-Postgres round-trip test, because a `normalize()`-only
assertion can't catch a value that violates a schema CHECK — PR #138 had
every Solvia ingest fail that way while its unit tests were green.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.geography import UnresolvableGeographyError
from etl.connectors.vivantial import VivantialConnector, _resolve_geography
from etl.connectors.vivantial_mapping import (
    external_id_from_url,
    extract_bathrooms,
    extract_city_province,
    extract_coordinates,
    extract_description,
    extract_features,
    extract_has_elevator,
    extract_m2_built,
    extract_photo_urls,
    extract_price,
    extract_property_type,
    extract_reference_code,
    extract_rooms,
)

FIXTURES = Path(__file__).parent / "fixtures"
MADRID_URL = (
    "https://www.vivantial.es/Inmuebles/vivienda_en_venta_en_madrid_en_madrid_5336"
)


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, status: int = 200):
    class _R:
        def __init__(self) -> None:
            self.text = text
            self.status_code = status

        def raise_for_status(self) -> None:
            return None

    return _R()


class TestFieldExtraction:
    """Values asserted here are the real ones from the live Madrid listing."""

    def test_extracts_every_field_from_a_real_listing(self):
        page = _fixture("vivantial_sample_detail.html")
        assert extract_price(page) == Decimal(288000)
        assert extract_m2_built(page) == Decimal(67)
        assert extract_rooms(page) == 4
        assert extract_bathrooms(page) == 1
        assert extract_reference_code(page) == "VIVANTIAL-5336"

    def test_coordinates_are_extracted_from_the_hidden_spans(self):
        """The original spike concluded "no coordinates anywhere" and
        asserted it as a permanent source limitation. They are in fact
        published as `<span id="latitude" class="hide">40,399</span>` —
        hidden, with comma decimals, which is how a visual sweep missed
        them (PR #139 review). Real per-listing values, not a centroid:
        two different cities must not resolve to the same point."""
        madrid = extract_coordinates(_fixture("vivantial_sample_detail.html"))
        murcia = extract_coordinates(_fixture("vivantial_sample_detail_murcia.html"))
        assert madrid == (Decimal("40.399"), Decimal("-3.698"))
        assert murcia == (Decimal("37.977"), Decimal("-1.131"))
        assert madrid != murcia

    def test_no_coordinates_yields_none_not_zero(self):
        assert extract_coordinates("<html><body>nothing</body></html>") == (
            None,
            None,
        )

    def test_description_is_the_real_copy_not_the_h1_boilerplate(self):
        """The <h1> is "Piso en venta en Madrid, Madrid" — no signal. The
        <p class="descripcion"> carries the occupancy disclosure issue #25
        depends on."""
        desc = extract_description(_fixture("vivantial_sample_detail.html"))
        assert desc is not None
        assert "OCUPADO POR PERSONA SIN JUSTO TÍTULO" in desc
        assert "NO ADMITE VISITAS" in desc
        assert not desc.startswith("Piso en venta en")

    def test_price_ignores_the_struck_through_previous_price(self):
        """Regression: the page renders a `<del>310.000 €</del>` previous
        price directly above the current one inside the same `precio`
        container. An earlier version fell through to a page-wide
        euro-amount search and reported 310.000 € as the asking price
        instead of 288.000 €. The `<del>` in the fixture is what makes
        this test meaningful."""
        page = _fixture("vivantial_sample_detail.html")
        assert "310.000" in page, "fixture must retain the struck-through price"
        assert extract_price(page) == Decimal(288000)

    def test_price_falls_back_to_precio_rojo_when_meta_is_absent(self):
        """EC: a field with a working fallback chain, proven with the primary
        path removed. The fallback must still read the `.precio-rojo`
        element specifically, not the sibling (empty, in this fixture)
        plain `precio` div.

        This fixture used to also embed a fabricated `<section
        class="similares">` decoy carrying a "310.000 €" figure, framed as
        proof the fallback "avoids the neighbour's price" — removed during
        issue #144: it never exercised anything real. Both the current
        `scoped_text(keep=".precio-rojo")` implementation and the regex it
        replaced select the `.precio-rojo` element directly, so neither
        would ever have read a page-wide, unscoped match in the first
        place — the decoy was inert theatre, not a regression test, and (per
        issue #169's research on this same PR) Vivantial's real pages don't
        render a server-side "similar properties" section at all. The real
        neighbour-shaped risk this site actually has — the struck-through
        *previous* price living in a sibling `precio` div on a discounted
        listing — is covered by `test_price_ignores_the_struck_through_previous_price`
        above, against real captured fixtures.
        """
        page = _fixture("vivantial_sample_detail_no_meta.html")
        assert 'name="description"' not in page
        assert extract_price(page) == Decimal(288000)

    def test_photo_urls_are_absolute_and_exclude_site_chrome(self):
        """`//cdn.vivantial.es/...` is protocol-relative — the same shape
        that produced a `https:////host` double-slash bug in Milanuncios."""
        urls = extract_photo_urls(_fixture("vivantial_sample_detail.html"))
        assert urls == (
            "https://cdn.vivantial.es/photos/ES5336_INV09-FINSO-CENRE-047_5677.png",
        )
        assert all(u.startswith("https://cdn.vivantial.es/") for u in urls)
        assert not any("logoHead" in u or "favicon" in u for u in urls)

    def test_rooms_fall_back_to_the_caracteristicas_block(self):
        """The meta description is the primary source, but the
        "Características" block is a real second getter — label-anchored,
        so unlike a page-wide `\\d+ hab` regex it can't pick up a
        neighbouring card's count. Removing the meta slot must still yield
        the listing's own values."""
        page = _fixture("vivantial_sample_detail.html").replace(
            "con 4 hab. y 1 ba&#241;o por", "con  por"
        )
        assert "N&#186; habitaciones: 4" in page or "habitaciones: 4" in page
        assert extract_rooms(page) == 4
        assert extract_bathrooms(page) == 1
        assert extract_price(page) == Decimal(288000)

    def test_optional_fields_are_none_not_zero_when_absent(self):
        """A listing that publishes neither a meta slot nor a
        Características block yields None, not 0 — absence of evidence."""
        page = _fixture("vivantial_sample_detail_no_meta.html")
        assert extract_rooms(page) is None
        assert extract_bathrooms(page) is None
        assert extract_features(page) == ()
        assert extract_has_elevator(page) is None


class TestUrlParsing:
    @pytest.mark.parametrize(
        "url,city,province",
        [
            (MADRID_URL, "Madrid", "Madrid"),
            (
                (
                    "https://www.vivantial.es/Inmuebles/"
                    "vivienda_en_venta_en_rabade_en_lugo_6896"
                ),
                "Rabade",
                "Lugo",
            ),
            (
                (
                    "https://www.vivantial.es/Inmuebles/"
                    "vivienda_en_venta_en_saguntosagunt_en_valencia_18529"
                ),
                "Saguntosagunt",
                "Valencia",
            ),
        ],
    )
    def test_city_province_come_from_the_slug(self, url, city, province):
        """Regression: the slug prefix contains its own `_en_`
        ("vivienda_en_venta_en_"), so anchoring on the first occurrence
        yielded "Venta/Madrid En Madrid" instead of "Madrid"/"Madrid"."""
        assert extract_city_province(url) == (city, province)

    def test_external_id_is_the_trailing_number(self):
        assert external_id_from_url(MADRID_URL) == "5336"


class TestGeographyResolution:
    def test_free_text_geography_wins(self):
        assert _resolve_geography(ConnectorScope(geography="madrid")) == "madrid"

    def test_center_resolves_to_a_city_slug(self):
        scope = ConnectorScope(center=(40.4168, -3.7038), radius_km=10.0)
        assert _resolve_geography(scope) == "madrid"

    @pytest.mark.parametrize(
        ("center", "expected_slug"),
        [
            # Costa del Sol (issue #169 course-correction v1 market) — real
            # gazetteer coordinates, tight radius so the match can only come
            # from that municipality's own _CITY_SLUGS entry (Marbella is
            # deliberately absent from the table — the live sitemap has no
            # entries there — so it isn't included here).
            ((36.75854, -4.39717), "malaga"),
            ((36.44543, -5.12739), "estepona"),
            ((36.58975, -4.54213), "benalmadena"),
            ((36.53507, -4.67355), "mijas"),
        ],
    )
    def test_costa_del_sol_v1_market_towns_resolve_to_their_own_slug(
        self, center, expected_slug
    ):
        """These must resolve to their OWN municipality slug, not collapse
        to a province-level fallback — the granularity a coastal-town
        search actually needs."""
        scope = ConnectorScope(center=center, radius_km=10.0)
        assert _resolve_geography(scope) == expected_slug

    def test_no_geography_at_all_returns_none_not_a_default(self):
        """Issue #71: never silently fall back to a hardcoded city. A scope
        with no center and no geography string has nothing to resolve at
        all — a legitimate no-op, distinct from the unresolvable-center
        case below (issue #169)."""
        assert _resolve_geography(ConnectorScope()) is None

    def test_unresolvable_center_raises_not_returns_none(self):
        """Issue #169: a scope WITH a real center that matches no known
        place must raise, not silently return None — a None here used to
        read as "zero listings found" all the way up, identical to a
        genuinely empty result set."""
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5.0)  # Lisbon
        with pytest.raises(UnresolvableGeographyError):
            _resolve_geography(far)

    def test_scope_key_never_raises_and_uses_a_sentinel_for_unresolvable(self):
        """scope_key() must never raise (the orchestrator calls it with no
        try/except) — an unresolvable center must still surface as a
        distinct, non-None key so the orchestrator calls discover(), whose
        own _resolve_geography() call raises there and gets recorded as a
        real connector_run_results failure (issue #169)."""
        connector = VivantialConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5.0)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")


class TestDiscover:
    def test_filters_the_national_sitemap_by_city(self):
        connector = VivantialConnector()
        sitemap = _fixture("vivantial_sample_sitemap.xml")
        with patch(
            "etl.connectors.vivantial.requests.get",
            return_value=_mock_response(sitemap),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert ids == ["5336", "9001"], "only Madrid listings, sorted, deduped"

    def test_unresolvable_scope_raises_rather_than_returning_empty(self):
        """An empty discover() would read as 'everything was withdrawn' to the
        orchestrator — and this connector claims full inventory, so that
        would mass-withdraw real listings."""
        connector = VivantialConnector()
        with pytest.raises(ConnectorError, match="not defaulting to a hardcoded"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_a_sitemap_with_no_loc_entries_raises(self):
        """A WAF interstitial or error page must not be read as an empty
        inventory — same guard as the other connectors' marker checks."""
        connector = VivantialConnector()
        with (
            patch(
                "etl.connectors.vivantial.requests.get",
                return_value=_mock_response("<html>Access Denied</html>"),
            ),
            pytest.raises(ConnectorError, match="no <loc> entries"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )


class TestFetchDetailAndNormalize:
    def test_normalize_produces_a_canonical_listing(self):
        connector = VivantialConnector()
        page = _fixture("vivantial_sample_detail.html")
        connector._url_cache["5336"] = MADRID_URL
        with patch(
            "etl.connectors.vivantial.requests.get",
            return_value=_mock_response(page),
        ):
            raw = connector.fetch_detail("5336", throttle=lambda: None)
        listing = connector.normalize(raw)

        assert listing.source == "vivantial"
        assert listing.external_id == "5336"
        assert listing.current_price == Decimal(288000)
        assert listing.m2_built == Decimal(67)
        assert listing.rooms == 4
        assert listing.reference_code == "VIVANTIAL-5336"
        assert listing.city == "Madrid"
        assert listing.province == "Madrid"
        assert listing.operation == "sale"
        assert listing.listing_kind == "agency"
        assert listing.status == "active"

        # Coordinates ARE published, in hidden spans with comma decimals.
        # The original spike recorded "no coordinates anywhere" as a
        # permanent source limitation and asserted it here; PR #139's
        # review proved that wrong against the live site.
        assert listing.lat == Decimal("40.399")
        assert listing.lon == Decimal("-3.698")

        # Structured "Características" block — previously ignored entirely.
        assert listing.property_type == "piso"
        assert listing.bathrooms == 1
        assert listing.floor == "4 planta"
        assert listing.year_built == 1930  # published as "Antigüedad: 96 años"
        assert listing.has_elevator is True
        assert listing.features == (
            "ascensor",
            "parque_a_menos_de_500_metros",
            "zonas_verdes",
            "portero_automático",
        )

        # The substantive <p class="descripcion"> copy, not the <h1>
        # boilerplate. Occupancy status lives here, which is what issue
        # #25's assessment reads.
        assert listing.description is not None
        assert "OCUPADO POR PERSONA SIN JUSTO TÍTULO" in listing.description
        assert "Piso en venta en" not in listing.description

    def test_property_type_is_read_not_hardcoded(self):
        """Regression: property_type was hardcoded to "piso", mistyping the
        ~5% of the live sitemap that is parking/local/trastero/oficina/
        edificio. Every value must also be one the schema CHECK allows."""
        page = _fixture("vivantial_sample_detail.html")
        allowed = {
            "piso",
            "chalet",
            "atico",
            "local",
            "nave",
            "garaje",
            "terreno",
            "edificio",
        }
        assert extract_property_type(page, MADRID_URL) == "piso"
        # Slug fallback carries the type when the block is absent.
        garaje_url = (
            "https://www.vivantial.es/Inmuebles/garaje_en_venta_en_madrid_en_madrid_1"
        )
        assert extract_property_type("<html></html>", garaje_url) == "garaje"
        # An unrecognised type degrades to None, never a guess — passing a
        # site's raw label straight through is what made every Solvia
        # ingest fail on a CheckViolation (PR #138).
        weird = (
            "https://www.vivantial.es/Inmuebles/zeppelin_en_venta_en_madrid_en_madrid_1"
        )
        assert extract_property_type("<html></html>", weird) is None
        for url in (MADRID_URL, garaje_url):
            value = extract_property_type(page, url)
            assert value is None or value in allowed

    def test_fetch_detail_without_a_cached_url_raises_rather_than_guessing(self):
        """The slug carries city/province, so an id alone can't build a
        valid URL. An earlier version returned `/Inmuebles/<id>`, a
        guaranteed 404 that surfaced as a confusing fetch error instead of
        the cache miss it actually is."""
        connector = VivantialConnector()
        with pytest.raises(ConnectorError, match="no cached detail URL"):
            connector.fetch_detail("5336", throttle=lambda: None)

    def test_a_page_without_the_reference_marker_raises(self):
        connector = VivantialConnector()
        connector._url_cache["5336"] = MADRID_URL
        with (
            patch(
                "etl.connectors.vivantial.requests.get",
                return_value=_mock_response("<html><body>gone</body></html>"),
            ),
            pytest.raises(ConnectorError, match="no reference marker"),
        ):
            connector.fetch_detail("5336", throttle=lambda: None)


class TestPersistsToRealPostgres:
    """A `normalize()`-only assertion cannot catch a value the schema
    rejects. PR #138 shipped a connector whose `property_type` violated
    `property`'s CHECK constraint — every ingest would have failed, while
    370 unit tests stayed green, because none of them ever inserted a row.
    """

    def test_normalized_listing_round_trips_through_the_real_schema(self, pg_conn):
        from etl import orchestrator

        sql = (Path(__file__).parent.parent / "schema" / "init.sql").read_text(
            encoding="utf-8"
        )
        with pg_conn.cursor() as cur:
            cur.execute(sql)
        pg_conn.commit()

        connector = VivantialConnector()
        connector._url_cache["5336"] = MADRID_URL
        with patch(
            "etl.connectors.vivantial.requests.get",
            return_value=_mock_response(_fixture("vivantial_sample_detail.html")),
        ):
            raw = connector.fetch_detail("5336", throttle=lambda: None)
        canonical = connector.normalize(raw)

        try:
            # The assertion that matters: this must not raise
            # CheckViolation on property_type, or any other constraint.
            orchestrator._upsert_canonical_listing(pg_conn, canonical)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT p.property_type, p.lat, p.lon, p.city, p.rooms, "
                    "       p.has_elevator, p.year_built, p.features, "
                    "       l.reference_code, l.description "
                    "  FROM listing l JOIN property p ON p.id = l.property_id "
                    " WHERE l.source = %s AND l.external_id = %s",
                    ("vivantial", "5336"),
                )
                row = cur.fetchone()

            assert row is not None, "listing did not persist"
            (
                property_type,
                lat,
                lon,
                city,
                rooms,
                has_elevator,
                year_built,
                features,
                reference_code,
                description,
            ) = row
            assert property_type == "piso"
            assert lat == Decimal("40.399000")
            assert lon == Decimal("-3.698000")
            assert city == "Madrid"
            assert rooms == 4
            assert has_elevator is True
            assert year_built == 1930
            assert "ascensor" in features
            assert reference_code == "VIVANTIAL-5336"
            assert "OCUPADO POR PERSONA SIN JUSTO TÍTULO" in description
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing_status_event WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'vivantial')"
                )
                cur.execute(
                    "DELETE FROM listing_price_history WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'vivantial')"
                )
                # listing before property — listing.property_id is a NOT
                # NULL FK, so the property can't go first.
                cur.execute(
                    "CREATE TEMP TABLE _viv_props ON COMMIT DROP AS "
                    "SELECT property_id FROM listing WHERE source = 'vivantial'"
                )
                cur.execute("DELETE FROM listing WHERE source = 'vivantial'")
                cur.execute(
                    "DELETE FROM property WHERE id IN "
                    "(SELECT property_id FROM _viv_props)"
                )
            pg_conn.commit()


class TestRegistration:
    def test_registered_and_claims_full_inventory(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        by_name = {c.name: c for c in CONNECTORS}
        assert "vivantial" in by_name
        # Justified: the sitemap is the site's complete published inventory
        # and discover() reads all of it, so absence really does mean removed
        # (unlike Fotocasa's page-1 slice).
        assert by_name["vivantial"].discovers_full_inventory is True
