"""Per-connector `search_previews()` contract (issue #478 P4).

Pure/offline (no DB, no network): every preview a connector produces must use
the SAME helper/constant its `discover()` builds the real request from, so a
preview can never drift from what the ETL actually does. The non-tunable
sitemap/API connectors must declare that truth (tunable=False + an honest note),
and the capture-only portals must produce no ETL preview at all (their preview
lives on the TypeScript side).
"""

from __future__ import annotations

from etl.connectors import (
    aliseda,
    altamira,
    buildingcenter,
    cimenta2,
    diglo,
    escogecasa,
    fotocasa,
    fotocasa_rental,
    habitaclia,
    idealista,
    milanuncios,
    milanuncios_rental,
    pisos,
    servihabitat,
    solvia,
    unicaja,
    vivantial,
)
from etl.connectors.base import ConnectorScope, SearchPreview

# A scope whose free-text geography escape hatch resolves offline for each
# connector (no gazetteer/network needed) — see each connector's
# _resolve_geography docstring for why scope.geography wins.
_CITY = ConnectorScope(geography="dos-hermanas")
_PROV = ConnectorScope(geography="sevilla")
_PROV_NAME = ConnectorScope(geography="Sevilla")
_BBOX = ConnectorScope(geography="37.3891,-5.9845")


def _one(connector, scope) -> SearchPreview:
    previews = connector.search_previews(scope)
    assert len(previews) == 1, f"{connector.name}: expected one preview"
    return previews[0]


class TestTunablePreviewsMatchDiscoverHelper:
    """preview.url == the exact helper/constant discover() builds its entry
    request from — the shared-helper, no-duplication contract."""

    def test_pisos(self):
        c = pisos.PisosConnector()
        p = _one(c, _CITY)
        assert p.url == c._search_url("dos-hermanas")
        assert p.kind == "search_page"
        assert p.tunable is True
        assert c.override_host_suffix == "pisos.com"

    def test_habitaclia(self):
        c = habitaclia.HabitacliaConnector()
        p = _one(c, _CITY)
        assert p.url == c._search_url("dos-hermanas")
        assert p.tunable is True
        assert c.override_host_suffix == "habitaclia.com"

    def test_fotocasa(self):
        c = fotocasa.FotocasaConnector()
        p = _one(c, _CITY)
        assert p.url == c._search_url("dos-hermanas", fotocasa._ZONE_SLUG_ALL, "")
        assert p.tunable is True
        assert c.override_host_suffix == "fotocasa.es"

    def test_fotocasa_rooms_segment_flows_into_preview(self):
        c = fotocasa.FotocasaConnector()
        scope = ConnectorScope(geography="dos-hermanas", rooms=2)
        p = _one(c, scope)
        assert p.url == c._search_url(
            "dos-hermanas", fotocasa._ZONE_SLUG_ALL, "2-habitaciones/"
        )

    def test_fotocasa_rental(self):
        c = fotocasa_rental.FotocasaRentalConnector()
        p = _one(c, _CITY)
        assert p.url == c._rental_search_url("dos-hermanas")
        assert p.tunable is True
        # inherits the sale connector's host suffix
        assert c.override_host_suffix == "fotocasa.es"

    def test_milanuncios(self):
        c = milanuncios.MilanunciosConnector()
        p = _one(c, _PROV)
        assert p.url == c._search_url("sevilla")
        assert p.tunable is True
        assert c.override_host_suffix == "milanuncios.com"

    def test_milanuncios_rental(self):
        c = milanuncios_rental.MilanunciosRentalConnector()
        p = _one(c, _PROV)
        assert p.url == c._rental_search_url("sevilla")
        assert p.tunable is True
        assert c.override_host_suffix == "milanuncios.com"

    def test_servihabitat(self):
        c = servihabitat.ServihabitatConnector()
        p = _one(c, _PROV)
        assert p.url == servihabitat._sitemap_url("sevilla")
        assert p.kind == "sitemap"
        assert p.tunable is True
        assert c.override_host_suffix == "servihabitat.com"

    def test_solvia(self):
        c = solvia.SolviaConnector()
        p = _one(c, _PROV)
        # Issue #495: the preview is now a HUMAN search page (the provincia
        # entry page discover() sweeps), not the sitemap XML — built from the
        # same `_search_url()` helper discover() uses per municipio.
        assert p.url == c._search_url("sevilla", "")
        assert p.kind == "search_page"
        assert p.tunable is True
        assert c.override_host_suffix == "solvia.es"

    def test_diglo(self):
        c = diglo.DigloConnector()
        p = _one(c, _PROV_NAME)
        province = c._scope_province(_PROV_NAME)
        assert p.url == c._search_url(province, 0)
        assert p.tunable is True
        assert c.override_host_suffix == "digloservicer.com"

    def test_unicaja(self):
        c = unicaja.UnicajaConnector()
        p = _one(c, _PROV_NAME)
        ine = c._scope_ine_code(_PROV_NAME)
        assert p.url == unicaja._search_url(ine, 1)
        assert p.tunable is True
        assert c.override_host_suffix == "unicajainmuebles.com"


class TestUnresolvedScopeIsDegraded:
    """A scope that resolves to nothing yields a single degraded row (url=None
    + a note), never an empty list — so the page always has something to show."""

    def test_pisos_unresolved(self):
        c = pisos.PisosConnector()
        p = _one(c, ConnectorScope())  # no center, no geography
        assert p.url is None
        assert p.notes is not None
        assert p.tunable is True


class TestNonTunablePreviewsDeclareTheirTruth:
    """The sitemap/API connectors must declare tunable=False with an honest
    note and no override host suffix — nothing to pin, filtering is by data."""

    def test_cimenta2(self):
        c = cimenta2.Cimenta2Connector()
        p = _one(c, _PROV)
        assert p.url == cimenta2._SITEMAP_INDEX_URL
        assert p.kind == "sitemap"
        assert p.tunable is False
        assert p.notes is not None
        assert c.override_host_suffix is None

    def test_vivantial(self):
        c = vivantial.VivantialConnector()
        p = _one(c, _PROV)
        assert p.url == vivantial._SITEMAP_URL
        assert p.tunable is False
        assert p.notes is not None
        assert c.override_host_suffix is None

    def test_buildingcenter(self):
        c = buildingcenter.BuildingCenterConnector()
        p = _one(c, _PROV)
        assert p.url == buildingcenter._SEARCH_URL
        assert p.kind == "api"
        assert p.tunable is False
        assert p.notes is not None
        assert c.override_host_suffix is None

    def test_escogecasa(self):
        c = escogecasa.EscogecasaConnector()
        p = _one(c, _BBOX)
        assert p.url == escogecasa._SEARCH_ACTION
        assert p.kind == "api"
        assert p.tunable is False
        assert p.notes is not None
        assert c.override_host_suffix is None


class TestCaptureOnlyConnectorsHaveNoEtlPreview:
    """idealista/aliseda/altamira are capture-only: their preview is on the TS
    side, so search_previews() is empty and they accept no pinned URL here."""

    def test_capture_only(self):
        for conn in (
            idealista.IdealistaConnector(),
            aliseda.AlisedaConnector(),
            altamira.AltamiraConnector(),
        ):
            assert conn.search_previews(_CITY) == [], conn.name
            assert conn.override_host_suffix is None, conn.name
