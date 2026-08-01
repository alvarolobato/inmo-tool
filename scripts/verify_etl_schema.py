#!/usr/bin/env python3
"""Verify ETL column mappings match etl/schema/init.sql CREATE TABLE definitions.

Each sync module exposes dict[str, str] mappings (4D lowercase key → PostgreSQL
column name). If init.sql adds columns only inside CREATE TABLE IF NOT EXISTS,
existing databases need ALTER ... ADD COLUMN — but new mismatches between the
mapping values and the DDL still break INSERT/UPSERT. This script fails CI when
any mapped PostgreSQL column is missing from the corresponding CREATE TABLE block.

Usage (from repository root):
    python scripts/verify_etl_schema.py

When you add a new table sync with a *_MAPPING dict, append a row to CHECKS.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_INIT_SQL = _REPO_ROOT / "etl" / "schema" / "init.sql"

# (importlib module name, mapping attribute on module, PostgreSQL table name)
CHECKS: list[tuple[str, str, str]] = [
    ("etl.sync.articulos", "_ARTICULOS_MAPPING", "ps_articulos"),
    ("etl.sync.articulos", "_FAMILIAS_MAPPING", "ps_familias"),
    ("etl.sync.articulos", "_DEPARTAMENTOS_MAPPING", "ps_departamentos"),
    ("etl.sync.articulos", "_COLORES_MAPPING", "ps_colores"),
    ("etl.sync.articulos", "_TEMPORADAS_MAPPING", "ps_temporadas"),
    ("etl.sync.articulos", "_MARCAS_MAPPING", "ps_marcas"),
    ("etl.sync.ventas", "_VENTAS_MAPPING", "ps_ventas"),
    ("etl.sync.ventas", "_LINEAS_MAPPING", "ps_lineas_ventas"),
    ("etl.sync.ventas", "_PAGOS_MAPPING", "ps_pagos_ventas"),
    ("etl.sync.compras", "_COMPRAS_MAPPING", "ps_compras"),
    ("etl.sync.compras", "_LINEAS_COMPRAS_MAPPING", "ps_lineas_compras"),
    ("etl.sync.compras", "_FACTURAS_MAPPING", "ps_facturas"),
    ("etl.sync.compras", "_ALBARANES_MAPPING", "ps_albaranes"),
    ("etl.sync.compras", "_FACTURAS_COMPRA_MAPPING", "ps_facturas_compra"),
    ("etl.sync.mayorista", "_ALBARANES_MAPPING", "ps_gc_albaranes"),
    ("etl.sync.mayorista", "_LIN_ALBARANE_MAPPING", "ps_gc_lin_albarane"),
    ("etl.sync.mayorista", "_FACTURAS_MAPPING", "ps_gc_facturas"),
    ("etl.sync.mayorista", "_LIN_FACTURAS_MAPPING", "ps_gc_lin_facturas"),
    ("etl.sync.mayorista", "_PEDIDOS_MAPPING", "ps_gc_pedidos"),
    ("etl.sync.mayorista", "_LIN_PEDIDOS_MAPPING", "ps_gc_lin_pedidos"),
]

_DDL_SKIP_FIRST = frozenset(
    {
        "constraint",
        "primary",
        "foreign",
        "unique",
        "check",
        "references",
        "create",
    }
)


def _parse_create_table_columns(sql: str, table: str) -> set[str]:
    """Return column names declared inside CREATE TABLE IF NOT EXISTS <table> (...)."""
    marker = f"CREATE TABLE IF NOT EXISTS {table} ("
    idx = sql.find(marker)
    if idx < 0:
        msg = f"init.sql: no {marker!r} block found"
        raise ValueError(msg)
    start = idx + len(marker)
    body_lines: list[str] = []
    for line in sql[start:].splitlines():
        stripped = line.strip()
        if stripped.startswith(");"):
            break
        body_lines.append(line)
    cols: set[str] = set()
    for raw in body_lines:
        line = raw.strip()
        if not line or line.startswith("--"):
            continue
        parts = line.split()
        if not parts:
            continue
        first = parts[0].strip('"').rstrip(",")
        if not first or first.startswith("--"):
            continue
        low = first.lower()
        if low in _DDL_SKIP_FIRST:
            continue
        if low == "primary" and len(parts) > 1 and parts[1].lower() == "key":
            continue
        cols.add(first)
    return cols


def _mapping_pg_columns(mapping: dict[str, str]) -> set[str]:
    return {v for v in mapping.values() if v}


def main() -> int:
    sys.path.insert(0, str(_REPO_ROOT))
    text = _INIT_SQL.read_text(encoding="utf-8")
    errors: list[str] = []
    ddl_cache: dict[str, set[str]] = {}

    for mod_name, attr, table in CHECKS:
        mod = importlib.import_module(mod_name)
        mapping = getattr(mod, attr)
        if not isinstance(mapping, dict):
            errors.append(f"{mod_name}.{attr} is not a dict")
            continue
        pg_cols = _mapping_pg_columns(mapping)
        if table not in ddl_cache:
            try:
                ddl_cache[table] = _parse_create_table_columns(text, table)
            except ValueError as e:
                errors.append(str(e))
                continue
        ddl = ddl_cache[table]
        missing = sorted(pg_cols - ddl)
        if missing:
            errors.append(
                f"{mod_name}.{attr} → {table}: mapped PostgreSQL columns missing "
                f"from init.sql DDL: {missing}"
            )

    if errors:
        print("verify_etl_schema: FAILED", file=sys.stderr)
        for line in errors:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(f"verify_etl_schema: OK ({len(CHECKS)} mapping(s) checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
