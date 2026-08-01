"""ETL sync for Compras (purchasing & invoicing) domain tables.

All five tables use full-refresh (truncate + insert) strategy:
- Compras (~2,700 rows)
- CCLineasCompr (~44,000 rows)  — NOTE: NOT LineasCompras (that table doesn't exist)
- Facturas (~2,357 rows)
- Albaranes (~3,672 rows)
- FacturasCompra (~3,884 rows) — no natural PK; uses surrogate IDENTITY key

Column mapping convention
-------------------------
safe_fetch returns lowercase keys (4D returns column names uppercase; fourd.py
normalises them).  The mapping dicts below translate those lowercase 4D names to
the snake_case PostgreSQL column names defined in etl/schema/init.sql.

PK precision warning
--------------------
4D PKs are REAL (float) with a .99 suffix pattern.  They are stored as NUMERIC in
PostgreSQL to avoid binary-float precision loss.  All PK/FK values are converted to
decimal.Decimal before being passed to the PostgreSQL insert helpers.

Proveedores.nombre mapping (confirmed 2026-05-01)
-------------------------------------------------
The 4D field ``Proveedor`` (DATA_TYPE=10, text, 100 chars) contains the actual
supplier name.  ``NombreComercial`` is empty for all 520 rows in 4D.  We map
``proveedor`` → ``nombre`` in ps_proveedores.

CCLineasCompr enrichment (confirmed 2026-05-01)
-----------------------------------------------
Fields Unidades, PrecioCoste, PrecioNetoSI, TotalSI, NumProveedor all exist on
CCLineasCompr (DATA_TYPE=6, Real) and are now included in the sync.

Albaranes enrichment (confirmed 2026-05-01)
-------------------------------------------
Fields NPedido, NumProveedor (both DATA_TYPE=6, Real) and Proveedor (DATA_TYPE=10,
text) exist on Albaranes and are now included in the sync, giving ps_albaranes a
FK link to ps_compras and ps_proveedores.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_NUMERIC_FIELDS = {
    # ps_compras
    "regpedido",
    "numproveedor",
    # ps_lineas_compras
    "reglineacompra",
    "numpedido",
    "numtienda",
    "numarticulo",
    # ps_lineas_compras enrichment (CCLineasCompr REAL fields — DATA_TYPE=6)
    "unidades",
    "preciocoste",
    "precionetosi",
    "totalsi",
    # ps_albaranes enrichment
    "npedido",
    # ps_facturas
    "regfactura",
    # ps_albaranes
    "regalbaran",
}


def _to_decimal(value: Any) -> Any:
    """Convert float to Decimal; pass other types through unchanged."""
    if isinstance(value, float):
        return Decimal(str(value))
    return value


def _map_row(source: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """Return a new dict with keys renamed according to *mapping*.

    Keys in *source* that are absent from *mapping* are silently dropped.
    Values that are floats (in known numeric fields) are converted to Decimal.
    """
    result: dict[str, Any] = {}
    for src_key, pg_key in mapping.items():
        value = source.get(src_key)
        if src_key in _NUMERIC_FIELDS:
            value = _to_decimal(value)
        result[pg_key] = value
    return result


# ---------------------------------------------------------------------------
# Column mappings: 4D lowercase name → PostgreSQL column name
# ---------------------------------------------------------------------------

_COMPRAS_MAPPING: dict[str, str] = {
    "regpedido": "reg_pedido",
    "fechapedido": "fecha_pedido",
    "fecharecibido": "fecha_recibido",
    "modificada": "modificada",
    "numproveedor": "num_proveedor",
}

_LINEAS_COMPRAS_MAPPING: dict[str, str] = {
    "reglineacompra": "reg_linea_compra",
    "numpedido": "num_pedido",
    "numtienda": "num_tienda",
    "fecha": "fecha",
    "numarticulo": "num_articulo",
    # Enrichment fields confirmed in CCLineasCompr via _USER_COLUMNS (2026-05-01).
    "unidades": "unidades",
    "preciocoste": "precio_coste",
    "precionetosi": "precio_neto_si",
    "totalsi": "total_si",
    "numproveedor": "num_proveedor",
}

_FACTURAS_MAPPING: dict[str, str] = {
    "regfactura": "reg_factura",
    "fechafactura": "fecha_factura",
    "fechamodifica": "fecha_modifica",
}

_ALBARANES_MAPPING: dict[str, str] = {
    "regalbaran": "reg_albaran",
    "fecharecibido": "fecha_recibido",
    "modificada": "modificada",
    # Enrichment fields confirmed in Albaranes via _USER_COLUMNS (2026-05-01).
    # NPedido is the FK to Compras.RegPedido; NumProveedor is FK to Proveedores.
    "npedido": "num_pedido",
    "numproveedor": "num_proveedor",
    "proveedor": "proveedor",
}

_FACTURAS_COMPRA_MAPPING: dict[str, str] = {
    "fechafactura": "fecha_factura",
    "fechavalor": "fecha_valor",
}


# ---------------------------------------------------------------------------
# SQL queries
# ---------------------------------------------------------------------------

_SQL_LINEAS_COMPRAS = (
    "SELECT RegLineaCompra, NumPedido, NumTienda, Fecha, NumArticulo,"
    " Unidades, PrecioCoste, PrecioNetoSI, TotalSI, NumProveedor"
    " FROM CCLineasCompr"
)


# ---------------------------------------------------------------------------
# Public sync functions
# ---------------------------------------------------------------------------


def sync_compras(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh ps_compras from the 4D Compras table.

    Verifies PK column existence before querying.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows loaded into ps_compras.
    """
    from etl.db.fourd import get_queryable_columns, safe_fetch
    from etl.db.postgres import truncate_and_insert

    # Verify PK exists in source
    pk_check = safe_fetch(
        conn_4d,
        "SELECT COLUMN_NAME FROM _USER_COLUMNS"
        " WHERE TABLE_NAME='Compras' AND COLUMN_NAME LIKE 'Reg%'",
    )
    pk_cols = [r["column_name"] for r in pk_check]
    if "RegPedido" not in pk_cols:
        raise RuntimeError(
            f"Expected PK 'RegPedido' not found in Compras. Found Reg* columns: {pk_cols}"
        )

    # Use get_queryable_columns to check for type-0 columns, but we use an
    # explicit safe column list that matches the DDL.
    queryable = get_queryable_columns(conn_4d, "Compras")
    queryable_lower = {c.lower() for c in queryable}

    # Build column list: only include columns that are queryable
    cols_map = _COMPRAS_MAPPING.copy()
    cols_map = {k: v for k, v in cols_map.items() if k in queryable_lower}

    selected = [k for k in _COMPRAS_MAPPING if k in queryable_lower]
    orig_case = {c.lower(): c for c in queryable}
    sql = "SELECT " + ", ".join(orig_case[k] for k in selected) + " FROM Compras"

    raw_rows = safe_fetch(conn_4d, sql)
    pg_rows = [_map_row(r, cols_map) for r in raw_rows]
    return truncate_and_insert(conn_pg, "ps_compras", pg_rows)


def sync_lineas_compras(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh ps_lineas_compras from the 4D CCLineasCompr table.

    NOTE: The source table is CCLineasCompr, NOT LineasCompras (which does not
    exist in the 4D database).

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows loaded into ps_lineas_compras.
    """
    from etl.db.fourd import safe_fetch
    from etl.db.postgres import truncate_and_insert

    raw_rows = safe_fetch(conn_4d, _SQL_LINEAS_COMPRAS)
    pg_rows = [_map_row(r, _LINEAS_COMPRAS_MAPPING) for r in raw_rows]
    return truncate_and_insert(conn_pg, "ps_lineas_compras", pg_rows)


def sync_facturas(conn_4d: Any, conn_pg: Any, since: Any = None) -> int:
    """Sync ps_facturas from the 4D Facturas table.

    since=None  → full refresh (TRUNCATE + INSERT). Catches hard-deletes.
    since=date  → delta upsert (WHERE FechaModifica > since).
    """
    from etl.db.fourd import get_queryable_columns, safe_fetch
    from etl.db.postgres import truncate_and_insert, upsert

    # Verify PK
    pk_check = safe_fetch(
        conn_4d,
        "SELECT COLUMN_NAME FROM _USER_COLUMNS"
        " WHERE TABLE_NAME='Facturas' AND COLUMN_NAME LIKE 'Reg%'",
    )
    pk_cols = [r["column_name"] for r in pk_check]
    if "RegFactura" not in pk_cols:
        raise RuntimeError(
            f"Expected PK 'RegFactura' not found in Facturas. Found Reg* columns: {pk_cols}"
        )

    queryable = get_queryable_columns(conn_4d, "Facturas")
    queryable_lower = {c.lower() for c in queryable}
    orig_case = {c.lower(): c for c in queryable}

    cols_map = {k: v for k, v in _FACTURAS_MAPPING.items() if k in queryable_lower}
    selected = [k for k in _FACTURAS_MAPPING if k in queryable_lower]

    where = ""
    if since is not None:
        if "fechamodifica" not in queryable_lower:
            logger.warning(
                "sync_facturas: delta requested but FechaModifica missing — falling back to full refresh"
            )
        else:
            # `>=` not `>`: FechaModifica is date-only; strict `>` would
            # silently skip same-day updates once the watermark advances.
            # Upsert is idempotent so re-fetching today's rows is harmless.
            date_str = since.strftime("%Y-%m-%d")
            where = f" WHERE FechaModifica >= {{d '{date_str}'}}"

    sql = (
        "SELECT " + ", ".join(orig_case[k] for k in selected) + " FROM Facturas" + where
    )

    raw_rows = safe_fetch(conn_4d, sql)
    pg_rows = [_map_row(r, cols_map) for r in raw_rows]

    if since is None or not where:
        return truncate_and_insert(conn_pg, "ps_facturas", pg_rows)

    if not pg_rows:
        return 0
    return upsert(conn_pg, "ps_facturas", pg_rows, pk_cols=["reg_factura"])


def sync_albaranes(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh ps_albaranes from the 4D Albaranes table.

    Verifies PK column existence and uses get_queryable_columns to avoid
    type-0 column errors.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows loaded into ps_albaranes.
    """
    from etl.db.fourd import get_queryable_columns, safe_fetch
    from etl.db.postgres import truncate_and_insert

    # Verify PK
    pk_check = safe_fetch(
        conn_4d,
        "SELECT COLUMN_NAME FROM _USER_COLUMNS"
        " WHERE TABLE_NAME='Albaranes' AND COLUMN_NAME LIKE 'Reg%'",
    )
    pk_cols = [r["column_name"] for r in pk_check]
    if "RegAlbaran" not in pk_cols:
        raise RuntimeError(
            f"Expected PK 'RegAlbaran' not found in Albaranes. Found Reg* columns: {pk_cols}"
        )

    queryable = get_queryable_columns(conn_4d, "Albaranes")
    queryable_lower = {c.lower() for c in queryable}
    orig_case = {c.lower(): c for c in queryable}

    cols_map = {k: v for k, v in _ALBARANES_MAPPING.items() if k in queryable_lower}
    selected = [k for k in _ALBARANES_MAPPING if k in queryable_lower]
    sql = "SELECT " + ", ".join(orig_case[k] for k in selected) + " FROM Albaranes"

    raw_rows = safe_fetch(conn_4d, sql)
    pg_rows = [_map_row(r, cols_map) for r in raw_rows]
    return truncate_and_insert(conn_pg, "ps_albaranes", pg_rows)


def sync_facturas_compra(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh ps_facturas_compra from the 4D FacturasCompra table.

    ps_facturas_compra uses a surrogate IDENTITY key (no natural PK in 4D).
    TRUNCATE ... RESTART IDENTITY is used to reset the surrogate key on each
    full refresh so sequences stay consistent.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows loaded into ps_facturas_compra.
    """
    from etl.db.fourd import get_queryable_columns, safe_fetch
    from etl.db.postgres import truncate_and_insert

    queryable = get_queryable_columns(conn_4d, "FacturasCompra")
    queryable_lower = {c.lower() for c in queryable}
    orig_case = {c.lower(): c for c in queryable}

    cols_map = {
        k: v for k, v in _FACTURAS_COMPRA_MAPPING.items() if k in queryable_lower
    }
    selected = [k for k in _FACTURAS_COMPRA_MAPPING if k in queryable_lower]

    if not selected:
        # No matching columns found — fail fast to avoid silently wiping the
        # target table on a schema/mapping mismatch.
        expected = sorted(_FACTURAS_COMPRA_MAPPING.keys())
        discovered = sorted(queryable)
        raise RuntimeError(
            "sync_facturas_compra: no expected columns found in source table "
            "'FacturasCompra'. Expected at least one of: "
            f"{expected}; discovered columns: {discovered}"
        )

    sql = "SELECT " + ", ".join(orig_case[k] for k in selected) + " FROM FacturasCompra"

    raw_rows = safe_fetch(conn_4d, sql)
    pg_rows = [_map_row(r, cols_map) for r in raw_rows]
    return truncate_and_insert(
        conn_pg, "ps_facturas_compra", pg_rows, restart_identity=True
    )
