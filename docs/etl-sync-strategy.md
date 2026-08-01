# ETL Sync Strategy — 4D to PostgreSQL

> Validated against real data on 2026-03-30. Row counts and date ranges reflect live production data at that point.

This document defines the sync strategy for each table in the ETL pipeline from 4D to the PostgreSQL mirror used by WrenAI. For each table it records: row count, available delta fields, PK, sync method, and any gotchas discovered by direct query.

---

## Key findings

- **Ventas/LineasVentas/PagosVentas are NOT append-only.** 19–21% of historical records have `FechaModifica > FechaCreacion`, caused by returns, TBAI fiscal corrections, and payment flag updates. All three tables require **UPSERT by `FechaModifica`**.
- **`FechaDocumento` is NULL for all records in Ventas.** Never use it as a delta field. Use `FechaModifica` or `FechaCreacion`.
- **`LineasCompras` does not exist.** The correct table name is `CCLineasCompr` (44K rows). Links to `Compras` via `NumPedido`.
- **`Exportaciones.TiendaCodigo`** has the format `"tienda/articulo"` (e.g. `"104/169"`), not just a store code. The compound PK is `(Codigo, TiendaCodigo)`.
- **PKs are REAL (float) with `.99` suffix** (e.g. `RegVentas = 10028816.641`). Store as `NUMERIC` in PostgreSQL, not `FLOAT8`, to avoid precision loss.
- **Referencia prefix `MA` = material (no inventory).** Articles whose `CCRefeJOFACM` starts with `MA` are materials (bolsas, perchas, etc.) — no stock tracking, no inventory management. Exclude from stock analysis and sales KPIs. `M` (non-MA) = wholesale. No prefix = retail.
- **MA articles (materials) excluded at ETL level.** Articles whose `CCRefeJOFACM` starts with `'MA'` are filtered from the 4D extraction query in `sync_articulos` (`WHERE LEFT(CCRefeJOFACM, 2) <> 'MA'`). After each full sync, a cascade cleanup step also removes MA-linked rows from line-item tables (`ps_lineas_ventas`, `ps_stock_tienda`, `ps_gc_lin_albarane`, `ps_gc_lin_facturas`) using `get_ma_article_codes()` in `etl/sync/articulos.py`. This eliminates the need for `MA%` filtering in all downstream queries and WrenAI instructions.
- **All 41K Articulos have `FechaModifica >= 2025-03-26`** due to a batch update. Delta sync is ineffective; use full refresh.
- **GCLinAlbarane and GCLinFacturas have no modification timestamp.** Delta is derived from the parent header's `Modifica` field via a parent-join strategy.

### Learnings from first production sync (2026-03-31)

- **NUMERIC(20,3) not (20,2)** for PKs. Some 4D PKs have 3 decimal places (e.g. `RegCliente = 4.152, 4.153`). Scale 2 rounded them and caused duplicate-key violations.
- **4D SQL `!=` not supported** — use `<>`. This broke `get_queryable_columns()` and all tables using it (Compras, Facturas, Albaranes, FacturasCompra).
- **Exportaciones needs progressive sync by store** — single 2M-row fetch OOMs. Fetch per-store (`WHERE Tienda = 'X'`): 50 stores × ~41K rows × ~80s = ~67 min total. Each store normalizes to ~247K rows (6 tallas avg).
- **Single-query is still correct for tables <2M rows** — Ventas (911K, 16 min), LineasVentas (1.7M, 30 min), PagosVentas (965K, 14 min) all completed with single-fetch. LIMIT/OFFSET is never correct for 4D (re-scans from row 0 at each offset).
- **GCLinAlbarane missing columns**: `NumComercial` and `Mes` don't exist in GCLinAlbarane (they do in GCLinFacturas). Column lists must be verified per table.
- **GCAlbaranes has `Unidades` not `Entregadas`** — column name mismatch from the architecture docs.
- **n_albaran/n_factura are NOT unique** — multiple documents can share the same number (different series). UNIQUE indexes and FK constraints on these fail.
- **NUL byte padding** in 4D text fields — fixed-length fields come with `\x00` padding.
- **p4d cursor.description returns bytes** — column names are `b'REGARTICULO'`, not str.
- **TRUNCATE CASCADE needed** when FK constraints exist between full-refresh tables.
- **Full initial load time**: ~2.5 hours total (Ventas chain ~60 min, GC chain ~50 min, Stock ~67 min, rest ~15 min).

---

## Sync strategies by table

### Ventas domain (retail POS)

| Table | Rows | PK | Delta field | Strategy |
|-------|------|----|-------------|---------|
| Ventas | 911,619 | `RegVentas` | `FechaModifica` (max = today) | UPSERT delta |
| LineasVentas | 1,689,796 | `RegLineas` | `FechaModifica` (max = today) | UPSERT delta |
| PagosVentas | 964,971 | `RegPagos` | `FechaModifica` (max = today) | UPSERT delta |

**Daily volume:** ~454 Ventas + ~897 LineasVentas new/modified per day.

```sql
-- Delta pattern for all three tables
SELECT ... FROM Ventas WHERE FechaModifica > :last_sync
-- → UPSERT INTO ps_ventas ON CONFLICT (reg_ventas) DO UPDATE SET ...
```

**Why UPSERT and not INSERT?**
- 177,530 Ventas records modified since 2025-01-01 (19% of total)
- 356,505 LineasVentas records modified since 2025-01-01 (21% of total)
- 188,859 PagosVentas records modified since 2025-01-01 (20% of total)

**FK chain:** `LineasVentas.NumVentas` → `Ventas.RegVentas`, `PagosVentas.NumVentas` → `Ventas.RegVentas`

---

### Stock domain

| Table | Rows | PK | Delta field | Strategy |
|-------|------|----|-------------|---------|
| Exportaciones | 2,058,201 | `(Codigo, TiendaCodigo)` compound | `FechaModifica` (some NULLs for zero-stock articles) | UPSERT delta + normalize |
| Traspasos | 262,689 | `RegTraspaso` | `FechaS` (send date) | Append-only by `FechaS` |
| CCStock | 41,478 | `NumArticulo` (Real) | None | Full refresh nightly → `ps_stock_central` |

**Exportaciones normalization:** The source table is wide-format (Talla1..Talla34 + Stock1..Stock34 per row). `_USER_COLUMNS` shows every **`Stock1`…`Stock34`** as **`DATA_TYPE = 3`**, **`DATA_LENGTH = 2`** (16-bit integer). Through **4D SQL / p4d**, slot values can arrive as **unsigned** (`65535` for `−1`); ETL applies **`decode_signed_int16_word()`** (`etl/db/fourd.py`) before `int` cast so `ps_stock_tienda.stock` matches native/POS signed semantics. **`CCStock`** on the same row (the `Exportaciones.CCStock` column) is **Real** and already carries the signed row total.

`TiendaCodigo` format: `"104/169"` = store 104 / article 169. The compound `(Codigo, TiendaCodigo)` is the natural PK — verified by row count.

**Traspasos:** Only 153 rows since 2025-01-01 (mostly historical log). No `FechaModifica`. Records appear immutable once created. Append-only by `FechaS`. Initial load covers all 262K rows.

**CCStock (central warehouse, confirmed 2026-05-01):** One row per article (41 478 rows). `NumArticulo` is the PK (Real, .99 suffix). `Stock1..Stock34` are **`DATA_TYPE=3, DATA_LENGTH=2`** (16-bit WORD) — same type as `Exportaciones.StockN`. `decode_signed_int16_word()` is applied before summing. The root-level `Stock` column (Real, type 6) is the 4D-maintained total but we recompute from slots for accuracy. No delta field: full refresh is fast at 41K rows. Mirror: `ps_stock_central(num_articulo, stock, fecha_modifica)`.

---

### Wholesale domain (Gestión Comercial)

| Table | Rows | PK | Delta field | Strategy |
|-------|------|----|-------------|---------|
| GCAlbaranes | 48,948 | `RegAlbaran` | `Modifica` (max = today, ~19/day) | UPSERT delta |
| GCLinAlbarane | 1,016,290 | `RegLinea` | **None** — derive from parent | Delete+reinsert via parent |
| GCFacturas | 18,060 | `RegFactura` | `Modifica` (all 18K populated) | UPSERT delta |
| GCLinFacturas | 974,742 | `RegLinea` | **None** — derive from parent | Delete+reinsert via parent |
| GCPedidos | 101 | `RegPedido` | `Modifica` (available) | Full refresh (trivially small) |
| GCLinPedidos | 2,645 | `RegLinea` | None | Full refresh (trivially small) |

**Parent-join delta pattern for lines:**
```sql
-- Fetch lines for recently modified delivery notes
SELECT * FROM GCLinAlbarane
WHERE NAlbaran IN (
    SELECT NAlbaran FROM GCAlbaranes WHERE Modifica > :last_sync
)
-- → DELETE FROM ps_gc_lin_albarane WHERE n_albaran = ANY(:changed_ids)
-- → INSERT INTO ps_gc_lin_albarane ...
```

**FK corrections (important):**
- `GCLinAlbarane.NAlbaran` → `GCAlbaranes.NAlbaran` (not RegAlbaran — these are different fields)
- `GCLinFacturas.NumFactura` → `GCFacturas.NFactura` (note asymmetric naming)

**GCAlbaranes daily volume:** ~19 modified/day, ~833/month. Lines delta is lightweight.

---

### Products & catalog domain

| Table | Rows | Strategy | Reason |
|-------|------|---------|--------|
| Articulos | 41,264 | Full refresh nightly | All records have FechaModifica >= 2025-03-26 (batch update renders delta useless) |
| FamiGrupMarc | 78 | Full refresh | Trivially small |
| DepaSeccFabr | 10 | Full refresh | Trivially small |
| CCOPColores | 99 | Full refresh | Trivially small |
| CCOPTempTipo | 69 | Full refresh | Trivially small |
| CCOPMarcTrat | ~147 | Full refresh | Trivially small |

**Articulos column selection:** Do NOT use `SELECT *`. The table has 379 columns including BLOB/PICTURE types (DATA_TYPE 12 and 18) that slow queries significantly. Select only the ~30–40 needed columns explicitly.

---

### Master/dimension tables

| Table | Rows | PK | Delta | Strategy |
|-------|------|----|-------|---------|
| Clientes | 27,568 | `RegCliente` | `FechaModifica` | Full refresh (small enough, simpler) |
| Tiendas | 51 | `RegTienda` | `FechaModifica` | Full refresh |
| Proveedores | 519 | — (verify `RegProveedor`) | `FModifica` | Full refresh |
| GCComerciales | 5 | `RegComercial` | — | Full refresh |

---

### Purchasing & invoicing domain

| Table | Rows | PK | Delta | Strategy |
|-------|------|----|-------|---------|
| Compras | 2,700 | `RegPedido` | `Modificada` | Full refresh |
| CCLineasCompr | 44,425 | `RegLineaCompra` | `Fecha` | Full refresh |
| Facturas | 2,357 | `RegFactura` (verify) | `FechaModifica` | Full refresh |
| Albaranes | 3,672 | `RegAlbaran` (verify) | `Modificada` | Full refresh |
| FacturasCompra | 3,884 | — (verify) | `FechaFactura` | Full refresh |

**Important:** `LineasCompras` does not exist as a table. The line items for purchase orders are in `CCLineasCompr`. It links to `Compras` via `NumPedido` (not a direct `NumCompra` field), and to `Tiendas` via `NumTienda`.

**Enrichment added 2026-05-01 (issue #429):**
- `CCLineasCompr` now also syncs: `Unidades`, `PrecioCoste`, `PrecioNetoSI`, `TotalSI`, `NumProveedor` (all `DATA_TYPE=6`, Real).
- `Albaranes` now also syncs: `NPedido` (FK → Compras.RegPedido), `NumProveedor` (FK → Proveedores.RegProveedor), `Proveedor` (denorm text, 100 chars).
- `Proveedores.nombre` fix: the actual name is in `Proveedor` (text, 100 chars) not `NombreComercial` (empty in 4D for all 520 rows). ETL now maps `Proveedor` → `ps_proveedores.nombre`.

---

## Nightly execution order

Tables must be synced in topological order (dimensions before facts):

1. Catalog: Articulos, FamiGrupMarc, CCOPColores, CCOPTempTipo, DepaSeccFabr
2. Masters: Tiendas, Clientes, Proveedores, GCComerciales
3. Stock: Exportaciones
4. Retail: Ventas → LineasVentas → PagosVentas
5. Wholesale: GCAlbaranes → GCLinAlbarane | GCFacturas → GCLinFacturas | GCPedidos → GCLinPedidos
6. Purchasing: Compras → CCLineasCompr → Facturas → Albaranes → FacturasCompra
7. Movements: Traspasos

## Watermarks

The ETL service stores last-sync timestamps in a `etl_watermarks` table in PostgreSQL:

```sql
CREATE TABLE etl_watermarks (
    table_name   TEXT PRIMARY KEY,
    last_sync_at TIMESTAMPTZ NOT NULL,
    rows_synced  INTEGER,
    status       TEXT DEFAULT 'ok',
    error_msg    TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

On first run (no watermark), use `datetime(2014, 1, 1)` as the default `since` date to load all historical data.

---

## Implementation

See GitHub issues #1–#19 for the implementation plan. Issues are tagged `[infra]`, `[etl]`, `[wren]`, and `[docs]`.

Key files (to be created):
- `etl/` — Python ETL package
- `docker-compose.yml` — Full stack (PostgreSQL + ETL + WrenAI)
- `wren/mdl/` — WrenAI semantic model definitions

---

## LLM:rules

Business rules and field conventions the dashboard LLM must follow when generating SQL against the `ps_*` mirror tables.

```json
[
  {
    "instruction": "Siempre usar el campo total_si (sin IVA) para análisis económico de ventas retail. NUNCA usar el campo total que incluye IVA. El IVA varía por región (23% Portugal continental, 22% Madeira, 21% España) y distorsiona las comparaciones entre tiendas.",
    "questions": ["¿Cuánto vendimos?", "¿Cuáles son las ventas netas?", "¿Cuál es la facturación?", "¿Cuántos ingresos tuvimos este mes?"]
  },
  {
    "instruction": "El campo fecha_creacion en Venta y LineaVenta es la fecha de la venta (tipo DATE, formato YYYY-MM-DD). Para filtrar por fecha usar comparaciones simples: fecha_creacion >= '2026-03-24' AND fecha_creacion < '2026-03-31'. NUNCA hacer CAST a TIMESTAMP WITH TIME ZONE — el campo ya es DATE. El campo fecha_documento está vacío (NULL) en todos los registros de Ventas — NUNCA usarlo para filtrar.",
    "questions": ["¿Ventas de la semana pasada?", "¿Ventas de hoy?", "¿Ventas de este mes?", "¿Cuánto vendimos en marzo?"]
  },
  {
    "instruction": "El campo mes en LineaVenta es un entero con formato YYYYMM (ej: 202603 = marzo 2026). Usar para filtrado rápido por período en vez de funciones de fecha: WHERE mes BETWEEN 202601 AND 202612. Es el filtro más eficiente para consultas de ventas por período.",
    "questions": ["¿Ventas del primer trimestre?", "¿Ventas de enero a marzo?", "¿Rendimiento del año 2025?"]
  },
  {
    "instruction": "En la tabla Venta, el campo entrada indica si es venta (entrada=true) o devolución (entrada=false). Para ventas brutas filtrar entrada=true. Para devoluciones filtrar entrada=false. Para calcular ventas netas, sumar ventas con entrada=true y restar el importe de devoluciones con entrada=false. El campo tipo_documento contiene 'Ticket' para ventas POS normales. NO filtrar por tipo_documento='V' que no existe en el mirror.",
    "questions": ["¿Cuántas devoluciones hubo?", "¿Ventas netas sin devoluciones?", "¿Cuánto se devolvió este mes?", "¿Tasa de devolución?"]
  },
  {
    "instruction": "Para excluir la tienda 99 (almacén central) del análisis retail, añadir WHERE tienda <> '99' en consultas de ventas por tienda. El almacén central no es una tienda física de venta al público. La tienda 97 es la tienda online con patrones diferentes.",
    "questions": ["¿Ventas por tienda?", "¿Qué tiendas venden más?", "¿Rendimiento de tiendas retail?", "¿Ranking de tiendas?"]
  },
  {
    "instruction": "El ticket medio se calcula como: SUM(total_si) / COUNT(DISTINCT reg_ventas) de la tabla Venta. Usar siempre total_si (sin IVA). Filtrar entrada=true para excluir devoluciones del cálculo.",
    "questions": ["¿Cuál es el ticket medio?", "¿Cuánto gasta cada cliente de media?", "¿Valor medio por transacción?"]
  },
  {
    "instruction": "Las ventas YTD (año hasta la fecha) se calculan con: WHERE fecha_creacion >= DATE_TRUNC('year', CURRENT_DATE) AND fecha_creacion <= CURRENT_DATE. Para comparar con el año anterior usar: WHERE fecha_creacion >= DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year' AND fecha_creacion <= CURRENT_DATE - INTERVAL '1 year'.",
    "questions": ["¿Ventas acumuladas del año?", "¿Comparativa año anterior?", "¿Crecimiento YTD?", "¿Ventas vs el año pasado?"]
  },
  {
    "instruction": "La tendencia semanal se calcula iterando semanas hacia atrás desde hoy: WHERE fecha_creacion >= CURRENT_DATE - INTERVAL '7 days'. Para 12 semanas, usar rangos semanales. Excluir tienda 99 para análisis de retail. Usar total_si para importes.",
    "questions": ["¿Tendencia de ventas semanal?", "¿Últimas 12 semanas?", "¿Evolución semanal de ventas?"]
  },
  {
    "instruction": "Para facturación mayorista (canal B2B), el importe neto sin IVA se calcula como base1 + base2 + base3 de las tablas ps_gc_facturas o ps_gc_albaranes. NUNCA usar total_factura o total_albaran que incluyen IVA. Excluir notas de crédito con abono=true.",
    "questions": ["¿Cuánto facturamos en mayorista?", "¿Cuál es la facturación B2B?", "¿Ventas mayoristas del año?", "¿Ingresos del canal wholesale?"]
  },
  {
    "instruction": "El canal mayorista sigue un flujo de documentos: Pedido (ps_gc_pedidos) → Albarán/nota de entrega (ps_gc_albaranes) → Factura (ps_gc_facturas) → Cobro (tabla cobros_facturas). Para métricas financieras usar facturas. Para métricas logísticas/operativas usar albaranes. Los cobros son deferred (30/60/90 días después de la factura).",
    "questions": ["¿Cuántos pedidos mayoristas?", "¿Estado de cobros B2B?", "¿Albaranes pendientes de facturar?"]
  },
  {
    "instruction": "Los abonos mayoristas (ps_gc_albaranes con abono=true o ps_gc_facturas con abono=true) son notas de crédito por devoluciones. Para calcular facturación neta mayorista, excluirlos: WHERE abono = false.",
    "questions": ["¿Devoluciones de clientes mayoristas?", "¿Facturación neta mayorista?", "¿Cuántos abonos mayoristas?"]
  },
  {
    "instruction": "La facturación mayorista por comercial se obtiene de ps_gc_facturas JOIN ps_gc_comerciales usando num_comercial = reg_comercial. Usar base1+base2+base3 para el importe neto. Excluir abono=true.",
    "questions": ["¿Facturación por comercial?", "¿Qué comercial vende más?", "¿Rendimiento de representantes de ventas?"]
  },
  {
    "instruction": "Stock total de un artículo = stock en almacén central (ps_stock_tienda WHERE tienda='99') + stock en tiendas físicas (ps_stock_tienda WHERE tienda<>'99'). Tienda código 99 = almacén central, código 97 = tienda online, el resto son tiendas físicas. La tabla ps_stock_tienda contiene AMBOS: central y tiendas.",
    "questions": ["¿Cuánto stock tenemos?", "¿Stock total de un artículo?", "¿Qué stock hay en el almacén?", "¿Inventario total?"]
  },
  {
    "instruction": "El stock puede ser negativo en la base de datos. Causas: timing gaps (venta antes de reponer), modo offline del TPV, ajustes manuales. Para análisis de valoración, filtrar WHERE stock > 0 o usar GREATEST(stock, 0). Para análisis de incidencias, filtrar WHERE stock < 0.",
    "questions": ["¿Artículos con stock negativo?", "¿Problemas de inventario?", "¿Valor del stock?"]
  },
  {
    "instruction": "El valor del stock al coste se calcula como SUM(s.stock * p.precio_coste) del JOIN entre ps_stock_tienda y ps_articulos. precio_coste ya está sin IVA. Filtrar WHERE s.stock > 0 AND p.anulado = false para excluir negativos y artículos inactivos.",
    "questions": ["¿Cuál es el valor del inventario?", "¿Valor del stock al coste?", "¿Inversión en stock?"]
  },
  {
    "instruction": "Stock por talla se obtiene de ps_stock_tienda donde cada fila tiene (codigo, tienda, talla, stock). Para ver stock por talla de un artículo: SELECT talla, SUM(stock) FROM ps_stock_tienda WHERE codigo='X' GROUP BY talla. Las tallas son texto libre (ej: 'S', 'M', 'L', '38', '39', 'U').",
    "questions": ["¿Stock por talla?", "¿Qué tallas quedan?", "¿Distribución de tallas en stock?"]
  },
  {
    "instruction": "Dead stock (stock paralizado): artículos con stock alto pero sin ventas recientes. Identificar con: ps_stock_tienda con stock > X, cruzado con ps_lineas_ventas sin ventas en los últimos N meses. Stock de temporadas antiguas que no rota es el principal riesgo.",
    "questions": ["¿Stock sin rotación?", "¿Artículos encallados?", "¿Dead stock?", "¿Stock de temporadas pasadas?"]
  },
  {
    "instruction": "En la tabla Venta, num_cliente=0 indica venta anónima (cliente no identificado). Para análisis de clientes identificados, siempre filtrar num_cliente > 0. Para calcular % de ventas anónimas: COUNT(CASE WHEN num_cliente=0 THEN 1 END) / COUNT(*) * 100.",
    "questions": ["¿Cuántos clientes únicos?", "¿Clientes identificados vs anónimos?", "¿Porcentaje de ventas anónimas?"]
  },
  {
    "instruction": "Los clientes mayoristas tienen mayorista=true en ps_clientes. Los clientes retail tienen mayorista=false. Un mismo cliente puede aparecer en ambos canales. Para clientes activos retail: COUNT(DISTINCT num_cliente) FROM ps_ventas WHERE num_cliente > 0. Para activos mayoristas: COUNT(DISTINCT num_cliente) FROM ps_gc_albaranes.",
    "questions": ["¿Cuántos clientes mayoristas?", "¿Clientes activos retail?", "¿Cuántos clientes B2B?"]
  },
  {
    "instruction": "Los top clientes retail se obtienen de ps_ventas agrupando por num_cliente y sumando total_si, filtrando num_cliente > 0 y entrada=true. Para identificarlos hacer JOIN con ps_clientes. La frecuencia de compra se calcula como COUNT(DISTINCT reg_ventas) por cliente.",
    "questions": ["¿Mejores clientes retail?", "¿Top clientes por compras?", "¿Clientes más fieles?", "¿Frecuencia de compra?"]
  },
  {
    "instruction": "En pagos retail (ps_pagos_ventas), usar siempre importe_cob (importe cobrado) para análisis de revenue. NUNCA usar importe_ent (importe entregado/tendido) que representa el efectivo físico entregado por el cliente (puede incluir cambio). Para análisis de método de pago: campo forma o codigo_forma.",
    "questions": ["¿Ingresos por método de pago?", "¿Cuánto se cobró en efectivo?", "¿Desglose de formas de pago?"]
  },
  {
    "instruction": "Para efectivo vs tarjeta: codigo_forma='01' (o similar) suele ser efectivo/metalico. Para desglose exacto JOIN con la tabla de formas de pago. Un ticket puede tener múltiples filas en ps_pagos_ventas (pagos divididos). SUM(importe_cob) por num_ventas = Venta.total.",
    "questions": ["¿Efectivo vs tarjeta?", "¿Mix de medios de pago?", "¿Cuánto se pagó con tarjeta?"]
  },
  {
    "instruction": "Margen bruto retail = (total_si - total_coste_si) / total_si * 100. Campos en ps_lineas_ventas: total_si = ingreso sin IVA, total_coste_si = coste sin IVA. Para margen por artículo: GROUP BY codigo. Para margen por familia: JOIN con ps_articulos y ps_familias.",
    "questions": ["¿Margen bruto retail?", "¿Rentabilidad por familia?", "¿Margen por artículo?", "¿Qué departamento tiene mejor margen?"]
  },
  {
    "instruction": "Para margen mayorista, usar ps_gc_lin_facturas: margen = (total - total_coste) / total * 100. El campo total en líneas de facturas mayoristas es el ingreso, total_coste es el coste. Para resumen por cliente o comercial hacer JOIN con ps_gc_facturas.",
    "questions": ["¿Margen mayorista?", "¿Rentabilidad canal B2B?", "¿Margen por comercial?"]
  },
  {
    "instruction": "Productos con bajo margen (< 30%): (precio_coste / precio1) > 0.7 en ps_articulos, donde precio1 es PVP con IVA. Para un cálculo más preciso usar el margen realizado de ventas: (total_si - total_coste_si) / total_si en ps_lineas_ventas. Excluir artículos con anulado=true.",
    "questions": ["¿Productos con bajo margen?", "¿Artículos poco rentables?", "¿Qué artículos vender menos?"]
  },
  {
    "instruction": "El identificador de artículo visible para el usuario es la Referencia (campo ccrefejofacm en ps_articulos, mostrar como 'Referencia'). El campo 'codigo' es un código interno. Siempre incluir la Referencia y Descripción del artículo en los resultados. En ps_lineas_ventas el campo codigo es el código interno — hacer JOIN con ps_articulos para obtener la Referencia.",
    "questions": ["¿Qué artículos vendimos?", "¿Cuáles son los productos más vendidos?", "¿Top artículos?", "¿Referencia de un producto?"]
  },
  {
    "instruction": "Los artículos cuya Referencia (ccrefejofacm) empieza por 'MA' son materiales (bolsas, perchas, envoltorios) que NO tienen seguimiento de inventario. Estos artículos están EXCLUIDOS A NIVEL DE ETL — no existen en las tablas PostgreSQL (ps_articulos ni en las tablas de líneas). NO es necesario filtrar 'MA%' en ninguna consulta SQL sobre el mirror PostgreSQL. Los que empiezan por 'M' (sin 'MA') son artículos mayoristas.",
    "questions": ["¿Cuántos artículos tenemos?", "¿Catálogo activo de productos?", "¿Artículos de venta?"]
  },
  {
    "instruction": "Las ventas retail están en ps_ventas y ps_lineas_ventas. El canal mayorista B2B usa tablas separadas: ps_gc_albaranes, ps_gc_facturas y sus líneas. NUNCA mezclar datos retail y mayorista en la misma consulta a menos que se pida explícitamente una comparativa entre canales.",
    "questions": ["¿Ventas totales?", "¿Compara retail y mayorista?", "¿Cuál canal vende más?"]
  },
  {
    "instruction": "Los artículos con prefijo M en la Referencia (ccrefejofacm LIKE 'M%') son artículos mayoristas. Para análisis de ventas retail puro, excluir estos artículos: JOIN ps_articulos ON lv.codigo = p.codigo WHERE p.ccrefejofacm NOT LIKE 'M%'. Para análisis mayorista puro, usar las tablas GC (ps_gc_albaranes, etc.).",
    "questions": ["¿Ventas retail puras?", "¿Artículos exclusivamente retail?", "¿Filtrar artículos mayoristas?"]
  },
  {
    "instruction": "Los artículos inactivos tienen anulado=true en ps_articulos. Para análisis de catálogo activo: WHERE anulado = false. Para stock disponible: WHERE anulado = false AND stock > 0. Para historial de ventas incluir también artículos anulados (pueden tener ventas históricas).",
    "questions": ["¿Artículos activos?", "¿Cuántos productos en catálogo?", "¿Artículos discontinuados?"]
  },
  {
    "instruction": "PKs (claves primarias) en todas las tablas son NUMERIC(20,3) en PostgreSQL, no INTEGER ni FLOAT. Esto incluye reg_ventas, reg_lineas, reg_articulo, reg_cliente, etc. Son números con decimales heredados del sistema 4D (ej: 10028816.641). NO hacer aritmética con ellos — son identificadores opacos.",
    "questions": ["¿Cómo hacer JOIN entre tablas?", "¿Tipo de datos de IDs?"]
  },
  {
    "instruction": "La tabla Tienda (ps_tiendas) solo tiene codigo, no tiene campo de nombre. Al consultar ventas por tienda, mostrar el código directamente. Códigos especiales: 99=almacén central (excluir de retail), 97=tienda online. El resto son códigos numéricos de tiendas físicas.",
    "questions": ["¿Nombre de las tiendas?", "¿Qué significa el código de tienda?", "¿Tiendas físicas vs online?"]
  },
  {
    "instruction": "El campo fecha_documento en ps_ventas es NULL para todos los registros. NUNCA usarlo. Usar fecha_creacion para filtrar por fecha de venta. El campo fecha_modifica refleja la última modificación (incluye devoluciones y correcciones fiscales).",
    "questions": ["¿Qué campo de fecha usar?", "¿Por qué fecha_documento está vacío?"]
  },
  {
    "instruction": "n_albaran y n_factura NO son únicos en las tablas mayoristas. Múltiples documentos pueden compartir el mismo número (series diferentes, correcciones). No asumir unicidad ni hacer filtros de unicidad basados solo en estos campos. En las tablas de líneas del mirror (ps_gc_lin_albarane, ps_gc_lin_facturas), los JOINs líneas→cabecera deben hacerse por n_albaran/num_factura (únicos campos disponibles), pero sin asumir que sean únicos. Para JOINs entre cabeceras, usar reg_albaran y reg_factura (PKs numéricas) donde estén disponibles.",
    "questions": ["¿Por qué hay duplicados en n_albaran?", "¿Cómo hacer JOIN entre albaranes y líneas?"]
  },
  {
    "instruction": "Las temporadas y colecciones en ps_articulos usan el campo clave_temporada (texto, ej: 'PV26' = Primavera-Verano 2026). Para análisis de temporada, hacer JOIN con ps_temporadas usando num_temporada = reg_temporada. El campo temporada en albaranes mayoristas es texto libre.",
    "questions": ["¿Ventas por temporada?", "¿Stock de la temporada actual?", "¿Artículos de la colección?"]
  },
  {
    "instruction": "El usuario puede filtrar por temporada (colección) usando el campo clave_temporada de ps_articulos. Claves de temporada: PV = Primavera-Verano, OI = Otoño-Invierno, seguido del año en 2 dígitos (ej: PV26, OI25, PV25). Al generar SQL, filtra por clave_temporada cuando el usuario mencione una temporada o colección específica: JOIN ps_articulos p ON lv.codigo = p.codigo WHERE p.clave_temporada = 'PV26'.",
    "questions": ["¿Ventas de la colección PV26?", "¿Stock de la temporada actual PV26?", "¿Artículos de primavera-verano 2026?", "¿Rendimiento de la colección OI25?"]
  },
  {
    "instruction": "Cada traspaso físico crea DOS filas en ps_traspasos: una de salida (entrada=false, tienda_salida rellena, unidades_s) y una de entrada (entrada=true, tienda_entrada rellena, unidades_e). Para analizar envíos usar entrada=false con unidades_s. Para analizar recepciones usar entrada=true con unidades_e. Ambas filas comparten el mismo número de documento.",
    "questions": ["¿Traspasos enviados por tienda?", "¿Cuántas unidades se traspasaron?", "¿Movimientos de stock entre tiendas?"]
  },
  {
    "instruction": "La fórmula VFP (Verificación Física de Producto) para calcular el stock esperado: Entradas = devoluciones_retail + albaranes_compra + traspasos_entrada. Salidas = ventas_retail + traspasos_salida + envíos_mayoristas. Stock_esperado = Stock_inicial + Entradas - Salidas. Si stock_esperado != stock_actual = merma o error de inventario.",
    "questions": ["¿Cómo calcular el stock esperado?", "¿Merma de inventario?", "¿Movimiento neto de stock?"]
  },
  {
    "instruction": "En ps_articulos, precio_coste es el coste base sin IVA. El PVP con IVA es precio1 (o precio2, precio3 para tarifas alternativas). Para calcular margen estimado al catálogo: (precio1/(1+p_iva/100) - precio_coste) / (precio1/(1+p_iva/100)) * 100. El margen realizado en ventas es más preciso: usar total_si y total_coste_si de ps_lineas_ventas.",
    "questions": ["¿Margen estimado de un artículo?", "¿PVP sin IVA?", "¿Precio de coste de un artículo?"]
  },
  {
    "instruction": "En ps_lineas_ventas, el precio de venta unitario sin IVA está en precio_neto_si. El descuento aplicado en el campo p_desc_g (porcentaje) o importe_descuento (importe). Para calcular el descuento medio solo en ventas (no devoluciones): AVG(lv.p_desc_g) FROM ps_lineas_ventas lv JOIN ps_ventas v ON lv.num_ventas = v.reg_ventas WHERE v.entrada=true. Un descuento alto indica outlet o rebajas.",
    "questions": ["¿Descuento medio aplicado?", "¿Precio de venta vs PVP?", "¿Nivel de descuentos?"]
  },
  {
    "instruction": "Las compras a proveedores están en ps_compras (pedidos) y ps_lineas_compras (líneas). Las recepciones de mercancía están en ps_albaranes. Las facturas de proveedor en ps_facturas_compra. Para análisis de compras por proveedor: JOIN ps_compras con ps_proveedores usando num_proveedor = reg_proveedor.",
    "questions": ["¿Compras a proveedores?", "¿Pedidos pendientes de recibir?", "¿Cuánto compramos al proveedor X?"]
  },
  {
    "instruction": "El campo 'entrada' (boolean: true=venta, false=devolución) SOLO existe en la tabla Venta (ps_ventas), NO en LineaVenta (ps_lineas_ventas). Las columnas de LineaVenta son: reg_lineas, num_ventas, n_documento, mes, tienda, codigo, descripcion, unidades, precio_neto_si, total_si, precio_coste_ci, total_coste_si, fecha_creacion, fecha_modifica. NO tiene: entrada, tipo_documento, forma, num_cliente, cajero_nombre. Para filtrar devoluciones en consultas con LineaVenta, hacer JOIN con Venta y filtrar Venta.entrada.",
    "questions": ["¿Artículos más vendidos?", "¿Unidades vendidas por producto?", "¿Ventas por artículo sin devoluciones?"]
  },
  {
    "instruction": "Cuando el usuario pide datos desglosados por tienda en columnas (tabla pivot/crosstab), NO generar CROSSTAB ni múltiples CASE WHEN por tienda. Generar una tabla plana con columnas (artículo, tienda, valor) agrupada por artículo y tienda. El usuario pivotará después.",
    "questions": ["¿Ventas por tienda en columnas?", "¿Unidades por artículo y tienda?", "¿Desglose por tienda?", "¿Tabla con código de tienda?"]
  },
  {
    "instruction": "Cuando el usuario pida un cuadro de mandos, dashboard, o resumen ejecutivo, genera una especificación JSON de dashboard estructurada con múltiples widgets, cada uno con su propia consulta SQL. No respondas con texto explicativo libre ni con una única consulta SQL; incluye SQL solo dentro de los campos correspondientes de cada widget.",
    "questions": ["¿Cuadro de mandos?", "¿Dashboard de ventas?", "¿Resumen ejecutivo?", "¿KPIs del mes?"]
  },
  {
    "instruction": "NUNCA generar consultas sin filtro de fecha sobre tablas grandes: ps_ventas (900K filas), ps_lineas_ventas (1.7M filas), ps_stock_tienda (12M filas). Siempre incluir un rango de fechas explícito. Si el usuario no especifica período, usar 'este mes' (fecha_creacion >= DATE_TRUNC('month', CURRENT_DATE)). Para análisis histórico máximo, limitar a los últimos 2 años.",
    "questions": ["¿Ventas totales históricas?", "¿Todo el historial de ventas?", "¿Ventas de siempre?", "¿Consulta sin filtro de fecha?"]
  },
  {
    "instruction": "Al hacer JOIN entre ps_ventas y ps_lineas_ventas (o cualquier JOIN cabecera→líneas), usar COUNT(DISTINCT v.reg_ventas) para contar tickets — NUNCA COUNT(*) sin DISTINCT. COUNT(*) cuenta una fila por artículo en el ticket (un ticket con 3 artículos = 3 filas en ps_lineas_ventas). Para totales monetarios de cabecera (total_si, descuento), usar ps_ventas directamente SIN JOIN con líneas — evita multiplicar la cabecera.",
    "questions": ["¿Cuántos tickets hay?", "¿Por qué se duplican los totales al hacer JOIN?", "¿Número de transacciones únicas?"]
  },
  {
    "instruction": "GUARDIA DE MAGNITUD — solo aplicar cuando el resultado parece imposible, no cuando es simplemente bajo o alto. Los rangos siguientes son para TODA LA CADENA y PERÍODO MENSUAL: ventas netas retail €200K–€3M; ticket medio €30–€250; stock total en unidades 20K–400K; valor del stock al coste €500K–€15M. Escalar proporcionalmente si la consulta es más estrecha: una tienda ÷ ~50, un día ÷ ~30, una familia de producto ÷ ~20. NO añadir advertencias de magnitud en consultas acotadas a una tienda, un artículo, un día o un departamento — el resultado bajo es correcto. Solo revisar filtros si el resultado es > 10x el rango esperado (probable JOIN sin DISTINCT o falta de entrada=true) o exactamente 0 en un período con ventas conocidas.",
    "questions": ["¿El resultado parece correcto?", "¿Por qué el stock vale €1.000 millones?", "¿Cuál es el rango esperado de ventas?", "¿Los números parecen razonables?"]
  }
]
```
