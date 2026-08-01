# Wholesale vs Retail Split in PowerShop

> How to distinguish wholesale (B2B) from retail (B2C) data across all tables.
> Covers the M-prefix convention, POS vs GC channels, and implications for reporting.

## Table of Contents

1. [Overview](#1-overview)
2. [The M-Prefix Convention](#2-the-m-prefix-convention)
3. [POS Channel (Retail)](#3-pos-channel-retail)
4. [GC Channel (Wholesale)](#4-gc-channel-wholesale)
5. [Stock by Channel](#5-stock-by-channel)
6. [Customers by Channel](#6-customers-by-channel)
7. [Payments by Channel](#7-payments-by-channel)
8. [Report Implications](#8-report-implications)
9. [Common Pitfalls](#9-common-pitfalls)

---

## 1. Overview

PowerShop supports two sales channels within the same database:

| Aspect | Retail (B2C) | Wholesale (B2B) |
|--------|-------------|-----------------|
| **Tables** | Ventas, LineasVentas, PagosVentas | GCAlbaranes, GCLinAlbarane, GCFacturas, GCLinFacturas |
| **Document flow** | Ticket -> (optional Invoice) | Order -> Delivery Note -> Invoice -> Collection |
| **Product codes** | Standard codes (no prefix) | Often M-prefixed codes |
| **Customers** | Clientes where Mayorista=False | Clientes where Mayorista=True |
| **Payments** | PagosVentas (ImporteCob) | CobrosFacturas (Importe) |
| **Pricing** | PVP (Precio1, with VAT) | Net prices (negotiated, often without VAT) |
| **Stock source** | Exportaciones (retail stores) | CCStock (central warehouse) |
| **Rows** | ~910K sales, ~1.69M lines | ~49K delivery notes, ~1.01M lines |

---

## 2. The M-Prefix Convention

Articles with codes starting with **"M"** (e.g., `M12345`) are wholesale/bulk products:

| Code Pattern | Channel | Example |
|-------------|---------|---------|
| `12345` | Retail | Standard product sold in stores |
| `M12345` | Wholesale | Bulk/wholesale variant |

### How to Filter

```sql
-- Retail products only
WHERE Codigo NOT LIKE 'M%'

-- Wholesale products only
WHERE Codigo LIKE 'M%'

-- Both channels
-- (no filter on Codigo)
```

### Important Notes

- Not all wholesale transactions use M-prefix products. Some standard products are also sold wholesale.
- The M-prefix is a **convention**, not a hard rule enforced by the system.
- For definitive channel separation, use the **table** (Ventas vs GCAlbaranes), not just the prefix.

---

## 3. POS Channel (Retail)

### Tables

| Table | Rows | Description |
|-------|------|-------------|
| Ventas | ~910,726 | Ticket headers |
| LineasVentas | ~1,687,995 | Ticket line items |
| PagosVentas | ~964,039 | Payment records |
| Cajas | ~42,504 | Register sessions |
| Facturas | ~2,356 | Formal invoices (when requested) |

### Characteristics

- **Point-of-sale** transactions from physical stores and online orders.
- **Immediate payment**: cash, card, voucher at time of sale.
- **Prices include VAT** (Total field includes VAT; TotalSI excludes it).
- **Anonymous or identified**: NumCliente may be 0 for walk-in customers.
- **One ticket, one moment**: sale happens at a single point in time.

### Key Queries

```sql
-- Total retail revenue (excluding returns)
SELECT SUM(Total) AS retail_revenue
FROM Ventas
WHERE FechaCreacion >= '2025-01-01'
  AND Entrada = TRUE

-- Retail revenue from non-M products only
SELECT SUM(lv.Total) AS pure_retail
FROM LineasVentas lv
WHERE lv.Mes BETWEEN 202501 AND 202512
  AND lv.Entrada = TRUE
  AND lv.Codigo NOT LIKE 'M%'
```

---

## 4. GC Channel (Wholesale)

### Tables

| Table | Rows | Description |
|-------|------|-------------|
| GCPedidos | ~101 | Purchase orders |
| GCLinPedidos | ~2,645 | Order line items |
| GCAlbaranes | ~48,882 | Delivery notes |
| GCLinAlbarane | ~1,014,995 | Delivery note lines |
| GCFacturas | ~18,060 | Invoices |
| GCLinFacturas | ~974,742 | Invoice lines |
| CobrosFacturas | ~12,459 | Invoice collections |
| GCComerciales | ~5 | Sales representatives |

### Document Flow

```
GCPedidos (Order)
    -> GCAlbaranes (Delivery Note -- goods shipped)
        -> GCFacturas (Invoice -- billing)
            -> CobrosFacturas (Collection -- payment received)
```

### Characteristics

- **Deferred payment**: invoices with 30/60/90 day terms.
- **Prices often net** (without VAT). VAT calculated separately.
- **Always identified customer**: NumCliente always references a Clientes record.
- **Multiple deliveries per order**: one order can generate many delivery notes.
- **Multiple delivery notes per invoice**: one invoice can cover multiple shipments.
- **Credit notes** (Abono=True) for returns/corrections.
- **Sales representatives** (GCComerciales) assigned per customer.
- **Size-level detail**: GCLinAlbarane has Entregadas1..34 for per-size quantities.

### Key Queries

```sql
-- Total wholesale revenue (from invoices, excluding credit notes)
SELECT SUM(TotalFactura) AS wholesale_revenue
FROM GCFacturas
WHERE FechaFactura >= '2025-01-01'
  AND Abono = FALSE
  AND FacturaAnulada = FALSE

-- Wholesale revenue from delivery notes
SELECT SUM(TotalAlbaran) AS ws_delivery_revenue
FROM GCAlbaranes
WHERE FechaEnvio >= '2025-01-01'
  AND Abono = FALSE
```

---

## 5. Stock by Channel

### Where Stock Lives

| Location | Table | Store | Channel Served |
|----------|-------|-------|---------------|
| Central warehouse | CCStock | 99 | Primarily wholesale |
| Retail stores | Exportaciones | All except 99 | Primarily retail |

### Flow of Stock

```
Supplier
  -> Albaranes (purchase receipt) -> CCStock (central)
      -> Traspasos -> Exportaciones (retail stores)
      -> GCAlbaranes -> Customer (wholesale shipment)
```

### Stock by Channel Query

```sql
-- Central warehouse stock (serves wholesale)
SELECT SUM(Stock) AS central_stock
FROM CCStock
WHERE Stock > 0

-- Retail store stock
SELECT SUM(STStock) AS retail_stock
FROM Exportaciones
WHERE STStock > 0
```

### Products Available per Channel

```sql
-- Products with central stock (potential wholesale)
SELECT COUNT(DISTINCT a.Codigo)
FROM CCStock cs
INNER JOIN Articulos a ON cs.NumArticulo = a.RegArticulo
WHERE cs.Stock > 0

-- Products with store stock (retail)
SELECT COUNT(DISTINCT Codigo)
FROM Exportaciones
WHERE STStock > 0
```

---

## 6. Customers by Channel

### Identification

```sql
-- Wholesale customers
SELECT COUNT(*) FROM Clientes WHERE Mayorista = TRUE AND Anulado = FALSE

-- Retail customers
SELECT COUNT(*) FROM Clientes WHERE Mayorista = FALSE AND Anulado = FALSE
```

### Customer Characteristics by Channel

| Field | Retail Customer | Wholesale Customer |
|-------|----------------|-------------------|
| Mayorista | False | True |
| FormaPago | Typically cash/card | Credit terms (30/60/90 days) |
| PDescCom | Usually 0 | Negotiated discount |
| RiesgoConcedid | 0 | Credit limit set |
| NumComercial | 0 | Assigned sales rep |
| BloqueoFinancials | Rare | Used for credit control |
| LlevaIva | True | May be False (intra-community) |
| LlevaRE | Sometimes | Depends on tax regime |

### Cross-Channel Customers

Some customers may appear in both channels:

```sql
-- Customers that appear in both retail and wholesale
SELECT c.Codigo, c.Cliente
FROM Clientes c
WHERE c.RegCliente IN (
    SELECT DISTINCT NumCliente FROM Ventas WHERE NumCliente > 0
)
AND c.RegCliente IN (
    SELECT DISTINCT NumCliente FROM GCAlbaranes
)
```

---

## 7. Payments by Channel

### Retail Payments

Tracked in `PagosVentas`:

| Field | Description |
|-------|-------------|
| ImporteEnt | Amount tendered |
| ImporteCob | Amount collected (**use this for revenue**) |
| CodigoForma | Payment method code |
| Forma | Payment method name |

```sql
-- Retail payment breakdown
SELECT pv.Forma,
       SUM(pv.ImporteCob) AS collected
FROM PagosVentas pv
WHERE pv.FechaCreacion >= '2025-01-01'
  AND pv.Entrada = TRUE
GROUP BY pv.Forma
ORDER BY collected DESC
```

### Wholesale Payments

Tracked in `CobrosFacturas`:

| Field | Description |
|-------|-------------|
| Importe | Payment amount |
| Fecha | Payment date |
| Forma | Payment method |
| Pagado | Fully paid flag |
| NumFactura | FK -> GCFacturas |

```sql
-- Wholesale collection summary
SELECT cf.Forma,
       COUNT(*) AS payments,
       SUM(cf.Importe) AS collected
FROM CobrosFacturas cf
WHERE cf.Fecha >= '2025-01-01'
GROUP BY cf.Forma
ORDER BY collected DESC
```

### Outstanding Wholesale Receivables

```sql
-- Unpaid wholesale invoices
SELECT gf.NFactura, gf.Cliente, gf.FechaFactura,
       gf.TotalFactura,
       COALESCE(SUM(cf.Importe), 0) AS paid,
       gf.TotalFactura - COALESCE(SUM(cf.Importe), 0) AS outstanding
FROM GCFacturas gf
LEFT OUTER JOIN CobrosFacturas cf ON gf.RegFactura = cf.NumFactura
WHERE gf.Abono = FALSE
  AND gf.FacturaAnulada = FALSE
GROUP BY gf.NFactura, gf.Cliente, gf.FechaFactura, gf.TotalFactura
HAVING gf.TotalFactura - COALESCE(SUM(cf.Importe), 0) > 0
ORDER BY outstanding DESC
```

---

## 8. Report Implications

### Revenue Reports

When building revenue reports, be clear about which channel:

| Report Type | Source | Filters |
|------------|--------|---------|
| Retail revenue | Ventas.Total or SUM(LineasVentas.Total) | Entrada=True |
| Wholesale revenue | SUM(GCFacturas.TotalFactura) | Abono=False, FacturaAnulada=False |
| Total revenue | Sum of both | Combine in Python |
| Pure retail | LineasVentas | Entrada=True AND Codigo NOT LIKE 'M%' |
| Pure wholesale | GCLinFacturas | Standard query |

### Margin Reports

| Channel | Revenue Field | Cost Field |
|---------|-------------|-----------|
| Retail | LineasVentas.TotalSI | LineasVentas.TotalCosteSI |
| Wholesale | GCLinFacturas.Total | GCLinFacturas.TotalCoste |

### Units Sold

| Channel | Table | Field |
|---------|-------|-------|
| Retail | LineasVentas | Unidades (with Entrada filter) |
| Wholesale | GCLinAlbarane or GCLinFacturas | Unidades |

### Time Periods

| Channel | Fast Filter | Date Filter |
|---------|------------|------------|
| Retail | LineasVentas.Mes (YYYYMM integer) | Ventas.FechaCreacion |
| Wholesale | GCLinFacturas.Mes (YYYYMM integer) | GCFacturas.FechaFactura or GCAlbaranes.FechaEnvio |

---

## 9. Common Pitfalls

### 1. Mixing Channels in Revenue

**Wrong**: Summing Ventas.Total and GCFacturas.TotalFactura without noting they have different VAT treatment.
- Ventas.Total **includes VAT**
- GCFacturas.TotalFactura **may or may not include VAT** depending on LlevaIva

**Correct**: Use TotalSI (without VAT) for both channels when comparing, or explicitly handle VAT.

### 2. Double-Counting M-Prefix Products

M-prefix products may appear in both LineasVentas (if sold retail) and GCLinAlbarane (if sold wholesale). If you sum across both tables without deduplication, you will double-count.

### 3. Ignoring Credit Notes

Both channels have credit notes:
- Retail: `LineasVentas.Entrada = False` (returns)
- Wholesale: `GCAlbaranes.Abono = True` or `GCFacturas.Abono = True`

Always filter these out (or subtract them) for net revenue.

### 4. Customer Count

Some customers exist in Clientes but have never transacted. Always join to transaction tables for "active customer" counts:

```sql
-- Active retail customers (with purchases)
SELECT COUNT(DISTINCT NumCliente)
FROM Ventas
WHERE NumCliente > 0
  AND FechaCreacion >= '2025-01-01'
  AND Entrada = TRUE

-- Active wholesale customers
SELECT COUNT(DISTINCT NumCliente)
FROM GCAlbaranes
WHERE FechaEnvio >= '2025-01-01'
  AND Abono = FALSE
```

### 5. Store 99 in Reports

Store 99 is the central warehouse. It should typically be **excluded** from retail store performance reports:

```sql
-- Retail store performance (exclude central)
SELECT lv.Tienda, SUM(lv.Total) AS revenue
FROM LineasVentas lv
WHERE lv.Tienda <> '99'
  AND lv.Mes BETWEEN 202501 AND 202512
  AND lv.Entrada = TRUE
GROUP BY lv.Tienda
ORDER BY revenue DESC
```

### 6. Wholesale Delivery Notes vs Invoices

Revenue can be measured at two points:
- **Delivery note** (GCAlbaranes.FechaEnvio) -- when goods ship
- **Invoice** (GCFacturas.FechaFactura) -- when billed

These may differ by days or weeks. Choose one consistently:
- Use **delivery notes** for operational/logistics metrics
- Use **invoices** for financial/accounting metrics

### 7. Payment Timing

Retail payments are immediate (PagosVentas at time of sale).
Wholesale payments are deferred (CobrosFacturas weeks/months later).

For cash flow analysis, use payment dates, not sale/invoice dates.

---

## Summary Decision Tree

```
Q: What channel is this data from?
|
+-- Table starts with "GC"? -> Wholesale
|   (GCAlbaranes, GCLinAlbarane, GCFacturas, GCLinFacturas)
|
+-- Table is Ventas/LineasVentas/PagosVentas? -> Retail (POS)
|
+-- Table is Articulos/CCStock/Exportaciones? -> Both channels
|   (Filter by Codigo LIKE/NOT LIKE 'M%' if needed)
|
+-- Table is Clientes? -> Both channels
|   (Filter by Mayorista = True/False)
|
+-- Table is CobrosFacturas? -> Wholesale payments
|
+-- Table is Traspasos? -> Stock operations (supports both)
```
