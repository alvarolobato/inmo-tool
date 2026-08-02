"""Solvia connector tests (issue #116).

Fixtures are trimmed from real pages fetched during the feasibility spike
(2026-08-02) — `solvia_sample_detail.html` carries the genuine
`propertyBasicDetail` payload of a real Torrevieja apartment, and
`solvia_sample_search.html` the genuine detail hrefs from that
municipality's search page. No network access is needed to run these.
"""

from __future__ import annotations

import json
import pathlib
import re
from decimal import Decimal
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.solvia import SolviaConnector

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


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

    def test_unknown_geography_returns_none_so_orchestrator_skips_it(self):
        connector = SolviaConnector()
        # Lisbon — outside every known centroid, must not silently pick one.
        assert (
            connector.scope_key(ConnectorScope(center=(38.7223, -9.1393), radius_km=10))
            is None
        )

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
        assert all(i.startswith("/es/propiedades/comprar/") for i in ids)
        assert (
            "/es/propiedades/comprar/apartamento-torrevieja-2-dormitorios-220640-267805"
            in ids
        )

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
                "/es/propiedades/comprar/apartamento-torrevieja-2-dormitorios-220640-267805",
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
        assert c.property_type == "Apartamento"
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
        on every listing spot-checked during the spike.
        """
        c = self._normalized()
        assert c.raw_extra["cadastral_ref"] == "3061226YH0036S0007SM"

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
                "/es/propiedades/comprar/apartamento-torrevieja-2-dormitorios-220640-267805",
                throttle=_noop_throttle,
            )
        return connector.normalize(raw)

    def test_rooms_falls_back_to_url_slug_when_json_key_is_renamed(self):
        c = self._normalize_with_mutated_state(lambda s: s.pop("totalDormitorios"))
        # "...-2-dormitorios-..." in the external_id still yields the answer.
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
        assert c.property_type == "Viviendas"

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
