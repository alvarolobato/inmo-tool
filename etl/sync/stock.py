"""ETL sync for stock domain: Exportaciones (ps_stock_tienda) and Traspasos (ps_traspasos).

Exportaciones normalization
---------------------------
The source table is wide-format: one row per (article, store) pair with columns
Talla1..Talla34 and Stock1..Stock34.  Each row is unpivoted into individual
(codigo, tienda_codigo, talla, stock) rows for ps_stock_tienda.

Batch processing is critical: Exportaciones has ~2M source rows.  We fetch in
batches of 1000 source rows (configurable via _SOURCE_BATCH) to avoid loading
the full wide table into memory.  Each batch is normalized and upserted immediately.
Pagination uses LIMIT/OFFSET with a stable ORDER BY (Codigo, TiendaCodigo) to
provide consistent page boundaries in the absence of concurrent modifications.
Note: LIMIT/OFFSET is not fully safe against concurrent inserts/deletes — a row
added or removed before the current OFFSET can shift later pages and cause some
rows to be processed twice or skipped.  For a nightly ETL where Exportaciones is
effectively quiescent this is acceptable; use keyset pagination if strict
consistency under concurrent writes is required.

Note on pagination performance: LIMIT/OFFSET scanning can degrade at large offsets
because the DB engine must scan all preceding rows.  At 2M source rows this is
acceptable for a nightly batch (profiled at <10 min in testing), but keyset
pagination (WHERE (Codigo, TiendaCodigo) > (:last_codigo, :last_tienda_codigo))
would be more efficient if runtime becomes a concern.  4D SQL's support for
row-value comparators was not validated at implementation time.

The `since` parameter is truncated to a date literal in 4D SQL — only the date
portion is used; any time component is ignored.  Pass a date-aligned datetime.

``Stock1``…``Stock34`` in 4D are 16-bit WORD fields: negatives are delivered as
unsigned values (e.g. ``65535`` for ``-1``).  ``_normalize_expo_row`` decodes them
via ``decode_signed_int16_word`` before persisting to PostgreSQL.

TiendaCodigo format: "store_code/article_code" (e.g. "104/169").  It is NOT
just a store code.  The compound PK for ps_stock_tienda is (codigo, tienda_codigo, talla).

Traspasos
---------
Append-only by FechaS.  No modification timestamp.  Fetched and inserted in batches.
Insert uses ON CONFLICT (reg_traspaso) DO NOTHING (via insert_ignore) so the
operation is idempotent: re-running with an overlapping delta window or running an
initial load twice will not cause PK violations or update existing rows.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from etl.db.fourd import decode_signed_int16_word, safe_fetch
from etl.db.postgres import insert_ignore, upsert

logger = logging.getLogger(__name__)

# Number of source rows to fetch per SQL query (Exportaciones is wide format —
# each row expands to ~5 normalized rows on average; Traspasos uses same constant).
_SOURCE_BATCH = 1000

# Number of normalized rows to upsert per PG call.
_PG_BATCH = 5000

# Column pairs to unpivot.
_MAX_TALLA = 34

# Fixed columns to select from Exportaciones.
_EXPO_FIXED_COLS = [
    "Codigo",
    "TiendaCodigo",
    "Tienda",
    "CCStock",
    "STStock",
    "FechaModifica",
]

# Talla + Stock columns in order.
_EXPO_TALLA_COLS = [f"Talla{i}" for i in range(1, _MAX_TALLA + 1)]
_EXPO_STOCK_COLS = [f"Stock{i}" for i in range(1, _MAX_TALLA + 1)]

# Full SELECT column list (original 4D casing, required by 4D SQL).
_EXPO_COLUMNS = ", ".join(_EXPO_FIXED_COLS + _EXPO_TALLA_COLS + _EXPO_STOCK_COLS)

# Stable ORDER BY for deterministic LIMIT/OFFSET pagination.
_EXPO_ORDER_BY = "ORDER BY Codigo, TiendaCodigo"

# Quantize target for NUMERIC(20,3) PK values. Three decimal places, matching
# the ps_* schema convention (see etl/schema/init.sql header): some 4D Real PKs
# carry 3-decimal values (e.g. 4.152 vs 4.153) — quantizing to 2 places made
# them collide on the same key and silently lose rows (issue #827).
_THREE_PLACES = Decimal("0.001")


def _validate_since(since: datetime, name: str = "since") -> None:
    """Log a warning if *since* has a non-zero time component and return silently.

    The 4D SQL date filter uses {d 'YYYY-MM-DD'} and silently drops any time
    portion.  Watermarks stored by set_watermark() include a time component
    (datetime.now(timezone.utc)), so raising here would break all delta syncs.
    We log a warning instead so the behaviour is visible without breaking the
    pipeline.  Callers should pass midnight-aligned datetimes when possible,
    but the date-only filter is still correct for day-granularity delta syncs.
    """
    if (
        since.hour != 0
        or since.minute != 0
        or since.second != 0
        or since.microsecond != 0
    ):
        logger.debug(
            "%s=%r has a non-zero time component — only the date portion "
            "(YYYY-MM-DD) will be used in the 4D SQL filter.",
            name,
            since,
        )


def _build_expo_where(since: datetime | None, *, include_nulls: bool = False) -> str:
    """Return a WHERE clause fragment for Exportaciones delta filtering.

    Only the date portion of *since* is used — 4D SQL date literals have no
    time component.  Pass a midnight-aligned datetime to avoid confusion.
    Logs a debug warning if *since* has a non-zero time component (does not raise).

    - since=None: no filter (full load).
    - since=<datetime>: filter by FechaModifica >= {d 'YYYY-MM-DD'}.
    - include_nulls=True: also include rows where FechaModifica IS NULL
      (zero-stock articles that have never been modified).

    Uses `>=` (not strict `>`): FechaModifica is date-only, so once the
    watermark advances to today, strict `>` would silently skip same-day
    updates until tomorrow. `>=` re-fetches those rows; upsert is
    idempotent. See issue #459 / PR #461 for the same fix in ventas.py.
    """
    if since is None:
        return ""
    _validate_since(since, "since")
    date_str = since.strftime("%Y-%m-%d")
    cond = f"FechaModifica >= {{d '{date_str}'}}"
    if include_nulls:
        cond = f"({cond} OR FechaModifica IS NULL)"
    return f"WHERE {cond}"


def _count_expo(conn_4d, where: str) -> int:
    """Return row count for Exportaciones with given WHERE clause.

    Uses an explicit ``AS cnt`` alias so the returned column key is deterministic
    across p4d driver versions — bare ``COUNT(*)`` has produced rows whose first
    value is ``None``, which caused ``int(None)`` to blow up the whole sync. If
    the driver still returns a row without a usable value, we treat it as 0
    rather than abort: COUNT is used for progress logging only.
    """
    sql = f"SELECT COUNT(*) AS cnt FROM Exportaciones {where}".strip()
    rows = safe_fetch(conn_4d, sql)
    if not rows:
        return 0
    val = rows[0].get("cnt")
    if val is None and rows[0]:
        val = next(iter(rows[0].values()))
    return int(val) if val is not None else 0


def _normalize_expo_row(src: dict) -> list[dict]:
    """Unpivot one wide Exportaciones row into normalized (talla, stock) rows.

    Raises ValueError if Codigo or TiendaCodigo is missing/None — these fields
    form part of the target primary key and silent NULL-to-empty coercion would
    produce invalid keys that collide on upsert.

    Only emits a row if Talla_i is not None and not an empty/whitespace string.

    Decimal conversions for cc_stock and st_stock are computed once per source
    row (not per talla pair) to avoid redundant CPU work at Exportaciones scale.
    """
    codigo = src.get("codigo")
    tienda_codigo = src.get("tiendacodigo")

    if not codigo:
        # Include only the key identifiers in the message, not the full wide row,
        # to keep logs readable (Exportaciones rows have 74+ columns).
        raise ValueError(
            f"_normalize_expo_row: source row has missing/empty Codigo "
            f"(tiendacodigo={tienda_codigo!r}, fechamodifica={src.get('fechamodifica')!r})"
        )
    if not tienda_codigo:
        raise ValueError(
            f"_normalize_expo_row: source row has missing/empty TiendaCodigo "
            f"(codigo={codigo!r}, fechamodifica={src.get('fechamodifica')!r})"
        )

    # Convert shared fields once per source row (not per talla pair).
    cc_stock_raw = src.get("ccstock")
    st_stock_raw = src.get("ststock")
    cc_stock = Decimal(str(cc_stock_raw)) if cc_stock_raw is not None else None
    st_stock = Decimal(str(st_stock_raw)) if st_stock_raw is not None else None
    tienda = src.get("tienda")
    fecha_modifica = src.get("fechamodifica")

    out: list[dict] = []
    for i in range(1, _MAX_TALLA + 1):
        talla = src.get(f"talla{i}")
        stock_raw = src.get(f"stock{i}")
        if talla is None or (isinstance(talla, str) and not talla.strip()):
            continue
        talla_str = talla.strip() if isinstance(talla, str) else str(talla)
        if stock_raw is None:
            stock_val = 0
        else:
            decoded = decode_signed_int16_word(stock_raw)
            stock_val = int(decoded)
        out.append(
            {
                "codigo": codigo,
                "tienda_codigo": tienda_codigo,
                "tienda": tienda,
                "talla": talla_str,
                "stock": stock_val,
                "cc_stock": cc_stock,
                "st_stock": st_stock,
                "fecha_modifica": fecha_modifica,
            }
        )
    return out


def _get_store_codes(conn_4d) -> list[str]:
    """Return the distinct Tienda codes from Exportaciones."""
    rows = safe_fetch(conn_4d, "SELECT DISTINCT Tienda FROM Exportaciones")
    return sorted(r["tienda"] for r in rows if r.get("tienda"))


def sync_stock(conn_4d, conn_pg, since: datetime | None = None) -> int:
    """Extract Exportaciones from 4D, normalize, and upsert into ps_stock_tienda.

    Progressive approach: fetches one store at a time (~41K rows per store)
    to avoid OOM on the full 2M-row table. Each store's data fits comfortably
    in memory and is upserted immediately before moving to the next store.

    For delta syncs (since is set), only rows modified after the date are fetched
    per store. For initial loads, all rows for each store are fetched.

    Args:
        conn_4d: P4D connection object.
        conn_pg: psycopg2 connection object.
        since: If provided, only fetch rows where FechaModifica >= since (date only).
               If None, fetch all rows (initial load).

    Returns:
        Total number of normalized rows attempted (upserted or updated).
    """
    include_nulls = since is None
    where = _build_expo_where(since, include_nulls=include_nulls)

    total_source = _count_expo(conn_4d, where)
    logger.info(
        "sync_stock: %d source rows to process %s",
        total_source,
        f"({where})" if where else "(full)",
    )

    # Get all store codes and process one store at a time (progressive)
    stores = _get_store_codes(conn_4d)
    logger.info("sync_stock: processing %d stores progressively", len(stores))

    total_processed = 0
    total_skipped = 0
    for store_idx, store_code in enumerate(stores):
        # Validate store code before interpolating into SQL (defense-in-depth).
        # ERP codes are numeric or alphanumeric with optional slashes/dashes.
        if not re.match(r"^[A-Za-z0-9/_-]+$", store_code):
            logger.warning(
                "sync_stock: skipping store with unexpected code format: %r",
                store_code,
            )
            continue

        # Build per-store query
        store_filter = f"Tienda = '{store_code}'"
        if where:
            store_where = f"{where} AND {store_filter}"
        else:
            store_where = f"WHERE {store_filter}"

        sql = f"SELECT {_EXPO_COLUMNS} FROM Exportaciones {store_where}".strip()
        store_rows = safe_fetch(conn_4d, sql)

        if not store_rows:
            continue

        # Normalize and upsert this store's data. A row with a missing PK
        # component (Codigo / TiendaCodigo) is logged and skipped — one corrupt
        # source record must not abort the sync for all ~50 stores and stall
        # the watermark in a permanent retry loop (issue #820).
        pg_buffer: list[dict] = []
        store_skipped = 0
        for src_row in store_rows:
            try:
                pg_buffer.extend(_normalize_expo_row(src_row))
            except ValueError as exc:
                store_skipped += 1
                logger.warning(
                    "sync_stock: skipping invalid row in store %s: %s",
                    store_code,
                    exc,
                )
        total_skipped += store_skipped

        # Upsert in batches
        store_processed = 0
        for i in range(0, len(pg_buffer), _PG_BATCH):
            chunk = pg_buffer[i : i + _PG_BATCH]
            attempted = upsert(
                conn_pg,
                "ps_stock_tienda",
                chunk,
                pk_cols=["codigo", "tienda_codigo", "talla"],
            )
            store_processed += attempted

        total_processed += store_processed
        logger.info(
            "sync_stock: store %s (%d/%d): %d source rows → %d normalized rows (total: %d)",
            store_code,
            store_idx + 1,
            len(stores),
            len(store_rows),
            store_processed,
            total_processed,
        )

    if total_skipped > 0:
        logger.warning(
            "sync_stock: skipped %d invalid source row(s) across the run — "
            "check the warnings above and fix the source data in 4D",
            total_skipped,
        )
    logger.info(
        "sync_stock: done — %d normalized rows processed across %d stores",
        total_processed,
        len(stores),
    )
    return total_processed


# ---------------------------------------------------------------------------
# Traspasos (append-only, idempotent)
# ---------------------------------------------------------------------------

# Columns to SELECT from Traspasos (explicit list to avoid type-0 columns).
_TRASPASOS_COLUMNS = (
    "RegTraspaso, Codigo, Descripcion, Talla, UnidadesS, UnidadesE, "
    "TiendaSalida, TiendaEntrada, FechaS, FechaE, Tipo, Concepto, Entrada"
)

# Stable ORDER BY for deterministic LIMIT/OFFSET pagination on Traspasos.
_TRASPASOS_ORDER_BY = "ORDER BY RegTraspaso"


def _map_traspaso_row(src: dict) -> dict:
    """Map a safe_fetch row (lowercase keys) to ps_traspasos column names.

    4D float PKs are converted to Decimal and quantized to 3 decimal places
    (matching the NUMERIC(20,3) PG schema) to prevent float-string artifacts
    such as trailing ...99999 digits from causing unexpected key differences.
    Scale 3 is required: real RegTraspaso values can differ only in the third
    decimal, and rounding to 2 places collides them (issue #827).
    """
    reg = src.get("regtraspaso")
    if reg is None:
        # ps_traspasos.reg_traspaso is NOT NULL PRIMARY KEY — fail fast with context
        # rather than letting the database raise an opaque constraint violation.
        raise ValueError(
            f"_map_traspaso_row: source row is missing RegTraspaso "
            f"(codigo={src.get('codigo')!r}, fechas={src.get('fechas')!r})"
        )
    reg_decimal = Decimal(str(reg)).quantize(_THREE_PLACES, rounding=ROUND_HALF_UP)
    return {
        "reg_traspaso": reg_decimal,
        "codigo": src.get("codigo"),
        "descripcion": src.get("descripcion"),
        "talla": src.get("talla"),
        "unidades_s": src.get("unidadess"),
        "unidades_e": src.get("unidadese"),
        "tienda_salida": src.get("tiendasalida"),
        "tienda_entrada": src.get("tiendaentrada"),
        "fecha_s": src.get("fechas"),
        "fecha_e": src.get("fechae"),
        "tipo": src.get("tipo"),
        "concepto": src.get("concepto"),
        "entrada": src.get("entrada"),
    }


def _build_traspasos_where(since: datetime | None) -> str:
    """Return a WHERE clause fragment for Traspasos delta filtering.

    Only the date portion of *since* is used — 4D SQL date literals have no
    time component.  Logs a debug warning if *since* has a non-zero time component (does not raise).

    Uses `>=` (not strict `>`): FechaS is date-only, so once the watermark
    advances to today, strict `>` would silently skip same-day transfers.
    `>=` re-fetches those rows; insert-ignore is idempotent. See issue #459.
    """
    if since is None:
        return ""
    _validate_since(since, "since")
    date_str = since.strftime("%Y-%m-%d")
    return f"WHERE FechaS >= {{d '{date_str}'}}"


def _count_traspasos(conn_4d, where: str) -> int:
    """Return row count for Traspasos with given WHERE clause.

    See ``_count_expo`` for the rationale behind the explicit ``AS cnt`` alias
    and the None-value fallback.
    """
    sql = f"SELECT COUNT(*) AS cnt FROM Traspasos {where}".strip()
    rows = safe_fetch(conn_4d, sql)
    if not rows:
        return 0
    val = rows[0].get("cnt")
    if val is None and rows[0]:
        val = next(iter(rows[0].values()))
    return int(val) if val is not None else 0


def sync_traspasos(conn_4d, conn_pg, since: datetime | None = None) -> int:
    """Extract Traspasos from 4D and append-insert (idempotent) into ps_traspasos.

    Traspasos is append-only by FechaS.  Records are immutable once created.
    Uses insert_ignore (ON CONFLICT (reg_traspaso) DO NOTHING) so the operation
    is safe to re-run: rows that already exist are skipped without error and
    without modifying the existing data.

    Rows are fetched and inserted in batches (LIMIT/OFFSET with stable ORDER BY)
    to avoid loading the entire table into memory at once.

    Note: only the date portion of *since* is used in the 4D SQL filter;
    any time component is silently ignored.  Pass a date-aligned datetime.

    Args:
        conn_4d: P4D connection object.
        conn_pg: psycopg2 connection object.
        since: If provided, only fetch rows where FechaS >= since (date only).
               If None, fetch all rows (initial load).

    Returns:
        Total number of rows attempted (including rows skipped due to conflicts).
    """
    where = _build_traspasos_where(since)

    # COUNT is used for progress logging only — loop termination is driven by
    # empty-batch detection to avoid missing rows added after this initial count.
    total_source = _count_traspasos(conn_4d, where)
    logger.info(
        "sync_traspasos: %d rows to process %s",
        total_source,
        f"({where})" if where else "(full)",
    )

    total_attempted = 0
    offset = 0

    while True:
        sql = (
            f"SELECT {_TRASPASOS_COLUMNS} FROM Traspasos "
            f"{where} {_TRASPASOS_ORDER_BY} LIMIT {_SOURCE_BATCH} OFFSET {offset}"
        ).strip()

        batch = safe_fetch(conn_4d, sql)
        if not batch:
            break  # no more rows — pagination complete

        mapped = [_map_traspaso_row(r) for r in batch]

        # insert_ignore uses ON CONFLICT (reg_traspaso) DO NOTHING — idempotent.
        attempted = insert_ignore(
            conn_pg, "ps_traspasos", mapped, pk_cols=["reg_traspaso"]
        )
        total_attempted += attempted
        offset += len(batch)
        logger.debug(
            "sync_traspasos: fetched %d rows so far (est. total %d, batch attempted: %d)",
            offset,
            total_source,
            attempted,
        )

    logger.info("sync_traspasos: done — %d rows attempted", total_attempted)
    return total_attempted
