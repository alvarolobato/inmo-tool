"""Full-refresh sync for master/dimension tables.

Tables covered:
- Clientes        → ps_clientes
- Tiendas         → ps_tiendas
- Proveedores     → ps_proveedores
- GCComerciales   → ps_gc_comerciales

All four use TRUNCATE + INSERT (full refresh) because they are small enough
that a delta strategy adds complexity without meaningful benefit.

Column-name mapping convention
-------------------------------
safe_fetch() returns lowercase keys (4D returns UPPERCASE column names).
The mapping dicts translate from lowercase 4D names to PostgreSQL snake_case
column names used in init.sql.

PK precision
------------
4D primary keys are REAL (float) with a `.99` suffix pattern.
All PK/FK values are converted to Decimal before insertion to prevent
binary-float precision loss when stored in PostgreSQL NUMERIC columns.

Proveedores.nombre fix (confirmed 2026-05-01)
---------------------------------------------
The 4D Proveedores table has ``Proveedor`` (text, 100 chars) as the actual
supplier name.  ``NombreComercial`` (text, 160 chars) is empty for all 520
rows.  We now map ``Proveedor`` → ``nombre`` in ps_proveedores.  The old
desired list used ``Nombre`` which does not exist; this has been corrected.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from etl.db.fourd import _validate_identifier, safe_fetch
from etl.db.postgres import truncate_and_insert

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _to_decimal(value: Any) -> Decimal | None:
    """Convert a float PK/FK value to Decimal; pass None through unchanged."""
    if value is None:
        return None
    return Decimal(str(value))


def _discover_columns(
    conn_4d, table_name: str, exclude_types: tuple[int, ...] = (0, 12, 18)
) -> list[str]:
    """Return safe column names for *table_name*, excluding blob/picture/unknown types.

    DATA_TYPE exclusions:
    - 0  : unknown/unsupported type (causes "Unrecognized 4D type" error in p4d)
    - 12 : picture/blob type
    - 18 : blob type

    Returns original-casing column names (as stored in _USER_COLUMNS).

    *table_name* is validated against the safe-identifier pattern used by
    get_queryable_columns() in etl/db/fourd.py to prevent SQL injection.
    """
    _validate_identifier(table_name)
    exclude_list = ", ".join(str(t) for t in exclude_types)
    sql = (
        f"SELECT COLUMN_NAME FROM _USER_COLUMNS "
        f"WHERE TABLE_NAME = '{table_name}' "
        f"AND DATA_TYPE NOT IN ({exclude_list})"
    )
    rows = safe_fetch(conn_4d, sql)
    return [row["column_name"] for row in rows]


# ---------------------------------------------------------------------------
# sync_clientes
# ---------------------------------------------------------------------------

# Mapping from lowercase 4D column names → PostgreSQL column names.
# Only the columns present in ps_clientes (init.sql) are mapped.
# Actual 4D column names discovered via _USER_COLUMNS + docs/schema-discovery:
#   - NumCliente does not exist; Codigo is the client code
#   - Cliente (Alpha 100) is the canonical customer name. NombreComercial
#     exists too but is empty for ~98% of rows (27 452 / 27 988); using it
#     leaves the wholesale review showing num_cliente numerics instead of
#     names. Same gotcha pattern as Proveedores.NombreComercial (D-017).
#   - NIF does not exist; CIF is the tax ID
#   - Email does not exist (case-sensitive); 'email' (lowercase) is the column
#   - CodigoPostal does not exist; Postal is the zip code
_CLIENTES_MAP: dict[str, str] = {
    "regcliente": "reg_cliente",
    "codigo": "num_cliente",  # Codigo = client code (maps to num_cliente)
    "cliente": "nombre",  # Cliente = canonical customer name (Alpha 100)
    "cif": "nif",  # CIF = tax ID (maps to nif)
    "email": "email",  # email (lowercase in 4D)
    "postal": "codigo_postal",  # Postal = zip code (maps to codigo_postal)
    "poblacion": "poblacion",
    "pais": "pais",
    "fechacreacion": "fecha_creacion",
    "fechamodifica": "fecha_modifica",
    "ultimacompraf": "ultima_compra_f",
}

# Preferred 4D column names to query (original casing required in SQL).
# These are the *desired* columns; if a column is missing from the table
# it will be silently omitted by the discovery step.
# `NombreComercial` is queried as a fallback for the few rows where Cliente
# is empty: the post-fetch loop COALESCEs them.
_CLIENTES_DESIRED = [
    "RegCliente",
    "Codigo",  # client code → num_cliente
    "Cliente",  # canonical name → nombre (preferred)
    "NombreComercial",  # business name fallback when Cliente is empty
    "CIF",  # tax ID → nif
    "email",  # email (lowercase in 4D)
    "Postal",  # zip code → codigo_postal
    "Poblacion",
    "Pais",
    "FechaCreacion",
    "FechaModifica",
    "UltimaCompraF",
]


def sync_clientes(conn_4d, conn_pg, since=None) -> int:
    """Sync Clientes → ps_clientes.

    since=None  → full refresh (TRUNCATE + INSERT). Catches hard-deletes.
    since=date  → delta upsert (WHERE FechaModifica > since). The hourly
                  delta cron uses this; the nightly full pass cleans up.

    Returns the number of rows touched.
    """
    from etl.db.postgres import upsert

    # Discover which desired columns actually exist in 4D (safe columns only).
    safe_cols = set(_discover_columns(conn_4d, "Clientes"))
    # Intersect with desired list, preserving desired order.
    cols_to_query = [c for c in _CLIENTES_DESIRED if c in safe_cols]

    if not cols_to_query:
        logger.error("sync_clientes: no queryable columns found in Clientes — aborting")
        return 0
    if "RegCliente" not in cols_to_query:
        logger.error(
            "sync_clientes: required PK column RegCliente not available in Clientes — aborting"
        )
        return 0

    where = ""
    if since is not None:
        if "FechaModifica" not in safe_cols:
            logger.warning(
                "sync_clientes: delta requested but FechaModifica missing — falling back to full refresh"
            )
        else:
            # `>=` not `>`: FechaModifica is date-only; strict `>` would
            # silently skip same-day updates once the watermark advances.
            # Upsert is idempotent so re-fetching today's rows is harmless.
            date_str = since.strftime("%Y-%m-%d")
            where = f" WHERE FechaModifica >= {{d '{date_str}'}}"

    sql = f"SELECT {', '.join(cols_to_query)} FROM Clientes{where}"
    logger.info("sync_clientes: querying 4D — %s", sql)
    rows_4d = safe_fetch(conn_4d, sql)
    logger.info("sync_clientes: fetched %d rows from 4D", len(rows_4d))

    pg_rows: list[dict] = []
    for row in rows_4d:
        mapped: dict[str, Any] = {}
        for fourd_key_lower, pg_key in _CLIENTES_MAP.items():
            if fourd_key_lower in row:
                v = row[fourd_key_lower]
                # Convert float PKs/FKs to Decimal.
                if pg_key in ("reg_cliente", "num_cliente"):
                    v = _to_decimal(v)
                mapped[pg_key] = v
        # Fallback: if the canonical Cliente field is empty for this row but
        # NombreComercial has something, use it. ~98% of clients had Cliente
        # populated and NombreComercial empty in the live mirror, but the few
        # rows that only have NombreComercial would otherwise show num_cliente.
        nombre = mapped.get("nombre")
        if (nombre is None or nombre == "") and "nombrecomercial" in row:
            fallback = row["nombrecomercial"]
            if fallback:
                mapped["nombre"] = fallback
        pg_rows.append(mapped)

    if since is None or not where:
        count = truncate_and_insert(conn_pg, "ps_clientes", pg_rows)
        logger.info("sync_clientes: inserted %d rows into ps_clientes", count)
        return count

    if not pg_rows:
        return 0
    count = upsert(conn_pg, "ps_clientes", pg_rows, pk_cols=["reg_cliente"])
    logger.info("sync_clientes: upserted %d rows into ps_clientes", count)
    return count


# ---------------------------------------------------------------------------
# sync_tiendas
# ---------------------------------------------------------------------------

# Minimum required columns for ps_tiendas (init.sql).
# IdentificadorTienda is the human-readable store label shown in the 4D POS
# form above the address block (e.g. "Factory Rio Mo", "Valencia Alcantara").
# It may be empty; downstream consumers fall back to Poblacion, then the
# raw store Codigo.
_TIENDAS_MAP: dict[str, str] = {
    "regtienda": "reg_tienda",
    "codigo": "codigo",
    "identificadortienda": "identificador",
    "poblacion": "poblacion",
    "fechamodifica": "fecha_modifica",
}

_TIENDAS_DESIRED = [
    "RegTienda",
    "Codigo",
    "IdentificadorTienda",
    "Poblacion",
    "FechaModifica",
]


def sync_tiendas(conn_4d, conn_pg) -> int:
    """Full-refresh sync of Tiendas → ps_tiendas.

    Tiendas has 209 columns including Picture/BLOB columns that hang on
    SELECT *.  Only safe columns (DATA_TYPE NOT IN (0, 12, 18)) are queried,
    intersected with the minimum set required by ps_tiendas.

    Returns the number of rows inserted.
    """
    safe_cols = set(_discover_columns(conn_4d, "Tiendas"))
    cols_to_query = [c for c in _TIENDAS_DESIRED if c in safe_cols]

    if not cols_to_query:
        logger.error("sync_tiendas: no queryable columns found in Tiendas — aborting")
        return 0
    if "RegTienda" not in cols_to_query:
        logger.error(
            "sync_tiendas: required PK column RegTienda is not available or not selected "
            "from Tiendas — aborting to avoid violating ps_tiendas.reg_tienda PRIMARY KEY"
        )
        return 0

    sql = f"SELECT {', '.join(cols_to_query)} FROM Tiendas"
    logger.info("sync_tiendas: querying 4D — %s", sql)
    rows_4d = safe_fetch(conn_4d, sql)
    logger.info("sync_tiendas: fetched %d rows from 4D", len(rows_4d))

    pg_rows: list[dict] = []
    for row in rows_4d:
        mapped: dict[str, Any] = {}
        for fourd_key_lower, pg_key in _TIENDAS_MAP.items():
            if fourd_key_lower in row:
                v = row[fourd_key_lower]
                if pg_key == "reg_tienda":
                    v = _to_decimal(v)
                mapped[pg_key] = v
        pg_rows.append(mapped)

    count = truncate_and_insert(conn_pg, "ps_tiendas", pg_rows)
    logger.info("sync_tiendas: inserted %d rows into ps_tiendas", count)
    return count


# ---------------------------------------------------------------------------
# sync_proveedores
# ---------------------------------------------------------------------------

# Mapping for ps_proveedores (init.sql).
# NOTE: 4D field is "Proveedor" (not "Nombre") — confirmed via _USER_COLUMNS
# and live data (2026-05-01). "NombreComercial" is always empty.
_PROVEEDORES_MAP: dict[str, str] = {
    "regproveedor": "reg_proveedor",
    "proveedor": "nombre",  # Proveedores.Proveedor → ps_proveedores.nombre
    "nif": "nif",
    "pais": "pais",
    "fmodifica": "f_modifica",
}

_PROVEEDORES_DESIRED = [
    "RegProveedor",
    "Proveedor",  # The actual supplier name column (NombreComercial is always empty)
    "NIF",
    "Pais",
    "FModifica",
]


def _discover_pk_proveedores(conn_4d) -> str | None:
    """Discover the PK column for Proveedores by looking for Reg* columns.

    Selection is deterministic and constrained to queryable (safe) columns:
    - Collect all Reg% columns present in _USER_COLUMNS.
    - Intersect with _discover_columns() so we do not pick a column that is
      filtered out by DATA_TYPE exclusions (type 0/12/18).
    - Prefer an exact (case-insensitive) match to "RegProveedor".
    - Otherwise pick the first candidate in a case-insensitive sort.
    """
    # Only consider columns that are queryable (no BLOB/PICTURE/unknown types).
    safe_cols = {name.lower() for name in _discover_columns(conn_4d, "Proveedores")}

    sql = (
        "SELECT COLUMN_NAME FROM _USER_COLUMNS "
        "WHERE TABLE_NAME = 'Proveedores' AND COLUMN_NAME LIKE 'Reg%'"
    )
    rows = safe_fetch(conn_4d, sql)
    if not rows:
        return None

    # Intersect with safe columns.
    candidates = [
        row["column_name"]
        for row in rows
        if isinstance(row.get("column_name"), str)
        and row["column_name"].lower() in safe_cols
    ]

    if not candidates:
        return None

    # Prefer exact RegProveedor (case-insensitive).
    for col_name in candidates:
        if col_name.lower() == "regproveedor":
            return col_name

    # Fall back to deterministic sort.
    return sorted(candidates, key=lambda s: s.lower())[0]


def sync_proveedores(conn_4d, conn_pg) -> int:
    """Full-refresh sync of Proveedores → ps_proveedores.

    Discovers the PK column first (expected: RegProveedor), then queries
    safe columns only.

    Returns the number of rows inserted.
    """
    # Discover PK; default to RegProveedor per etl-sync-strategy.md.
    pk_col = _discover_pk_proveedores(conn_4d)
    if pk_col is None:
        pk_col = "RegProveedor"
        logger.warning(
            "sync_proveedores: could not discover Reg* PK column — defaulting to %s",
            pk_col,
        )
    else:
        logger.info("sync_proveedores: discovered PK column: %s", pk_col)

    # Build desired list with the discovered PK.
    # If the discovered PK differs from the default (RegProveedor), remove the
    # default to avoid selecting two candidate PK columns and ambiguous mapping.
    desired = list(_PROVEEDORES_DESIRED)
    if pk_col != "RegProveedor":
        desired = [c for c in desired if c != "RegProveedor"]
    if pk_col not in desired:
        desired.insert(0, pk_col)

    safe_cols = set(_discover_columns(conn_4d, "Proveedores"))
    cols_to_query = [c for c in desired if c in safe_cols]

    if not cols_to_query:
        logger.error(
            "sync_proveedores: no queryable columns found in Proveedores — aborting"
        )
        return 0
    if pk_col not in cols_to_query:
        logger.error(
            "sync_proveedores: primary key column %s is not queryable in Proveedores — aborting",
            pk_col,
        )
        return 0

    # Validate all dynamically selected column names before interpolating them
    # into the SELECT clause to guard against invalid or unsafe metadata values.
    for col in cols_to_query:
        try:
            _validate_identifier(col)
        except ValueError:
            logger.error(
                "sync_proveedores: invalid column name %r discovered from metadata — aborting",
                col,
            )
            return 0

    sql = f"SELECT {', '.join(cols_to_query)} FROM Proveedores"
    logger.info("sync_proveedores: querying 4D — %s", sql)
    rows_4d = safe_fetch(conn_4d, sql)
    logger.info("sync_proveedores: fetched %d rows from 4D", len(rows_4d))

    # Build a dynamic map that accounts for the discovered PK column name.
    pk_lower = pk_col.lower()
    proveedores_map = dict(_PROVEEDORES_MAP)
    if pk_lower not in proveedores_map:
        proveedores_map[pk_lower] = "reg_proveedor"

    pg_rows: list[dict] = []
    for row in rows_4d:
        mapped: dict[str, Any] = {}
        for fourd_key_lower, pg_key in proveedores_map.items():
            if fourd_key_lower in row:
                v = row[fourd_key_lower]
                if pg_key == "reg_proveedor":
                    v = _to_decimal(v)
                mapped[pg_key] = v
        pg_rows.append(mapped)

    count = truncate_and_insert(conn_pg, "ps_proveedores", pg_rows)
    logger.info("sync_proveedores: inserted %d rows into ps_proveedores", count)
    return count


# ---------------------------------------------------------------------------
# sync_gc_comerciales
# ---------------------------------------------------------------------------

_GC_COMERCIALES_MAP: dict[str, str] = {
    "regcomercial": "reg_comercial",
    "comercial": "comercial",
    "cif": "cif",
    "zonacomercial": "zona_comercial",
    "comision1": "comision1",
    "comision2": "comision2",
    "email": "email",
    "movil": "movil",
}


def sync_gc_comerciales(conn_4d, conn_pg) -> int:
    """Full-refresh sync of GCComerciales → ps_gc_comerciales.

    Only 5 rows; all columns are safe (no BLOB/PICTURE).

    Returns the number of rows inserted.
    """
    sql = (
        "SELECT RegComercial, Comercial, CIF, ZonaComercial, "
        "Comision1, Comision2, email, Movil FROM GCComerciales"
    )
    logger.info("sync_gc_comerciales: querying 4D — %s", sql)
    rows_4d = safe_fetch(conn_4d, sql)
    logger.info("sync_gc_comerciales: fetched %d rows from 4D", len(rows_4d))

    pg_rows: list[dict] = []
    for row in rows_4d:
        mapped: dict[str, Any] = {}
        for fourd_key_lower, pg_key in _GC_COMERCIALES_MAP.items():
            if fourd_key_lower in row:
                v = row[fourd_key_lower]
                if pg_key == "reg_comercial":
                    v = _to_decimal(v)
                mapped[pg_key] = v
        pg_rows.append(mapped)

    count = truncate_and_insert(conn_pg, "ps_gc_comerciales", pg_rows)
    logger.info("sync_gc_comerciales: inserted %d rows into ps_gc_comerciales", count)
    return count
