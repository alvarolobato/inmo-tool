# Skill: Business Intelligence Report Generation

**Use when**: The user asks for a new snapshot/report, asks to regenerate `informe-coleccion.html`, or asks for a business analysis of the data.

## Overview

This skill produces a standalone, offline HTML business intelligence report in **Spanish (Spain)** for the the company / PowerShop fashion retail chain. The report targets three audiences: business owners (Dirección), stock/purchasing managers, and department heads.

**Output**: `/Users/alobato/git/powershop-analytics/docs/reports/informe-coleccion.html`

---

## Wholesale vs Retail Split

The report MUST treat wholesale and retail as separate businesses. See [docs/wholesale-retail-split.md](../wholesale-retail-split.md) for full details.

### How to filter
- **Retail articles**: `a.CCRefeJOFACM NOT LIKE 'M%'` (in Articulos JOIN)
- **Wholesale articles**: `a.CCRefeJOFACM LIKE 'M%'`
- **Wholesale channel** (GC tables): GCAlbaranes, GCFacturas, GCLinAlbarane, GCLinFacturas, CobrosFacturas — these are 100% wholesale
- **Retail POS** (Ventas/LineasVentas): Filter with `NOT LIKE 'M%'` for pure retail metrics

### Report structure
The report has three main blocks:
1. **Executive Summary** — combined group KPIs (retail + wholesale totals)
2. **Retail section** (cyan accent) — stores, products, stock, customers, payments, retail actions
3. **Wholesale section** (gold accent) — customers B2B, invoicing, collections, GC articles, wholesale actions

### What makes sense where
- **Store performance**: Retail only (wholesale doesn't use stores)
- **Stock per store**: Retail only (wholesale manufactures to order)
- **Product rankings**: Separate — retail top articles vs wholesale top GC articles
- **Customer analysis**: Retail = POS customers, Wholesale = GC clients (different tables)
- **Payments**: Retail only (wholesale uses invoicing/collections)
- **Weekly trend**: Retail only

### SKU identifier
Always show `Articulos.CCRefeJOFACM` (Referencia) as the primary product identifier in tables and action items, not Codigo.

---

## Data Sources

### 1. SQL (P4D) -- Bulk data

```python
import p4d
conn = p4d.connect(host='YOUR_4D_SERVER_IP', port=19812, user='YOUR_4D_USER', password='')
cur = conn.cursor()
```

Use venv: `${REPO_ROOT}/.venv/bin/python3`

### 2. SOAP (zeep) -- Per-store stock

```python
from zeep import Client
import json
client = Client('http://YOUR_4D_SERVER_IP:8080/4DWSDL')
result = client.service.WS_JS_StockTiendas(Entrada1=json.dumps(['144880','144588']))
status = json.loads(result.Salida1)
data = json.loads(result.Salida2)  # per-store, per-size stock
```

### 3. SQL Exportaciones table -- Per-store stock totals (faster for bulk)

```sql
SELECT Tienda, SUM(CCStock) AS total_stock FROM Exportaciones GROUP BY Tienda ORDER BY total_stock DESC
```

---

## VAT Policy

**ALL reports must use VAT-exclusive (sin IVA) figures.** VAT rates differ across regions (23% Portugal mainland, 22% Madeira, 21% Spain), so including VAT distorts cross-store and cross-region comparisons.

### Field Mapping: VAT-Exclusive Fields

| Table | WITH VAT (con IVA) -- DO NOT USE | WITHOUT VAT (sin IVA) -- USE THIS |
|-------|----------------------------------|-----------------------------------|
| **Ventas** | `Total` | **`TotalSI`** ("Total Sin Impuestos") |
| **LineasVentas** | `Total` | **`PrecioNetoSI * Unidades`** (or `TotalSI` if available per line) |
| **GCFacturas** | `TotalFactura` | **`Base1 + Base2 + Base3`** (sum of tax bases per VAT rate) |
| **GCAlbaranes** | `TotalAlbaran` | **`Base1 + Base2 + Base3`** |
| **PagosVentas** | `ImporteCob` | ImporteCob = con IVA (matches Ventas.Total). For VAT-exclusive payment analysis, JOIN with Ventas.TotalSI or use COUNT for method mix proportions. |
| **Articulos** | `Precio2Neto` (PVP con IVA) | **`PrecioCoste`** (already without VAT). For net selling prices use `PrecioNetoSI` in LineasVentas. |

### Rule

When computing revenue, average ticket, margin, or any monetary KPI, always use the sin-IVA column. The only acceptable use of VAT-inclusive fields is when reconciling against tax documents or payment totals.

---

## Query Cookbook

All queries use 4D SQL dialect. Date literals: `{d 'YYYY-MM-DD'}` or `'YYYY-MM-DD'`. Read-only always.

### Step 1: Determine date ranges

```python
from datetime import date, timedelta
today = date.today()
ytd_start = date(today.year, 1, 1)
last_year_start = date(today.year - 1, 1, 1)
last_year_end = date(today.year - 1, today.month, today.day)
last_30d = today - timedelta(days=30)
```

### Step 2: Identify active season/collection

```sql
SELECT RegTemporada, Clave, TemporadaTipo, TemporadaActiv, InicioVentas, FinVentas
FROM CCOPTempTipo
WHERE TemporadaActiv = TRUE
```

Also get article counts per season:

```sql
SELECT ClaveTemporada, COUNT(RegArticulo) as cnt
FROM Articulos
GROUP BY ClaveTemporada
ORDER BY COUNT(RegArticulo) DESC
```

And stock per season:

```sql
SELECT a.ClaveTemporada, SUM(cs.Stock) AS stock_uds, COUNT(a.RegArticulo) AS n_arts
FROM Articulos a
INNER JOIN CCStock cs ON cs.NumArticulo = a.RegArticulo
GROUP BY a.ClaveTemporada
```

### Step 3: Sales overview (YTD current year + comparison year)

**Total KPIs** (run for both current and previous year date ranges):

```sql
-- YTD current year (use TotalSI = sin IVA)
SELECT COUNT(RegVentas), SUM(TotalSI)
FROM Ventas
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}'

-- Same period last year
SELECT COUNT(RegVentas), SUM(TotalSI)
FROM Ventas
WHERE FechaCreacion >= '{last_year_start}' AND FechaCreacion <= '{last_year_end}'

-- Total units (from LineasVentas, same date filter)
SELECT SUM(Unidades)
FROM LineasVentas
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}'

-- Average ticket (sin IVA)
SELECT AVG(TotalSI) FROM Ventas
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}'
```

### Step 4: Weekly sales trend (last 12 weeks)

Run a query per week or use a loop:

```sql
SELECT COUNT(RegVentas), SUM(TotalSI), SUM(Unidades)
FROM Ventas
WHERE FechaCreacion >= '{week_start}' AND FechaCreacion < '{week_end}'
```

Iterate over 12 weeks backwards from today. Store results for the sparkline/chart.

### Step 5: Per-store performance

```sql
-- YTD current year by store (sin IVA)
SELECT Tienda, COUNT(RegVentas) AS cnt, SUM(TotalSI) AS tot
FROM Ventas
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}'
GROUP BY Tienda
ORDER BY SUM(TotalSI) DESC

-- Same period last year by store (for YoY comparison, sin IVA)
SELECT Tienda, COUNT(RegVentas) AS cnt, SUM(TotalSI) AS tot
FROM Ventas
WHERE FechaCreacion >= '{last_year_start}' AND FechaCreacion <= '{last_year_end}'
GROUP BY Tienda
```

Get store names separately:

```sql
SELECT Codigo, Poblacion, Provincia FROM Tiendas ORDER BY Codigo
```

### Step 6: Product performance

**Important**: Product tables must show `CCRefeJOFACM` (Referencia) as the primary SKU identifier, displayed as "Ref." column. This is what staff and business users recognise. `Codigo` may appear as a secondary column or be omitted. Since `LineasVentas` does not have `CCRefeJOFACM`, always JOIN with `Articulos` to get the Referencia.

**Top articles by revenue and units**:

```sql
SELECT a.CCRefeJOFACM, lv.Codigo, lv.Descripcion, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.CCRefeJOFACM, lv.Codigo, lv.Descripcion
ORDER BY SUM(lv.PrecioNetoSI * lv.Unidades) DESC
LIMIT 25
```

**By family (FamiGrupSeri)**:

```sql
SELECT a.FamiGrupSeri, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.FamiGrupSeri
ORDER BY SUM(lv.PrecioNetoSI * lv.Unidades) DESC
```

**By department (DepaSeccFabr)**:

```sql
SELECT a.DepaSeccFabr, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.DepaSeccFabr
ORDER BY SUM(lv.PrecioNetoSI * lv.Unidades) DESC
```

**By color**:

```sql
SELECT a.Color, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.Color
ORDER BY SUM(lv.PrecioNetoSI * lv.Unidades) DESC
```

**By size (talla)**:

```sql
SELECT lv.CCOPTallaOjo, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY lv.CCOPTallaOjo
ORDER BY SUM(lv.Unidades) DESC
```

**Sales by season of origin** (what season's products are actually selling):

```sql
SELECT a.ClaveTemporada, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.ClaveTemporada
ORDER BY SUM(lv.PrecioNetoSI * lv.Unidades) DESC
```

### Step 7: Pricing and discount analysis

```sql
-- Average selling price vs PVP
SELECT AVG(lv.PrecioNetoSI) AS avg_sell, AVG(a.Precio2Neto) AS avg_pvp
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'

-- Average discount percentage (revenue sin IVA)
SELECT AVG(lv.PDescG) AS avg_discount, SUM(lv.PrecioNetoSI * lv.Unidades) AS total_revenue, SUM(lv.Unidades) AS total_units
FROM LineasVentas lv
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
```

### Step 8: Margin analysis

**By department**:

```sql
SELECT a.DepaSeccFabr, SUM(lv.PrecioNetoSI * lv.Unidades) AS revenue, SUM(lv.Unidades * a.PrecioCoste) AS cost
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.DepaSeccFabr
```

Margin = `(revenue - cost) / revenue * 100`

**By family**:

```sql
SELECT a.FamiGrupSeri, SUM(lv.PrecioNetoSI * lv.Unidades) AS revenue, SUM(lv.Unidades * a.PrecioCoste) AS cost
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.FamiGrupSeri
```

**By store**:

```sql
SELECT lv.Tienda, SUM(lv.PrecioNetoSI * lv.Unidades) AS revenue, SUM(lv.Unidades * a.PrecioCoste) AS cost
FROM LineasVentas lv
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{ytd_start}' AND lv.FechaCreacion <= '{today}'
GROUP BY lv.Tienda
```

### Step 9: Stock analysis (CORRECTED)

**IMPORTANT**: CCStock = central warehouse (store 99) ONLY. Exportaciones = retail stores (store 99 is NOT included). True total = both.

See [docs/stock-analysis.md](../stock-analysis.md) for full details.

**Central warehouse stock (CCStock = store 99)**:

```sql
SELECT SUM(Stock) FROM CCStock                    -- net total (includes negatives from returns)
SELECT SUM(Stock) FROM CCStock WHERE Stock > 0    -- positive stock only
```

**Retail store stock (Exportaciones = all stores except central)**:

```sql
SELECT SUM(CCStock) FROM Exportaciones
```

**Stock value (central only — retail value needs SOAP or Exportaciones join)**:

```sql
-- PrecioCoste is already VAT-free; Precio2Neto includes VAT (use for PVP reference only)
SELECT SUM(cs.Stock * a.PrecioCoste) AS stock_cost_value, SUM(cs.Stock * a.Precio2Neto) AS stock_retail_value_inc_vat
FROM CCStock cs
INNER JOIN Articulos a ON a.RegArticulo = cs.NumArticulo
```

> **Note**: `stock_cost_value` (PrecioCoste) is already VAT-exclusive and should be the primary stock valuation metric. `stock_retail_value_inc_vat` (Precio2Neto) includes VAT and is only useful as a PVP reference -- do not mix it with sin-IVA revenue figures.

**Stock by family**:

```sql
SELECT a.FamiGrupSeri, SUM(cs.Stock) AS uds, SUM(cs.Stock * a.PrecioCoste) AS val_cost
FROM CCStock cs
INNER JOIN Articulos a ON a.RegArticulo = cs.NumArticulo
GROUP BY a.FamiGrupSeri
ORDER BY SUM(cs.Stock) DESC
```

**Per-store stock (Exportaciones)**:

```sql
SELECT Tienda, SUM(CCStock) AS total_stock
FROM Exportaciones
GROUP BY Tienda
ORDER BY SUM(CCStock) DESC
```

**Dead stock / overstock** (high stock, zero or low sales):

```sql
-- Get articles with stock > 50 but low/no recent sales
SELECT a.CCRefeJOFACM, a.Codigo, a.Descripcion, cs.Stock, a.FamiGrupSeri, a.ClaveTemporada, a.Precio2Neto, a.PrecioCoste
FROM CCStock cs
INNER JOIN Articulos a ON a.RegArticulo = cs.NumArticulo
WHERE cs.Stock > 50
ORDER BY cs.Stock DESC
LIMIT 30
```

Then cross-reference with sales data to find articles with stock but no recent sales.

**Lost sales** (high sales velocity, zero stock):

Get top sellers and their stock from CCStock. Articles with high sales and `Stock = 0` are lost sales.

```sql
SELECT a.CCRefeJOFACM, lv.Codigo, lv.Descripcion, SUM(lv.Unidades) AS uds, SUM(lv.PrecioNetoSI * lv.Unidades) AS tot, cs.Stock
FROM LineasVentas lv
INNER JOIN CCStock cs ON cs.NumArticulo = lv.NumArticulo
INNER JOIN Articulos a ON a.RegArticulo = lv.NumArticulo
WHERE lv.FechaCreacion >= '{last_30d}' AND lv.FechaCreacion <= '{today}'
GROUP BY a.CCRefeJOFACM, lv.Codigo, lv.Descripcion, cs.Stock
ORDER BY SUM(lv.Unidades) DESC
LIMIT 30
```

**Per-store stock for specific articles** (SOAP):

```python
from zeep import Client
import json
client = Client('http://YOUR_4D_SERVER_IP:8080/4DWSDL')
codes = ['144880', '144588', '144844']  # top seller Codigo values
result = client.service.WS_JS_StockTiendas(Entrada1=json.dumps(codes))
data = json.loads(result.Salida2)
# Returns: [{"codigo": "144880", "tiendas": [{"codigo_tienda": "644", "id_tienda": "HELLIN", "stock": [{"talla": "38", "stock": 1}, ...]}]}]
```

Use this for the top 10-20 articles to show per-store stock breakdown.

### Step 10: Customer analysis

```sql
-- Identified customers (with NumCliente > 0) in period
SELECT COUNT(DISTINCT NumCliente)
FROM Ventas
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}' AND NumCliente > 0

-- Total customers in database
SELECT COUNT(RegCliente) FROM Clientes

-- New customers (by FechaCreacion in Clientes)
SELECT COUNT(RegCliente)
FROM Clientes
WHERE FechaCreacion >= '{ytd_start}' AND FechaCreacion <= '{today}'

-- Customer frequency and concentration
SELECT v.NumCliente, SUM(v.TotalSI) AS tot, COUNT(v.RegVentas) AS txn
FROM Ventas v
WHERE v.FechaCreacion >= '{ytd_start}' AND v.FechaCreacion <= '{today}' AND v.NumCliente > 0
GROUP BY v.NumCliente
ORDER BY SUM(v.TotalSI) DESC

-- Frequency distribution
SELECT v.NumCliente, COUNT(v.RegVentas) AS purchases
FROM Ventas v
WHERE v.FechaCreacion >= '{ytd_start}' AND v.FechaCreacion <= '{today}' AND v.NumCliente > 0
GROUP BY v.NumCliente
```

From the frequency data, compute: 1-purchase, 2-3 purchases, 4+ purchases buckets. Also compute top-10% concentration (top 10% of customers = X% of revenue).

### Step 11: Wholesale channel

```sql
-- Invoices YTD (sin IVA: sum of tax bases)
SELECT COUNT(RegFactura), SUM(Base1 + Base2 + Base3) AS tot_si
FROM GCFacturas
WHERE FechaFactura >= '{ytd_start}' AND FechaFactura <= '{today}'

-- Previous year comparison (sin IVA)
SELECT COUNT(RegFactura), SUM(Base1 + Base2 + Base3) AS tot_si
FROM GCFacturas
WHERE FechaFactura >= '{last_year_start}' AND FechaFactura <= '{last_year_end}'

-- Delivery notes
SELECT COUNT(RegAlbaran), SUM(BaseImponible)
FROM GCAlbaranes
WHERE FechaEnvio >= '{ytd_start}' AND FechaEnvio <= '{today}'

-- Collections
SELECT COUNT(RegCobro), SUM(ImporteCobro)
FROM CobrosFacturas
WHERE Fecha >= '{ytd_start}' AND Fecha <= '{today}'

-- Also get previous year collections
SELECT SUM(ImporteCobro)
FROM CobrosFacturas
WHERE Fecha >= '{last_year_start}' AND Fecha <= '{last_year_end}'

-- Recent orders
SELECT RegPedido, NPedido, FechaPedido, Cliente, BaseE
FROM GCPedidos
ORDER BY RegPedido DESC
LIMIT 10
```

### Step 12: Payment methods

```sql
-- NOTE: ImporteCob includes VAT (matches Ventas.Total). Use COUNT for method mix
-- proportions, or JOIN with Ventas.TotalSI for VAT-exclusive revenue by payment method.
SELECT pv.Forma, COUNT(pv.RegPagos) AS cnt, SUM(pv.ImporteCob) AS tot_inc_vat
FROM PagosVentas pv
WHERE pv.FechaCreacion >= '{ytd_start}' AND pv.FechaCreacion <= '{today}'
GROUP BY pv.Forma
ORDER BY COUNT(pv.RegPagos) DESC
```

Map `Forma` codes to names using FormasPago table or hardcoded: 1=Metalico(cash), 2=Tarjeta(card), 3=Vales, etc.

**Cash vs card by store** (use COUNT for proportions -- ImporteCob includes VAT):

```sql
SELECT pv.Tienda, pv.Forma, COUNT(pv.RegPagos) AS cnt
FROM PagosVentas pv
WHERE pv.FechaCreacion >= '{ytd_start}' AND pv.FechaCreacion <= '{today}'
GROUP BY pv.Tienda, pv.Forma
```

### Step 13: Transfers/logistics

```sql
SELECT COUNT(RegTraspaso), SUM(UnidadesS)
FROM Traspasos
WHERE FechaTraspaso >= '{ytd_start}' AND FechaTraspaso <= '{today}'

-- Transfer routes
SELECT TiendaSalida, TiendaEntrada, SUM(UnidadesS) AS uds
FROM Traspasos
WHERE FechaTraspaso >= '{ytd_start}' AND FechaTraspaso <= '{today}'
GROUP BY TiendaSalida, TiendaEntrada
ORDER BY SUM(UnidadesS) DESC
LIMIT 15
```

---

## Report Structure

The HTML file has these sections in order:

1. **Header**: Brand name, report title, date range, generation timestamp
2. **Resumen Ejecutivo**: 8 KPI cards (revenue, transactions, units, avg ticket, active stores, active customers, wholesale revenue, margin) + 2-3 insight boxes (green=good, amber=warning, red=alert)
3. **Para la Dirección**: Monthly trends bar chart (CSS-based), department distribution bars, key business ratios table, sales by season table, business insights
4. **Análisis de Ventas por Tienda**: Full store table (store code, city, transactions, revenue, YoY change%, avg ticket, margin%) with heatmap coloring. Closed stores note.
5. **Análisis de Producto**: Top 15 articles table, top families bar chart, top colors chart, margin by family table, size distribution
6. **Para el Responsable de Stock y Compras**: 6 stock KPI cards, stock by store table (Exportaciones), lost sales table (sold well but zero stock), dead stock table (high stock low sales)
7. **Análisis de Clientes**: 4 customer KPIs, frequency segmentation, concentration analysis
8. **Canal Mayorista**: 4 wholesale KPIs, insight on YoY trend, recent orders table
9. **Medios de Pago**: Payment method breakdown with bars, cash vs card by store
10. **Traspasos y Logística**: Transfer volume and top routes
11. **10 Acciones Inmediatas -- Dirección**: Numbered action items, each with specific numbers and expected impact
12. **10 Acciones Inmediatas -- Stock y Compras**: Same format, stock-focused
13. **Tendencia Semanal**: 12-week sparkline/bar chart
14. **Footer**: Generation timestamp, data source, disclaimer

---

## HTML Design Specifications

### Color scheme (fashion brand aesthetic)

```css
--navy: #0a1628;
--navy-light: #132240;
--navy-mid: #1a3058;
--gold: #c9a84c;
--gold-light: #e8d48b;
--white: #f4f4f8;
--green: #27ae60;    /* positive metrics */
--red: #e74c3c;      /* alerts */
--amber: #f39c12;    /* warnings */
--blue: #3498db;     /* info */
```

### Design principles

- **Standalone**: No external dependencies (no CDN, no JS libraries). All CSS inline in `<style>`.
- **Charts**: CSS-based bars and progress bars. NO JavaScript charting libraries. SVG inline only if needed.
- **Tables**: Alternating row colors, right-aligned numbers, bold headers, colored cells for heatmap effect.
- **Cards**: White background, subtle shadow, border-left color-coded (gold=highlight, green=good, red=alert, blue=info, amber=warning).
- **Insights**: Colored left-border boxes with bold lead sentence + details.
- **Responsive**: Max-width 1400px, works on desktop and print.
- **Numbers**: Spanish formatting (decimal comma, period for thousands: `1.234,56 €`). Currency always EUR (€).

### KPI card HTML pattern

```html
<div class="kpi-card highlight">
  <div class="label">Facturación YTD</div>
  <div class="value">770.862 &euro;</div>
  <div class="change positive">+8,8% vs 2025</div>
</div>
```

### Insight box pattern

```html
<div class="insight alert">
  <strong>Lead sentence:</strong> Detail text with specific numbers.
</div>
```

Classes: `success` (green), `alert` (red), `warning` (amber), no class (neutral/blue).

### Table heatmap pattern

For store performance tables, apply background color based on YoY change:
- `> +10%`: green background
- `0% to +10%`: light green
- `-10% to 0%`: light amber
- `< -10%`: light red

---

## Generating the 10 Action Items

### For Dirección (business owners):

Think like a management consultant. Each action must have:
- **Specific store/product/number** (not generic)
- **Why** (data-backed observation)
- **Expected impact** (estimated EUR or %)

Typical actions:
1. Investigate critical underperforming stores (revenue drop > 50%)
2. Audit low-margin stores (< 35% margin)
3. Investigate wholesale channel decline
4. Address closed/inactive stores
5. Review pricing strategy for outlet-like stores
6. Expand top-performing stores/categories
7. Customer loyalty program for high-frequency buyers
8. Portugal vs Spain market strategy
9. Cash vs card policy review
10. Seasonal transition planning

### For Stock/Purchasing Manager:

Each action must reference specific SKU codes and store codes:
1. Emergency restock of top sellers with zero stock
2. Rebalance stock from overstocked to understocked stores
3. Markdown dead stock (high stock + zero sales for 60+ days)
4. Size curve adjustment (sizes that sell out first)
5. Transfer-out from stores with excessive stock
6. Replenishment plan for new season articles
7. Return-to-vendor for oldest unsold stock
8. Inter-store transfer optimization
9. Safety stock levels for bestsellers
10. Inventory audit for discrepancy stores

---

## Gotchas and Data Quality Notes

1. **Always use VAT-exclusive (sin IVA) fields**: `Ventas.TotalSI` not `Total`, `LineasVentas.PrecioNetoSI * Unidades` not `Total`, `GCFacturas.(Base1+Base2+Base3)` not `TotalFactura`. VAT rates differ by region (23% PT mainland, 22% Madeira, 21% Spain) and including VAT distorts cross-store comparisons and inflates revenue.
2. **FechaCreacion vs FechaDocumento**: Use `FechaCreacion` for date filtering -- `FechaDocumento` is often NULL in Ventas.
3. **Bags (BOLSA)**: Exclude or separate bags from apparel analysis -- they distort unit counts (high volume, near-zero revenue).
4. **Store 99**: Central warehouse, not a retail store. Exclude from retail store rankings.
5. **Store 97**: Online store. May have different patterns.
6. **Negative units**: Can appear in LineasVentas (returns). SUM handles this correctly.
7. **Float PKs**: `RegArticulo`, `RegVentas` etc. are Real (float) with `.99` suffix -- don't compare with `=` on computed values.
8. **Exportaciones for stock**: The table with 2M+ rows -- use `CAST(Tienda AS INT)` and `CCStock <> 0` for filtering.
9. **SOAP stock**: `WS_JS_StockTiendas` input must be `Articulos.Codigo` (text codes like "144880"), NOT RegArticulo.
10. **p4d type 0 columns**: Always specify columns explicitly. Never `SELECT *` on wide tables.
11. **Bytes in results**: Text fields may return `bytes` -- always `.decode('utf-8', errors='replace')`.
12. **Connection timeout**: The 4D SQL server may be slow on large JOINs. Use LIMIT and batch queries.
13. **Spanish number formatting**: Use `.` for thousands, `,` for decimals (e.g., `1.234,56 €`).
14. **All currency is EUR** -- never use `$` or USD.
15. **PagosVentas.ImporteEnt vs ImporteCob**: `ImporteEnt` = "Importe Entregado" (physical amount handed over by customer, e.g., a 20 EUR bill). NOT useful for analytics. `ImporteCob` = "Importe Cobrado" (actual charge). Always use `ImporteCob` for payment analysis, or `Ventas.TotalSI` for VAT-exclusive revenue. ~33 "Devolucion Vale" records have a POS bug in ImporteEnt -- ignore it, no data needs fixing.

---

## Execution Checklist

When asked to regenerate the report:

- [ ] Determine today's date for date ranges
- [ ] Run all Step 1-13 queries, collecting results into Python dicts/lists
- [ ] Handle query failures gracefully -- note assumptions, continue with available data
- [ ] Compute derived metrics (margins, YoY%, coverage days, concentrations)
- [ ] Generate the full HTML with inline CSS
- [ ] Write to `docs/reports/informe-coleccion.html`
- [ ] Open in browser with `open` command
- [ ] Verify no `$` or `USD` anywhere -- all EUR
- [ ] Verify Spanish number formatting throughout
- [ ] Verify all sections are populated with real data
