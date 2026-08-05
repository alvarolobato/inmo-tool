"""Registers real connectors into the orchestrator's CONNECTORS list.

`register_all()` is called by etl/main.py, after it has already imported
`etl.orchestrator` — deliberately NOT an import-time side effect (e.g.
`CONNECTORS.append(...)` at module level) because `etl.orchestrator` itself
imports `etl.connectors.base`, and importing any submodule of a package
always runs that package's `__init__.py` first. An import-time side effect
here would make `etl.orchestrator`'s own import trigger this module, which
would try to import `etl.orchestrator.CONNECTORS` back while `etl.orchestrator`
is still mid-import (line 16 of orchestrator.py, before `CONNECTORS = []` on
line 29 has executed) — a circular import that fails under some import
orders and not others, which is worse than failing consistently. Deferring
the `etl.orchestrator` import to inside this function, called explicitly
after both modules are fully loaded, avoids the cycle entirely. Task 2.1's
second connector adds one more `.append(...)` line inside this function,
not a new registration mechanism.
"""

from __future__ import annotations


def register_all() -> None:
    """Idempotent — safe to call more than once (e.g. a test importing
    etl.main twice, or a future entry point calling it defensively). Skips
    a connector whose `name` is already registered rather than appending a
    duplicate, which would otherwise make the orchestrator run the same
    site twice per sweep.
    """
    from etl.connectors.aliseda import AlisedaConnector
    from etl.connectors.altamira import AltamiraConnector
    from etl.connectors.buildingcenter import BuildingCenterConnector
    from etl.connectors.cimenta2 import Cimenta2Connector
    from etl.connectors.diglo import DigloConnector
    from etl.connectors.fotocasa import FotocasaConnector
    from etl.connectors.fotocasa_rental import FotocasaRentalConnector
    from etl.connectors.idealista import IdealistaConnector
    from etl.connectors.milanuncios import MilanunciosConnector
    from etl.connectors.milanuncios_rental import MilanunciosRentalConnector
    from etl.connectors.servihabitat import ServihabitatConnector
    from etl.connectors.solvia import SolviaConnector
    from etl.connectors.vivantial import VivantialConnector
    from etl.orchestrator import CONNECTORS

    registered_names = {c.name for c in CONNECTORS}
    if FotocasaConnector.name not in registered_names:
        CONNECTORS.append(FotocasaConnector())
    if MilanunciosConnector.name not in registered_names:
        CONNECTORS.append(MilanunciosConnector())
    # Issue #211: rental comps at volume from Fotocasa's SEARCH payload
    # (coordinates + price + m2 + type per listing, no detail fetch) — a
    # subclass of FotocasaConnector overriding discover()/fetch_detail()/
    # normalize() to read the search-results JSON instead of a walled
    # detail page. Born disabled (#100). See fotocasa_rental.py's module
    # docstring and D-066.
    if FotocasaRentalConnector.name not in registered_names:
        CONNECTORS.append(FotocasaRentalConnector())
    # Issue #31: rental comps, same site, separate connector — see
    # milanuncios_rental.py's module docstring for why it's a subclass
    # rather than a change to MilanunciosConnector itself.
    if MilanunciosRentalConnector.name not in registered_names:
        CONNECTORS.append(MilanunciosRentalConnector())
    if ServihabitatConnector.name not in registered_names:
        CONNECTORS.append(ServihabitatConnector())
    if SolviaConnector.name not in registered_names:
        CONNECTORS.append(SolviaConnector())
    if VivantialConnector.name not in registered_names:
        CONNECTORS.append(VivantialConnector())
    if IdealistaConnector.name not in registered_names:
        # scope_key() always returns None (issue #75 — capture-only, never
        # crawls) — registering it here is self-documenting (CONNECTORS is
        # "every known site"), not functionally load-bearing for the
        # orchestrator's normal sweep, which skips it every time.
        CONNECTORS.append(IdealistaConnector())
    if BuildingCenterConnector.name not in registered_names:
        CONNECTORS.append(BuildingCenterConnector())
    # Issue #237: capture-only, same as Idealista above. scope_key() always
    # returns None (D-019 — Aliseda's data host is robots.txt Disallow: /, so
    # there is no live discover(); listings arrive via guided extension
    # capture). Registered here to keep CONNECTORS "every known site".
    if AlisedaConnector.name not in registered_names:
        CONNECTORS.append(AlisedaConnector())
    # Issue #271: capture-only, same as Idealista/Aliseda above. scope_key()
    # always returns None (D-027 — Altamira returns an Akamai WAF 403 on every
    # path, so there is no live discover(); listings arrive via guided
    # extension capture). Registered here to keep CONNECTORS "every known site".
    if AltamiraConnector.name not in registered_names:
        CONNECTORS.append(AltamiraConnector())
    # Issue #136: sitemap-index/discovery only — it enumerates Cajamar's
    # assets and their reference codes, and deliberately never fetches a
    # detail page (D-033). See cimenta2.py's module docstring.
    if Cimenta2Connector.name not in registered_names:
        CONNECTORS.append(Cimenta2Connector())
    # Issue #117: Banco Santander's own REO portal (digloservicer.com).
    # Sitemap-driven full-inventory discovery over a permissive-robots
    # Drupal site; publishes lat/lon (a batch first). Born disabled (#100).
    if DigloConnector.name not in registered_names:
        CONNECTORS.append(DigloConnector())
