"""Unit tests for etl/db/fourd.py.

These tests use stub objects (no real 4D connection required).
They cover the safety logic that is hardest to test via integration tests:
- bytes→str decoding in safe_fetch
- lowercase column normalisation in safe_fetch
- None pass-through in safe_fetch
- _validate_identifier rejecting unsafe strings
- get_queryable_columns with a stub cursor
"""

from __future__ import annotations

import pytest

from etl.db.fourd import _validate_identifier, get_queryable_columns, safe_fetch


# ---------------------------------------------------------------------------
# Stub helpers
# ---------------------------------------------------------------------------


class _StubCursor:
    """Minimal cursor stub for testing safe_fetch and get_queryable_columns."""

    def __init__(self, description: list[tuple], rows: list[tuple]) -> None:
        self.description = description
        self._rows = rows

    def execute(self, sql: str) -> None:
        pass

    def fetchall(self) -> list[tuple]:
        return list(self._rows)

    def close(self) -> None:
        pass


class _StubConn:
    """Minimal connection stub that returns a pre-configured cursor."""

    def __init__(self, description: list[tuple], rows: list[tuple]) -> None:
        self._cursor = _StubCursor(description, rows)

    def cursor(self) -> _StubCursor:
        return self._cursor


# ---------------------------------------------------------------------------
# safe_fetch tests
# ---------------------------------------------------------------------------


def _make_desc(*names: str) -> list[tuple]:
    """Build a cursor.description-like list of 1-tuples from column names."""
    return [(name,) for name in names]


class TestSafeFetch:
    def test_returns_list_of_dicts(self):
        conn = _StubConn(
            description=_make_desc("CODIGO", "PRECIO"),
            rows=[("ABC", 9.99)],
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert result == [{"codigo": "ABC", "precio": 9.99}]

    def test_column_names_lowercased(self):
        conn = _StubConn(
            description=_make_desc("UPPER_COL", "MixedCase"),
            rows=[("x", "y")],
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert "upper_col" in result[0]
        assert "mixedcase" in result[0]

    def test_bytes_decoded_to_str(self):
        conn = _StubConn(
            description=_make_desc("NAME"),
            rows=[(b"caf\xc3\xa9",)],  # UTF-8 bytes for "café"
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert result[0]["name"] == "café"

    def test_bytes_with_replacement_on_invalid_utf8(self):
        conn = _StubConn(
            description=_make_desc("NAME"),
            rows=[(b"\xff\xfe",)],  # invalid UTF-8
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert isinstance(result[0]["name"], str)  # decoded, not bytes

    def test_none_values_preserved(self):
        conn = _StubConn(
            description=_make_desc("COL"),
            rows=[(None,)],
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert result[0]["col"] is None

    def test_empty_result(self):
        conn = _StubConn(description=_make_desc("COL"), rows=[])
        result = safe_fetch(conn, "SELECT * FROM t")
        assert result == []

    def test_multiple_rows(self):
        conn = _StubConn(
            description=_make_desc("ID", "VAL"),
            rows=[(1, "a"), (2, "b"), (3, "c")],
        )
        result = safe_fetch(conn, "SELECT * FROM t")
        assert len(result) == 3
        assert result[2] == {"id": 3, "val": "c"}

    def test_description_none_raises_runtime_error(self):
        conn = _StubConn(description=None, rows=[])
        sql = "SELECT * FROM some_table"
        with pytest.raises(RuntimeError, match="some_table"):
            safe_fetch(conn, sql)


# ---------------------------------------------------------------------------
# _validate_identifier tests
# ---------------------------------------------------------------------------


class TestValidateIdentifier:
    def test_valid_simple(self):
        assert _validate_identifier("Articulos") == "Articulos"

    def test_valid_with_underscores(self):
        assert _validate_identifier("GC_Albaranes_123") == "GC_Albaranes_123"

    def test_valid_starts_with_underscore(self):
        assert _validate_identifier("_USER_COLUMNS") == "_USER_COLUMNS"

    def test_invalid_with_space(self):
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("bad name")

    def test_invalid_with_semicolon(self):
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("t; DROP TABLE foo")

    def test_invalid_with_quote(self):
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("t' OR '1'='1")

    def test_invalid_empty(self):
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            _validate_identifier("")


# ---------------------------------------------------------------------------
# get_queryable_columns tests
# ---------------------------------------------------------------------------


class TestGetQueryableColumns:
    """Test get_queryable_columns with a stub cursor (no real 4D connection)."""

    def test_returns_column_names(self):
        """Returns column names from the stub cursor rows."""
        stub_rows = [("Codigo",), ("Descripcion",), ("Precio",)]
        conn = _StubConn(
            description=[("COLUMN_NAME",)],
            rows=stub_rows,
        )
        result = get_queryable_columns(conn, "Articulos")
        assert result == ["Codigo", "Descripcion", "Precio"]

    def test_empty_result(self):
        """Returns empty list when no queryable columns exist."""
        conn = _StubConn(description=[("COLUMN_NAME",)], rows=[])
        result = get_queryable_columns(conn, "SomeTable")
        assert result == []

    def test_invalid_table_name_raises(self):
        """Rejects an unsafe table name before querying the cursor."""
        conn = _StubConn(description=[("COLUMN_NAME",)], rows=[])
        with pytest.raises(ValueError, match="Unsafe SQL identifier"):
            get_queryable_columns(conn, "bad table'name")
