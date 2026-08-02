"""Tests for cli/lib/sql_guard.py — a generic read-only SQL allowlist.

Lives under etl/tests/ (not scripts/tests/ or a cli test dir) because the CI
`test` job only runs `pytest etl/tests/`. The `ps sql query` command that
originally consumed this guard was removed in task 1.1 (#9) along with the
rest of the 4D-specific CLI, but the guard utility itself is kept for reuse
by any future read-only DB inspection command (task 1.5, #13) — these tests
stay meaningful regardless of which command ends up calling it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cli" / "lib"))

from sql_guard import validate_readonly_sql  # noqa: E402


class TestAcceptsReadOnly:
    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT 1",
            "select * from Ventas",
            "  SELECT COUNT(*) FROM Articulos  ",
            "SELECT * FROM Ventas;",  # single trailing semicolon tolerated
            "SELECT Codigo FROM Articulos WHERE Nombre = 'a;b'",  # ; in literal
            "SELECT Codigo FROM Articulos WHERE Nombre = 'it''s'",  # '' escape
            "SELECT 1 -- trailing comment",
            "SELECT /* inline */ 1",
            "-- leading comment\nSELECT 1",
            '/* block */ SELECT "Mixed Case Col" FROM Ventas',
            "SELECT 'DELETE FROM Ventas' AS txt FROM Ventas",  # verb in literal
            "SELECT Fecha FROM Ventas WHERE Fecha >= {d '2026-01-01'}",
        ],
    )
    def test_valid_select_passes(self, sql):
        assert validate_readonly_sql(sql) is None


class TestRejectsBypasses:
    """The exact bypasses from issue #832 — each defeated the old startswith check."""

    @pytest.mark.parametrize(
        "sql",
        [
            "/* x */ DELETE FROM Ventas",
            "-- nota\nDROP TABLE Ventas",
            "SELECT 1; DELETE FROM Ventas",
            "SELECT 1;DROP TABLE Ventas;",
            "  \t/* a */ /* b */ UPDATE Ventas SET Total = 0",
        ],
    )
    def test_bypass_rejected(self, sql):
        assert validate_readonly_sql(sql) is not None

    @pytest.mark.parametrize(
        "sql",
        [
            "INSERT INTO Ventas VALUES (1)",
            "UPDATE Ventas SET Total = 0",
            "DELETE FROM Ventas",
            "DROP TABLE Ventas",
            "ALTER TABLE Ventas ADD COLUMN x INT",
            "CREATE TABLE x (id INT)",
            "TRUNCATE Ventas",
            "WITH t AS (SELECT 1) DELETE FROM Ventas",  # allowlist, not blocklist
            "EXECUTE IMMEDIATE 'DROP TABLE Ventas'",
        ],
    )
    def test_non_select_verbs_rejected(self, sql):
        err = validate_readonly_sql(sql)
        assert err is not None
        assert "read-only" in err.lower() or "select" in err.lower()


class TestRejectsMalformed:
    @pytest.mark.parametrize(
        "sql",
        [
            "",
            "   ",
            ";",
            "--only a comment",
            "/* only a comment */",
            "SELECT 'unterminated",
            "SELECT /* unterminated",
            'SELECT "unterminated',
        ],
    )
    def test_malformed_rejected(self, sql):
        assert validate_readonly_sql(sql) is not None

    def test_non_string_rejected(self):
        assert validate_readonly_sql(None) is not None  # type: ignore[arg-type]


class TestQuotedIdentifierEscapes:
    """`""` embeds a literal double-quote in a SQL identifier (#846 review)."""

    def test_doubled_quote_in_identifier_accepted(self):
        assert validate_readonly_sql('SELECT "Precio""IVA" FROM Articulos') is None

    def test_doubled_quote_does_not_unbalance(self):
        # The "" must not be read as a closing+opening quote that swallows the rest.
        assert validate_readonly_sql('SELECT "a""b" FROM t WHERE x = 1') is None
