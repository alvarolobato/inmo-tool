# PowerShop 4D SQL Views Reference

> Discovered 2026-04-05 by querying `_USER_VIEWS` on the live 4D server.
> Views are accessible via the 4D SQL port (19812) using the p4d driver.
> All view names can be used directly in SQL: `SELECT * FROM Ventas_SQL LIMIT 100`

## Overview

The 4D database defines **100 SQL views** — 50 `*_SQL` views (queryable subsets of raw tables)
and 50 `*_BI` views (Business Intelligence variants, same data different column ordering/selection).

These views represent the **vendor's intended query patterns** and are the best guide to which
fields are relevant for analytics.

> **Note:** `CCStock_SQL` causes a driver error ("Unrecognized 4D type: 0") — skip it and use
> the underlying `CCStock` table columns that are type-safe.

---

## Complete View List

### `*_SQL` Views (Analytics-Recommended)

> Column counts validated 2026-04-05 by querying `SELECT * FROM <view> LIMIT 1` on live server.
> Views marked **CRASH** cause the p4d driver to abort (contain Picture/Blob type fields).

| View | Columns | Domain | Notes |
|------|---------|--------|-------|
| `Ventas_SQL` | **145** | Sales | Full POS ticket headers — TBAI, marketplace, tax-free, Aena fields |
| `LineasVentas_SQL` | **157** | Sales | POS line items with cost prices |
| `PagosVentas_SQL` | **49** | Sales | Payment records — PSCARD1-10 card slots |
| `Cajas_SQL` | CRASH | Sales | Cash register sessions — contains Blob type fields |
| `Clientes_SQL` | CRASH | Customers | Full customer master — contains Blob type fields |
| `Exportaciones_SQL` | **161** | Stock | Retail store stock — 34-slot matrix (Stock1-34, Talla1-34, Minimo1-34) |
| `Articulos_SQL` | CRASH | Products | Full product catalog — contains Picture/Blob fields |
| `Albaranes_SQL` | **68** | Purchasing | Delivery notes received from suppliers |
| `LinAlbaranes_SQL` | **108** | Purchasing | Delivery note lines |
| `Compras_SQL` | **129** | Purchasing | Purchase orders |
| `LineasCompras_SQL` | **56** | Purchasing | Purchase order lines |
| `GCAlbaranes_SQL` | **162** | Wholesale | Wholesale delivery notes — tracking, SAFT, maritime expedition fields |
| `GCLinAlbarane_SQL` | **138** | Wholesale | Wholesale delivery lines — 34 Talla/Entregadas slots |
| `GCPedidos_SQL` | **123** | Wholesale | Wholesale orders |
| `GCLinPedidos_SQL` | **239** | Wholesale | Wholesale order lines — 34-slot × 5 qty dimensions (widest view) |
| `GCFacturas_SQL` | **183** | Wholesale | Wholesale invoices |
| `GCLinFacturas_SQL` | **63** | Wholesale | Wholesale invoice lines — COSTEUNITARIO, TOTALCOSTE |
| `GCComerciales_SQL` | **49** | Wholesale | Sales representatives |
| `GCTransporte_SQL` | **3** | Wholesale | Wholesale transport/carriers (minimal) |
| `Tiendas_SQL` | **208** | Stores | Full store config — accounting codes, Aena, groupings |
| `Proveedores_SQL` | **114** | Purchasing | Supplier master |
| `FamiGrupMarc_SQL` | **112** | Lookups | Product families — SERIETALLAS field (blank in production) |
| `CCLineasCompr_SQL` | **234** | Stock | Central warehouse purchase reception lines (very wide) |
| `CCMedTarReg_SQL` | **10** | Customers | Loyalty card registration |
| `CCOPColores_SQL` | **35** | Lookups | Color master |
| `CCOPMarcTrat_SQL` | **63** | Lookups | Brand/treatment master |
| `CCOPTempTipo_SQL` | **75** | Lookups | Season type master |
| `CCSexos_SQL` | **56** | Lookups | Gender classification |
| `CCStock_SQL` | ERROR | Stock | Causes p4d error "Unrecognized 4D type" — skip entirely |
| `Traspasos_SQL` | **29** | Logistics | Stock transfers — one row per article/size/store pair |
| `Paises_SQL` | **10** | Lookups | Country master |
| `Provincias_SQL` | **3** | Lookups | Province master (minimal) |
| `RRHHEmpleados_SQL` | **104** | HR | Employee master |
| `RRHHControlPresencia_SQL` | **30** | HR | Time & attendance |
| `RRHHBajas_SQL` | **20** | HR | Sick leave |
| `RRHHAusencias_SQL` | **15** | HR | Absences |
| `ServicioSO_SQL` | **52** | Service | Service orders (after-sales / repairs) |
| `SubfamModelo_SQL` | **47** | Lookups | Subfamily/model master |
| `DepaSeccFabr_SQL` | **76** | Lookups | Department/section/fabrication master |
| `BalanceoStock_SQL` | **13** | Stock | Stock balancing operations |
| `BarrasAsociado_SQL` | **10** | Products | Associated barcodes |
| `AutoReposicion_SQL` | **10** | Stock | Auto-replenishment rules |
| `InformeReposicion_SQL` | **8** | Stock | Replenishment reports |
| `LineasInformeReposicion_SQL` | **47** | Stock | Replenishment report lines |
| `PackQueue_SQL` | **15** | Promotions | Pack promotion queue |
| `PackStreet_SQL` | **19** | Promotions | Street/in-store packs |
| `PackVisitors_SQL` | **15** | Promotions | Visitor packs |
| `ComentariosTickets_SQL` | **34** | Sales | Ticket comments |
| `CRMDetalleCue_SQL` | **17** | CRM | CRM survey details |
| `DetalleInventa_SQL` | **6** | Stock | Inventory count details |
| `Inventarios_SQL` | **14** | Stock | Inventory headers |
| `Facturas_SQL` | **116** | Finance | Retail invoices |

---

## Key View Structures

### `Ventas_SQL` — 150 columns

Complete POS sale header. Key column groups:

| Group | Columns | Purpose |
|-------|---------|---------|
| Identity | REGVENTAS, FECHACREACION, FECHAMODIFICA, HORA | Record ID and timestamps |
| Store/POS | TIENDA, CAJA, PUESTO, CODIGOCAJERO, CAJERONOMBRE, CODIGOEMPLEADO | Terminal and cashier |
| Customer | NUMCLIENTE, CLIENTE, CODIGOPOSTAL | Customer reference |
| Amounts | TOTAL, TOTALSI, TOTALBRUTO, METALICO, CREDITO, VALE, DESCUENTO, CAMBIO | Financial totals |
| Payment | FORMA, CODIGOFORMA, TARJETAFINANCIA, CODIGOTARJETA, APAGAR, PAGADO | Payment method |
| Loyalty | CARGAPUNTOS, DESCARGAPUNTOS, TARJETAPUNTOS | Points program |
| Document | TIPODOCUMENTO, NDOCUMENTO, SERIEV, FACTURADOVENTA | Document type and series |
| Status | ENTRADA, EXPORTADO, ENVIADOCENTRAL, ENVIADOSUBCENT, STOCKACTUALIZADO | Processing flags |
| Vouchers | VALE, DEVOLUCIONVALE, IMPVALECAMBIO, NUMVALECAMBIO, VALEREGALOIMP, VALEREGALOFEC, VALEREGALOTIE, TARJETAREGALOIMP, TARJETAREGALOID | Voucher/gift card |
| Delivery | ENVCLIENTE, ENVDIRECCION, ENVPOBLACION, ENVPROVINCIA, ENVPOSTAL, ENVTELEFONO, ENVNUMEROR, ENVPAIS | Home delivery address |
| Airport (Aena) | AENANACIONALIDAD, AENAORIGEN, AENADESTINO, AENAVUELO | Passenger data for duty-free |
| SAF-T | SAFTFECHA, SAFTHORA, SAFTHASHNCF, SAFTMOTIVOEXENTA, SAFTSERIECODVAL, NCFD | Portuguese/Spanish fiscal audit |
| TicketBAI | TBAI_HACIENDAID, TBAI_FIRMADO, TBAI_FIRMA13, TBAI_ERRORFIRMA, TBAI_ENVIADO, TBAI_ERRORENVIO, TBAI_ENVIAR12..TBAI_ANULADOERRORENVIO12 | Basque Country e-invoicing |
| E-commerce | PEDIDOWEB, MARKETPLACE, INTEGRADORMK, NUMPEDIDO, WAPPING_ID, WAPPING_PROMO, WAPPING_PUNTOSMAS, WAPPING_PUNTOSMENOS, IDORDERMARKET | Online channel fields |
| Tax-free | TAXFREEREFUND, TAXFREEID | Tourist tax refund |
| External invoice | FACTEXTNDOC, FACTEXTFECHA, FACTEXTSERIE | External invoice reference |
| Free fields | LIBRE03, LIBRE06..LIBRE15 | Custom/future use |

### `Exportaciones_SQL` — 161 columns (34-slot stock matrix)

One row per (article × store) pair. The 34 size slots are the key analytics structure:

| Columns | Count | Purpose |
|---------|-------|---------|
| STOCK1..STOCK34 | 34 | Current stock per size |
| TALLA1..TALLA34 | 34 | Size label per slot |
| MINIMO1..MINIMO34 | 34 | Minimum stock per size |
| REPPORCENTAJE1..REPPORCENTAJE34 | 34 | Replenishment percentage per size |
| STSTOCK | 1 | Pre-aggregated total stock |
| CCSTOCK | 1 | Central warehouse stock (store 99) |
| TIENDA, TIENDACODIGO, CODIGO | 3 | Article-store key |
| FECHAMODIFICA, HORAMODIFICA | 2 | Delta sync fields |
| UBICACION1, UBICACION2, UBICACION3 | 3 | Warehouse location codes |
| REPPRIORIDADWEB, PUNTOPEDIDO, RECOMENDADO, UNIDADESREPOSI | 4 | Replenishment config |
| BORRAR5, BORRAR6, BORRAR7, BORRAR8, BORRAR9, BORRAR10, BORRAR12 | 7 | Deprecated/unused columns |
| ALBARANESENVIADOS, BLOQUEADO, CCSTOCK, DESCRIPCION | 4 | Status and metadata |

> **Note:** ETL currently uses slots 1-17. The view confirms slots 1-34 exist. Some articles
> may use only 17 slots (standard clothing sizes), others use 34 (footwear, optics, etc.).
> The number of populated slots per article depends on the `FamiGrupMarc.SerieTallas` field.

### `GCLinPedidos_SQL` — 239 columns (5-dimension, 34-slot matrix)

The widest analytics-relevant view. For each order line × size slot:

| Column Group | Slots | Purpose |
|-------------|-------|---------|
| TALLA1..TALLA34 | 34 | Size labels |
| PEDIDAS1..PEDIDAS34 | 34 | Quantities ordered |
| ENTREGADAS1..ENTREGADAS34 | 34 | Quantities delivered |
| ASIGNADAS1..ASIGNADAS34 | 34 | Quantities allocated in warehouse |
| ORIGINAL1..ORIGINAL34 | 34 | Original ordered qty (before edits) |
| ENTREGADAS (total) | 1 | Total delivered all sizes |
| PENDIENTES | 1 | Total pending |
| ASIGNADAS (total) | 1 | Total allocated |

Plus: NPEDIDO, NLINEA, CODIGO, NUMARTICULO, PRECIOBRUTO, PRECIONETO, TOTAL, TOTALNETO, PIVA, 
TIPOPEDIDO, PLAZOENTREGA, FECSERVICIOMIN, FECSERVICIOMAX, B2CANULADA (B2C cancellation), 
PSCREGALADO (gifted), PSCTIENDAASI/CON (store assignment/confirmation for B2C)

### `Tiendas_SQL` — 208 columns

Key column groups:

| Group | Prefix/Pattern | Purpose |
|-------|----------------|---------|
| Identification | CODIGO, REGTIENDA, CODIGOC, CODIGOE, IDSERIE | Store codes |
| External IDs | IDENTIFICADORTIENDA, IDENTIFICADORTIENDA1/2/3, A3CODIGOTIENDA, IDSENDCLOUD | Integration IDs |
| Accounting | CONVENTAS, CONIVA1-3, CONCAJA, CONCLIENTES, CONBANCO, CONGASTOS, CONINGRESOS, CONGCOD1-6, CONGCUE1-6 | Chart of accounts per store |
| Aena airport | AENA_AEROPUERTO, AENA_CONTRATO, AENA_LOCAL, AENA_TPV0/1/2, AENA_RENTA_* | Airport concession data |
| Stock groups | GRUPOSTOCK, VERGRUPOSTOCK/2/3, GRUPOBALANCEO/2/3 | Stock management grouping |
| Promo groups | GRUPOPROMOCION/2/3, GRUPOCUESTIONARIO/2/3 | Promotion and survey groups |
| B2C/online | GRUPOSTOCKB2C/2, ANULADOSTOMNICANAL, B2CNOREPONERDOMINGOS, SOSIRVEDESDECENTRAL | Omnichannel config |
| Physical | SUPERFICIE (m²), PRECIOM2, HORAAPERTURA, HORACAJA, PAIS, COMUNIDADAUTONOMA | Physical store data |
| Flags | OUTLET, TRANSITO, FRANQUICIADO, EXTRANJERO, ANULADA, NODISPONIBLE | Store type flags |
| Controls | CONTROLVFECHA, CONTROLVVENTAS, CONTROLVLINEAS, CONTROLVPAGOS (+*C variants) | Integrity reconciliation |
| Module access | APARTICULOS, APCOMPRAST/A, APCOMPRASTU/AU/TP/AP | Feature permissions |
| Tax rates | PIVA, PIVA2, PIVA3, APLICAREXCEPCIONIVA | VAT rate overrides per store |
| Replenishment | REPOSICION, WEBNOREPOMI, WEBNOREPOMA, AUTORECONSTOCK, ALMACENNOREPONE | Replenishment config |

---

## How to Query Views

```python
import p4d
conn = p4d.connect(host='10.0.1.35', port=19812, user='Administrador', password='')
cur = conn.cursor()

# Query a view with specific columns (recommended — avoids crash on Picture/Blob types)
cur.execute("""
    SELECT REGVENTAS, FECHACREACION, TIENDA, TOTALSI, NUMCLIENTE, MARKETPLACE
    FROM Ventas_SQL
    WHERE FECHACREACION >= '2025-01-01' AND ENTRADA = TRUE
    LIMIT 100
""")
rows = cur.fetchall()
```

**Important notes:**
- `CCStock_SQL` crashes the p4d driver — never query it. Use individual columns from `CCStock` directly.
- Very wide tables (Articulos_SQL, Exportaciones_SQL, Clientes_SQL) may crash if fetching ALL columns.
  Always specify the columns you need.
- `BORRAR*` columns in Exportaciones are legacy/deprecated — ignore them.
- `LIBRE*` columns are generic free-text fields with variable business use per installation.

---

## `*_BI` Views

The Business Intelligence views (`*_BI` suffix) are paired with each `*_SQL` view. They appear
to select the same data but optimized for BI tool consumption (different column ordering or subset).

Available BI views (same tables as SQL views):
Albaranes_BI, Articulos_BI, AutoReposicion_BI, BalanceoStock_BI, BarrasAsociado_BI,
Cajas_BI, CCLineasCompr_BI, CCMedTarReg_BI, CCOPColores_BI, CCOPMarcTrat_BI, CCOPTempTipo_BI,
CCSexos_BI, CCStock_BI, Clientes_BI, Compras_BI, CRMDetalleCue_BI, DepaSeccFabr_BI,
Exportaciones_BI, FamiGrupMarc_BI, GCAlbaranes_BI, GCComerciales_BI, GCFacturas_BI,
GCLinAlbarane_BI, GCLinFacturas_BI, GCLinPedidos_BI, GCPedidos_BI, GCTransporte_BI,
InformeReposicion_BI, LinAlbaranes_BI, LineasInformeReposicion_BI, LineasVentas_BI,
PackQueue_BI, PackStreet_BI, PackVisitors_BI, PagosVentas_BI, Paises_BI, Preferencias_BI,
Preferencias2_BI, Proveedores_BI, Provincias_BI, RRHHAusencias_BI, RRHHBajas_BI,
RRHHControlPresencia_BI, RRHHEmpleados_BI, ServicioSO_BI, SubfamModelo_BI, Tiendas_BI,
Traspasos_BI, Ventas_BI
