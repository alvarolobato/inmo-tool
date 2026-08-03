"""Solvia connector tests (issue #116).

Fixtures are trimmed from real pages fetched during the feasibility spike
(2026-08-02) — `solvia_sample_detail.html` carries the genuine
`propertyBasicDetail` payload of a real Torrevieja apartment, and
`solvia_sample_search.html` the genuine detail hrefs from that
municipality's search page. No network access is needed to run these.
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import re
from decimal import Decimal
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.geography import UnresolvableGeographyError
from etl.connectors.solvia import SolviaConnector, _resolve_geography
from etl.connectors.solvia_mapping import map_property_type
from etl.orchestrator import _upsert_canonical_listing

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
SCHEMA_SQL = pathlib.Path(__file__).resolve().parents[1] / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str) -> Mock:
    response = Mock()
    response.text = text
    response.raise_for_status = Mock()
    return response


def _noop_throttle() -> None:
    return None


def _detail_state(html: str) -> dict:
    match = re.search(
        r'<script id="ng-state" type="application/json">(.*?)</script>', html, re.DOTALL
    )
    assert match is not None
    return json.loads(match.group(1))["propertyBasicDetail"]


class TestScopeResolution:
    def test_known_centroid_resolves_to_provincia_municipio(self):
        connector = SolviaConnector()
        # Madrid city centre.
        key = connector.scope_key(
            ConnectorScope(center=(40.4168, -3.7038), radius_km=10)
        )
        assert key == "madrid/madrid"

    @pytest.mark.parametrize(
        ("center", "expected_key"),
        [
            # Costa del Sol (issue #169 course-correction v1 market) —
            # independently-sourced landmark coordinates (issue #177, M2:
            # not copied from the gazetteer's own row for each municipality
            # — see test_geography.py's TestNearestPlaceReturnsProvince
            # docstring for why that distinction matters), tight radius so a
            # match can only come from that municipality's own _CITY_SLUGS
            # entry, not a wide-radius coincidental hit on a neighbour.
            ((36.7211, -4.4220), "malaga/malaga"),  # Plaza de la Constitución
            ((36.51667, -4.88333), "malaga/marbella"),  # Wikipedia infobox
            ((36.42643, -5.1465), "malaga/estepona"),  # Plaza San Francisco
            # Greater Sevilla (owner's other stated v1 market) — the
            # task/PR reviewer's own measured Dos Hermanas centroid, also
            # the exact point of the Dos Hermanas regression case (see
            # test_geography.py's TestDosHermanasRegression).
            ((37.283689, -5.9226718), "sevilla/dos-hermanas"),
        ],
    )
    def test_v1_market_towns_resolve_to_their_own_provincia_municipio(
        self, center, expected_key
    ):
        """Issue #169: these must resolve to their OWN municipio slug, not
        collapse to the province capital — the granularity that makes a
        province-level fallback pointless for a coastal town search."""
        connector = SolviaConnector()
        key = connector.scope_key(ConnectorScope(center=center, radius_km=10))
        assert key == expected_key

    def test_unresolvable_center_raises_rather_than_silently_resolving(self):
        """Issue #169: Lisbon is a real center point but matches no known
        place in the shared gazetteer at all — this must raise, not
        silently return None (which used to read as "no coverage",
        identical to "zero listings found")."""
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        with pytest.raises(UnresolvableGeographyError):
            _resolve_geography(far)

    def test_scope_key_never_raises_and_uses_a_sentinel_for_unresolvable(self):
        """scope_key() must never raise itself (the orchestrator calls it
        with no try/except) — the unresolvable case above must still
        surface as a distinct, non-None key so discover() gets called and
        raises there, landing as a real connector_run_results failure."""
        connector = SolviaConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_a_known_municipality_this_connector_doesnt_cover_returns_none(self):
        """Distinct from the unresolvable case above: a scope that DOES
        resolve to a real, known municipality (via the shared gazetteer)
        that Solvia's own `_CITY_SLUGS` table simply doesn't have an entry
        for is a legitimate, non-failure coverage gap — scope_key() still
        returns None for this, and the orchestrator skips it without
        recording a failure (issue #99, unchanged by issue #169)."""
        connector = SolviaConnector()
        # A real Spanish municipality, deliberately not in Solvia's table.
        scope = ConnectorScope(center=(43.463, -3.8044), radius_km=5)  # Santander
        assert connector.scope_key(scope) is None

    def test_free_text_geography_escape_hatch(self):
        connector = SolviaConnector()
        assert connector.scope_key(ConnectorScope(geography="alicante/torrevieja")) == (
            "alicante/torrevieja"
        )


class TestDiscover:
    def test_extracts_detail_paths_from_real_search_markup(self):
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            return_value=_mock_response(_read("solvia_sample_search.html")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="alicante/torrevieja"), throttle=_noop_throttle
            )
        assert len(ids) == 3
        # The stable "<idPromocion>-<idVivienda>" pair, NOT the descriptive
        # slug: the slug changes when the title does, which would make a
        # retitled listing look like a new property (#138 review).
        assert ids == ["220640-267805", "222830-270617", "224346-272477"]

    def test_page_without_ng_state_raises_rather_than_reporting_zero_listings(self):
        """A soft-block/structural change must not look like an empty geography.

        Returning [] here would let _reconcile_missed_discoveries treat real
        inventory as vanished — the failure mode Connector.discovers_full_inventory
        exists to guard against.
        """
        connector = SolviaConnector()
        with (
            patch(
                "etl.connectors.solvia.requests.get",
                return_value=_mock_response("<html><body>blocked</body></html>"),
            ),
            pytest.raises(ConnectorError, match="ng-state"),
        ):
            connector.discover(
                ConnectorScope(geography="alicante/torrevieja"), throttle=_noop_throttle
            )


class TestNormalize:
    def _normalized(self):
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            return_value=_mock_response(_read("solvia_sample_detail.html")),
        ):
            raw = connector.fetch_detail(
                "220640-267805",
                throttle=_noop_throttle,
            )
        return connector.normalize(raw)

    def test_core_fields_from_real_payload(self):
        c = self._normalized()
        assert c.source == "solvia"
        assert c.current_price == Decimal(169000)
        assert c.rooms == 2
        assert c.bathrooms == 1
        assert c.m2_built == Decimal(50)
        assert c.property_type == "piso"  # "Apartamento" -> schema vocabulary
        assert c.address == "C/ Villa Madrid"
        assert c.operation == "sale"
        assert c.status == "active"
        # Servicer disposing of bank-owned stock, never a private seller.
        assert c.listing_kind == "agency"

    def test_superset_geography_fields_are_populated(self):
        c = self._normalized()
        assert c.city == "Torrevieja"
        assert c.province == "Alicante/Alacant"
        assert c.postal_code == "03133"

    def test_cadastral_reference_is_captured(self):
        """The headline reason this source matters (issue #1 §6 signal 1).

        #42 was cancelled assuming no portal would publish this; Solvia does,
        on every listing spot-checked during the spike. Now lands on the
        canonical field rather than `raw_extra` (issue #140 wired the column
        through), so it actually reaches the dedup engine.
        """
        c = self._normalized()
        assert c.cadastral_ref == "3061226YH0036S0007SM"
        assert "cadastral_ref" not in c.raw_extra, (
            "should live on the canonical field now, not duplicated in raw_extra"
        )

    def test_carrying_costs_reach_raw_extra_for_phase_5(self):
        c = self._normalized()
        assert c.raw_extra["gastos_comunidad_eur"] == 38
        assert c.raw_extra["ibi_anual_eur"] == 225
        assert c.raw_extra["estado"] == "Segunda Mano"

    def test_features_are_slug_tokens_not_prose(self):
        c = self._normalized()
        # data-model.md's documented convention: short slugs usable by a GIN
        # containment query, not human-readable sentences.
        assert "amueblado" in c.features
        assert "aire_acondicionado" in c.features
        assert all(" " not in token for token in c.features)

    def test_photos_prefer_original_resolution_and_deduplicate(self):
        c = self._normalized()
        assert len(c.photo_urls) == 25
        assert len(set(c.photo_urls)) == len(c.photo_urls)
        # Backslashes in Solvia's CDN paths are normalised, not passed through.
        assert all("\\" not in u for u in c.photo_urls)

    def test_no_coordinates_published(self):
        """Documents a real limitation rather than silently yielding None.

        Solvia publishes no lat/lon (verified across five live listings), so
        the address_coords dedup signal cannot fire for this source — the
        cadastral ref and postal code carry matching instead.
        """
        c = self._normalized()
        assert c.lat is None and c.lon is None

    def test_zero_plot_size_treated_as_absent(self):
        c = self._normalized()
        # m2Parcela is null on this flat; must not become Decimal("0"), which
        # COALESCE would later treat as a real measurement.
        assert c.m2_plot is None


class TestFallbackChains:
    """Each fallback must be proven to fire when its primary path is gone.

    Shipping an untested fallback is how #77/#78 ended up retrofitting
    single-path extractors — a renamed key silently yields None forever.
    """

    def _normalize_with_mutated_state(self, mutate) -> object:
        html = _read("solvia_sample_detail.html")
        state = _detail_state(html)
        mutate(state)
        rebuilt = re.sub(
            r'(<script id="ng-state" type="application/json">).*?(</script>)',
            lambda m: (
                m.group(1)
                + json.dumps({"propertyBasicDetail": state}, ensure_ascii=False)
                + m.group(2)
            ),
            html,
            flags=re.DOTALL,
        )
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get", return_value=_mock_response(rebuilt)
        ):
            raw = connector.fetch_detail(
                "220640-267805",
                throttle=_noop_throttle,
            )
        return connector.normalize(raw)

    def test_rooms_falls_back_to_url_slug_when_json_key_is_renamed(self):
        c = self._normalize_with_mutated_state(lambda s: s.pop("totalDormitorios"))
        # "...-2-dormitorios-..." in the page's own canonical URL still
        # yields the answer (external_id is now the bare numeric pair).
        assert c.rooms == 2

    def test_m2_falls_back_to_superficie_construida(self):
        c = self._normalize_with_mutated_state(lambda s: s.pop("m2"))
        # Genuinely a different figure (43 vs the advertised 50), proving the
        # fallback fired rather than the primary silently succeeding.
        assert c.m2_built == Decimal(43)

    def test_price_falls_back_to_rendered_markup(self):
        c = self._normalize_with_mutated_state(lambda s: s.pop("precio"))
        assert c.current_price == Decimal(169000)

    def test_property_type_falls_back_to_category(self):
        c = self._normalize_with_mutated_state(lambda s: s.pop("tipoVivienda"))
        # The fallback path fires (categoriaTipoVivienda == "Viviendas"), but
        # "Viviendas" is not a schema value, so it maps to None rather than
        # being written raw — which is what previously broke every INSERT.
        assert c.property_type is None
        # The raw value still survives for diagnosis.
        assert c.raw_extra["tipo_vivienda_raw"] == "Viviendas"

    def test_withheld_price_is_none_not_a_markup_misparse(self):
        """`mostrarPrecio == 'N'` is a real state, not a parse failure.

        The markup fallback must not kick in and scrape some unrelated
        number off the page when Solvia deliberately withholds the price.
        """
        c = self._normalize_with_mutated_state(
            lambda s: s.update({"mostrarPrecio": "N"})
        )
        assert c.current_price is None


class TestRegistration:
    def test_registered_and_declares_partial_coverage(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        names = [c.name for c in CONNECTORS]
        assert "solvia" in names
        assert len(names) == len(set(names)), f"duplicate registrations: {names}"

        connector = next(c for c in CONNECTORS if c.name == "solvia")
        # 20 of a geography's listings per sweep — absence proves nothing.
        assert connector.discovers_full_inventory is False


class TestPropertyTypeMapping:
    """Solvia's vocabulary must be translated to the schema's, not passed through.

    `property.property_type` carries a CHECK constraint allowing only
    ('piso','chalet','atico','local','nave','garaje','terreno','edificio').
    Passing Solvia's own names ("Apartamento", "Locales", "Nave Industrial")
    straight through makes every INSERT raise CheckViolation — see
    TestDatabaseRoundTrip for the test that actually catches that.

    The values below marked (v) were read from live `tipoVivienda.name`
    fields during the #138 review, one per slug family across the
    viviendas/locales/garajes/naves/suelos/oficinas/trasteros trees.
    """

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Piso", "piso"),  # (v)
            ("Bajo", "piso"),  # (v)
            ("Estudio", "piso"),  # (v)
            ("Dúplex", "piso"),  # (v) accented
            ("Casa", "chalet"),  # (v)
            ("Chalet adosado", "chalet"),  # (v)
            ("Locales", "local"),  # (v) Solvia pluralises
            ("Oficinas", "local"),  # (v)
            ("Nave Industrial", "nave"),  # (v)
            ("Solares", "terreno"),  # (v)
            ("Garaje", "garaje"),  # (v)
            ("Apartamento", "piso"),
            ("Ático", "atico"),
        ],
    )
    def test_real_site_vocabulary_maps_into_the_schema_check(self, raw, expected):
        assert map_property_type(raw) == expected

    @pytest.mark.parametrize("raw", ["duplex", "DÚPLEX", "  Dúplex  "])
    def test_case_and_accent_folding(self, raw):
        """Solvia's casing/accenting is inconsistent across trees."""
        assert map_property_type(raw) == "piso"

    @pytest.mark.parametrize("raw", [None, "", "   ", "Viviendas", "Trastero"])
    def test_unknown_values_yield_none_rather_than_a_guess(self, raw):
        """None costs a NULL; a guess silently mis-files a property forever.

        "Trastero" (v) is real and deliberately unmapped — a storage room
        has no schema equivalent, and 'local'/'garaje' would both be wrong.
        "Viviendas" is the categoriaTipoVivienda fallback value.
        """
        assert map_property_type(raw) is None


class TestDatabaseRoundTrip:
    """The gap that let the property_type bug ship.

    Every other test in this file stops at `normalize()`, so a value that
    is structurally fine but violates a schema CHECK passes them all while
    failing 100% of real ingests. These drive the real orchestrator
    persistence path against a real database instead.
    """

    def _persist(self, pg_conn):
        _apply_schema(pg_conn)
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            return_value=_mock_response(_read("solvia_sample_detail.html")),
        ):
            raw = connector.fetch_detail("220640-267805", throttle=_noop_throttle)
        canonical = connector.normalize(raw)
        _upsert_canonical_listing(pg_conn, canonical)
        pg_conn.commit()
        return canonical

    def test_normalized_listing_actually_persists(self, pg_conn):
        """Would have failed with CheckViolation before the mapping fix."""
        self._persist(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.property_type, p.city, p.province, p.postal_code,
                       p.m2_built, p.rooms, l.current_price, l.source,
                       l.external_id, l.operation
                  FROM listing l JOIN property p ON p.id = l.property_id
                 WHERE l.source = 'solvia'
                """
            )
            row = cur.fetchone()
        assert row is not None, "no row persisted"
        (
            property_type,
            city,
            province,
            postal_code,
            m2_built,
            rooms,
            price,
            source,
            external_id,
            operation,
        ) = row
        assert property_type == "piso"
        assert city == "Torrevieja"
        assert province == "Alicante/Alacant"
        assert postal_code == "03133"
        assert m2_built == Decimal(50)
        assert rooms == 2
        assert price == Decimal(169000)
        assert source == "solvia"
        assert external_id == "220640-267805"
        assert operation == "sale"

    def test_cadastral_ref_reaches_the_property_column(self, pg_conn):
        """Issue #140: the value must land in the column the dedup engine reads.

        It previously stopped at `raw_extra` — `CanonicalListingVersion` had
        no field for it and neither SQL path wrote it — so the highest-
        confidence dedup signal could never fire no matter what Solvia
        published. A `normalize()`-only assertion cannot catch that class of
        break, which is exactly why this is a round-trip.
        """
        self._persist(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT p.cadastral_ref FROM listing l "
                "JOIN property p ON p.id = l.property_id WHERE l.source = 'solvia'"
            )
            (cadastral_ref,) = cur.fetchone()
        assert cadastral_ref == "3061226YH0036S0007SM"

    def test_re_ingest_preserves_cadastral_ref(self, pg_conn):
        """COALESCE discipline: a later fetch that omits it must not blank it.

        Matters once dedup points two listings at one property — a re-visit
        of the source that doesn't publish a reference must not erase what
        the other source contributed.
        """
        self._persist(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT p.id FROM listing l JOIN property p ON p.id = l.property_id "
                "WHERE l.source = 'solvia'"
            )
            (property_id,) = cur.fetchone()

        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            return_value=_mock_response(_read("solvia_sample_detail.html")),
        ):
            raw = connector.fetch_detail("220640-267805", throttle=_noop_throttle)
        canonical = connector.normalize(raw)
        _upsert_canonical_listing(
            pg_conn, dataclasses.replace(canonical, cadastral_ref=None)
        )
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT cadastral_ref FROM property WHERE id = %s", (property_id,)
            )
            (cadastral_ref,) = cur.fetchone()
        assert cadastral_ref == "3061226YH0036S0007SM"

    def test_re_ingest_updates_in_place_rather_than_duplicating(self, pg_conn):
        """The stable numeric external_id is what makes this hold.

        With the old slug-derived id, a retitled listing produced a second
        `listing` row for the same flat — a phantom duplicate that then
        polluted dedup rather than updating the original.
        """
        self._persist(pg_conn)
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            return_value=_mock_response(_read("solvia_sample_detail.html")),
        ):
            raw = connector.fetch_detail("220640-267805", throttle=_noop_throttle)
        _upsert_canonical_listing(pg_conn, connector.normalize(raw))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM listing WHERE source = 'solvia'")
            assert cur.fetchone()[0] == 1
