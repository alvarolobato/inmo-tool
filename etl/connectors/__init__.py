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
    from etl.connectors.fotocasa import FotocasaConnector
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
