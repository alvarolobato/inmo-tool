#!/usr/bin/env python3
"""Deterministic synthetic-data generator for dashboard e2e tests.

Emits a SQL seed file (``seed.sql``) that fills the ``ps_*`` mirror tables with
**synthetic but production-faithful** data, so the dashboards (Cuadro de Mandos
8–9, Review semanal 10–13) and the home (``/``) render real values in e2e tests.

Design decisions
----------------
* **No production data, no PII.** This is a public repo. Shapes (value ranges,
  distributions, formats, the intraday sales curve, the ~43% gross margin, store
  code style, payment-method mix) were learned from production *aggregates only*
  — never rows. All names/refs here are obviously synthetic ("Proveedor 03",
  "Cliente 0007", "V…", "ART00042").
* **Dates are relative to ``CURRENT_DATE``.** Every date/timestamp is emitted as
  ``CURRENT_DATE - N`` / ``NOW() - INTERVAL`` so the dataset is always "recent"
  whenever the seed is loaded — the home (as-of today) and the dashboards'
  ``last_7_days`` range always match rows, with no clock mocking and no staleness.
* **Deterministic.** Fixed RNG seed → byte-identical ``seed.sql`` every run.
* **Tuned for coverage, not realism in volume.** Small row counts (a few
  thousand) keep ``seed.sql`` small and CI fast, while every widget still returns
  rows. Where prod ratios would leave a widget empty (e.g. only 9% of purchase
  orders are received), the test data deliberately balances both branches so
  "recibidos" *and* "abiertos" tables both have rows; this is documented in
  ``README.md``.

Run::

    python dashboard/e2e/fixtures/generate_seed.py > dashboard/e2e/fixtures/seed.sql

The committed ``seed.sql`` is what e2e/CI loads (no Python needed at test time):

    psql "$DSN" -f etl/schema/init.sql
    psql "$DSN" -f dashboard/e2e/fixtures/seed.sql
"""

from __future__ import annotations

import math
import random
import sys
from datetime import time

SEED = 42
DAYS = 90  # sales span: CURRENT_DATE-89 .. CURRENT_DATE (today inclusive)

# Store codes mimic the 3-digit production style (152–159, 60x …). "99" is the
# special non-retail store the dashboards explicitly exclude (WHERE tienda<>'99').
# It is present in ps_tiendas so dimension joins don't fail, but has no fact rows.
STORE_CODES = [
    "152",
    "153",
    "154",
    "155",
    "156",
    "157",
    "159",
    "601",
    "606",
    "608",
    "611",
    "622",
    "637",
    "99",
]
CITIES = [
    "Madrid",
    "Barcelona",
    "Valencia",
    "Sevilla",
    "Bilbao",
    "Málaga",
    "Zaragoza",
    "Murcia",
    "Vigo",
    "Gijón",
    "Córdoba",
    "Valladolid",
    "Alicante",
    "Granada",
]

N_FAMILIAS = 6
N_DEPARTAMENTOS = 4
N_COLORES = 8
N_MARCAS = 5
N_TEMPORADAS = 4
N_PROVEEDORES = 15
N_CLIENTES = 40
N_ARTICULOS = 120

# Sales total_si (VAT-excl) is log-normal: prod median ≈ 15.4 €, p90 ≈ 39.8 €.
TOTAL_SI_MU = math.log(15.4)
TOTAL_SI_SIGMA = 0.765
COST_RATIO = 0.565  # total_coste_si / total_si → ~43.5% gross margin (prod)
ENTRADA_RATIO = 0.91  # 9% of sales rows are returns/devoluciones

# Intraday weights (share of sales by hour) — production histogram, peak 11–13h.
HOUR_WEIGHTS = {
    8: 1,
    9: 10,
    10: 100,
    11: 156,
    12: 157,
    13: 99,
    14: 40,
    15: 52,
    16: 59,
    17: 72,
    18: 89,
    19: 66,
    20: 32,
    21: 4,
}

# Payment methods (forma) and their relative weight (prod mix).
FORMAS = [
    ("Metálico", 38),
    ("American Express", 22),
    ("Visa", 18),
    ("Vale", 8),
    ("MasterCard", 6),
    ("Maestro", 5),
    ("Transferencia", 3),
]

TALLAS = ["XS", "S", "M", "L", "XL", "XXL", "38", "40", "42", "44", "46", "U"]


def sql_str(s: str) -> str:
    """Single-quote and escape a string literal for SQL."""
    return "'" + s.replace("'", "''") + "'"


def d(offset: int) -> str:
    """A DATE literal `offset` days before today (offset 0 = today)."""
    return f"(CURRENT_DATE - {offset})" if offset else "CURRENT_DATE"


def emit_insert(out, table: str, cols: list[str], rows: list[str]) -> None:
    """Emit a multi-row INSERT (chunked to keep statements a sane size)."""
    if not rows:
        return
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        out.write(f"INSERT INTO {table} ({', '.join(cols)}) VALUES\n")
        out.write(",\n".join("  (" + r + ")" for r in chunk))
        out.write(";\n")


def weighted_hour(rng: random.Random) -> time:
    hours = list(HOUR_WEIGHTS)
    h = rng.choices(hours, weights=[HOUR_WEIGHTS[x] for x in hours])[0]
    return time(h, rng.randint(0, 59), rng.randint(0, 59))


def weighted_forma(rng: random.Random) -> str:
    return rng.choices([f for f, _ in FORMAS], weights=[w for _, w in FORMAS])[0]


def main() -> None:
    rng = random.Random(SEED)
    out = sys.stdout

    out.write("-- GENERATED FILE — do not edit by hand.\n")
    out.write(
        "-- Regenerate with: python dashboard/e2e/fixtures/generate_seed.py "
        "> dashboard/e2e/fixtures/seed.sql\n"
    )
    out.write(
        "-- Synthetic, production-faithful data for dashboard e2e tests. "
        "No real data / no PII.\n"
    )
    out.write(
        "-- Dates are CURRENT_DATE-relative so the dataset is always recent "
        "when loaded.\n\n"
    )
    out.write("BEGIN;\n\n")

    # Idempotent: clear the tables we populate so the seed can be re-loaded.
    populated = [
        "ps_pagos_ventas",
        "ps_lineas_ventas",
        "ps_ventas",
        "ps_lineas_compras",
        "ps_albaranes",
        "ps_compras",
        "ps_gc_facturas",
        "ps_gc_albaranes",
        "ps_traspasos",
        "ps_stock_tienda",
        "ps_stock_central",
        "ps_articulos",
        "ps_familias",
        "ps_departamentos",
        "ps_colores",
        "ps_marcas",
        "ps_temporadas",
        "ps_proveedores",
        "ps_clientes",
        "ps_tiendas",
        "etl_watermarks",
        "etl_sync_runs",
    ]
    out.write("TRUNCATE " + ", ".join(populated) + " RESTART IDENTITY CASCADE;\n\n")

    # ---- Dimensions ------------------------------------------------------
    # Tiendas
    rows = []
    for i, code in enumerate(STORE_CODES, start=1):
        city = CITIES[i % len(CITIES)]
        rows.append(
            ", ".join(
                [f"{i}", sql_str(code), sql_str(f"Tienda {code}"), sql_str(city), d(0)]
            )
        )
    emit_insert(
        out,
        "ps_tiendas",
        ["reg_tienda", "codigo", "identificador", "poblacion", "fecha_modifica"],
        rows,
    )

    # Familias / Departamentos / Colores / Marcas / Temporadas
    emit_insert(
        out,
        "ps_familias",
        ["reg_familia", "clave", "anulado"],
        [
            f"{i}, {sql_str(f'Familia {i:02d}')}, false"
            for i in range(1, N_FAMILIAS + 1)
        ],
    )
    emit_insert(
        out,
        "ps_departamentos",
        ["reg_departament", "clave", "anulado"],
        [
            f"{i}, {sql_str(f'Depto {i:02d}')}, false"
            for i in range(1, N_DEPARTAMENTOS + 1)
        ],
    )
    emit_insert(
        out,
        "ps_colores",
        ["reg_color", "clave", "color"],
        [
            f"{i}, {sql_str(f'C{i:02d}')}, {sql_str(c)}"
            for i, c in enumerate(
                ["Negro", "Blanco", "Azul", "Rojo", "Verde", "Gris", "Beige", "Marrón"],
                start=1,
            )
        ],
    )
    emit_insert(
        out,
        "ps_marcas",
        ["reg_marca", "clave"],
        [f"{i}, {sql_str(f'Marca {i:02d}')}" for i in range(1, N_MARCAS + 1)],
    )
    emit_insert(
        out,
        "ps_temporadas",
        ["reg_temporada", "clave", "temporada_tipo", "temporada_activ"],
        [
            f"{i}, {sql_str(f'T{2024 + i % 3}{i}')}, "
            f"{sql_str('Temporada' if i % 2 else 'Permanente')}, true"
            for i in range(1, N_TEMPORADAS + 1)
        ],
    )

    # Proveedores (synthetic names, no PII)
    emit_insert(
        out,
        "ps_proveedores",
        ["reg_proveedor", "nombre", "pais"],
        [
            f"{5000 + i}, {sql_str(f'Proveedor {i:02d}')}, {sql_str('ES')}"
            for i in range(1, N_PROVEEDORES + 1)
        ],
    )
    prov_ids = [5000 + i for i in range(1, N_PROVEEDORES + 1)]

    # Clientes (synthetic, no PII)
    emit_insert(
        out,
        "ps_clientes",
        ["reg_cliente", "num_cliente", "nombre", "pais", "fecha_creacion"],
        [
            f"{3000 + i}.99, {3000 + i}.99, {sql_str(f'Cliente {i:04d}')}, "
            f"{sql_str('ES')}, {d(rng.randint(200, 900))}"
            for i in range(1, N_CLIENTES + 1)
        ],
    )

    # Articulos — codigo (TEXT, joined by ps_lineas_ventas.codigo), reg_articulo
    # (NUMERIC, joined by ps_lineas_compras.num_articulo), num_familia (INNER
    # JOIN ps_familias, so it MUST reference an existing familia).
    art_rows, articulos = [], []
    for i in range(1, N_ARTICULOS + 1):
        reg = f"{100000 + i}.99"
        codigo = f"ART{i:05d}"
        ref = f"V{rng.randint(10, 29)}{rng.randint(100000, 999999)}"
        familia = rng.randint(1, N_FAMILIAS)
        precio_coste = round(rng.uniform(2, 18), 2)
        precio1 = round(precio_coste / (1 - rng.uniform(0.45, 0.65)), 2)
        articulos.append((reg, codigo, precio_coste, precio1))
        art_rows.append(
            ", ".join(
                [
                    reg,
                    sql_str(codigo),
                    sql_str(ref),
                    sql_str(f"Artículo {i:05d}"),
                    f"{familia}",
                    f"{rng.randint(1, N_TEMPORADAS)}",
                    f"{rng.randint(1, N_MARCAS)}",
                    f"{rng.choice(prov_ids)}",
                    f"{precio_coste}",
                    f"{precio1}",
                    "23.00",
                    "false",
                    d(rng.randint(120, 900)),
                ]
            )
        )
    emit_insert(
        out,
        "ps_articulos",
        [
            "reg_articulo",
            "codigo",
            "ccrefejofacm",
            "descripcion",
            "num_familia",
            "num_temporada",
            "num_marca",
            "num_proveedor",
            "precio_coste",
            "precio1",
            "p_iva",
            "anulado",
            "fecha_creacion",
        ],
        art_rows,
    )

    # ---- Retail sales: ventas + lineas_ventas + pagos_ventas -------------
    venta_rows, linea_rows, pago_rows = [], [], []
    reg_v, reg_lv, reg_pg = 1_000_000, 5_000_000, 9_000_000
    retail_stores = [c for c in STORE_CODES if c != "99"]
    for offset in range(DAYS - 1, -1, -1):
        # Slightly busier recent days (no day-of-week variation).
        base = 3 if offset > 14 else 5
        for code in retail_stores:
            n = rng.randint(base, base + 4)
            for _ in range(n):
                reg_v += 1
                entrada = rng.random() < ENTRADA_RATIO
                hora = weighted_hour(rng)
                n_lines = rng.randint(1, 3)
                venta_total = 0.0
                for _ in range(n_lines):
                    reg_lv += 1
                    art = rng.choice(articulos)
                    unidades = 1 if rng.random() < 0.85 else rng.randint(2, 3)
                    line_si = round(
                        math.exp(rng.normalvariate(TOTAL_SI_MU, TOTAL_SI_SIGMA))
                        * unidades,
                        2,
                    )
                    if not entrada:
                        line_si = -line_si
                    coste = round(line_si * COST_RATIO * rng.uniform(0.9, 1.1), 2)
                    venta_total += line_si
                    linea_rows.append(
                        ", ".join(
                            [
                                f"{reg_lv}.99",
                                f"{reg_v}.99",
                                f"{reg_v}.99",
                                sql_str(art[1]),
                                f"{unidades}",
                                f"{line_si}",
                                f"{coste}",
                                d(offset),
                                sql_str(code),
                            ]
                        )
                    )
                venta_total = round(venta_total, 2)
                venta_rows.append(
                    ", ".join(
                        [
                            f"{reg_v}.99",
                            sql_str(code),
                            d(offset),
                            f"'{hora.strftime('%H:%M:%S')}'",
                            f"{venta_total}",
                            f"{round(venta_total * 1.21, 2)}",
                            "true" if entrada else "false",
                        ]
                    )
                )
                if entrada:
                    reg_pg += 1
                    pago_rows.append(
                        ", ".join(
                            [
                                f"{reg_pg}.99",
                                f"{reg_v}.99",
                                sql_str(weighted_forma(rng)),
                                f"{round(venta_total * 1.21, 2)}",
                                d(offset),
                                sql_str(code),
                                "true",
                            ]
                        )
                    )

    emit_insert(
        out,
        "ps_ventas",
        [
            "reg_ventas",
            "tienda",
            "fecha_creacion",
            "hora_creacion",
            "total_si",
            "total",
            "entrada",
        ],
        venta_rows,
    )
    emit_insert(
        out,
        "ps_lineas_ventas",
        [
            "reg_lineas",
            "num_ventas",
            "n_documento",
            "codigo",
            "unidades",
            "total_si",
            "total_coste_si",
            "fecha_creacion",
            "tienda",
        ],
        linea_rows,
    )
    emit_insert(
        out,
        "ps_pagos_ventas",
        [
            "reg_pagos",
            "num_ventas",
            "forma",
            "importe_cob",
            "fecha_creacion",
            "tienda",
            "entrada",
        ],
        pago_rows,
    )

    # ---- Purchasing: compras + lineas_compras + albaranes ----------------
    # ~half received (recent) and ~half still open, so dashboard 9's "recibidos"
    # and "abiertos" tables both return rows (prod's 9%-received ratio would
    # leave one empty — coverage over fidelity here, documented in README).
    compra_rows, lc_rows, alb_rows = [], [], []
    reg_lc, reg_alb = 2_000_000, 4_000_000
    for i in range(1, 41):
        reg_pedido = f"{700000 + i}.99"
        prov = rng.choice(prov_ids)
        ped_offset = rng.randint(0, 13)  # within last_7_days for some
        received = i % 2 == 0
        rec_offset = max(0, ped_offset - rng.randint(0, 3)) if received else None
        compra_rows.append(
            ", ".join(
                [
                    reg_pedido,
                    d(ped_offset),
                    d(rec_offset) if received else "NULL",
                    f"{prov}",
                ]
            )
        )
        if received:
            reg_alb += 1
            alb_rows.append(
                ", ".join(
                    [
                        f"{reg_alb}.99",
                        d(rec_offset),
                        reg_pedido,
                        f"{prov}",
                        sql_str(f"Proveedor {prov - 5000:02d}"),
                    ]
                )
            )
        for _ in range(rng.randint(5, 16)):
            reg_lc += 1
            art = rng.choice(articulos)
            unidades = rng.randint(10, 400)
            coste = round(art[2] * unidades, 2)
            lc_rows.append(
                ", ".join(
                    [
                        f"{reg_lc}.99",
                        reg_pedido,
                        art[0],
                        d(ped_offset),
                        f"{unidades}",
                        f"{art[2]}",
                        f"{coste}",
                        f"{prov}",
                    ]
                )
            )
    emit_insert(
        out,
        "ps_compras",
        ["reg_pedido", "fecha_pedido", "fecha_recibido", "num_proveedor"],
        compra_rows,
    )
    emit_insert(
        out,
        "ps_lineas_compras",
        [
            "reg_linea_compra",
            "num_pedido",
            "num_articulo",
            "fecha",
            "unidades",
            "precio_coste",
            "total_si",
            "num_proveedor",
        ],
        lc_rows,
    )
    emit_insert(
        out,
        "ps_albaranes",
        ["reg_albaran", "fecha_recibido", "num_pedido", "num_proveedor", "proveedor"],
        alb_rows,
    )

    # ---- Wholesale invoices (review: canal mayorista) --------------------
    gc_rows = []
    for i in range(1, 121):
        offset = rng.randint(0, 20)
        abono = rng.random() < 0.44
        total = round(rng.uniform(400, 9000) * (-1 if abono else 1), 2)
        gc_rows.append(
            ", ".join(
                [
                    f"{800000 + i}.99",
                    f"{i}.99",
                    d(offset),
                    f"{round(abs(total) / 1.21, 2)}",
                    "0",
                    "0",
                    f"{3000 + rng.randint(1, N_CLIENTES)}.99",
                    "true" if abono else "false",
                    f"{total}",
                ]
            )
        )
    emit_insert(
        out,
        "ps_gc_facturas",
        [
            "reg_factura",
            "n_factura",
            "fecha_factura",
            "base1",
            "base2",
            "base3",
            "num_cliente",
            "abono",
            "total_factura",
        ],
        gc_rows,
    )

    # ---- Wholesale delivery notes (review: albaranes mayorista) ----------
    # ps_gc_albaranes feeds the "Albaranes Recientes" widget (mayorista.ts:252)
    # which filters WHERE abono = false AND fecha_envio within curr_from..curr_to.
    alb_gc_rows = []
    for i in range(1, 51):
        offset = rng.randint(0, 20)
        abono = rng.random() < 0.15  # ~15% credit notes so abono=false majority
        base1 = round(rng.uniform(200, 5000) * (-1 if abono else 1), 2)
        entregadas = rng.randint(1, 50)
        alb_gc_rows.append(
            ", ".join(
                [
                    f"{910000 + i}.99",
                    f"{200 + i}.99",
                    f"{3000 + rng.randint(1, N_CLIENTES)}.99",
                    d(offset),
                    d(max(0, offset - 2)),
                    d(offset),
                    f"{abs(base1)}",
                    "0",
                    "0",
                    f"{entregadas}",
                    sql_str("Transportista 01"),
                    "NULL",
                    sql_str(""),
                    "true" if abono else "false",
                ]
            )
        )
    emit_insert(
        out,
        "ps_gc_albaranes",
        [
            "reg_albaran",
            "n_albaran",
            "num_cliente",
            "fecha_envio",
            "fecha_valor",
            "modifica",
            "base1",
            "base2",
            "base3",
            "entregadas",
            "transportista",
            "num_comercial",
            "temporada",
            "abono",
        ],
        alb_gc_rows,
    )

    # ---- Transfers (review: stock) ---------------------------------------
    # Each physical transfer is represented as two rows (domain model from
    # knowledge.ts): entrada=false (outgoing, source releases stock) and
    # entrada=true (incoming, destination receives stock). The stock template
    # filters WHERE entrada = false for "Traspasos Recientes".
    tr_rows = []
    for i in range(1, 201):
        offset = rng.randint(0, 13)
        salida, entrada_t = rng.sample(retail_stores, 2)
        codigo = sql_str(rng.choice(articulos)[1])
        talla = sql_str(rng.choice(TALLAS))
        us = rng.randint(1, 6)
        ue = rng.randint(1, 6)
        common = [
            codigo, talla,
            f"{us}", f"{ue}",
            sql_str(salida), sql_str(entrada_t),
            d(offset), d(max(0, offset - 1)),
        ]
        tr_rows.append(", ".join([f"{600000 + i * 2 - 1}.99"] + common + ["false"]))
        tr_rows.append(", ".join([f"{600000 + i * 2}.99"] + common + ["true"]))
    emit_insert(
        out,
        "ps_traspasos",
        [
            "reg_traspaso",
            "codigo",
            "talla",
            "unidades_s",
            "unidades_e",
            "tienda_salida",
            "tienda_entrada",
            "fecha_s",
            "fecha_e",
            "entrada",
        ],
        tr_rows,
    )

    # ---- Stock snapshots -------------------------------------------------
    st_rows = []
    for art in articulos[:60]:
        for code in rng.sample(retail_stores, 3):
            st_rows.append(
                ", ".join(
                    [
                        sql_str(art[1]),
                        sql_str(f"{code}/{art[1]}"),
                        sql_str(code),
                        sql_str(rng.choice(TALLAS)),
                        f"{rng.randint(0, 25)}",
                        d(0),
                    ]
                )
            )
    emit_insert(
        out,
        "ps_stock_tienda",
        ["codigo", "tienda_codigo", "tienda", "talla", "stock", "fecha_modifica"],
        st_rows,
    )
    emit_insert(
        out,
        "ps_stock_central",
        ["num_articulo", "stock", "fecha_modifica"],
        [f"{art[0]}, {rng.randint(0, 200)}, {d(0)}" for art in articulos],
    )

    # ---- ETL status (home "Datos al día" + health) ----------------------
    etl_tables = [
        "ps_ventas",
        "ps_lineas_ventas",
        "ps_compras",
        "ps_lineas_compras",
        "ps_articulos",
        "ps_clientes",
        "ps_gc_facturas",
        "ps_traspasos",
        "ps_stock_tienda",
    ]
    emit_insert(
        out,
        "etl_watermarks",
        ["table_name", "last_sync_at", "rows_synced", "status", "updated_at"],
        [
            f"{sql_str(t)}, NOW() - INTERVAL '12 minutes', {rng.randint(50, 5000)}, "
            f"'ok', NOW() - INTERVAL '12 minutes'"
            for t in etl_tables
        ],
    )
    out.write(
        "INSERT INTO etl_sync_runs "
        "(trigger, started_at, finished_at, duration_ms, status, kind, "
        "tables_ok, tables_failed, total_tables, total_rows_synced) VALUES\n"
        "  ('cron', NOW() - INTERVAL '12 minutes', NOW() - INTERVAL '8 minutes', "
        "240000, 'ok', 'delta', 9, 0, 9, 18420);\n"
    )

    out.write("\nCOMMIT;\n")


if __name__ == "__main__":
    main()
