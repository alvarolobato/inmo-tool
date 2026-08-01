# PowerShop Stock Analysis Guide

> How stock is tracked, moved, and reconciled in the PowerShop database.
> Covers the dual-table model (CCStock + Exportaciones), transfers, returns,
> the SOAP web service for per-store-per-size stock, and the VFP formula.

## Table of Contents

1. [Stock Model Overview](#1-stock-model-overview)
2. [CCStock -- Central Warehouse (Store 99)](#2-ccstock--central-warehouse)
3. [Exportaciones -- Retail Store Stock](#3-exportaciones--retail-store-stock)
4. [Total Stock Calculation](#4-total-stock-calculation)
5. [Stock Movement Formula (VFP)](#5-stock-movement-formula-vfp)
6. [Transfers (Traspasos)](#6-transfers-traspasos)
7. [Returns via GCAlbaranes](#7-returns-via-gcalbaranes)
8. [Negative Stock](#8-negative-stock)
9. [SOAP Web Service: WS_JS_StockTiendas](#9-soap-web-service-ws_js_stocktiendas)
10. [Inventory Snapshots](#10-inventory-snapshots)
11. [Common Stock Queries](#11-common-stock-queries)

---

## 1. Stock Model Overview

PowerShop uses a **dual-table model** for stock:

```
                    +-------------------+
                    |    Articulos      |
                    | (product master)  |
                    | Stock = aggregate |
                    +--------+----------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+     +-------------v-----------+
    |     CCStock        |     |     Exportaciones        |
    | (store 99/central) |     | (all retail stores)      |
    | 1 row per product  |     | 1 row per product/store  |
    | ~41,222 rows       |     | ~2,056,000 rows          |
    +--------------------+     +--------------------------+
```

### Key Rules

1. **CCStock** holds stock for **store 99** (the central warehouse). One row per product.
2. **Exportaciones** holds stock for **all retail stores**. One row per product per store.
3. **Store 99 never appears in Exportaciones.**
4. **Articulos.Stock** is a denormalized aggregate of CCStock + all Exportaciones rows for that product.
5. Both tables use a **wide format**: up to 34 size slots per row (Stock1..Stock34, Talla1..Talla34).

---

## 2. CCStock -- Central Warehouse

**~41,222 rows, 582 columns**

Each row represents one product's stock position at the central warehouse.

### Structure

```
NumArticulo  -> FK to Articulos.RegArticulo
Stock        -> Total units (sum of Stock1..Stock34)
Stock1..34   -> Units per size slot (Integer)
Talla1..34   -> Size label per slot (Alpha)
Compra1..34  -> Purchase price per size
Minimo1..34  -> Minimum stock level per size
Anulada1..34 -> Size cancelled flag
PVP11..PVP734 -> PVP per tariff (7 tariffs) per size (34 sizes)
Rebaja11..234 -> Markdown per level per size
Ubicacion11..334 -> Warehouse location per zone per size
```

### Why 582 Columns?

The wide format avoids joins for size-level queries but results in a very wide table:
- 34 stock columns
- 34 size labels
- 34 purchase prices
- 34 minimums
- 34 cancelled flags
- 238 PVP columns (7 tariffs x 34 sizes)
- 68 markdown columns (2 levels x 34 sizes)
- 102 location columns (3 zones x 34 sizes)
- Plus aggregate and metadata fields

---

## 3. Exportaciones -- Retail Store Stock

**~2,056,001 rows, 161 columns**

Each row represents one product's stock at one retail store.

### Structure

```
Codigo       -> Product code (Alpha)
Tienda       -> Store code (Alpha)
TiendaCodigo -> Composite key: store+code
CCStock      -> FK to CCStock record
STStock      -> Total units at this store (sum of Stock1..34)
Stock1..34   -> Units per size slot
Talla1..34   -> Size labels
Minimo1..34  -> Minimum stock per size
```

### Key Points

- **2 million+ rows** -- this is the largest table in the database.
- Querying all stores for a product requires filtering by `Codigo`.
- Querying all products for a store requires filtering by `Tienda`.
- The composite `TiendaCodigo` field can be used for fast lookups.

---

## 4. Total Stock Calculation

### For a Single Product

```
Total Stock = CCStock.Stock (central)
            + SUM(Exportaciones.STStock) for all stores
```

### SQL Example

Since 4D does not support UNION, run two queries and sum in Python:

```python
# Central stock
cur.execute("""
    SELECT cs.Stock
    FROM CCStock cs
    INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
    WHERE a.Codigo = '12345'
""")
central = cur.fetchone()[0] or 0

# Store stock
cur.execute("""
    SELECT SUM(e.STStock)
    FROM Exportaciones e
    WHERE e.Codigo = '12345'
""")
stores = cur.fetchone()[0] or 0

total = central + stores
```

### Per-Size Stock for a Product

```python
# Central per-size
cur.execute("""
    SELECT cs.Talla1, cs.Stock1, cs.Talla2, cs.Stock2,
           cs.Talla3, cs.Stock3, cs.Talla4, cs.Stock4,
           cs.Talla5, cs.Stock5, cs.Talla6, cs.Stock6
    FROM CCStock cs
    INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
    WHERE a.Codigo = '12345'
""")
```

---

## 5. Stock Movement Formula (VFP)

The VFP (Verificacion Fisica de Producto) formula tracks all stock movements:

### Entry Components (Entradas)

| Source | Table | Filter | Quantity Field |
|--------|-------|--------|---------------|
| Customer returns (retail) | LineasVentas | Entrada=False | Unidades |
| Purchase receipts | LinAlbaranes / Albaranes | Abono=False | Recibidas |
| Transfers in | Traspasos | Entrada=True | UnidadesE |
| Wholesale returns (credit notes) | GCAlbaranes | Abono=True | Unidades |

### Exit Components (Salidas)

| Source | Table | Filter | Quantity Field |
|--------|-------|--------|---------------|
| Retail sales | LineasVentas | Entrada=True | Unidades |
| Purchase returns | LinAlbaranes / Albaranes | Abono=True | Recibidas |
| Transfers out | Traspasos | Entrada=False | UnidadesS |
| Wholesale shipments | GCLinAlbarane | Abono=False | Unidades |

### Formula

```
Entradas = devoluciones_retail
         + albaranes_compra_recibidos
         + envios_recibidos
         + traspasos_entrada

Salidas  = ventas_retail
         + albaranes_compra_devolucion
         + envios_salida
         + traspasos_salida

Neto     = Entradas - Salidas
```

### Expected Stock

```
Stock_esperado = Stock_inicial + Neto
```

If `Stock_esperado != Stock_actual`, the difference is shrinkage (theft, damage, counting errors).

---

## 6. Transfers (Traspasos)

**~262,689 rows, 29 columns**

### Dual-Entry Pattern

Every physical transfer creates **two rows** in Traspasos:

| Row | Entrada | Store Fields | Qty Field |
|-----|---------|-------------|-----------|
| Exit row | False | TiendaSalida filled | UnidadesS |
| Entry row | True | TiendaEntrada filled | UnidadesE |

Both rows share the same `Documento` number.

### Transfer Types

| Tipo | Description | Stock Effect |
|------|-------------|-------------|
| Traspaso | Normal inter-store transfer | Moves stock |
| Regularizacion | Stock adjustment/correction | Adjusts stock |
| S-Robo | Theft write-off | Decreases stock |
| Devolucion | Return to supplier | Decreases stock |

### Querying Transfers

```sql
-- All transfers INTO store 104 in January 2025
SELECT Documento, Codigo, Descripcion, Talla,
       UnidadesE, FechaE, Tipo, Concepto
FROM Traspasos
WHERE TiendaEntrada = '104'
  AND FechaE >= '2025-01-01'
  AND FechaE <= '2025-01-31'
  AND Entrada = TRUE
ORDER BY FechaE

-- All transfers OUT OF store 104
SELECT Documento, Codigo, Descripcion, Talla,
       UnidadesS, FechaS, TiendaEntrada, Tipo
FROM Traspasos
WHERE TiendaSalida = '104'
  AND FechaS >= '2025-01-01'
  AND Entrada = FALSE
ORDER BY FechaS
```

### Transfer Volume Analysis

```sql
-- Monthly transfer volume by route
SELECT TiendaSalida, TiendaEntrada,
       YEAR(FechaS) AS yr, MONTH(FechaS) AS mo,
       COUNT(*) AS num_transfers,
       SUM(UnidadesS) AS total_units
FROM Traspasos
WHERE FechaS >= '2025-01-01'
  AND Entrada = FALSE
GROUP BY TiendaSalida, TiendaEntrada, YEAR(FechaS), MONTH(FechaS)
ORDER BY total_units DESC
```

---

## 7. Returns via GCAlbaranes

Wholesale returns are tracked through `GCAlbaranes` with `Abono = True`:

### How Returns Work

1. A wholesale customer initiates a return.
2. A credit note delivery note is created: `GCAlbaranes.Abono = True`.
3. Line items in `GCLinAlbarane` also have `Abono = True`.
4. Quantities in `Entregadas1..34` represent returned units.
5. Stock is **added back** to the central warehouse (CCStock).

### Querying Returns

```sql
-- Wholesale returns by customer
SELECT ga.Cliente,
       COUNT(*) AS num_returns,
       SUM(ga.TotalAlbaran) AS total_returned,
       SUM(ga.Unidades) AS units_returned
FROM GCAlbaranes ga
WHERE ga.Abono = TRUE
  AND ga.FechaEnvio >= '2025-01-01'
GROUP BY ga.Cliente
ORDER BY total_returned DESC

-- Return detail lines
SELECT gl.NAlbaran, gl.Codigo, gl.Descripcion,
       gl.Unidades, gl.Total, gl.FechaAlbaran
FROM GCLinAlbarane gl
WHERE gl.Abono = TRUE
  AND gl.FechaAlbaran >= '2025-01-01'
ORDER BY gl.FechaAlbaran DESC
LIMIT 50
```

### Retail Returns

Retail returns are tracked in `LineasVentas` with `Entrada = False`:

```sql
SELECT lv.Tienda, lv.Codigo, lv.Descripcion,
       lv.Unidades, lv.Total, lv.FechaCreacion,
       lv.MotivoDevolucion
FROM LineasVentas lv
WHERE lv.Entrada = FALSE
  AND lv.Mes = 202501
ORDER BY lv.FechaCreacion DESC
LIMIT 50
```

---

## 8. Negative Stock

Negative stock values can occur in the database and are a known data quality issue:

### Why Negative Stock Happens

1. **Timing gaps**: A sale is recorded before the transfer that replenishes stock.
2. **POS offline mode**: Sales recorded locally, stock not yet decremented centrally.
3. **Data entry errors**: Manual stock adjustments with incorrect values.
4. **Returns not processed**: Physical return received but not entered in system.
5. **Multi-store transfers**: Exit recorded at origin but entry not yet at destination.

### Finding Negative Stock

```sql
-- Products with negative total stock
SELECT a.Codigo, a.Descripcion, a.Stock
FROM Articulos a
WHERE a.Stock < 0
  AND a.Anulado = FALSE
ORDER BY a.Stock ASC
LIMIT 20

-- Per-store negative stock
SELECT e.Tienda, e.Codigo, e.STStock
FROM Exportaciones e
WHERE e.STStock < 0
ORDER BY e.STStock ASC
LIMIT 20

-- Central negative stock per size
SELECT a.Codigo, cs.Talla1, cs.Stock1, cs.Talla2, cs.Stock2,
       cs.Talla3, cs.Stock3
FROM CCStock cs
INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
WHERE cs.Stock1 < 0 OR cs.Stock2 < 0 OR cs.Stock3 < 0
LIMIT 20
```

### Impact on Analytics

When calculating stock value or stock coverage, filter out or flag negative stock:

```python
# In Python, handle negative stock
stock = max(0, raw_stock)  # Clip to zero for valuation
# OR flag for review
if raw_stock < 0:
    flag_for_review(product_code, store, raw_stock)
```

---

## 9. SOAP Web Service: WS_JS_StockTiendas

PowerShop exposes a SOAP web service for querying per-store per-size stock in real time.

### Service Details

| Parameter | Value |
|-----------|-------|
| Endpoint | `http://YOUR_4D_SERVER_IP:8080/4DWSDL` |
| Method | `WS_JS_StockTiendas` |
| Input | Product reference (CCRefeJOFACM) |
| Output | JSON with per-store per-size stock |

### Python Example

```python
import requests
from xml.etree import ElementTree

def get_stock_by_reference(reference):
    """Query per-store stock via SOAP web service."""
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
    <SOAP-ENV:Envelope
        xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:ns="http://www.4d.com/namespace/default">
        <SOAP-ENV:Body>
            <ns:WS_JS_StockTiendas>
                <ns:param1>{reference}</ns:param1>
            </ns:WS_JS_StockTiendas>
        </SOAP-ENV:Body>
    </SOAP-ENV:Envelope>"""

    response = requests.post(
        'http://YOUR_4D_SERVER_IP:8080/4DWSDL',
        data=soap_body,
        headers={'Content-Type': 'text/xml; charset=utf-8'},
        timeout=30
    )

    # Parse response -- returns JSON inside SOAP envelope
    tree = ElementTree.fromstring(response.content)
    # Extract result and parse as JSON
    # Structure varies by installation
    return response.text
```

### When to Use the Web Service vs SQL

| Approach | Use When |
|----------|----------|
| SQL (CCStock + Exportaciones) | Bulk stock analysis, reporting, data export |
| SOAP WS_JS_StockTiendas | Real-time single-product stock check, integration |

The SOAP service returns the same data as querying CCStock + Exportaciones but in a single call with real-time values.

---

## 10. Inventory Snapshots

### Physical Inventory (Inventarios Table)

The `Inventarios` table (14 columns) is designed for physical inventory counts but is currently **empty** (0 rows). This suggests either:
- Physical counts are performed via external systems
- Inventory data is archived after reconciliation
- The module is not actively used

### Related Tables

| Table | Rows | Description |
|-------|------|-------------|
| Inventarios | 0 | Inventory count headers |
| DetalleInventa | 0 | Inventory count line items |

### Building Your Own Snapshots

Since no historical stock snapshots exist in the database, you can build them by periodically querying current stock:

```python
import datetime

def snapshot_stock(cur, snapshot_date=None):
    """Take a stock snapshot of all products across all stores."""
    if snapshot_date is None:
        snapshot_date = datetime.date.today().isoformat()

    # Central stock
    cur.execute("""
        SELECT a.Codigo, cs.Stock
        FROM CCStock cs
        INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
        WHERE a.Anulado = FALSE
    """)
    central = {row[0]: row[1] for row in cur.fetchall()}

    # Per-store stock
    cur.execute("""
        SELECT e.Tienda, e.Codigo, e.STStock
        FROM Exportaciones e
        WHERE e.STStock <> 0
    """)
    store_stock = cur.fetchall()

    return {
        'date': snapshot_date,
        'central': central,
        'stores': store_stock
    }
```

---

## 11. Common Stock Queries

### Stock Value at Central Warehouse

```sql
SELECT SUM(cs.Stock * a.PrecioCoste) AS stock_value_cost,
       SUM(cs.Stock * a.Precio1) AS stock_value_pvp,
       SUM(cs.Stock) AS total_units,
       COUNT(*) AS product_count
FROM CCStock cs
INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
WHERE cs.Stock > 0
  AND a.Anulado = FALSE
```

### Stock Value per Store

```sql
SELECT e.Tienda,
       COUNT(*) AS products,
       SUM(e.STStock) AS total_units
FROM Exportaciones e
WHERE e.STStock > 0
GROUP BY e.Tienda
ORDER BY total_units DESC
```

### Products with Stock Below Minimum

```sql
SELECT a.Codigo, a.Descripcion,
       a.Stock, a.StockMinimo,
       a.StockMinimo - a.Stock AS deficit
FROM Articulos a
WHERE a.Stock < a.StockMinimo
  AND a.StockMinimo > 0
  AND a.Anulado = FALSE
ORDER BY deficit DESC
LIMIT 50
```

### Stock Turnover (Units Sold / Average Stock)

```sql
-- Units sold per product in a period
SELECT lv.Codigo,
       SUM(lv.Unidades) AS units_sold
FROM LineasVentas lv
WHERE lv.Mes BETWEEN 202501 AND 202512
  AND lv.Entrada = TRUE
GROUP BY lv.Codigo
HAVING SUM(lv.Unidades) > 0
ORDER BY units_sold DESC
LIMIT 50
```

*Note: Average stock requires historical snapshots (not available in the database). Use current stock as an approximation or build periodic snapshots.*

### Dead Stock (No Sales in 12 Months)

```sql
SELECT a.Codigo, a.Descripcion, a.Stock,
       a.FechaModifica AS last_modified
FROM Articulos a
WHERE a.Stock > 0
  AND a.Anulado = FALSE
  AND a.RegArticulo NOT IN (
      SELECT DISTINCT lv.NumArticulo
      FROM LineasVentas lv
      WHERE lv.Mes >= 202501
  )
ORDER BY a.Stock DESC
LIMIT 50
```
