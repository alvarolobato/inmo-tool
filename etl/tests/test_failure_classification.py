"""Unit tests for the typed failure classifier (issue #242, D-079).

Pure functions, no DB — the integration side (that the orchestrator actually
writes the right value) lives in test_orchestrator.py against real Postgres.
"""

from __future__ import annotations

import pytest

from etl.connectors.base import ConnectorError
from etl.failure_classification import (
    FAILURE_CLASSIFICATIONS,
    classify_error_message,
    classify_fatal_exception,
)


class TestClassifyFatalException:
    @pytest.mark.parametrize(
        "message",
        [
            "Connection timeout after 60s",
            "connection refused by host",
            "Name or service not known (DNS)",
            "SSL handshake failed",
            "network is unreachable",
        ],
    )
    def test_network_markers(self, message):
        assert classify_fatal_exception(ConnectorError(message)) == "network"

    @pytest.mark.parametrize(
        "message",
        [
            "failed to parse listing HTML",
            "no JSON payload in response",
            "expected marker not found in page",
            "CSS selector matched nothing",
        ],
    )
    def test_structure_markers(self, message):
        assert classify_fatal_exception(ConnectorError(message)) == "structure_change"

    def test_exception_type_name_participates(self):
        # A bare AttributeError with no useful message still classifies as a
        # structure break via its type name.
        assert classify_fatal_exception(AttributeError("x")) == "structure_change"

    def test_unknown_falls_back_to_other(self):
        assert classify_fatal_exception(ConnectorError("something weird")) == "other"

    def test_result_is_always_in_the_taxonomy(self):
        for exc in (
            ConnectorError("timeout"),
            ConnectorError("parse error"),
            ConnectorError("???"),
        ):
            assert classify_fatal_exception(exc) in FAILURE_CLASSIFICATIONS


class TestClassifyErrorMessage:
    """Mirrors the one-time SQL backfill in init.sql, branch for branch."""

    def test_clean_or_skipped_status_is_none(self):
        assert classify_error_message("ok", None) is None
        assert classify_error_message("ok", "scopes ok: madrid: ...") is None
        assert (
            classify_error_message("skipped", "disabled via connector_config") is None
        )

    def test_unresolvable_wins_first(self):
        assert (
            classify_error_message("failed", "unresolvable geography madrid: ...")
            == "unresolvable"
        )

    def test_uncovered(self):
        assert (
            classify_error_message(
                "failed", "resolved but uncovered: x -> Ronda/Málaga"
            )
            == "uncovered"
        )

    def test_soft_block_prose(self):
        assert (
            classify_error_message(
                "circuit_open", "nota: bloqueo temporal del sitio (rate-throttling)"
            )
            == "soft_block"
        )

    def test_circuit_open_defaults_to_structure_change(self):
        assert (
            classify_error_message("circuit_open", "circuit breaker open after 8/10")
            == "structure_change"
        )

    def test_failed_network(self):
        assert (
            classify_error_message("failed", "madrid: Connection timeout after 60s")
            == "network"
        )

    def test_failed_structure(self):
        assert (
            classify_error_message("failed", "madrid: failed to parse JSON")
            == "structure_change"
        )

    def test_failed_unclassifiable_is_other(self):
        assert classify_error_message("failed", "madrid: kaboom") == "other"

    def test_result_is_always_none_or_in_the_taxonomy(self):
        for status, msg in [
            ("ok", None),
            ("failed", "timeout"),
            ("circuit_open", "x"),
            ("skipped", "y"),
        ]:
            result = classify_error_message(status, msg)
            assert result is None or result in FAILURE_CLASSIFICATIONS
