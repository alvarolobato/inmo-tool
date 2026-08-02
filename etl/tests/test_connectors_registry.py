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
            names = {c.name for c in CONNECTORS}
            assert FotocasaConnector.name in names
            assert MilanunciosConnector.name in names
            assert len(CONNECTORS) == 2
        finally:
            _reset_connectors()

    def test_idempotent_does_not_duplicate_on_repeated_calls(self):
        _reset_connectors()
        try:
            register_all()
            register_all()
            names = [c.name for c in CONNECTORS]
            assert len(names) == len(set(names)), f"duplicate registrations: {names}"
            assert len(CONNECTORS) == 2
        finally:
            _reset_connectors()
