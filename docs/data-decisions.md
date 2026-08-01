# Data Platform — Facts for the Runtime LLM

This document distills the data-relevant platform decisions into facts that the runtime
dashboard LLM needs to understand when generating SQL queries and dashboard specs.
It will be the primary source input to `dashboard/lib/knowledge.ts` once the knowledge
build pipeline is implemented (issue #502).

Non-data operational and infrastructure decisions are **not** recorded here — see
[DECISIONS.md](../DECISIONS.md) (one-line index) and `docs/decisions/D-NN-<slug>.md` for full rationale.

## LLM:rules

```json
[
  {
    "instruction": "All analytics SQL must target the PostgreSQL mirror (ps_* tables). Never reference 4D ERP source tables directly in dashboard SQL. The mirror is the sole analytics target; ETL is the only writer.",
    "questions": ["¿Qué tablas usar para SQL?", "¿Se puede consultar 4D directamente?", "¿Dónde están los datos analíticos?", "¿Cuáles son las tablas del mirror?"]
  },
  {
    "instruction": "ps_tiendas columns: reg_tienda, codigo, fecha_modifica — there is no activa or anulada field. To exclude the central warehouse filter WHERE tienda <> '99'. Store 97 is the online store with different purchasing patterns.",
    "questions": ["¿Cómo filtrar tiendas activas?", "¿Hay campo activa en ps_tiendas?", "¿Qué campos tiene ps_tiendas?", "¿Cómo excluir el almacén central?"]
  },
  {
    "instruction": "ps_stock_tienda reflects the last completed nightly ETL run, not real-time inventory. Stock values show stock as of the previous night. ps_articulos has 379 columns — always specify columns explicitly, never SELECT *.",
    "questions": ["¿El stock es tiempo real?", "¿Cuándo se actualiza el stock?", "¿Puedo hacer SELECT * en ps_articulos?", "¿Por qué no usar SELECT * en artículos?"]
  },
  {
    "instruction": "ps_stock_tienda.stock can be negative — this is a valid business state (returns, inter-store adjustments). Do not treat negative stock as a data error. ps_stock_central.stock is decoded the same way.",
    "questions": ["¿Puede el stock ser negativo?", "¿Qué significa stock negativo?", "¿Hay errores en el stock?", "¿Es normal el stock negativo?"]
  }
]
```

### Data store: `ps_*` tables in PostgreSQL

All analytics SQL runs against the **PostgreSQL mirror**, not the live 4D ERP.
Mirror tables are prefixed `ps_`. Never reference the 4D source in dashboard SQL.

Key mirror tables and approximate sizes:

| Table | Contents | Rows |
|-------|----------|------|
| `ps_ventas` | Sales headers (retail) | ~911K |
| `ps_lineas_ventas` | Sales lines (retail) | ~1.7M |
| `ps_stock_tienda` | Stock per store per article | ~12.3M |
| `ps_articulos` | Product catalog (379 columns — always specify columns, never `SELECT *`) | — |
| `ps_clientes` | Customers | — |
| `ps_tiendas` | Stores (`reg_tienda`, `codigo`, `fecha_modifica` — no `activa`/`anulada` field) | — |
| `ps_gc_facturas`, `ps_gc_lin_facturas`, `ps_gc_pedidos` | Wholesale invoices, lines, and orders (mayorista) | — |
| `ps_gc_lin_albarane` | Wholesale delivery lines (mayorista) | ~1M |
| `ps_compras`, `ps_lineas_compras`, `ps_albaranes` | Purchasing | — |
| `ps_stock_central` | Central warehouse stock per article (from CCStock) | ~41.5K |

### Primary keys: `NUMERIC`, not `FLOAT8`

4D PKs are Real (float) fields with a `.99` suffix pattern. In PostgreSQL they are stored as
`NUMERIC(20,3)`. Never use `FLOAT8` comparisons for PK joins — float equality is unreliable.

### ETL extraction strategy

**Consequence for queries**: `ps_stock_tienda` is updated nightly, not in real time. Stock
values reflect the last completed ETL run.

How tables are populated:

- **`ps_ventas` / `ps_lineas_ventas`**: delta-synced via a watermark field. Full table scanned
  with a single SELECT (no pagination) because 4D SQL re-scans from row 0 at every LIMIT/OFFSET,
  making pagination unusable at scale.
- **`ps_stock_tienda`**: fetched one store at a time (`WHERE Tienda = 'X'`) because the source
  `Exportaciones` table has ~2M rows. The ETL processes ~50 stores sequentially; each store's
  ~41K rows fit in memory.
- **Small tables** (Articulos, Clientes, Tiendas, etc.): full refresh each night.

### Stock fields: signed 16-bit integers

`Exportaciones.Stock1`–`Stock34` and `CCStock.Stock1`–`Stock34` in the 4D source are
**16-bit signed integers** (`DATA_TYPE=3, DATA_LENGTH=2` in `_USER_COLUMNS`). The 4D SQL
wire protocol returns them unsigned (0–65535). The ETL decodes them: values ≥ 32768 have
65536 subtracted to recover the signed integer (e.g. 65535 → −1).

Implications for SQL and interpretation:

- `ps_stock_tienda.stock` values are **signed**. Negative stock is a legitimate business state
  (returns, inter-store adjustments). Do not treat it as a data error.
- `ps_stock_central.stock` (from CCStock) is decoded the same way.
- `CCStock.Stock` (the root-level aggregate, `DATA_TYPE=6` Real) is **not** decoded —
  it is already a correct float.
- Wholesale quantity columns (`GCLin*`) are Real type and are never decoded.

### 4D source schema: 324 tables, 100 SQL views

The PowerShop 4D source has 324 tables and 100 vendor-provided SQL views:

- **`*_SQL` views (50)**: vendor's intended query targets with derived and computed columns.
  Use these as the reference for field relationships and preferred join paths.
- **`*_BI` views (50)**: business-intelligence aggregations.
- Notable views: `Exportaciones_SQL` (34 stock + talla slots), `Ventas_SQL` (150 columns
  including TBAI, marketplace, fiscal fields), `Tiendas_SQL` (208 columns).

Only ~26 source tables are mirrored as `ps_*` tables. Other data may be accessible via
SOAP web services (port 8080) — consult `docs/skills/data-access.md`.

### The 34-slot size matrix

`Exportaciones` and `CCStock` store stock per size using a 34-slot matrix:
`Stock1`–`Stock34` (units) paired with `Talla1`–`Talla34` (size labels).
`FamiGrupMarc.SERIETALLAS` maps each product family to which size series applies,
determining which slots are active for that family.

In `ps_stock_tienda`, stock is stored in long format (one row per article + store + size).

### WrenAI knowledge corpus

WrenAI uses two knowledge channels to understand business semantics:

- **Instructions** (40+): business rules mapping business terms to tables, e.g. "ventas
  (retail) = `ps_ventas`; mayorista (wholesale) = `ps_gc_*`". Source instructions carry
  `is_default=1`; user-created instructions carry `is_default=0` and are never overwritten.
- **SQL pairs** (52+): validated example question → SQL mappings covering all business domains.

When business semantics change (new table, new join, new KPI definition), update both the
relevant instruction and add or update a SQL pair.
