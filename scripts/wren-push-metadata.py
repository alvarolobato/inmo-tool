#!/usr/bin/env python3
"""Push full semantic metadata to WrenAI: descriptions, aliases, knowledge, relationships.

Run after WrenAI is up and the PostgreSQL data source is connected:
    python3 scripts/wren-push-metadata.py [--url http://localhost:3000]
    python3 scripts/wren-push-metadata.py --validate  # validate SQL pairs against PostgreSQL

This script is idempotent — safe to re-run. Steps:
  1. Push model descriptions and display name aliases via GraphQL API
  2. Create relationships via GraphQL API
  3. Update column display names and descriptions directly in WrenAI's SQLite DB
  4. Populate knowledge (instructions + SQL pairs) in SQLite using merge strategy:
       - Source instructions: marked is_default=1, deleted+recreated on each run
       - User instructions: is_default=0 (created via UI), never touched by this script
       - SQL pairs: tracked by question text — only source pairs are updated
  5. Deploy (re-index embeddings in qdrant)
  6. Index instructions + SQL pairs in qdrant via AI service

All three WrenAI knowledge surfaces are MD-driven (post-#532/#550):
  ## LLM:rules        → INSTRUCTIONS  (JSON instruction arrays)
  ## LLM:sql-pairs    → SQL_PAIRS     (### heading + ```sql``` blocks)
  ## LLM:relationships → RELATIONSHIPS (JSON FK-relationship arrays)

Requires: the wren-ui container to be running (for GraphQL API + SQLite copy).
"""

import argparse
import decimal
import json
import os
import pathlib
import re
import shutil
import subprocess
import sqlite3
import sys
import tempfile
import urllib.request

import yaml


def gql(url, query):
    req = urllib.request.Request(
        f"{url}/api/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read())


# ═══════════════════════════════════════════════════════════════════════
# KNOWLEDGE: MD parser — reads instructions + SQL pairs from source MDs
# ═══════════════════════════════════════════════════════════════════════
#
# Source MDs loaded from docs/knowledge-sources.yml (single source of truth).
# To add a new source, edit that file — this script picks it up automatically.
#
# Date placeholder transform (dashboard syntax → PostgreSQL native):
#   :curr_from  → DATE_TRUNC('month', CURRENT_DATE)
#   :curr_to    → CURRENT_DATE
#   :comp_from  → DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 year'
#   :comp_to    → CURRENT_DATE - INTERVAL '1 year'

_REPO_ROOT = pathlib.Path(__file__).parent.parent


def _load_source_mds() -> list[str]:
    """Load the source MD path list from docs/knowledge-sources.yml."""
    manifest = _REPO_ROOT / "docs" / "knowledge-sources.yml"
    with open(manifest, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return [entry["path"] for entry in data["sources"]]


SOURCE_MDS = _load_source_mds()

_LLM_HEADING = re.compile(r"^## LLM:([\w][\w-]*)$")
_ANY_H2 = re.compile(r"^## ")

_DATE_PLACEHOLDERS = [
    (":curr_from", "DATE_TRUNC('month', CURRENT_DATE)"),
    (":curr_to", "CURRENT_DATE"),
    (":comp_from", "DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 year'"),
    (":comp_to", "CURRENT_DATE - INTERVAL '1 year'"),
]


def parse_marker_sections(content: str) -> list[dict]:
    """Extract ## LLM:<marker> sections from Markdown content.

    Returns a list of {"marker": str, "content": str} dicts.
    A section ends at the next ## heading (LLM or otherwise) or end of file.
    Mirrors the TypeScript parseMarkdownSections() in build-knowledge.ts.
    """
    sections: list[dict] = []
    current_marker: str | None = None
    current_lines: list[str] = []
    for line in content.splitlines():
        m = _LLM_HEADING.match(line.rstrip())
        if m:
            if current_marker is not None:
                sections.append(
                    {
                        "marker": current_marker,
                        "content": "\n".join(current_lines).strip(),
                    }
                )
            current_marker = m.group(1)
            current_lines = []
        elif current_marker is not None:
            if _ANY_H2.match(line):
                sections.append(
                    {
                        "marker": current_marker,
                        "content": "\n".join(current_lines).strip(),
                    }
                )
                current_marker = None
                current_lines = []
            else:
                current_lines.append(line)
    if current_marker is not None:
        sections.append(
            {"marker": current_marker, "content": "\n".join(current_lines).strip()}
        )
    return sections


def extract_instructions(content: str) -> list[dict]:
    """Parse ## LLM:rules sections and return a list of instruction dicts.

    Expects the section content to contain a single ```json [...] ``` block
    whose items have "instruction" and "questions" keys.
    Skips empty arrays silently.
    """
    instructions: list[dict] = []
    for section in parse_marker_sections(content):
        if section["marker"] != "rules":
            continue
        json_m = re.search(r"```json\s*\n(.*?)\n```", section["content"], re.DOTALL)
        if not json_m:
            continue
        try:
            items = json.loads(json_m.group(1))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in ## LLM:rules: {exc}") from exc
        for item in items:
            if not isinstance(item, dict):
                continue
            if "instruction" not in item:
                continue
            if "questions" not in item or not isinstance(item["questions"], list):
                raise ValueError(
                    f"Instruction missing 'questions' list: {item.get('instruction', '')!r}"
                )
            instructions.append(item)
    return instructions


def extract_sql_pairs(content: str) -> list[tuple[str, str]]:
    """Parse ## LLM:sql-pairs sections and return (question, sql) tuples.

    Each pair is a ### heading followed by a ```sql ... ``` block.
    Applies transform_date_placeholders to each SQL string before returning.
    """
    pairs: list[tuple[str, str]] = []
    for section in parse_marker_sections(content):
        if section["marker"] != "sql-pairs":
            continue
        # Split on ### headings
        chunks = re.split(r"^### ", section["content"], flags=re.MULTILINE)
        for chunk in chunks:
            if not chunk.strip():
                continue
            lines = chunk.split("\n", 1)
            question = lines[0].strip()
            rest = lines[1] if len(lines) > 1 else ""
            sql_m = re.search(r"```sql\s*\n(.*?)\n```", rest, re.DOTALL)
            if not sql_m or not question:
                continue
            sql = transform_date_placeholders(sql_m.group(1).strip())
            sql = transform_wren_table_names(sql)
            pairs.append((question, sql))
    return pairs


def transform_date_placeholders(sql: str) -> str:
    """Replace dashboard parameter syntax with PostgreSQL-native date expressions.

    WrenAI executes SQL pairs directly during validation (ps wren validate),
    so placeholder syntax must be resolved to real expressions.
    """
    for placeholder, expression in _DATE_PLACEHOLDERS:
        sql = sql.replace(placeholder, expression)
    return sql


def transform_wren_table_names(sql: str) -> str:
    """Convert PostgreSQL schema.table notation to WrenAI model reference names.

    SQL pairs in sql-pairs.md use "public"."ps_ventas" (valid PostgreSQL) but
    WrenAI's query engine expects the model reference name "public_ps_ventas"
    (schema and table joined with underscore). Feeding the schema.table form
    to WrenAI's RAG causes the LLM to generate SQL that WrenAI cannot execute.

    Transforms: "public"."ps_  →  "public_ps_
    Also handles unquoted variants: public.ps_  →  public_ps_
    """
    import re

    # Quoted: "public"."ps_something" -> "public_ps_something"
    sql = re.sub(r'"public"\."(ps_[^"]+)"', r'"public_\1"', sql)
    # Unquoted: public.ps_something -> public_ps_something
    sql = re.sub(r"\bpublic\.(ps_\w+)", r"public_\1", sql)
    return sql


def load_knowledge_from_mds() -> tuple[list[dict], list[tuple[str, str]]]:
    """Load all instructions and SQL pairs from SOURCE_MDS.

    Returns (instructions, sql_pairs) where:
      - instructions: list of {"instruction": str, "questions": [...]} dicts
      - sql_pairs:    list of (question, sql) tuples
    """
    all_instructions: list[dict] = []
    all_sql_pairs: list[tuple[str, str]] = []
    for rel_path in SOURCE_MDS:
        full_path = _REPO_ROOT / rel_path
        if not full_path.exists():
            print(
                f"  WARNING: source MD not found, skipped: {rel_path}", file=sys.stderr
            )
            continue
        content = full_path.read_text(encoding="utf-8")
        all_instructions.extend(extract_instructions(content))
        all_sql_pairs.extend(extract_sql_pairs(content))
    return all_instructions, all_sql_pairs


def parse_relationships_from_mds(
    mds: list[str],
) -> list[tuple[str, str, str, str, str]]:
    """Load FK relationships from ## LLM:relationships sections in source MDs.

    Each section's content must be a JSON array of objects with keys:
      "from", "fromColumn", "to", "toColumn", "type"

    Returns a list of (from_model, from_col, to_model, to_col, rel_type) tuples —
    the same shape that the GraphQL relationship-push loop expects.
    Handles both JSON arrays and single-object forms defensively.
    Skips files that are missing or have no ## LLM:relationships section.
    """
    _REQUIRED_KEYS = {"from", "fromColumn", "to", "toColumn", "type"}
    result: list[tuple[str, str, str, str, str]] = []
    for rel_path in mds:
        full_path = _REPO_ROOT / rel_path
        if not full_path.exists():
            print(
                f"  WARNING: source MD not found, skipped: {rel_path}", file=sys.stderr
            )
            continue
        content = full_path.read_text(encoding="utf-8")
        for section in parse_marker_sections(content):
            if section["marker"] != "relationships":
                continue
            json_m = re.search(r"```json\s*\n(.*?)\n```", section["content"], re.DOTALL)
            if not json_m:
                continue
            try:
                items = json.loads(json_m.group(1))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSON in ## LLM:relationships ({rel_path}): {exc}"
                ) from exc
            if isinstance(items, dict):
                items = [items]
            for item in items:
                if not isinstance(item, dict):
                    continue
                missing_keys = _REQUIRED_KEYS - item.keys()
                if missing_keys:
                    raise ValueError(
                        f"Relationship entry in {rel_path} missing keys {missing_keys}: {item!r}"
                    )
                result.append(
                    (
                        item["from"],
                        item["fromColumn"],
                        item["to"],
                        item["toColumn"],
                        item["type"],
                    )
                )
    # Deduplicate while preserving source order (defensive guard against duplicate
    # entries across source MDs — the GraphQL push loop also handles duplicates).
    seen: set[tuple[str, str, str, str, str]] = set()
    deduped = []
    for rel in result:
        if rel not in seen:
            seen.add(rel)
            deduped.append(rel)
    return deduped


# Load at import time so INSTRUCTIONS / SQL_PAIRS / RELATIONSHIPS are available
# as module-level names (consumed by main() and validate_sql_pairs()).
INSTRUCTIONS, SQL_PAIRS = load_knowledge_from_mds()
RELATIONSHIPS = parse_relationships_from_mds(SOURCE_MDS)


# ═══════════════════════════════════════════════════════════════════════
# MODEL METADATA (descriptions + aliases) — pushed via GraphQL
# ═══════════════════════════════════════════════════════════════════════

MODEL_METADATA = {
    "ps_articulos": {
        "alias": "Producto",
        "desc": "Catálogo de productos y artículos. Referencia comercial = ccrefejofacm (mostrar como 'Referencia'). Prefijo M = mayorista, MA = material sin inventario.",
    },
    "ps_familias": {
        "alias": "Familia",
        "desc": "Familias/grupos de productos (jerarquía de clasificación)",
    },
    "ps_departamentos": {
        "alias": "Departamento",
        "desc": "Departamentos/secciones (nivel superior)",
    },
    "ps_colores": {"alias": "Color", "desc": "Catálogo de colores de producto"},
    "ps_temporadas": {
        "alias": "Temporada",
        "desc": "Temporadas y tipos (clasificación temporal)",
    },
    "ps_marcas": {"alias": "Marca", "desc": "Marcas de producto"},
    "ps_clientes": {
        "alias": "Cliente",
        "desc": "Clientes. num_cliente=0 son ventas anónimas de caja.",
    },
    "ps_tiendas": {
        "alias": "Tienda",
        "desc": "Tiendas y puntos de venta. Código 99=almacén central, 97=tienda online.",
    },
    "ps_proveedores": {"alias": "Proveedor", "desc": "Proveedores de mercancía"},
    "ps_gc_comerciales": {
        "alias": "Comercial",
        "desc": "Comerciales/agentes de ventas mayorista",
    },
    "ps_ventas": {
        "alias": "Venta",
        "desc": "Tickets de venta retail/TPV. USAR SIEMPRE total_si (sin IVA) para análisis. NUNCA total (con IVA). fecha_creacion = fecha de la venta.",
    },
    "ps_lineas_ventas": {
        "alias": "LineaVenta",
        "desc": "Líneas de venta (detalle por artículo). total_si=importe sin IVA. unidades=cantidad. codigo=artículo (join con Producto).",
    },
    "ps_pagos_ventas": {
        "alias": "PagoVenta",
        "desc": "Pagos por ticket. importe_cob=importe cobrado.",
    },
    "ps_stock_tienda": {
        "alias": "StockTienda",
        "desc": "Stock por tienda y talla (normalizado). tienda=código (99=almacén, 97=online). stock=unidades.",
    },
    "ps_traspasos": {"alias": "Traspaso", "desc": "Traspasos de stock entre tiendas"},
    "ps_gc_albaranes": {
        "alias": "AlbaranMayorista",
        "desc": "Albaranes mayorista (entregas B2B). Importe neto=base1+base2+base3.",
    },
    "ps_gc_lin_albarane": {
        "alias": "LineaAlbaranMayorista",
        "desc": "Líneas de albarán mayorista",
    },
    "ps_gc_facturas": {
        "alias": "FacturaMayorista",
        "desc": "Facturas mayorista. Importe neto=base1+base2+base3.",
    },
    "ps_gc_lin_facturas": {
        "alias": "LineaFacturaMayorista",
        "desc": "Líneas de factura mayorista",
    },
    "ps_gc_pedidos": {"alias": "PedidoMayorista", "desc": "Pedidos mayorista"},
    "ps_gc_lin_pedidos": {
        "alias": "LineaPedidoMayorista",
        "desc": "Líneas de pedido mayorista",
    },
    "ps_compras": {"alias": "PedidoCompra", "desc": "Pedidos de compra a proveedores"},
    "ps_lineas_compras": {
        "alias": "LineaPedidoCompra",
        "desc": "Líneas de pedido de compra",
    },
    "ps_facturas": {"alias": "Factura", "desc": "Facturas de compra"},
    "ps_albaranes": {"alias": "AlbaranRecepcion", "desc": "Albaranes de recepción"},
    "ps_facturas_compra": {
        "alias": "FacturaCompra",
        "desc": "Facturas de compra a proveedores",
    },
}

# ═══════════════════════════════════════════════════════════════════════
# COLUMN DISPLAY NAMES + DESCRIPTIONS — pushed via SQLite
# ═══════════════════════════════════════════════════════════════════════

# {model_alias: {source_column: (display_name, description)}}
COLUMN_META = {
    "Producto": {
        "reg_articulo": ("ID Artículo", "ID interno del artículo (PK)"),
        "codigo": ("Código", "Código interno de artículo"),
        "ccrefejofacm": (
            "Referencia",
            "Referencia comercial — identificador principal de negocio. M=mayorista, MA=material",
        ),
        "descripcion": ("Descripción", "Descripción del artículo"),
        "codigo_barra": ("EAN", "Código de barras EAN"),
        "num_familia": ("Familia", "FK → Familia"),
        "num_departament": ("Departamento", "FK → Departamento"),
        "num_color": ("Color (FK)", "FK → Color"),
        "num_temporada": ("Temporada", "FK → Temporada"),
        "num_marca": ("Marca", "FK → Marca"),
        "num_proveedor": ("Proveedor", "FK → Proveedor"),
        "precio_coste": ("Precio Coste", "Precio de coste"),
        "pr_coste_ne": ("Coste Neto", "Precio de coste neto sin IVA"),
        "p_iva": ("% IVA", "Porcentaje de IVA"),
        "anulado": ("Anulado", "Artículo inactivo"),
        "fecha_creacion": ("Fecha Creación", "Fecha de creación"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
        "color": ("Color", "Color (texto)"),
        "clave_temporada": ("Clave Temporada", "Clave de temporada"),
        "modelo": ("Modelo", "Modelo del artículo"),
        "sexo": ("Género", "Género destinatario"),
    },
    "Venta": {
        "reg_ventas": ("ID Venta", "ID interno del ticket (PK)"),
        "n_documento": ("Nº Documento", "Número de ticket"),
        "serie_v": ("Serie", "Serie del documento"),
        "tienda": ("Tienda", "Código de tienda"),
        "fecha_creacion": ("Fecha", "Fecha de la venta"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
        "total_si": ("Importe Neto", "Importe SIN IVA — usar siempre para análisis"),
        "total": ("Importe Bruto", "Importe CON IVA — NO usar para comparar"),
        "num_cliente": ("Cliente", "Nº cliente (0=anónimo)"),
        "codigo_cajero": ("Código Cajero", "Código del cajero"),
        "cajero_nombre": ("Cajero", "Nombre del cajero"),
        "tipo_venta": ("Tipo Venta", "Tipo de venta"),
        "tipo_documento": ("Tipo Doc", "V=venta, D=devolución"),
        "forma": ("Forma Pago", "Forma de pago"),
        "entrada": ("Es Entrada", "Entrada (vs devolución)"),
        "pendiente": ("Pendiente", "Pendiente de cobro"),
        "pedido_web": ("Pedido Web", "ID pedido online"),
    },
    "LineaVenta": {
        "reg_lineas": ("ID Línea", "ID interno (PK)"),
        "num_ventas": ("ID Venta", "FK → Venta"),
        "n_documento": ("Nº Documento", "Número de ticket"),
        "mes": ("Período", "YYYYMM (ej: 202603)"),
        "tienda": ("Tienda", "Código de tienda"),
        "codigo": ("Código Artículo", "JOIN con Producto.codigo"),
        "descripcion": ("Descripción", "Descripción del artículo"),
        "unidades": ("Unidades", "Cantidad vendida"),
        "precio_neto_si": ("Precio Unitario", "Precio sin IVA"),
        "total_si": ("Importe Neto", "Importe línea sin IVA"),
        "precio_coste_ci": ("Coste Unitario", "Precio de coste"),
        "total_coste_si": ("Coste Total", "Coste total de la línea"),
        "fecha_creacion": ("Fecha", "Fecha de la venta"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
    },
    "PagoVenta": {
        "reg_pagos": ("ID Pago", "ID interno (PK)"),
        "num_ventas": ("ID Venta", "FK → Venta"),
        "forma": ("Forma Pago", "Forma de pago"),
        "codigo_forma": ("Código Forma", "Código forma pago"),
        "importe_cob": ("Importe", "Importe cobrado"),
        "fecha_creacion": ("Fecha", "Fecha del pago"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
        "tienda": ("Tienda", "Código de tienda"),
        "entrada": ("Es Entrada", "Entrada (vs devolución)"),
    },
    "StockTienda": {
        "codigo": ("Código Artículo", "Código de artículo"),
        "tienda_codigo": ("Clave Tienda/Artículo", "Clave compuesta"),
        "tienda": ("Tienda", "Código tienda (99=almacén, 97=online)"),
        "talla": ("Talla", "Talla del artículo"),
        "stock": ("Stock", "Unidades disponibles"),
        "cc_stock": ("Stock Central", "Stock almacén central"),
        "st_stock": ("Stock Total", "Stock total calculado"),
        "fecha_modifica": ("Última Actualización", "Última actualización"),
    },
    "Tienda": {
        "reg_tienda": ("ID Tienda", "ID interno (PK)"),
        "codigo": ("Código", "Código (99=almacén, 97=online)"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
    },
    "Cliente": {
        "reg_cliente": ("ID Cliente", "ID interno (PK)"),
        "num_cliente": ("Nº Cliente", "Número (0=anónimo)"),
        "nombre": ("Nombre", "Nombre del cliente"),
        "nif": ("NIF", "NIF/CIF"),
        "email": ("Email", "Email"),
        "codigo_postal": ("C.P.", "Código postal"),
        "poblacion": ("Población", "Ciudad"),
        "pais": ("País", "País"),
        "fecha_creacion": ("Fecha Alta", "Fecha de alta"),
        "fecha_modifica": ("Última Modificación", "Última modificación"),
        "ultima_compra_f": ("Última Compra", "Fecha última compra"),
    },
    "AlbaranMayorista": {
        "reg_albaran": ("ID Albarán", "ID interno (PK)"),
        "n_albaran": ("Nº Albarán", "Número de albarán"),
        "num_cliente": ("Cliente", "FK → Cliente"),
        "fecha_envio": ("Fecha Envío", "Fecha de envío"),
        "fecha_valor": ("Fecha Valor", "Fecha valor"),
        "modifica": ("Última Modificación", "Fecha modificación"),
        "base1": ("Base 1", "Base imponible 1 sin IVA"),
        "base2": ("Base 2", "Base imponible 2 sin IVA"),
        "base3": ("Base 3", "Base imponible 3 sin IVA"),
        "entregadas": ("Unidades", "Unidades entregadas"),
        "transportista": ("Transportista", "Transportista"),
        "num_comercial": ("Comercial", "FK → Comercial"),
        "temporada": ("Temporada", "Temporada"),
    },
    "FacturaMayorista": {
        "reg_factura": ("ID Factura", "ID interno (PK)"),
        "n_factura": ("Nº Factura", "Número de factura"),
        "fecha_factura": ("Fecha", "Fecha de factura"),
        "modifica": ("Última Modificación", "Fecha modificación"),
        "base1": ("Base 1", "Base imponible 1 sin IVA"),
        "base2": ("Base 2", "Base imponible 2 sin IVA"),
        "base3": ("Base 3", "Base imponible 3 sin IVA"),
        "num_cliente": ("Cliente", "FK → Cliente"),
        "num_comercial": ("Comercial", "FK → Comercial"),
        "abono": ("Es Abono", "Nota de crédito"),
        "total_factura": (
            "Total (IVA inc.)",
            "Total CON IVA — usar base1+2+3 para neto",
        ),
    },
}


SOURCE_QUESTIONS = {question for question, _sql in SQL_PAIRS}


def validate_sql_pairs(dsn: str) -> None:
    """Validate all SQL pairs by executing them against the PostgreSQL mirror.

    Checks:
    1. SQL executes without error (syntax, table/column names, joins)
    2. Query returns at least 1 row with non-NULL first value (warns if not — may be no
       data for current period, but worth flagging)
    3. Prints the first result value so you can spot-check magnitude visually
    """
    try:
        import psycopg2
    except ImportError:
        print("psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    print(f"\n═══ Validating {len(SQL_PAIRS)} SQL pairs against PostgreSQL ═══")
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '60s'")

    passed = failed = warned = 0
    for question, sql in SQL_PAIRS:
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
                rows = cur.fetchmany(3)
                col_names = [d[0] for d in cur.description] if cur.description else []

            if not rows:
                print(f"  WARN {question[:68]}")
                print("       (0 rows — no data for current period?)")
                warned += 1
            else:
                first_val = rows[0][0]
                if first_val is None:
                    print(f"  WARN {question[:68]}")
                    print("       (first value is NULL)")
                    warned += 1
                else:
                    n_cols = len(col_names)
                    n_rows = len(rows)
                    suffix = (
                        f" → {first_val}"
                        if n_rows == 1 and n_cols <= 3
                        else f" ({n_rows}+ rows × {n_cols} cols)"
                    )
                    print(f"  OK  {question[:68]}{suffix}")
                    passed += 1
        except Exception as e:
            print(f"  ERR {question[:70]}")
            print(f"      {e}")
            failed += 1

    conn.close()
    print(f"\nResult: {passed} OK, {warned} warnings, {failed} failed")
    if failed:
        sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════
# CROSS-VALIDATION: compare same metric from different data paths (I)
# ═══════════════════════════════════════════════════════════════════════
# These queries compute the same business metric two ways and compare.
# Discrepancies reveal JOIN errors, filter gaps, or ETL issues.
# Run with: ps wren crosscheck

CROSS_VALIDATIONS = [
    (
        "Retail sales: ps_ventas.total_si vs SUM(ps_lineas_ventas.total_si) YTD",
        """
        SELECT
            (SELECT SUM(total_si) FROM ps_ventas
             WHERE fecha_creacion >= DATE_TRUNC('year', CURRENT_DATE)
               AND entrada = true) AS ventas_cabecera,
            (SELECT SUM(lv.total_si) FROM ps_lineas_ventas lv
             JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
             WHERE v.fecha_creacion >= DATE_TRUNC('year', CURRENT_DATE)
               AND v.entrada = true) AS ventas_lineas
        """,
        "Should match within ~1% (rounding on line-level splits)",
    ),
    (
        "Retail tickets: COUNT in ps_ventas vs COUNT(DISTINCT num_ventas) in ps_lineas_ventas (this month)",
        """
        SELECT
            (SELECT COUNT(*) FROM ps_ventas
             WHERE fecha_creacion >= DATE_TRUNC('month', CURRENT_DATE)
               AND entrada = true) AS tickets_ventas,
            (SELECT COUNT(DISTINCT lv.num_ventas) FROM ps_lineas_ventas lv
             JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas
             WHERE v.fecha_creacion >= DATE_TRUNC('month', CURRENT_DATE)
               AND v.entrada = true) AS tickets_lineas
        """,
        "Should match exactly (every sale header has at least 1 line)",
    ),
    (
        "Stock total units: SUM(ps_stock_tienda.stock) retail vs SUM(ps_articulos.stock)",
        """
        SELECT
            (SELECT SUM(stock) FROM ps_stock_tienda
             WHERE tienda <> '99' AND stock > 0) AS stock_tiendas_retail,
            (SELECT SUM(st_stock) FROM ps_stock_tienda
             WHERE tienda <> '99') AS stock_tiendas_ststock,
            (SELECT SUM(stock) FROM ps_articulos
             WHERE anulado = false AND stock > 0) AS stock_articulos
        """,
        "stock_tiendas_retail ≈ stock_tiendas_ststock (same source, different columns). "
        "stock_articulos is a denormalized total (retail+central) — expect it to be larger.",
    ),
    (
        "Wholesale invoices: ps_gc_facturas header vs ps_gc_lin_facturas lines YTD",
        """
        SELECT
            (SELECT SUM(base1 + COALESCE(base2,0) + COALESCE(base3,0))
             FROM ps_gc_facturas
             WHERE fecha_factura >= DATE_TRUNC('year', CURRENT_DATE)
               AND abono = false) AS facturas_cabecera,
            (SELECT SUM(lf.total)
             FROM ps_gc_lin_facturas lf
             JOIN ps_gc_facturas f ON lf.num_factura = f.n_factura
             WHERE f.fecha_factura >= DATE_TRUNC('year', CURRENT_DATE)
               AND f.abono = false) AS facturas_lineas
        """,
        "Should match within ~2% (header bases may exclude minor rounding vs line totals)",
    ),
    (
        "Stock value at cost: ps_stock_tienda × ps_articulos.precio_coste",
        """
        SELECT
            SUM(s.stock * a.precio_coste) AS valor_coste_tiendas,
            COUNT(DISTINCT s.codigo)::text AS articulos_en_stock
        FROM ps_stock_tienda s
        JOIN ps_articulos a ON s.codigo = a.codigo
        WHERE s.stock > 0 AND a.anulado = false AND s.tienda <> '99'
        """,
        "Expected range: €500K–€15M. Flag if outside this range — likely a JOIN or filter issue.",
    ),
]


def cross_validate(dsn: str) -> None:
    """Run cross-validation queries to check data consistency across tables.

    Compares the same business metric computed from different data paths.
    Discrepancies reveal JOIN errors, filter gaps, or ETL sync issues.
    """
    try:
        import psycopg2
    except ImportError:
        print("psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    print(f"\n═══ Cross-validating {len(CROSS_VALIDATIONS)} metric pairs ═══\n")
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '120s'")

    issues = 0
    for name, sql, note in CROSS_VALIDATIONS:
        print(f"  ── {name}")
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
                rows = cur.fetchall()
                col_names = [d[0] for d in cur.description]

            if not rows:
                print("     WARN: no rows returned")
                issues += 1
            else:
                row = rows[0]
                for col, val in zip(col_names, row):
                    print(f"     {col}: {val}")

                # Auto-detect discrepancies: if two numeric cols, compare them
                numeric_vals = [
                    (c, v)
                    for c, v in zip(col_names, row)
                    if isinstance(v, (int, float, decimal.Decimal)) and v is not None
                ]
                if len(numeric_vals) == 2:
                    (c1, v1), (c2, v2) = numeric_vals
                    if v1 and v2:
                        ratio = abs(v1 - v2) / max(abs(v1), abs(v2))
                        if ratio > 0.05:
                            print(
                                f"     ⚠ MISMATCH: {c1}={v1:,.2f} vs {c2}={v2:,.2f} "
                                f"({ratio * 100:.1f}% difference)"
                            )
                            issues += 1
                        else:
                            print(f"     ✓ within {ratio * 100:.2f}% tolerance")
            print(f"     note: {note}\n")
        except Exception as e:
            print(f"     ERR: {e}\n")
            issues += 1

    conn.close()
    print(f"Cross-validation complete. Issues found: {issues}")
    if issues:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Push full semantic metadata to WrenAI"
    )
    parser.add_argument("--url", default="http://localhost:3000", help="WrenAI UI URL")
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate SQL pairs by executing against PostgreSQL (requires POSTGRES_DSN env var)",
    )
    parser.add_argument(
        "--crosscheck",
        action="store_true",
        help="Run cross-validation queries to check data consistency (requires POSTGRES_DSN env var)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print instruction + SQL pair counts and a JSON sample; exit without API calls or SQLite writes",
    )
    parser.add_argument(
        "--repo-root",
        type=pathlib.Path,
        default=None,
        metavar="PATH",
        help="Root of the repository (overrides auto-detection from script location). "
        "Use when running from a temp directory where source MDs have been SCP'd.",
    )
    args = parser.parse_args()
    url = args.url

    # If --repo-root is provided, update the global and reload knowledge from that root.
    if args.repo_root is not None:
        if not args.repo_root.is_dir():
            print(
                f"ERROR: --repo-root '{args.repo_root}' is not a directory",
                file=sys.stderr,
            )
            sys.exit(2)
        global _REPO_ROOT, INSTRUCTIONS, SQL_PAIRS, RELATIONSHIPS, SOURCE_QUESTIONS
        _REPO_ROOT = args.repo_root.resolve()
        INSTRUCTIONS, SQL_PAIRS = load_knowledge_from_mds()
        RELATIONSHIPS = parse_relationships_from_mds(SOURCE_MDS)
        SOURCE_QUESTIONS = {question for question, _sql in SQL_PAIRS}

    if args.dry_run:
        print("═══ Dry run — knowledge loaded from source MDs ═══")
        print(f"  Instructions : {len(INSTRUCTIONS)}")
        print(f"  SQL pairs    : {len(SQL_PAIRS)}")
        print(f"  Relationships: {len(RELATIONSHIPS)}")
        if INSTRUCTIONS:
            sample = INSTRUCTIONS[0]
            print("\nSample instruction:")
            print(json.dumps(sample, ensure_ascii=False, indent=2))
        if SQL_PAIRS:
            question, sql = SQL_PAIRS[0]
            print("\nSample SQL pair:")
            print(
                json.dumps(
                    {"question": question, "sql": sql}, ensure_ascii=False, indent=2
                )
            )
        return

    if args.validate:
        dsn = os.environ.get(
            "POSTGRES_DSN", "postgresql://postgres:change_me@localhost:5432/powershop"
        )
        validate_sql_pairs(dsn)
        return

    if args.crosscheck:
        dsn = os.environ.get(
            "POSTGRES_DSN", "postgresql://postgres:change_me@localhost:5432/powershop"
        )
        cross_validate(dsn)
        return

    # ── 1. GraphQL: Model metadata ──────────────────────────────────
    print("═══ Step 1: Model descriptions + aliases (GraphQL) ═══")
    data = gql(
        url, "{ listModels { id displayName fields { id displayName referenceName } } }"
    )
    models = {}
    for m in data["data"]["listModels"]:
        name = m["displayName"].replace("public.", "")
        models[name] = {
            "id": m["id"],
            "fields": {f["referenceName"]: f["id"] for f in m["fields"]},
        }

    for name, meta in MODEL_METADATA.items():
        if name not in models:
            continue
        mid = models[name]["id"]
        desc = meta["desc"].replace('"', '\\"')
        alias = meta["alias"]
        gql(
            url,
            f'mutation {{ updateModelMetadata(where: {{id: {mid}}}, data: {{displayName: "{alias}", description: "{desc}"}}) }}',
        )
        print(f"  OK {name} -> {alias}")

    # ── 2. GraphQL: Relationships ───────────────────────────────────
    print("\n═══ Step 2: Relationships (GraphQL) ═══")
    # Re-fetch models with new aliases
    data = gql(
        url, "{ listModels { id displayName fields { id displayName referenceName } } }"
    )
    models_by_alias = {}
    for m in data["data"]["listModels"]:
        alias = m["displayName"]
        table = None
        for t, meta in MODEL_METADATA.items():
            if meta["alias"] == alias:
                table = t
                break
        if not table:
            table = alias.replace("public.", "")
        models_by_alias[table] = {
            "id": m["id"],
            "fields": {f["referenceName"]: f["id"] for f in m["fields"]},
        }

    created = skipped = 0
    for from_m, from_f, to_m, to_f, rtype in RELATIONSHIPS:
        if from_m not in models_by_alias or to_m not in models_by_alias:
            continue
        fm = models_by_alias[from_m]
        tm = models_by_alias[to_m]
        if from_f not in fm["fields"] or to_f not in tm["fields"]:
            continue
        mutation = (
            f"mutation {{ createRelation(data: {{"
            f"fromModelId: {fm['id']}, fromColumnId: {fm['fields'][from_f]}, "
            f"toModelId: {tm['id']}, toColumnId: {tm['fields'][to_f]}, "
            f"type: {rtype}}}) }}"
        )
        resp = gql(url, mutation)
        if "errors" not in str(resp):
            created += 1
            print(f"  OK {from_m}.{from_f} -> {to_m}.{to_f}")
        else:
            skipped += 1  # Already exists
    print(f"  Created: {created}, Skipped: {skipped}")

    # ── 3. SQLite: Column display names + descriptions ──────────────
    print("\n═══ Step 3: Column metadata (SQLite) ═══")
    tmpdir = tempfile.mkdtemp()
    try:
        db_path = os.path.join(tmpdir, "db.sqlite3")

        subprocess.run(
            ["docker", "compose", "cp", "wren-ui:/app/data/db.sqlite3", db_path],
            check=True,
            capture_output=True,
        )
        print("  Copied SQLite DB from container")

        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row
        try:
            # Map alias -> model_id
            alias_to_id = {}
            for row in db.execute("SELECT id, display_name FROM model"):
                alias_to_id[row["display_name"]] = row["id"]

            col_updated = 0
            for alias, columns in COLUMN_META.items():
                mid = alias_to_id.get(alias)
                if not mid:
                    continue
                for row in db.execute(
                    "SELECT id, source_column_name, properties FROM model_column WHERE model_id = ?",
                    (mid,),
                ):
                    col_name = row["source_column_name"]
                    if col_name in columns:
                        display, desc = columns[col_name]
                        props = (
                            json.loads(row["properties"]) if row["properties"] else {}
                        )
                        props["description"] = desc
                        db.execute(
                            "UPDATE model_column SET display_name = ?, properties = ? WHERE id = ?",
                            (display, json.dumps(props), row["id"]),
                        )
                        col_updated += 1
            print(f"  Updated {col_updated} column metadata entries")

            # ── 4. SQLite: Instructions (knowledge rules) — merge strategy ──
            print(
                "\n═══ Step 4: Instructions / Knowledge (SQLite) — merge strategy ═══"
            )
            row = db.execute("SELECT id FROM project LIMIT 1").fetchone()
            if row is None:
                raise RuntimeError(
                    "WrenAI project not found in SQLite — is WrenAI initialised?"
                )
            project_id = row["id"]

            # Delete only source-managed instructions (is_default=1).
            # User-created instructions (is_default=0, created via WrenAI UI) are preserved.
            deleted = db.execute(
                "DELETE FROM instruction WHERE project_id = ? AND is_default = 1",
                (project_id,),
            ).rowcount
            for inst in INSTRUCTIONS:
                db.execute(
                    "INSERT INTO instruction (project_id, instruction, questions, is_default) VALUES (?, ?, ?, 1)",
                    (project_id, inst["instruction"], json.dumps(inst["questions"])),
                )
            user_count = db.execute(
                "SELECT COUNT(*) FROM instruction WHERE project_id = ? AND is_default = 0",
                (project_id,),
            ).fetchone()[0]
            print(f"  Deleted {deleted} old source instructions (is_default=1)")
            print(f"  Inserted {len(INSTRUCTIONS)} source instructions")
            print(f"  Preserved {user_count} user instructions (is_default=0)")

            # ── 5. SQLite: SQL Pairs (example queries for RAG) — merge strategy
            print("\n═══ Step 5: SQL Pairs / Examples (SQLite) — merge strategy ═══")
            # For sql_pair there is no is_default field. Use question text to track source pairs.
            # Delete ALL pairs (including duplicates) whose question matches any source question.
            # User pairs with different questions survive.
            total_before = db.execute(
                "SELECT COUNT(*) FROM sql_pair WHERE project_id = ?", (project_id,)
            ).fetchone()[0]
            if SOURCE_QUESTIONS:
                placeholders = ",".join("?" for _ in SOURCE_QUESTIONS)
                params = [project_id, *SOURCE_QUESTIONS]
                source_deleted = db.execute(
                    f"DELETE FROM sql_pair WHERE project_id = ? AND question IN ({placeholders})",
                    params,
                ).rowcount
            else:
                source_deleted = 0
            user_pairs_kept = total_before - source_deleted

            for question, sql in SQL_PAIRS:
                db.execute(
                    "INSERT INTO sql_pair (project_id, sql, question) VALUES (?, ?, ?)",
                    (project_id, sql, question),
                )
            print(f"  Deleted {source_deleted} old source SQL pairs")
            print(f"  Inserted {len(SQL_PAIRS)} source SQL pairs")
            print(f"  Preserved {user_pairs_kept} user SQL pairs")

            db.commit()
        finally:
            db.close()

        # Copy DB back
        subprocess.run(
            ["docker", "compose", "cp", db_path, "wren-ui:/app/data/db.sqlite3"],
            check=True,
            capture_output=True,
        )
        print("  Copied SQLite DB back to container")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # ── 6. Restart wren-ui + Deploy ─────────────────────────────────
    print("\n═══ Step 6: Restart + Deploy ═══")
    subprocess.run(
        ["docker", "compose", "restart", "wren-ui"], check=True, capture_output=True
    )
    print("  Restarted wren-ui")

    import time

    time.sleep(15)

    result = gql(url, "mutation { deploy(force: true) }")
    status = result["data"]["deploy"]["status"]
    print(f"  Deploy: {status}")

    if status != "SUCCESS":
        print(
            f"  Error: {result['data']['deploy'].get('error', 'unknown')}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── 7. Index instructions + SQL pairs into qdrant via AI service ─
    # NOTE: We do NOT delete the entire qdrant collection before re-indexing.
    # Doing so would remove user-created instructions/SQL pairs from the retrieval
    # index — breaking the "preserve user knowledge" promise. We POST only source
    # entries using stable integer IDs (1..N). The AI service upserts by ID, so
    # re-running this step simply updates the source entries without touching
    # entries at higher IDs that belong to user-created knowledge.
    print("\n═══ Step 7: Index instructions + SQL pairs (AI service) ═══")
    ai_url = url.replace(":3000", ":5555")  # AI service on port 5555

    ai_instructions = [
        {
            "id": str(i + 1),
            "instruction": inst["instruction"],
            "questions": inst["questions"],
        }
        for i, inst in enumerate(INSTRUCTIONS)
    ]
    try:
        req = urllib.request.Request(
            f"{ai_url}/v1/instructions",
            data=json.dumps(
                {
                    "id": "push_instructions",
                    "instructions": ai_instructions,
                    "mdl_hash": "current",
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=60)
        print(
            f"  Indexed {len(ai_instructions)} source instructions in qdrant (user instructions preserved)"
        )
    except Exception as e:
        print(f"  Instructions indexing failed: {e}")

    time.sleep(5)

    ai_pairs = [
        {"id": str(i + 1), "question": q, "sql": s}
        for i, (q, s) in enumerate(SQL_PAIRS)
    ]
    try:
        req = urllib.request.Request(
            f"{ai_url}/v1/sql-pairs",
            data=json.dumps(
                {"id": "push_sql_pairs", "sql_pairs": ai_pairs, "mdl_hash": "current"}
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=60)
        print(
            f"  Indexed {len(ai_pairs)} source SQL pairs in qdrant (user SQL pairs preserved)"
        )
    except Exception as e:
        print(f"  SQL pairs indexing failed: {e}")

    print("\nDone. WrenAI semantic model fully configured.")
    print(f"  Models: {len(MODEL_METADATA)} with descriptions")
    print(f"  Columns: {col_updated} with display names + descriptions")
    print(f"  Relations: {created} created")
    print(f"  Instructions: {len(INSTRUCTIONS)} source (user instructions preserved)")
    print(f"  SQL Pairs: {len(SQL_PAIRS)} source (user SQL pairs preserved)")


if __name__ == "__main__":
    main()
