"""ETL sync for the Ventas retail sales domain.

Three tables are synced here, all using UPSERT delta by FechaModifica:
  - Ventas        → ps_ventas         (PK: reg_ventas)
  - LineasVentas  → ps_lineas_ventas  (PK: reg_lineas)
  - PagosVentas   → ps_pagos_ventas   (PK: reg_pagos)

Why UPSERT and not plain INSERT
---------------------------------
19–21% of historical records have FechaModifica > FechaCreacion due to returns,
TBAI fiscal corrections, and payment-flag updates.  A plain INSERT would silently
miss these changes.  See docs/etl-sync-strategy.md for the full analysis.

Delta field: FechaModifica — NEVER FechaDocumento (it is NULL for all records).

PK precision
-----------
4D PKs are REAL (float) with a .99 suffix pattern (e.g. RegVentas = 10028816.641).
All PK/FK float values are converted to decimal.Decimal before being passed to
PostgreSQL to avoid binary-float precision loss in the NUMERIC columns.

Batch processing
----------------
For initial loads (since=None defaults to 2014-01-01) each table can return
hundreds of thousands of rows.  Rows are fetched in BATCH_SIZE chunks using
LIMIT/OFFSET with ORDER BY the PK column.  Each batch is upserted immediately so
memory usage stays bounded.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any

logger = logging.getLogger(__name__)

# Number of rows fetched and upserted per round-trip.
# Tuned to balance memory usage vs. round-trip overhead.
BATCH_SIZE = 5_000

# Default "load everything" start date used when no watermark exists.
_EPOCH = datetime(2014, 1, 1)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _to_decimal(value: Any) -> Any:
    """Convert float to Decimal; pass other types (None, int, str) through."""
    if isinstance(value, float):
        return Decimal(str(value))
    return value


def _map_row(
    source: dict[str, Any], mapping: dict[str, str], numeric_keys: set[str]
) -> dict[str, Any]:
    """Rename and type-convert a single raw row.

    Keys absent from *mapping* are silently dropped.
    Fields listed in *numeric_keys* are converted to Decimal.
    """
    result: dict[str, Any] = {}
    for src_key, pg_key in mapping.items():
        value = source.get(src_key)
        if src_key in numeric_keys:
            value = _to_decimal(value)
        result[pg_key] = value
    return result


def _date_literal(dt: datetime) -> str:
    """Return a 4D SQL date literal string: {d 'YYYY-MM-DD'}.

    Callers in this module pair the literal with `FechaModifica >=` (not
    strict `>`). Ventas/LineasVentas/PagosVentas.FechaModifica are date-
    only (`_USER_COLUMNS` DATA_TYPE=8): with strict `>` once the watermark
    advances to today, same-day updates with FechaModifica == today are
    silently skipped until tomorrow's run. `>=` re-fetches every row
    already touched today; upsert is idempotent so the only cost is one
    extra UPDATE per untouched row. See issue #459 / PR #461.
    """
    return f"{{d '{dt.strftime('%Y-%m-%d')}'}}"


def _sync_table(
    conn_4d: Any,
    conn_pg: Any,
    sql_base: str,
    where_clause: str,
    pk_col_4d: str,
    pg_table: str,
    pk_cols_pg: list[str],
    mapping: dict[str, str],
    numeric_keys: set[str],
) -> int:
    """Fetch all matching rows and upsert in batches.

    Single SELECT (no LIMIT/OFFSET) because 4D SQL OFFSET scanning is
    catastrophically slow at large offsets — it re-scans all preceding rows.
    The p4d driver buffers the full result set in memory, so a single query
    for ~1M rows uses ~500MB peak but completes in minutes vs hours.

    Args:
        sql_base:     SELECT ... FROM table (no WHERE/ORDER/LIMIT).
        where_clause: Already-formatted WHERE clause (e.g. "FechaModifica >= {d '...'}").
        pk_col_4d:    4D column name used for ORDER BY (original casing). Unused now but kept for API compat.
        pg_table:     Target PostgreSQL table name.
        pk_cols_pg:   PK column list for ON CONFLICT.
        mapping:      4D lowercase key → PG snake_case column mapping.
        numeric_keys: Source keys whose values should be Decimal-converted.

    Returns:
        Total rows upserted.
    """
    from etl.db.fourd import safe_fetch
    from etl.db.postgres import upsert

    full_sql = f"{sql_base} WHERE {where_clause}"
    logger.info("Fetching from 4D: %s", full_sql[:200])
    all_rows = safe_fetch(conn_4d, full_sql)
    logger.info("Fetched %d rows from 4D", len(all_rows))

    total = 0
    for i in range(0, len(all_rows), BATCH_SIZE):
        batch = all_rows[i : i + BATCH_SIZE]
        pg_rows = [_map_row(r, mapping, numeric_keys) for r in batch]
        total += upsert(conn_pg, pg_table, pg_rows, pk_cols_pg)
        if (i + BATCH_SIZE) % 50_000 == 0:
            logger.info("%s: upserted %d / %d rows", pg_table, total, len(all_rows))
    return total


# ---------------------------------------------------------------------------
# Column mappings: 4D lowercase key → PostgreSQL snake_case column name
# Keys match what safe_fetch returns (4D column names lowercased).
# ---------------------------------------------------------------------------

_VENTAS_MAPPING: dict[str, str] = {
    "regventas": "reg_ventas",
    "ndocumento": "n_documento",
    "seriev": "serie_v",
    "tienda": "tienda",
    "fechacreacion": "fecha_creacion",
    "fechamodifica": "fecha_modifica",
    # 4D Ventas.Hora is a Time field (DATA_TYPE 9). Brought into the
    # mirror so the home page hero can render a real intraday curve
    # instead of the date-only fallback.
    "hora": "hora_creacion",
    "totalsi": "total_si",
    "total": "total",
    "numcliente": "num_cliente",
    "codigocajero": "codigo_cajero",
    "cajeronombre": "cajero_nombre",
    "tipoventa": "tipo_venta",
    "tipodocumento": "tipo_documento",
    "forma": "forma",
    "entrada": "entrada",
    "pendiente": "pendiente",
    "pedidoweb": "pedido_web",
}

_VENTAS_NUMERIC: set[str] = {
    "regventas",
    "ndocumento",
    "numcliente",
    "totalsi",
    "total",
}

_LINEAS_MAPPING: dict[str, str] = {
    "reglineas": "reg_lineas",
    "numventas": "num_ventas",
    "ndocumento": "n_documento",
    "mes": "mes",
    "tienda": "tienda",
    "codigo": "codigo",
    "descripcion": "descripcion",
    "unidades": "unidades",
    "precionetosi": "precio_neto_si",
    "totalsi": "total_si",
    "preciocosteci": "precio_coste_ci",
    "totalcostesi": "total_coste_si",
    "fechacreacion": "fecha_creacion",
    "fechamodifica": "fecha_modifica",
}

_LINEAS_NUMERIC: set[str] = {
    "reglineas",
    "numventas",
    "ndocumento",
    "unidades",
    "precionetosi",
    "totalsi",
    "preciocosteci",
    "totalcostesi",
}

_PAGOS_MAPPING: dict[str, str] = {
    "regpagos": "reg_pagos",
    "numventas": "num_ventas",
    "forma": "forma",
    "codigoforma": "codigo_forma",
    "importecob": "importe_cob",
    "fechacreacion": "fecha_creacion",
    "fechamodifica": "fecha_modifica",
    "tienda": "tienda",
    "entrada": "entrada",
}

_PAGOS_NUMERIC: set[str] = {"regpagos", "numventas", "importecob"}


# ---------------------------------------------------------------------------
# SQL templates (WHERE clause appended at call-time)
# ---------------------------------------------------------------------------

_SQL_VENTAS_BASE = (
    "SELECT RegVentas, NDocumento, SerieV, Tienda, FechaCreacion, FechaModifica,"
    " Hora, TotalSI, Total, NumCliente, CodigoCajero, CajeroNombre, TipoVenta,"
    " TipoDocumento, Forma, Entrada, Pendiente, PedidoWeb"
    " FROM Ventas"
)

_SQL_LINEAS_BASE = (
    "SELECT RegLineas, NumVentas, NDocumento, Mes, Tienda, Codigo, Descripcion,"
    " Unidades, PrecioNetoSI, TotalSI, PrecioCosteCI, TotalCosteSI,"
    " FechaCreacion, FechaModifica"
    " FROM LineasVentas"
)

_SQL_PAGOS_BASE = (
    "SELECT RegPagos, NumVentas, Forma, CodigoForma, ImporteCob,"
    " FechaCreacion, FechaModifica, Tienda, Entrada"
    " FROM PagosVentas"
)


# ---------------------------------------------------------------------------
# Public sync functions
# ---------------------------------------------------------------------------


def sync_ventas(conn_4d: Any, conn_pg: Any, since: datetime | None = None) -> int:
    """Upsert-delta sync Ventas → ps_ventas.

    Args:
        conn_4d: Open p4d connection to the 4D server.
        conn_pg: Open psycopg2 connection to PostgreSQL.
        since:   Only fetch records with FechaModifica > since.
                 Pass None (or omit) for the initial full load
                 (defaults to 2014-01-01 which covers all history).

    Returns:
        Total number of rows upserted (inserted + updated).

    Notes:
        - FechaDocumento is NULL for all Ventas records — never used here.
        - PKs (RegVentas, NDocumento, NumCliente) are REAL floats; converted to
          Decimal before PostgreSQL insert to preserve NUMERIC precision.
        - Fetched and upserted one page at a time (BATCH_SIZE rows) to bound
          memory usage for the initial full load (~911K rows).
    """
    effective_since = since if since is not None else _EPOCH
    where = f"FechaModifica >= {_date_literal(effective_since)}"
    return _sync_table(
        conn_4d,
        conn_pg,
        sql_base=_SQL_VENTAS_BASE,
        where_clause=where,
        pk_col_4d="RegVentas",
        pg_table="ps_ventas",
        pk_cols_pg=["reg_ventas"],
        mapping=_VENTAS_MAPPING,
        numeric_keys=_VENTAS_NUMERIC,
    )


def sync_lineas_ventas(
    conn_4d: Any, conn_pg: Any, since: datetime | None = None
) -> int:
    """Upsert-delta sync LineasVentas → ps_lineas_ventas.

    Args:
        conn_4d: Open p4d connection.
        conn_pg: Open psycopg2 connection.
        since:   FechaModifica lower-bound (exclusive). None = full load.

    Returns:
        Total rows upserted.

    Notes:
        - TotalCosteSI is queried as-is; if the column does not exist in the 4D
          schema, safe_fetch will raise — verify against _USER_COLUMNS if the
          query fails with an unknown-column error.
        - PK and FK floats (RegLineas, NumVentas, NDocumento) converted to Decimal.
    """
    effective_since = since if since is not None else _EPOCH
    where = f"FechaModifica >= {_date_literal(effective_since)}"
    return _sync_table(
        conn_4d,
        conn_pg,
        sql_base=_SQL_LINEAS_BASE,
        where_clause=where,
        pk_col_4d="RegLineas",
        pg_table="ps_lineas_ventas",
        pk_cols_pg=["reg_lineas"],
        mapping=_LINEAS_MAPPING,
        numeric_keys=_LINEAS_NUMERIC,
    )


def sync_pagos_ventas(conn_4d: Any, conn_pg: Any, since: datetime | None = None) -> int:
    """Upsert-delta sync PagosVentas → ps_pagos_ventas.

    Args:
        conn_4d: Open p4d connection.
        conn_pg: Open psycopg2 connection.
        since:   FechaModifica lower-bound (exclusive). None = full load.

    Returns:
        Total rows upserted.

    Notes:
        - ImporteCob = "Importe Cobrado" (actual charged amount, VAT-inclusive).
          Use this for payment analytics, not ImporteEnt.
        - ~33 "Devolucion Vale" records have a POS bug in ImporteEnt that
          concatenates store codes; ImporteCob is unaffected.
    """
    effective_since = since if since is not None else _EPOCH
    where = f"FechaModifica >= {_date_literal(effective_since)}"
    return _sync_table(
        conn_4d,
        conn_pg,
        sql_base=_SQL_PAGOS_BASE,
        where_clause=where,
        pk_col_4d="RegPagos",
        pg_table="ps_pagos_ventas",
        pk_cols_pg=["reg_pagos"],
        mapping=_PAGOS_MAPPING,
        numeric_keys=_PAGOS_NUMERIC,
    )
