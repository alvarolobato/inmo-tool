"""ETL sync for the Wholesale (Gestión Comercial / GC*) domain.

Tables covered:
- GCAlbaranes      → ps_gc_albaranes       (UPSERT delta by Modifica)
- GCLinAlbarane    → ps_gc_lin_albarane    (DELETE+reinsert via parent Modifica)
- GCFacturas       → ps_gc_facturas        (UPSERT delta by Modifica)
- GCLinFacturas    → ps_gc_lin_facturas    (DELETE+reinsert via parent Modifica)
- GCPedidos        → ps_gc_pedidos         (full refresh — only 101 rows)
- GCLinPedidos     → ps_gc_lin_pedidos     (full refresh — only ~2.6K rows)

Sync strategy notes
-------------------
- GCLinAlbarane and GCLinFacturas have no own modification timestamp.
  Delta is derived from the parent header's Modifica field:
  1. Find parent IDs (NAlbaran / NFactura) modified since *since*.
  2. DELETE those parent IDs' lines from PostgreSQL.
  3. Re-fetch and re-insert the lines from 4D.
  For initial load (since=None): truncate + full extract.

Integer quantities (``Unidades``, ``Entregadas``, ``Pendientes`` on GC* lines)
are **not** passed through ``decode_signed_int16_word``: wholesale lines can
legitimately exceed 32767 units, which would be mis-decoded as negative if the
16-bit WORD reinterpretation were applied.

FK corrections (critical)
-------------------------
- GCLinAlbarane.NAlbaran  → GCAlbaranes.NAlbaran  (NOT RegAlbaran)
- GCLinFacturas.NumFactura → GCFacturas.NFactura   (asymmetric naming)

PK precision
------------
4D PKs are REAL (float) with a .99 suffix pattern.  All float PK/FK values
are converted to Decimal before insertion to avoid binary-float precision
loss in PostgreSQL NUMERIC columns.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any

from etl.db.fourd import safe_fetch
from etl.db.postgres import truncate_and_insert, upsert

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_NUMERIC_FIELDS = frozenset(
    {
        # GCAlbaranes
        "regalbaran",
        "nalbaran",
        "numcliente",
        "base1",
        "base2",
        "base3",
        "unidades",  # maps to ps_gc_albaranes.entregadas (Entregadas doesn't exist in GCAlbaranes)
        "numcomercial",
        # GCFacturas
        "regfactura",
        "nfactura",
        "totalfactura",
        # GCLinAlbarane
        "reglinea",
        "numalbaran",
        "unidades",
        "precioneto",
        "total",
        "numfamilia",
        "numdepartament",
        "numtemporada",
        "nummarca",
        "numcolor",
        # GCLinFacturas
        "numfactura",
        "totalcoste",
        "piva",
        # GCPedidos
        "regpedido",
        "npedido",
        "totalpedido",
        "pendientes",
        # GCLinPedidos
        "numpedido",
        "fechapedido",  # date — not numeric; included for safety but _to_decimal passes non-floats
    }
)


def _to_decimal(value: Any) -> Any:
    """Convert float to Decimal; pass all other types through unchanged."""
    if isinstance(value, float):
        return Decimal(str(value))
    return value


def _map_row(source: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """Rename keys per *mapping*, converting float PK/FK fields to Decimal.

    Keys absent from *mapping* are silently dropped.
    """
    result: dict[str, Any] = {}
    for src_key, pg_key in mapping.items():
        value = source.get(src_key)
        if src_key in _NUMERIC_FIELDS and isinstance(value, float):
            value = _to_decimal(value)
        result[pg_key] = value
    return result


def _format_since(since: datetime) -> str:
    """Return the 4D date literal for *since* in the format {d 'YYYY-MM-DD'}."""
    return f"{{d '{since.strftime('%Y-%m-%d')}'}}"


# ---------------------------------------------------------------------------
# Column mappings: lowercase 4D name → PostgreSQL snake_case name
# ---------------------------------------------------------------------------

_ALBARANES_MAPPING: dict[str, str] = {
    "regalbaran": "reg_albaran",
    "nalbaran": "n_albaran",
    "numcliente": "num_cliente",
    "fechaenvio": "fecha_envio",
    "fechavalor": "fecha_valor",
    "modifica": "modifica",
    "base1": "base1",
    "base2": "base2",
    "base3": "base3",
    # GCAlbaranes uses 'Unidades' (not 'Entregadas' which doesn't exist in this table)
    "unidades": "entregadas",
    "transportista": "transportista",
    "numcomercial": "num_comercial",
    "temporada": "temporada",
    "abono": "abono",
}

_LIN_ALBARANE_MAPPING: dict[str, str] = {
    "reglinea": "reg_linea",
    "nalbaran": "n_albaran",
    "numalbaran": "num_albaran",
    "codigo": "codigo",
    "articulo": "articulo",
    "descripcion": "descripcion",
    "color": "color",
    "fechaalbaran": "fecha_albaran",
    "unidades": "unidades",
    "precioneto": "precio_neto",
    "total": "total",
    "numcliente": "num_cliente",
    "numfamilia": "num_familia",
    "numdepartament": "num_departament",
    "numtemporada": "num_temporada",
    "nummarca": "num_marca",
    "numcolor": "num_color",
}

_FACTURAS_MAPPING: dict[str, str] = {
    "regfactura": "reg_factura",
    "nfactura": "n_factura",
    "fechafactura": "fecha_factura",
    "modifica": "modifica",
    "base1": "base1",
    "base2": "base2",
    "base3": "base3",
    "numcliente": "num_cliente",
    "numcomercial": "num_comercial",
    "abono": "abono",
    "totalfactura": "total_factura",
}

_LIN_FACTURAS_MAPPING: dict[str, str] = {
    "reglinea": "reg_linea",
    "numfactura": "num_factura",
    "codigo": "codigo",
    "descripcion": "descripcion",
    "unidades": "unidades",
    "precioneto": "precio_neto",
    "total": "total",
    "totalcoste": "total_coste",
    "piva": "p_iva",
    "fechafactura": "fecha_factura",
    "numcliente": "num_cliente",
    "numfamilia": "num_familia",
    "numdepartament": "num_departament",
    "nummarca": "num_marca",
    "numcolor": "num_color",
    "numcomercial": "num_comercial",
    "mes": "mes",
}

_PEDIDOS_MAPPING: dict[str, str] = {
    "regpedido": "reg_pedido",
    "npedido": "n_pedido",
    "fechapedido": "fecha_pedido",
    "modifica": "modifica",
    "numcliente": "num_cliente",
    "comercial": "comercial",
    "totalpedido": "total_pedido",
    "unidades": "unidades",
    "entregadas": "entregadas",
    "pendientes": "pendientes",
    "temporada": "temporada",
    "pedidocerrado": "pedido_cerrado",
    "abono": "abono",
}

_LIN_PEDIDOS_MAPPING: dict[str, str] = {
    "reglinea": "reg_linea",
    "numpedido": "num_pedido",
    "codigo": "codigo",
    "descripcion": "descripcion",
    "unidades": "unidades",
    "entregadas": "entregadas",
    "precioneto": "precio_neto",
    "total": "total",
    "fechapedido": "fecha_pedido",
}


# ---------------------------------------------------------------------------
# SQL queries (explicit column lists — never SELECT *)
# ---------------------------------------------------------------------------

_SQL_ALBARANES_DELTA = (
    "SELECT RegAlbaran, NAlbaran, NumCliente, FechaEnvio, FechaValor,"
    " Modifica, Base1, Base2, Base3, Unidades, Transportista,"
    " NumComercial, Temporada, Abono"
    " FROM GCAlbaranes"
    " WHERE Modifica >= {since}"
)

_SQL_ALBARANES_ALL = (
    "SELECT RegAlbaran, NAlbaran, NumCliente, FechaEnvio, FechaValor,"
    " Modifica, Base1, Base2, Base3, Unidades, Transportista,"
    " NumComercial, Temporada, Abono"
    " FROM GCAlbaranes"
)

_SQL_LIN_ALBARANE_PARENT_IDS = (
    "SELECT NAlbaran FROM GCAlbaranes WHERE Modifica >= {since}"
)

_SQL_LIN_ALBARANE_BY_PARENT = (
    "SELECT RegLinea, NAlbaran, NumAlbaran, Codigo, Articulo, Descripcion,"
    " Color, FechaAlbaran, Unidades, PrecioNeto, Total, NumCliente,"
    " NumFamilia, NumDepartament, NumTemporada, NumMarca, NumColor"
    " FROM GCLinAlbarane"
    " WHERE NAlbaran IN ({placeholders})"
)

_SQL_LIN_ALBARANE_ALL = (
    "SELECT RegLinea, NAlbaran, NumAlbaran, Codigo, Articulo, Descripcion,"
    " Color, FechaAlbaran, Unidades, PrecioNeto, Total, NumCliente,"
    " NumFamilia, NumDepartament, NumTemporada, NumMarca, NumColor"
    " FROM GCLinAlbarane"
)

_SQL_FACTURAS_DELTA = (
    "SELECT RegFactura, NFactura, FechaFactura, Modifica, Base1, Base2, Base3,"
    " NumCliente, NumComercial, Abono, TotalFactura"
    " FROM GCFacturas"
    " WHERE Modifica >= {since}"
)

_SQL_FACTURAS_ALL = (
    "SELECT RegFactura, NFactura, FechaFactura, Modifica, Base1, Base2, Base3,"
    " NumCliente, NumComercial, Abono, TotalFactura"
    " FROM GCFacturas"
)

_SQL_LIN_FACTURAS_PARENT_IDS = (
    "SELECT NFactura FROM GCFacturas WHERE Modifica >= {since}"
)

_SQL_LIN_FACTURAS_BY_PARENT = (
    "SELECT RegLinea, NumFactura, Codigo, Descripcion, Unidades, PrecioNeto,"
    " Total, TotalCoste, PIva, FechaFactura, NumCliente, NumFamilia,"
    " NumDepartament, NumMarca, NumColor, NumComercial, Mes"
    " FROM GCLinFacturas"
    " WHERE NumFactura IN ({placeholders})"
)

_SQL_LIN_FACTURAS_ALL = (
    "SELECT RegLinea, NumFactura, Codigo, Descripcion, Unidades, PrecioNeto,"
    " Total, TotalCoste, PIva, FechaFactura, NumCliente, NumFamilia,"
    " NumDepartament, NumMarca, NumColor, NumComercial, Mes"
    " FROM GCLinFacturas"
)

_SQL_PEDIDOS_ALL = (
    "SELECT RegPedido, NPedido, FechaPedido, Modifica, NumCliente, Comercial,"
    " TotalPedido, Unidades, Entregadas, Pendientes, Temporada,"
    " PedidoCerrado, Abono"
    " FROM GCPedidos"
)

_SQL_LIN_PEDIDOS_ALL = (
    "SELECT RegLinea, NumPedido, Codigo, Descripcion, Unidades, Entregadas,"
    " PrecioNeto, Total, FechaPedido"
    " FROM GCLinPedidos"
)


# ---------------------------------------------------------------------------
# Public sync functions
# ---------------------------------------------------------------------------


def sync_gc_albaranes(
    conn_4d: Any,
    conn_pg: Any,
    since: datetime | None = None,
) -> int:
    """UPSERT-delta sync of GCAlbaranes into ps_gc_albaranes.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.
        since:   Only fetch records with Modifica >= since.
                 If None, load all records (initial load).

    Returns:
        Number of rows upserted.
    """
    if since is None:
        sql = _SQL_ALBARANES_ALL
        logger.info("sync_gc_albaranes: initial load (no watermark)")
    else:
        sql = _SQL_ALBARANES_DELTA.format(since=_format_since(since))
        logger.info("sync_gc_albaranes: delta load since %s", since.date())

    raw_rows = safe_fetch(conn_4d, sql)
    if not raw_rows:
        logger.info("sync_gc_albaranes: no new/modified rows")
        return 0

    pg_rows = [_map_row(r, _ALBARANES_MAPPING) for r in raw_rows]
    count = upsert(conn_pg, "ps_gc_albaranes", pg_rows, pk_cols=["reg_albaran"])
    logger.info("sync_gc_albaranes: upserted %d rows", count)
    return count


def sync_gc_facturas(
    conn_4d: Any,
    conn_pg: Any,
    since: datetime | None = None,
) -> int:
    """UPSERT-delta sync of GCFacturas into ps_gc_facturas.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.
        since:   Only fetch records with Modifica >= since.
                 If None, load all records (initial load).

    Returns:
        Number of rows upserted.
    """
    if since is None:
        sql = _SQL_FACTURAS_ALL
        logger.info("sync_gc_facturas: initial load (no watermark)")
    else:
        sql = _SQL_FACTURAS_DELTA.format(since=_format_since(since))
        logger.info("sync_gc_facturas: delta load since %s", since.date())

    raw_rows = safe_fetch(conn_4d, sql)
    if not raw_rows:
        logger.info("sync_gc_facturas: no new/modified rows")
        return 0

    pg_rows = [_map_row(r, _FACTURAS_MAPPING) for r in raw_rows]
    count = upsert(conn_pg, "ps_gc_facturas", pg_rows, pk_cols=["reg_factura"])
    logger.info("sync_gc_facturas: upserted %d rows", count)
    return count


def sync_gc_lin_albarane(
    conn_4d: Any,
    conn_pg: Any,
    since: datetime | None = None,
) -> int:
    """DELETE+reinsert sync of GCLinAlbarane into ps_gc_lin_albarane.

    GCLinAlbarane has no own modification timestamp.  Delta is derived from
    the parent GCAlbaranes.Modifica field:
      1. Find NAlbaran values where parent Modifica >= since.
      2. DELETE those lines from ps_gc_lin_albarane.
      3. Re-fetch lines from 4D and INSERT.

    For initial load (since=None): truncate + full extract.

    FK note: GCLinAlbarane.NAlbaran → GCAlbaranes.NAlbaran (NOT RegAlbaran).

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.
        since:   Derive changed parents using Modifica >= since.
                 If None, perform full refresh.

    Returns:
        Number of line rows inserted.
    """
    if since is None:
        logger.info("sync_gc_lin_albarane: initial load (full truncate+insert)")
        raw_rows = safe_fetch(conn_4d, _SQL_LIN_ALBARANE_ALL)
        pg_rows = [_map_row(r, _LIN_ALBARANE_MAPPING) for r in raw_rows]
        count = truncate_and_insert(conn_pg, "ps_gc_lin_albarane", pg_rows)
        logger.info("sync_gc_lin_albarane: inserted %d rows (full refresh)", count)
        return count

    # Delta path: find parent IDs modified since watermark
    parent_sql = _SQL_LIN_ALBARANE_PARENT_IDS.format(since=_format_since(since))
    parent_rows = safe_fetch(conn_4d, parent_sql)
    if not parent_rows:
        logger.info(
            "sync_gc_lin_albarane: no parent albaranes modified since %s", since.date()
        )
        return 0

    # NAlbaran values from 4D — may be float; convert to Decimal for PG
    parent_ids = [_to_decimal(r["nalbaran"]) for r in parent_rows]
    logger.info(
        "sync_gc_lin_albarane: %d parent albaranes modified since %s",
        len(parent_ids),
        since.date(),
    )

    # Fetch lines for those parents
    id_list = ", ".join(str(pid) for pid in parent_ids)
    lines_sql = _SQL_LIN_ALBARANE_BY_PARENT.format(placeholders=id_list)
    raw_lines = safe_fetch(conn_4d, lines_sql)
    pg_lines = [_map_row(r, _LIN_ALBARANE_MAPPING) for r in raw_lines]

    # DELETE old lines then INSERT fresh ones in a single transaction
    try:
        import psycopg2.extras  # type: ignore[import-untyped]
        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn_pg.cursor() as cur:
            cur.execute(
                "DELETE FROM ps_gc_lin_albarane WHERE n_albaran = ANY(%s)",
                (list(parent_ids),),
            )
            deleted = cur.rowcount
            logger.info("sync_gc_lin_albarane: deleted %d stale lines", deleted)

            if pg_lines:
                columns = list(pg_lines[0].keys())
                stmt = pgsql.SQL("INSERT INTO {tbl} ({cols}) VALUES %s").format(
                    tbl=pgsql.Identifier("ps_gc_lin_albarane"),
                    cols=pgsql.SQL(", ").join(pgsql.Identifier(c) for c in columns),
                )
                psycopg2.extras.execute_values(
                    cur,
                    stmt.as_string(cur),
                    [tuple(row[c] for c in columns) for row in pg_lines],
                )
        conn_pg.commit()
    except Exception:
        conn_pg.rollback()
        raise

    count = len(pg_lines)
    logger.info("sync_gc_lin_albarane: inserted %d lines", count)
    return count


def sync_gc_lin_facturas(
    conn_4d: Any,
    conn_pg: Any,
    since: datetime | None = None,
) -> int:
    """DELETE+reinsert sync of GCLinFacturas into ps_gc_lin_facturas.

    GCLinFacturas has no own modification timestamp.  Delta is derived from
    the parent GCFacturas.Modifica field:
      1. Find NFactura values where parent Modifica >= since.
      2. DELETE those lines from ps_gc_lin_facturas.
      3. Re-fetch lines from 4D and INSERT.

    For initial load (since=None): truncate + full extract.

    FK note: GCLinFacturas.NumFactura → GCFacturas.NFactura (asymmetric naming).

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.
        since:   Derive changed parents using Modifica >= since.
                 If None, perform full refresh.

    Returns:
        Number of line rows inserted.
    """
    if since is None:
        logger.info("sync_gc_lin_facturas: initial load (full truncate+insert)")
        raw_rows = safe_fetch(conn_4d, _SQL_LIN_FACTURAS_ALL)
        pg_rows = [_map_row(r, _LIN_FACTURAS_MAPPING) for r in raw_rows]
        count = truncate_and_insert(conn_pg, "ps_gc_lin_facturas", pg_rows)
        logger.info("sync_gc_lin_facturas: inserted %d rows (full refresh)", count)
        return count

    # Delta path: find parent NFactura IDs modified since watermark
    parent_sql = _SQL_LIN_FACTURAS_PARENT_IDS.format(since=_format_since(since))
    parent_rows = safe_fetch(conn_4d, parent_sql)
    if not parent_rows:
        logger.info(
            "sync_gc_lin_facturas: no parent facturas modified since %s", since.date()
        )
        return 0

    # NFactura values from 4D — may be float; convert to Decimal for PG
    parent_ids = [_to_decimal(r["nfactura"]) for r in parent_rows]
    logger.info(
        "sync_gc_lin_facturas: %d parent facturas modified since %s",
        len(parent_ids),
        since.date(),
    )

    # Fetch lines for those parents (GCLinFacturas.NumFactura = GCFacturas.NFactura)
    id_list = ", ".join(str(pid) for pid in parent_ids)
    lines_sql = _SQL_LIN_FACTURAS_BY_PARENT.format(placeholders=id_list)
    raw_lines = safe_fetch(conn_4d, lines_sql)
    pg_lines = [_map_row(r, _LIN_FACTURAS_MAPPING) for r in raw_lines]

    # DELETE old lines then INSERT fresh ones in a single transaction
    try:
        import psycopg2.extras  # type: ignore[import-untyped]
        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn_pg.cursor() as cur:
            cur.execute(
                "DELETE FROM ps_gc_lin_facturas WHERE num_factura = ANY(%s)",
                (list(parent_ids),),
            )
            deleted = cur.rowcount
            logger.info("sync_gc_lin_facturas: deleted %d stale lines", deleted)

            if pg_lines:
                columns = list(pg_lines[0].keys())
                stmt = pgsql.SQL("INSERT INTO {tbl} ({cols}) VALUES %s").format(
                    tbl=pgsql.Identifier("ps_gc_lin_facturas"),
                    cols=pgsql.SQL(", ").join(pgsql.Identifier(c) for c in columns),
                )
                psycopg2.extras.execute_values(
                    cur,
                    stmt.as_string(cur),
                    [tuple(row[c] for c in columns) for row in pg_lines],
                )
        conn_pg.commit()
    except Exception:
        conn_pg.rollback()
        raise

    count = len(pg_lines)
    logger.info("sync_gc_lin_facturas: inserted %d lines", count)
    return count


def sync_gc_pedidos(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh sync of GCPedidos into ps_gc_pedidos.

    Only 101 rows — full truncate+insert on every run.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows inserted.
    """
    logger.info("sync_gc_pedidos: full refresh")
    raw_rows = safe_fetch(conn_4d, _SQL_PEDIDOS_ALL)
    pg_rows = [_map_row(r, _PEDIDOS_MAPPING) for r in raw_rows]
    count = truncate_and_insert(conn_pg, "ps_gc_pedidos", pg_rows)
    logger.info("sync_gc_pedidos: inserted %d rows", count)
    return count


def sync_gc_lin_pedidos(conn_4d: Any, conn_pg: Any) -> int:
    """Full-refresh sync of GCLinPedidos into ps_gc_lin_pedidos.

    Only ~2.6K rows — full truncate+insert on every run.

    Note: GCLinPedidos has 240 columns.  If SELECT with specific columns
    fails (Unrecognized 4D type), fall back to get_queryable_columns.

    Args:
        conn_4d: An open p4d connection.
        conn_pg: An open psycopg2 connection.

    Returns:
        Number of rows inserted.
    """
    logger.info("sync_gc_lin_pedidos: full refresh")
    try:
        raw_rows = safe_fetch(conn_4d, _SQL_LIN_PEDIDOS_ALL)
    except Exception as exc:
        logger.warning(
            "sync_gc_lin_pedidos: explicit column query failed (%s); "
            "retrying with get_queryable_columns",
            exc,
        )
        from etl.db.fourd import get_queryable_columns

        safe_cols = get_queryable_columns(conn_4d, "GCLinPedidos")
        # Only select columns present in our mapping
        wanted = set(_LIN_PEDIDOS_MAPPING.keys())
        # Map safe_cols back to lowercase to check membership
        selected = [c for c in safe_cols if c.lower() in wanted]
        if not selected:
            raise RuntimeError(
                "sync_gc_lin_pedidos: no queryable columns overlap with the expected mapping"
            ) from exc
        fallback_sql = "SELECT " + ", ".join(selected) + " FROM GCLinPedidos"
        raw_rows = safe_fetch(conn_4d, fallback_sql)

    pg_rows = [_map_row(r, _LIN_PEDIDOS_MAPPING) for r in raw_rows]
    count = truncate_and_insert(conn_pg, "ps_gc_lin_pedidos", pg_rows)
    logger.info("sync_gc_lin_pedidos: inserted %d rows", count)
    return count
