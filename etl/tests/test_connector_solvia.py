"""Solvia connector tests (issue #116; provincia-wide sitemap sweep #190).

Fixtures are trimmed from real pages/sitemaps fetched live —
`solvia_sample_detail.html` carries the genuine `propertyBasicDetail`
payload of a real Torrevieja apartment, `solvia_sample_search.html` the
genuine detail hrefs from that municipality's search page,
`solvia_sample_search_dos_hermanas.html` the genuine 9 detail hrefs from
`/es/comprar/viviendas/sevilla/dos-hermanas` (2026-08-03, live),
`solvia_sample_search_empty_town.html` the genuine (empty but well-formed)
`/es/comprar/viviendas/sevilla/san-nicolas-del-puerto` page, and
`solvia_sitemap_index.xml`/`solvia_sitemap_comprar_viviendas.xml` a trimmed
real pull of Solvia's own published sitemap (2026-08-03) — 43 Sevilla + 44
Málaga municipality entries kept verbatim, plus a handful from other
provinces to prove the parser doesn't only work for the two named markets.
No network access is needed to run these.
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import re
from decimal import Decimal
from unittest.mock import Mock, patch

import pytest

from etl.connectors import solvia
from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.solvia import SolviaConnector
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


@pytest.fixture(autouse=True)
def _reset_sitemap_cache():
    """The sitemap cache is module-level state (issue #190) — shared across
    every SolviaConnector instance by design (one national document, no
    reason to fetch it per scope). That means it would leak between test
    functions unless reset; production never needs this (the TTL is the
    only real eviction path there)."""
    solvia._reset_sitemap_cache()
    yield
    solvia._reset_sitemap_cache()


def _fake_get(responses: dict[str, str], calls: list[str] | None = None):
    """A `requests.get` stand-in keyed by exact URL, recording call order.

    Real discover() now issues several distinct requests per sweep (sitemap
    index, child sitemap, then one per municipio) — a single `return_value`
    mock can no longer stand in for all of them.
    """

    def _get(url, headers=None, timeout=None):
        if calls is not None:
            calls.append(url)
        if url not in responses:
            raise AssertionError(f"unexpected request: {url}")
        return _mock_response(responses[url])

    return _get


class TestScopeResolution:
    def test_known_centroid_resolves_to_provincia(self):
        connector = SolviaConnector()
        # Madrid city centre.
        key = connector.scope_key(
            ConnectorScope(center=(40.4168, -3.7038), radius_km=10)
        )
        assert key == "madrid"

    def test_unknown_geography_returns_none_so_orchestrator_skips_it(self):
        connector = SolviaConnector()
        # Lisbon — outside every known centroid, must not silently pick one.
        assert (
            connector.scope_key(ConnectorScope(center=(38.7223, -9.1393), radius_km=10))
            is None
        )

    def test_free_text_geography_is_provincia_only_now(self):
        """Issue #190: a scope resolves to a PROVINCIA, not a specific
        municipio — discover() sweeps every municipio the sitemap lists for
        it, so the old "provincia/municipio" pin no longer carries a
        distinct municipio through. Only the first segment matters."""
        connector = SolviaConnector()
        assert connector.scope_key(ConnectorScope(geography="alicante/torrevieja")) == (
            "alicante"
        )

    def test_bare_provincia_free_text_also_works(self):
        connector = SolviaConnector()
        assert connector.scope_key(ConnectorScope(geography="sevilla")) == "sevilla"

    def test_two_scopes_in_the_same_provincia_share_one_key(self):
        """The coverage-dedup consequence of provincia-only keys (issue
        #190): two profiles naming different municipios in the same
        provincia now sweep the identical set of pages, so the orchestrator
        must treat them as the same target, not two independent crawls."""
        connector = SolviaConnector()
        key_a = connector.scope_key(ConnectorScope(geography="sevilla/sevilla"))
        key_b = connector.scope_key(ConnectorScope(geography="sevilla/dos-hermanas"))
        assert key_a == key_b == "sevilla"


class TestSitemapCache:
    def test_first_discover_fetches_sitemap_index_and_child(self):
        calls: list[str] = []
        responses = {
            "https://www.solvia.es/sitemap.xml": _read("solvia_sitemap_index.xml"),
            "https://www.solvia.es/sitemap_comprar_viviendas.xml": _read(
                "solvia_sitemap_comprar_viviendas.xml"
            ),
            "https://www.solvia.es/es/comprar/viviendas/sevilla/dos-hermanas": _read(
                "solvia_sample_search_dos_hermanas.html"
            ),
        }
        # Stub every other Sevilla municipio with the empty-town fixture so
        # the sweep completes without needing all 43 real pages.
        for municipio in solvia._parse_municipio_locs(
            solvia._sitemap_locs(
                _read("solvia_sitemap_comprar_viviendas.xml"), context="test"
            )
        ).get("sevilla", []):
            url = f"https://www.solvia.es/es/comprar/viviendas/sevilla/{municipio}"
            responses.setdefault(url, _read("solvia_sample_search_empty_town.html"))

        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            side_effect=_fake_get(responses, calls),
        ):
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )

        assert "https://www.solvia.es/sitemap.xml" in calls
        assert "https://www.solvia.es/sitemap_comprar_viviendas.xml" in calls

    def test_second_discover_within_ttl_does_not_refetch_sitemap(self):
        calls: list[str] = []
        responses = {
            "https://www.solvia.es/sitemap.xml": _read("solvia_sitemap_index.xml"),
            "https://www.solvia.es/sitemap_comprar_viviendas.xml": _read(
                "solvia_sitemap_comprar_viviendas.xml"
            ),
        }
        for municipio in solvia._parse_municipio_locs(
            solvia._sitemap_locs(
                _read("solvia_sitemap_comprar_viviendas.xml"), context="test"
            )
        ).get("sevilla", []):
            url = f"https://www.solvia.es/es/comprar/viviendas/sevilla/{municipio}"
            responses[url] = _read("solvia_sample_search_empty_town.html")

        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get",
            side_effect=_fake_get(responses, calls),
        ):
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )
            sitemap_calls_after_first = calls.count("https://www.solvia.es/sitemap.xml")
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )
            sitemap_calls_after_second = calls.count(
                "https://www.solvia.es/sitemap.xml"
            )

        assert sitemap_calls_after_first == 1
        assert sitemap_calls_after_second == 1, (
            "second discover() within the TTL window must reuse the cached "
            "sitemap, not refetch 1,737 URLs' worth of XML per scope"
        )

    def test_stale_cache_past_ttl_refetches(self, monkeypatch):
        responses = {
            "https://www.solvia.es/sitemap.xml": _read("solvia_sitemap_index.xml"),
            "https://www.solvia.es/sitemap_comprar_viviendas.xml": _read(
                "solvia_sitemap_comprar_viviendas.xml"
            ),
        }
        for municipio in solvia._parse_municipio_locs(
            solvia._sitemap_locs(
                _read("solvia_sitemap_comprar_viviendas.xml"), context="test"
            )
        ).get("sevilla", []):
            url = f"https://www.solvia.es/es/comprar/viviendas/sevilla/{municipio}"
            responses[url] = _read("solvia_sample_search_empty_town.html")

        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
        ):
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )
            fetched_at = solvia._sitemap_cache["fetched_at"]

            # Simulate the TTL having elapsed without waiting real time.
            monkeypatch.setattr(
                solvia.time,
                "time",
                lambda: fetched_at + solvia._SITEMAP_CACHE_TTL_SECONDS + 1,
            )
            calls: list[str] = []
            with patch(
                "etl.connectors.solvia.requests.get",
                side_effect=_fake_get(responses, calls),
            ):
                connector.discover(
                    ConnectorScope(geography="sevilla"), throttle=_noop_throttle
                )
            assert "https://www.solvia.es/sitemap.xml" in calls

    def test_sitemap_parses_real_sevilla_and_malaga_counts(self):
        """The headline evidence from issue #190's own live spike, pinned
        as a regression test: 43 Sevilla + 44 Málaga municipality entries,
        including dos-hermanas as its own entry."""
        by_province = solvia._parse_municipio_locs(
            solvia._sitemap_locs(
                _read("solvia_sitemap_comprar_viviendas.xml"), context="test"
            )
        )
        assert len(by_province["sevilla"]) == 43
        assert len(by_province["malaga"]) == 44
        assert "dos-hermanas" in by_province["sevilla"]
        assert "mijas" in by_province["malaga"]

    def test_missing_child_sitemap_raises(self):
        index_without_viviendas = (
            '<?xml version="1.0"?>'
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            "<sitemap><loc>https://www.solvia.es/sitemap_comprar_trasteros.xml</loc>"
            "</sitemap></sitemapindex>"
        )
        responses = {"https://www.solvia.es/sitemap.xml": index_without_viviendas}
        connector = SolviaConnector()
        with (
            patch(
                "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
            ),
            pytest.raises(ConnectorError, match="no child sitemap"),
        ):
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )


class TestDiscoverProvinciaSweep:
    """Issue #190: discover() now sweeps every municipio the sitemap lists
    for the resolved provincia, not just the one a scope's centroid names."""

    def _small_province_sitemap(self) -> str:
        """A hand-scoped 3-municipio sitemap for a synthetic 'testprov'
        provincia, built from the real `_MUNICIPIO_LOC_RE` shape — kept
        separate from the real Sevilla/Málaga fixture so this test's
        assertions don't depend on 43/44 real pages existing."""
        locs = [
            "https://www.solvia.es/es/comprar/viviendas/testprov/alpha",
            "https://www.solvia.es/es/comprar/viviendas/testprov/beta",
            "https://www.solvia.es/es/comprar/viviendas/testprov/gamma",
        ]
        body = "".join(f"<url><loc>{loc}</loc></url>" for loc in locs)
        return (
            '<?xml version="1.0"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"{body}</urlset>"
        )

    def _index_pointing_at(self, child_url: str) -> str:
        return (
            '<?xml version="1.0"?>'
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"<sitemap><loc>{child_url}</loc></sitemap></sitemapindex>"
        )

    def test_ids_are_unioned_across_every_municipio_in_the_provincia(self):
        child_url = "https://www.solvia.es/sitemap_comprar_viviendas.xml"
        responses = {
            "https://www.solvia.es/sitemap.xml": self._index_pointing_at(child_url),
            child_url: self._small_province_sitemap(),
            "https://www.solvia.es/es/comprar/viviendas/testprov/alpha": _read(
                "solvia_sample_search.html"
            ),
            "https://www.solvia.es/es/comprar/viviendas/testprov/beta": _read(
                "solvia_sample_search_dos_hermanas.html"
            ),
            "https://www.solvia.es/es/comprar/viviendas/testprov/gamma": _read(
                "solvia_sample_search_empty_town.html"
            ),
        }
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
        ):
            ids = connector.discover(
                ConnectorScope(geography="testprov"), throttle=_noop_throttle
            )
        # 3 from alpha (Torrevieja fixture) + 9 from beta (Dos Hermanas
        # fixture) + 0 from gamma (empty town) = 12, deduplicated/sorted.
        assert len(ids) == 12
        assert "220640-267805" in ids  # from alpha
        assert "150714-187731" in ids  # from beta

    def test_a_dos_hermanas_centred_profile_reaches_dos_hermanas(self):
        """Acceptance criterion (#190): sweeping the whole provincia, not
        just the one municipio a centroid resolves to, is what makes a
        Sevilla-area profile see Dos Hermanas' own inventory at all."""
        child_url = "https://www.solvia.es/sitemap_comprar_viviendas.xml"
        sitemap_xml = _read("solvia_sitemap_comprar_viviendas.xml")
        responses = {
            "https://www.solvia.es/sitemap.xml": self._index_pointing_at(child_url),
            child_url: sitemap_xml,
        }
        for municipio in solvia._parse_municipio_locs(
            solvia._sitemap_locs(sitemap_xml, context="test")
        ).get("sevilla", []):
            url = f"https://www.solvia.es/es/comprar/viviendas/sevilla/{municipio}"
            responses[url] = (
                _read("solvia_sample_search_dos_hermanas.html")
                if municipio == "dos-hermanas"
                else _read("solvia_sample_search_empty_town.html")
            )

        connector = SolviaConnector()
        # geography="sevilla" mirrors what a Sevilla-centroid-resolved,
        # center-based profile produces via _resolve_geography — the
        # connector never learns "dos-hermanas" by name, only "sevilla".
        with patch(
            "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
        ):
            ids = connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
            )
        assert "150714-187731" in ids  # a real Dos Hermanas listing
        assert len(ids) == 9  # only Dos Hermanas' page had any listings

    def test_a_few_bad_municipio_pages_dont_abort_the_whole_sweep(self):
        child_url = "https://www.solvia.es/sitemap_comprar_viviendas.xml"
        responses = {
            "https://www.solvia.es/sitemap.xml": self._index_pointing_at(child_url),
            child_url: self._small_province_sitemap(),
            "https://www.solvia.es/es/comprar/viviendas/testprov/alpha": (
                "<html><body>blocked, no ng-state here</body></html>"
            ),
            "https://www.solvia.es/es/comprar/viviendas/testprov/beta": _read(
                "solvia_sample_search_dos_hermanas.html"
            ),
            "https://www.solvia.es/es/comprar/viviendas/testprov/gamma": _read(
                "solvia_sample_search_empty_town.html"
            ),
        }
        connector = SolviaConnector()
        with patch(
            "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
        ):
            ids = connector.discover(
                ConnectorScope(geography="testprov"), throttle=_noop_throttle
            )
        # alpha failed but beta/gamma still contributed — one bad page must
        # not zero out an otherwise-successful province sweep.
        assert len(ids) == 9

    def test_every_municipio_failing_raises_rather_than_returning_empty(self):
        """The provincia-level equivalent of the old single-page contract:
        a soft-block covering the whole sweep must not look like a
        provincia with zero listings."""
        child_url = "https://www.solvia.es/sitemap_comprar_viviendas.xml"
        blocked = "<html><body>Pardon Our Interruption</body></html>"
        responses = {
            "https://www.solvia.es/sitemap.xml": self._index_pointing_at(child_url),
            child_url: self._small_province_sitemap(),
            "https://www.solvia.es/es/comprar/viviendas/testprov/alpha": blocked,
            "https://www.solvia.es/es/comprar/viviendas/testprov/beta": blocked,
            "https://www.solvia.es/es/comprar/viviendas/testprov/gamma": blocked,
        }
        connector = SolviaConnector()
        with (
            patch(
                "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
            ),
            pytest.raises(ConnectorError, match="all 3 municipio"),
        ):
            connector.discover(
                ConnectorScope(geography="testprov"), throttle=_noop_throttle
            )

    def test_unresolvable_provincia_raises_before_any_sitemap_fetch(self):
        connector = SolviaConnector()
        with pytest.raises(ConnectorError, match="no known Solvia"):
            connector.discover(
                ConnectorScope(center=(38.7223, -9.1393), radius_km=10),
                throttle=_noop_throttle,
            )

    def test_provincia_absent_from_sitemap_raises(self):
        """A resolved provincia (from _PROVINCE_SLUGS) that the live sitemap
        doesn't actually list would be a real, worth-surfacing surprise —
        not a silent empty result."""
        child_url = "https://www.solvia.es/sitemap_comprar_viviendas.xml"
        responses = {
            "https://www.solvia.es/sitemap.xml": self._index_pointing_at(child_url),
            child_url: self._small_province_sitemap(),  # only "testprov"
        }
        connector = SolviaConnector()
        with (
            patch(
                "etl.connectors.solvia.requests.get", side_effect=_fake_get(responses)
            ),
            pytest.raises(ConnectorError, match="no municipality pages"),
        ):
            connector.discover(
                ConnectorScope(geography="sevilla"), throttle=_noop_throttle
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
        # 20 of a municipio's listings per sweep — absence proves nothing.
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
