"""register_all() wires real connectors into the orchestrator (etl/connectors/__init__.py).

Separate from test_orchestrator.py (which uses DummyConnector exclusively)
because this is the one place that needs to import the real Fotocasa/
Milanuncios classes to prove they actually get registered — a connector
existing and being unit-tested in isolation (test_connector_<site>.py) does
not by itself mean etl.main's real run picks it up. Phase 2.1 shipped
without this: milanuncios.py existed and passed its own tests, but nothing
appended it to CONNECTORS, so it would never actually run.
"""

from __future__ import annotations

from etl.connectors import register_all
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.milanuncios import MilanunciosConnector
from etl.orchestrator import CONNECTORS


def _reset_connectors():
    CONNECTORS.clear()


class TestRegisterAll:
    def test_registers_both_real_connectors(self):
        _reset_connectors()
        try:
            register_all()
            names = [c.name for c in CONNECTORS]
            # Superset + no-duplicates rather than an exact count: this test
            # shouldn't need editing every time a future task adds another
            # connector (2.2 onward will).
            assert FotocasaConnector.name in names
            assert MilanunciosConnector.name in names
            assert len(names) == len(set(names)), f"duplicate registrations: {names}"
        finally:
            _reset_connectors()

    def test_every_discovery_connector_has_a_home_url(self):
        """Issue #515 EC-3: after registration, every connector that appears on
        the Validar-filtros ETL section (supports_discovery=True) reports a
        non-null home_url — either derived from its override_host_suffix or set
        explicitly (the four non-tunable structural connectors). No such row may
        leave "Abrir" a dead button. Capture-only portals (supports_discovery=
        False) derive their home page from CAPTURE_PORTALS on the dashboard side,
        so they are intentionally not required to carry one in Python."""
        _reset_connectors()
        try:
            register_all()
            missing = [
                c.name for c in CONNECTORS if c.supports_discovery and not c.home_url
            ]
            assert missing == [], f"discovery connectors without a home_url: {missing}"
        finally:
            _reset_connectors()

    def test_idempotent_does_not_duplicate_on_repeated_calls(self):
        _reset_connectors()
        try:
            register_all()
            count_after_first = len(CONNECTORS)
            register_all()
            names = [c.name for c in CONNECTORS]
            assert len(names) == len(set(names)), f"duplicate registrations: {names}"
            assert len(CONNECTORS) == count_after_first
        finally:
            _reset_connectors()
