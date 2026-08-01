"""4D SQL (P4D) connection helpers.

Gotchas handled here:
- Column names are returned as BYTES by the p4d driver (e.g. b'REGARTICULO').
  safe_fetch() decodes them to lowercase str so callers always work with str keys.
- Text fields may return bytes in Python 3.13+ — always decode.
- Column names are returned UPPERCASE from 4D — normalize to lowercase.
- Some columns have type 0 (unknown to p4d); SELECT * on those tables raises
  "Unrecognized 4D type: 0". Use get_queryable_columns() to filter them out.
- PKs are REAL (float) with a .99 suffix — returned as Python float.
  WARNING: floats must be converted to decimal.Decimal before inserting into
  the NUMERIC pk columns in PostgreSQL to avoid precision loss (e.g. 10028816.641
  stored as a float may round incorrectly).  Sync modules are responsible for
  this conversion.
- None values are passed through unchanged.
- **Signed 16-bit integers over SQL** (``_USER_COLUMNS`` type **3**, length **2** —
  e.g. all ``Exportaciones.Stock1``…``Stock34``): the SQL/p4d path may widen the
  bit pattern as unsigned (``65535`` for ``-1``). Call ``decode_signed_int16_word()``
  **only** for those columns (rule: **metadata** says 16-bit integer, not guesswork).
  Do **not** apply to ``DATA_TYPE = 6`` (Real) columns such as ``LineasVentas.Unidades``.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from etl.config import Config

# Allowlist pattern for 4D table/column names (letters, digits, underscores).
# 4D table names in this project follow this pattern; reject anything that
# does not match to prevent SQL injection via get_queryable_columns().
_SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Integer strings (optional leading minus) for WORD decode coercion.
_SIGNED_INT16_DECIMAL_STR = re.compile(r"-?\d+$")


def _validate_identifier(name: str) -> str:
    """Raise ValueError if *name* is not a safe SQL identifier."""
    if not _SAFE_IDENTIFIER_RE.match(name):
        raise ValueError(
            f"Unsafe SQL identifier: {name!r}. "
            "Only letters, digits, and underscores are allowed."
        )
    return name


def get_connection(config: "Config"):  # type: ignore[return]
    """Return a p4d connection using the supplied Config.

    Raises ImportError if p4d is not installed.
    Raises an appropriate connection error if the server is unreachable.
    """
    try:
        import p4d  # type: ignore[import-untyped]
    except ImportError as exc:
        raise ImportError("p4d package is not installed. Run: pip install p4d") from exc

    return p4d.connect(
        host=config.p4d_host,
        port=config.p4d_port,
        user=config.p4d_user,
        password=config.p4d_password,
    )


def _decode_value(v: Any) -> Any:
    """Decode bytes to str and strip NUL characters; pass other types through.

    PostgreSQL rejects string literals containing NUL (0x00) characters with
    "A string literal cannot contain NUL (0x00) characters."  Some 4D text
    fields contain embedded NUL bytes (e.g. padding in fixed-length fields or
    corrupted data).  Stripping them here is the safest fix — NUL bytes carry
    no semantic meaning in these text fields.
    """
    if isinstance(v, bytes):
        decoded = v.decode("utf-8", errors="replace")
        return decoded.replace("\x00", "")
    if isinstance(v, str):
        # Also strip NUL from native str values (p4d may return str with NUL).
        return v.replace("\x00", "") if "\x00" in v else v
    return v


def decode_signed_int16_word(value: Any) -> Any:
    """Map an unsigned 32-bit carrier of a **signed int16** bit pattern to Python ``int``.

    This is **not** a business heuristic: integers in ``32768..65535`` are exactly
    the unsigned widening of signed int16 negatives (``65535`` → ``-1``, etc.) —
    reinterpret the low 16 bits as two's-complement signed.

    **When to call:** only for 4D columns that ``_USER_COLUMNS`` declares as
    **``DATA_TYPE = 3``** and **``DATA_LENGTH = 2``** (16-bit integer). In this
    project that is **exclusively** ``Exportaciones.Stock1``…``Stock34`` (verified
    on production). Do **not** call for ``DATA_TYPE = 6`` (Real) fields.

    The SQL/p4d stack sometimes delivers small negatives in those 16-bit slots
    as ``65535``, ``65534``, etc.

    Args:
        value: Raw value from ``safe_fetch`` (``int``, whole ``float``, ``Decimal``, ``str``, …).

    Returns:
        Values in ``32768..65535`` become signed ``int`` (``-32768..-1``).
        Finite integral ``Decimal`` outside that band becomes ``int`` with the same
        numeric value. ``None``, booleans, non-numeric strings, and fractional
        ``float`` / ``Decimal`` are unchanged. ``int`` outside the decode band is
        unchanged; whole ``float`` outside the band is returned as the original
        ``float``.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        s = value.strip()
        if _SIGNED_INT16_DECIMAL_STR.fullmatch(s):
            value = int(s)
        else:
            return value
    if isinstance(value, int):
        if 32768 <= value <= 65535:
            return value - 65536
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return value
        if not value.is_integer():
            return value
        iv = int(value)
        if 32768 <= iv <= 65535:
            return iv - 65536
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            return value
        if value != value.to_integral_value():
            return value
        iv = int(value)
        if 32768 <= iv <= 65535:
            return iv - 65536
        return iv
    return value


def _decode_column_name(name: Any) -> str:
    """Decode a cursor description column name to a lowercase str.

    p4d returns column names as bytes (e.g. b'REGARTICULO').  Decoding here
    keeps all callers simple — they always receive plain str keys.
    """
    if isinstance(name, bytes):
        return name.decode("utf-8", errors="replace").lower()
    return str(name).lower()


def safe_fetch(conn, sql: str) -> list[dict]:
    """Execute *sql* and return a list of dicts with lowercase str keys.

    - Column names are decoded from bytes to str and lowercased (p4d returns
      them as uppercase bytes, e.g. b'REGARTICULO' → 'regarticulo').
    - Decodes bytes values to str.
    - None values are preserved.
    - The cursor is always closed after fetching.
    """
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        if cursor.description is None:
            raise RuntimeError(
                f"Query returned no column metadata (non-SELECT or p4d quirk): {sql[:200]}"
            )
        columns = [_decode_column_name(desc[0]) for desc in cursor.description]
        rows = cursor.fetchall()
    finally:
        cursor.close()
    return [dict(zip(columns, (_decode_value(v) for v in row))) for row in rows]


def get_queryable_columns(conn, table_name: str) -> list[str]:
    """Return column names for *table_name* where DATA_TYPE != 0.

    4D type 0 columns are not understood by p4d and cause "Unrecognized 4D
    type: 0" errors on SELECT.  Filtering them out here lets callers build
    safe explicit column lists.

    The returned names use the original casing from _USER_COLUMNS (which
    matches what 4D expects in SQL statements).

    *table_name* is validated against a safe-identifier pattern to prevent
    SQL injection (p4d does not support parameterised queries on system tables).
    """
    _validate_identifier(table_name)
    sql = (
        f"SELECT COLUMN_NAME FROM _USER_COLUMNS "
        f"WHERE TABLE_NAME = '{table_name}' AND DATA_TYPE <> 0"
    )
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        return [row[0] for row in cursor.fetchall()]
    finally:
        cursor.close()
