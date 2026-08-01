# PowerShop Data Dictionary

> Field-level descriptions for key tables in the PowerShop 4D database.
> Covers naming conventions, primary keys, foreign key patterns, VAT handling,
> and the wholesale/retail split.

## Table of Contents

1. [Naming Conventions](#naming-conventions)
2. [Primary Key Pattern (.99 Suffix)](#primary-key-pattern)
3. [Articulos -- Product Master](#articulos)
4. [Ventas -- POS Ticket Headers](#ventas)
5. [LineasVentas -- POS Ticket Lines](#lineasventas)
6. [PagosVentas -- POS Payments](#pagosventas)
7. [Clientes -- Customer Master](#clientes)
8. [Tiendas -- Store Master](#tiendas)
9. [GCAlbaranes -- Wholesale Delivery Notes](#gcalbaranes)
10. [GCLinAlbarane -- Wholesale Delivery Note Lines](#gclinalbarane)
11. [GCFacturas -- Wholesale Invoices](#gcfacturas)
12. [Traspasos -- Stock Transfers](#traspasos)
13. [CCStock -- Central Warehouse Stock](#ccstock)
14. [Exportaciones -- Retail Store Stock](#exportaciones)
15. [FamiGrupMarc -- Family/Group Classification](#famigrupmarc)
16. [FormasPago -- Payment Methods](#formaspago)
17. [Proveedores -- Supplier Master](#proveedores)

---

## Naming Conventions

### Language

All table and column names are in **Spanish**. Common terms:

| Spanish | English | Context |
|---------|---------|---------|
| Ventas | Sales | POS transactions |
| Lineas | Lines | Line items |
| Pagos | Payments | Payment records |
| Compras | Purchases | Purchase orders |
| Albaranes | Delivery notes | Goods receipt/dispatch |
| Facturas | Invoices | Tax invoices |
| Traspasos | Transfers | Stock movements |
| Tienda | Store | Retail location |
| Cajero | Cashier | POS operator |
| Proveedor | Supplier | Vendor |
| Articulo | Article | Product |
| Unidades | Units | Quantity |
| Importe | Amount | Monetary value |
| Fecha | Date | Date field |
| Hora | Time | Time field |
| Codigo | Code | Identifier |
| Descripcion | Description | Text description |
| Abono | Credit note | Return/refund document |
| Entregadas | Delivered | Shipped quantity |
| Recibidas | Received | Received quantity |
| Cobros | Collections | Payment receipts |

### Common Prefixes

| Prefix | Meaning | Example |
|--------|---------|---------|
| Num | Numeric FK reference | NumCliente -> Clientes.RegCliente |
| Reg | Record PK | RegVentas, RegArticulo |
| N | Number/sequence | NDocumento, NFactura |
| P | Percentage | PIva (VAT %), PDescCom (discount %) |
| I | Amount (Importe) | IIva1 (VAT amount), IIRPF |
| Total | Sum/total | TotalSI, TotalBruto |
| Fecha | Date | FechaCreacion, FechaModifica |
| Hora | Time | HoraModifica |
| Clave | Code/key | ClaveMarca, ClaveTemporada |
| Libre | Free/custom field | Libre01..Libre16 |
| CC | Central/Core module | CCStock, CCRefeJOFACM |
| GC | Gestion Comercial | GCAlbaranes, GCFacturas |
| JO | Jewelry module | JOPrecioGramo, JOMetal |
| OP | Optical module | OPTipoArticulo |
| FA | Fabrication module | FAFabricacion |
| RRHH | Human Resources | RRHHEmpleados |
| SAFT | Portuguese tax audit | SAFTHash, SAFTFecha |
| TBAI | Basque Country tax | TBAI_Firmado |
| IMP | Import module | IMPIncoterm |
| CON | Accounting code | CONBanco, CONVentas |
| Web | eCommerce | WebClasifica1TO |
| PS | PowerShop | PSCPreferencias |

### Common Suffixes

| Suffix | Meaning | Example |
|--------|---------|---------|
| SI | Sin Impuestos (without tax) | TotalSI, PrecioNetoSI |
| CI | Con Importacion (with import) | PrCosteNeCI, TotalCosteCI |
| Bruto | Gross (before discounts) | TotalBruto, PrecioBruto |
| Neto | Net (after discounts) | PrecioNeto, TotalNeto |
| E | Envio/Shipping | DireccionE, PoblacionE |
| EF | Fiscal | DireccionEF |
| R | Alternative/secondary | DireccionR, ProvinciaR |
| Ent | Entered/Entry | ImporteEnt |
| Cob | Cobrado/Collected | ImporteCob |

---

## Primary Key Pattern

PowerShop uses **Real (float)** fields as primary keys with a special `.99` suffix convention:

- `Articulos.RegArticulo` = `534.99` -- the `.99` encodes store affiliation
- `Ventas.RegVentas` = `12345.155` -- the `.155` encodes store code
- `Clientes.RegCliente` = `678.99` -- `.99` = central record

This encoding allows implicit store-level filtering without a separate store column in some queries. Foreign keys reference these same float values:

```
LineasVentas.NumVentas -> Ventas.RegVentas
LineasVentas.NumArticulo -> Articulos.RegArticulo
Ventas.NumCliente -> Clientes.RegCliente
GCAlbaranes.NumCliente -> Clientes.RegCliente
```

**Important**: Do not perform arithmetic on PK values. They should be treated as opaque identifiers that happen to be stored as floats.

---

## Articulos

**Product Master** -- ~41,220 rows, 372 columns

### Key Fields

| Field | Type | Description | Notes |
|-------|------|-------------|-------|
| RegArticulo | Real | Primary key | `.99` suffix convention |
| Codigo | Alpha(60) | Product code | Unique business identifier. Example: `'12345'` |
| CCRefeJOFACM | Alpha(100) | Manufacturer reference | Example: `'I25123456'` |
| Descripcion | Alpha(160) | Product description | Spanish text |
| CodigoBarra | Alpha(80) | Primary barcode (EAN-13) | May be blank |
| SKU | Alpha(240) | Stock Keeping Unit | May differ from Codigo |

### Pricing Fields

| Field | Type | Description | Notes |
|-------|------|-------------|-------|
| Precio1 | Real | Primary retail price (PVP) | **With VAT** |
| Precio2..Precio4 | Real | Alternative price levels | For multi-tariff stores |
| PrecioCoste | Real | Cost price | Base cost |
| PrCosteNe | Real | Net cost price | After supplier discounts |
| PrCosteNeCI | Real | Net cost with import | Includes freight, tariffs |
| CosteEuros | Real | Cost in euros | For non-euro purchases |
| PVPEuros | Real | PVP in euros | Retail price in EUR |
| PIva | Real | VAT percentage | e.g., 23.0 for 23% |
| PrecioPromocion | Real | Promotional price | When promotion active |
| Precio1Neto | Real | Net price level 1 | PVP / (1 + PIva/100) |

### Classification

| Field | Type | Lookup Table | Description |
|-------|------|-------------|-------------|
| NumFamilia | Real | FamiGrupMarc | Family/Group (primary hierarchy) |
| NumDepartament | Real | DepaSeccFabr | Department/Section |
| NumMarca | Real | CCOPMarcTrat | Brand |
| NumColor | Real | CCOPColores | Color |
| NumTemporada | Real | CCOPTempTipo | Season |
| NumProveedor | Real | Proveedores | Supplier |
| NumSubfamilia | Real | SubfamModelo | Subfamily/Model |

### Stock

| Field | Type | Description |
|-------|------|-------------|
| Stock | Real | Total stock across all stores (aggregate) |
| StockInicial | Real | Initial stock at start of period |
| StockMinimo | Real | Reorder threshold |
| StockMaximo | Real | Maximum stock level |

**Note**: Articulos.Stock is a denormalized aggregate. For per-store stock, use CCStock (store 99/central) and Exportaciones (retail stores).

---

## Ventas

**POS Ticket Headers** -- ~910,726 rows, 145 columns

### Total vs TotalSI

| Field | Description |
|-------|-------------|
| Total | Total **with VAT** -- the receipt total the customer pays |
| TotalSI | Total **sin impuestos** (without tax) -- the net revenue |
| TotalBruto | Gross total before discounts |

For revenue analysis, use **Total** for consumer-facing totals and **TotalSI** for net revenue.

### Entry vs Return

| Field | Value | Meaning |
|-------|-------|---------|
| Entrada | True | Sale (money in) |
| Entrada | False | Return/refund (money out) |

Returns have `Entrada = False` and negative `Total`.

### Document Types

| TipoDocumento | Meaning |
|---------------|---------|
| V | Venta (Sale) |
| D | Devolucion (Return) |
| A | Abono (Credit note) |

### Key Relationships

```
Ventas.RegVentas -> LineasVentas.NumVentas (1:N)
Ventas.RegVentas -> PagosVentas.NumVentas (1:N)
Ventas.NumCliente -> Clientes.RegCliente
```

---

## LineasVentas

**POS Ticket Lines** -- ~1,687,995 rows, 154 columns

### Period Fields

| Field | Type | Format | Example |
|-------|------|--------|---------|
| Mes | Long Integer | YYYYMM | `202501` |
| NMes | Integer | M | `1` (January) |
| NDia | Integer | D | `15` |
| NSemana | Integer | W | `3` |
| DiaSemana | Long Integer | DOW | `2` (Monday=1?) |
| FechaCreacion | Date | YYYY-MM-DD | `2025-01-15` |

**Tip**: Use `Mes` for fast period filtering instead of date functions on FechaCreacion.

### Price Breakdown

| Field | Description |
|-------|-------------|
| PrecioBruto | Gross unit price (before discounts) |
| PrecioNeto | Net unit price (after discounts, with VAT) |
| PrecioNetoSI | Net unit price without VAT |
| PrecioBrutoSI | Gross unit price without VAT |
| PrecioOriginal | Original list price |
| PVPTarifa | Price list PVP |
| PrecioCosteSI | Unit cost without VAT |
| PrecioCosteCI | Unit cost with import costs |
| ImporteDescuento | Discount amount per line |
| ImporteRebajas | Markdown amount per line |

### Line Totals

| Field | Description |
|-------|-------------|
| Total | Line total with VAT: `Unidades * PrecioNeto` |
| TotalSI | Line total without VAT |
| TotalBruto | Gross line total |
| TotalOriginal | Original total before discounts |
| TotalCosteSI | Total cost without VAT |
| TotalCosteCI | Total cost with import costs |

### Margin Calculation

```
Gross Margin = Total - TotalCosteSI (approximate, if TotalSI used for net)
Margin % = (TotalSI - TotalCosteSI) / TotalSI * 100
```

---

## PagosVentas

**POS Payments** -- ~964,039 rows, 49 columns

### ImporteEnt vs ImporteCob

This is one of the most important distinctions in the payment model:

| Field | Description | Use |
|-------|-------------|-----|
| ImporteEnt | Amount **entered/tendered** | What the customer hands over |
| ImporteCob | Amount **collected/received** | Actual revenue recognized |

**Example**: Customer pays with a 50 EUR note for a 35 EUR purchase:
- `ImporteEnt = 50.00` (cash tendered)
- `ImporteCob = 35.00` (revenue collected)
- Change = `ImporteEnt - ImporteCob = 15.00`

**For revenue analysis, always use ImporteCob**, not ImporteEnt.

### Payment Method Fields

| Field | Description |
|-------|-------------|
| CodigoForma | Payment method code (FK -> FormasPago.Forma) |
| Forma | Payment method name (denormalized) |
| CodigoTarjeta | Card type code (FK -> Tarjetas) |

### Split Payments

A single sale (Ventas row) can have multiple PagosVentas rows for split payments:
- Row 1: `Forma='METALICO'`, `ImporteCob=20.00`
- Row 2: `Forma='VISA'`, `ImporteCob=15.00`

Sum of ImporteCob across all PagosVentas for a sale = Ventas.Total.

---

## Clientes

**Customer Master** -- ~27,545 rows, 308 columns

### Wholesale vs Retail

| Field | Value | Meaning |
|-------|-------|---------|
| Mayorista | True | Wholesale customer (B2B) |
| Mayorista | False | Retail customer (B2C) |

Wholesale customers (Mayorista=True) appear in GCAlbaranes/GCFacturas via NumCliente.
Retail customers appear in Ventas/LineasVentas via NumCliente.

### Address Fields

Three address sets:
1. **Billing**: Direccion, Poblacion, Provincia, Postal, Pais
2. **Shipping** (suffix E): DireccionE, PoblacionE, ProvinciaE, PostalE, PaisE
3. **Fiscal** (suffix EF): DireccionEF, PoblacionEF, PostalEF, PaisEF

### Credit Control

| Field | Description |
|-------|-------------|
| RiesgoConcedid | Credit limit (Long Integer) |
| BloqueoFinancials | Financial block -- prevents new orders |
| Retenido | On hold |
| FechaRetenido | Date put on hold |
| AcumuladoVentas | Accumulated purchase total |

### Loyalty

| Field | Description |
|-------|-------------|
| TarjetaPuntos | Has loyalty card (Boolean) |
| ImpTarjetaPuntos | Current points balance |
| ClubSocios | Is club member |
| FechaFideliza | Loyalty enrollment date |

---

## Tiendas

**Store Master** -- ~51 rows, 207 columns

### Key Store Concepts

- **Store 99** = Central warehouse (AlmacenCD=True). Stock lives in CCStock.
- **Other codes** = Retail stores. Stock lives in Exportaciones.
- Stores operate in Portugal and Spain with different VAT rates.

### Important Fields

| Field | Description |
|-------|-------------|
| Codigo | Store code (e.g., `'99'`, `'104'`, `'121'`) |
| AlmacenCD | True = central warehouse |
| Outlet | True = outlet store |
| Anulada | True = closed |
| Extranjero | True = foreign (non-domestic) |
| PIva | Default VAT rate for this store |
| PIva2, PIva3 | Additional VAT rates |
| GrupoStock | Stock group for replenishment |
| GrupoPromocion | Promotion group |
| Franquiciado | Franchise ID (0 = own store) |

---

## GCAlbaranes

**Wholesale Delivery Notes** -- ~48,882 rows, 161 columns

### Abono (Credit Notes / Returns)

| Field | Value | Meaning |
|-------|-------|---------|
| Abono | True | This is a return/credit note |
| Abono | False | Normal delivery |

When `Abono = True`:
- Quantities are positive but represent returned goods
- Stock is **added back** to the warehouse
- Used for wholesale returns processing

### Key Amounts

| Field | Description |
|-------|-------------|
| TotalAlbaran | Total delivery note amount |
| ImporteBruto | Gross amount before discounts |
| Base1..Base3 | Tax bases per rate |
| IIva1..IIva3 | VAT amounts per rate |
| Portes | Shipping/freight cost |

---

## GCLinAlbarane

**Wholesale Delivery Note Lines** -- ~1,014,995 rows, 138 columns

### Size-Level Quantities

This table uses a wide format with up to 34 size slots:

| Fields | Description |
|--------|-------------|
| Talla1..Talla34 | Size labels (e.g., 'S', 'M', 'L', '38', '39') |
| Entregadas1..Entregadas34 | Quantities delivered per size |
| Unidades | Total units (sum of Entregadas1..34) |

### Pricing

| Field | Description |
|-------|-------------|
| PrecioBruto | Gross unit price |
| PrecioNeto | Net unit price (after discounts) |
| Desc1 | Discount 1 percentage |
| Desc2Peso | Discount 2 / weight-based |
| Total | Line total |
| PIva | VAT percentage |

---

## GCFacturas

**Wholesale Invoices** -- ~18,060 rows, 183 columns

Invoices generated from delivery notes (GCAlbaranes). One invoice can cover multiple delivery notes.

### Key Fields

| Field | Description |
|-------|-------------|
| NFactura | Invoice number |
| SerieFVM | Invoice series (allows multiple numbering sequences) |
| TotalFactura | Total invoice amount |
| CobrosGenerado | True = payment schedule created in CobrosFacturas |
| FacturaAnulada | True = invoice cancelled |
| Vencimientos | Due dates as text (e.g., "30/60/90 dias") |
| FormaPago | Payment terms |

---

## Traspasos

**Stock Transfers** -- ~262,689 rows, 29 columns

### Dual-Entry Pattern

Each physical transfer creates **two rows**:
1. **Exit**: `Entrada=False`, `TiendaSalida` filled, `UnidadesS` has quantity
2. **Entry**: `Entrada=True`, `TiendaEntrada` filled, `UnidadesE` has quantity

Both share the same `Documento` number.

### Transfer Types (Tipo)

| Tipo | Description |
|------|-------------|
| Traspaso | Normal inter-store transfer |
| Regularizacion | Stock adjustment/correction |
| S-Robo | Theft adjustment |
| Devolucion | Return to supplier |

---

## CCStock

**Central Warehouse Stock** -- ~41,222 rows, 582 columns

### Structure

One row per product. Represents stock at the central warehouse (store 99).

The table is extremely wide (582 columns) because it stores per-size data in a flat structure:

| Pattern | Count | Description |
|---------|-------|-------------|
| Stock1..Stock34 | 34 | Current stock per size |
| Talla1..Talla34 | 34 | Size labels |
| Compra1..Compra34 | 34 | Purchase prices per size |
| Minimo1..Minimo34 | 34 | Minimum stock levels |
| Anulada1..Anulada34 | 34 | Size cancelled flags |
| PVP11..PVP734 | 238 | PVP per tariff (7) per size (34) |
| Rebaja11..Rebaja234 | 68 | Markdown per level (2) per size (34) |
| Ubicacion11..Ubicacion334 | 102 | Location per zone (3) per size (34) |

### Key Fields

| Field | Description |
|-------|-------------|
| NumArticulo | FK -> Articulos.RegArticulo |
| Stock | Total stock (aggregate of Stock1..Stock34) |

---

## Exportaciones

**Retail Store Stock** -- ~2,056,001 rows, 161 columns

### Relationship to CCStock

| Table | Store | Description |
|-------|-------|-------------|
| CCStock | 99 (central) | One row per product |
| Exportaciones | All others | One row per product per store |

**Store 99 never appears in Exportaciones.** To get total stock for a product:
```
Total Stock = CCStock.Stock (central) + SUM(Exportaciones.STStock) per store
```

### Key Fields

| Field | Description |
|-------|-------------|
| Codigo | Product code |
| Tienda | Store code |
| TiendaCodigo | Composite key: `Tienda + Codigo` |
| CCStock | FK to CCStock record |
| STStock | Aggregate stock for this product at this store |
| Stock1..Stock34 | Per-size stock |

---

## FamiGrupMarc

**Family/Group Classification** -- ~77 rows, 112 columns

Primary product hierarchy. Despite the name combining "Family", "Group", and "Brand", this table represents the **family** level.

| Field | Description |
|-------|-------------|
| RegFamilia | PK |
| Clave | Short code (e.g., `'10'`, `'20'`) |
| FamiGrupMarc | Family name |
| SerieTallas | Size series reference |
| Coeficiente1..4 | Markup coefficients |
| CuentaVentas | Accounting sales account |
| Presupuesto | Budget amount |
| Anulado | Disabled |
| SerieEmpresa | Company series |

### Promotions on Family Level

| Field | Description |
|-------|-------------|
| PorcenPromocion | Promotion discount % |
| PrecioPromocion | Promotion price |
| PromoDesde | Promotion start date |
| PromoHasta | Promotion end date |

---

## FormasPago

**Payment Methods** -- ~24 rows, 29 columns

| Field | Description |
|-------|-------------|
| Forma | Short code (e.g., `'01'`, `'02'`) |
| FormaPago | Full name (e.g., `'Metalico'`, `'Visa'`) |
| Activo | Active flag |
| Compra | Available for purchases |
| Venta | Available for sales |
| NuestroBanco | Payment to our bank |
| SuBanco | Payment from their bank |
| Remesable | Can be batch-processed |
| GCSinImpuestos | Wholesale: without taxes |
| VP1..VP12 | Payment term percentages (12 installments) |
| DiaA, DiaC | Payment day settings |

---

## Proveedores

**Supplier Master** -- ~518 rows, 114 columns

| Field | Description |
|-------|-------------|
| RegProveedor | PK |
| Codigo | Supplier code (Real) |
| Proveedor | Supplier name |
| NombreComercial | Trade name |
| CIF | Tax ID |
| Fabricante | True = is manufacturer (vs. distributor) |
| PDescCom | Commercial discount % |
| PDescPP | Prompt payment discount % |
| FormaPago | Default payment terms |
| Traspaso | Uses transfer system |
| TiempoEntrega | Delivery lead time (days) |
| LlevaIva | Subject to VAT |
| LlevaRE | Subject to surcharge (recargo de equivalencia) |

---

## VAT (IVA) Handling

### Total vs TotalSI Pattern

Throughout the database, amounts come in pairs:

| Field | Meaning |
|-------|---------|
| Total | Amount **with VAT** (Impuestos Incluidos) |
| TotalSI | Amount **Sin Impuestos** (without VAT) |

### VAT Rate Fields

| Field | Description |
|-------|-------------|
| PIva | VAT percentage on the line/document |
| PIva1, PIva2, PIva3 | Multiple VAT rates on a document |
| IIva1, IIva2, IIva3 | VAT amounts per rate |
| Base1, Base2, Base3 | Tax base per rate |
| BaseE | Exempt base |

### Surcharge (Recargo de Equivalencia)

Spanish retailers under the surcharge system have additional fields:

| Field | Description |
|-------|-------------|
| LlevaRE | Boolean -- subject to surcharge |
| PRE, PRE1..PRE3 | Surcharge percentages |
| IRE1..IRE3 | Surcharge amounts |

---

## Libre (Custom) Fields

Most major tables include `Libre01` through `Libre16` fields of various types. These are **customer-configurable** fields that PowerShop allows businesses to customize for their needs. Their meaning varies by installation and cannot be determined from the schema alone.

| Typical Types | Example |
|--------------|---------|
| Libre01..Libre03 | Boolean |
| Libre04..Libre06 | Alpha/Text |
| Libre07..Libre09 | Real/Integer |
| Libre10..Libre12 | Date |
| Libre13..Libre15 | Various |

Do not assume meaning for Libre fields without verifying with the business.
