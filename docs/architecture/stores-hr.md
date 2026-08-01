# Stores, HR & Finance Domain

> Store configuration, employee management, payment methods, vouchers, and supporting tables.

## Entity Relationship Diagram

```mermaid
erDiagram
    Tiendas {
        float RegTienda PK "Store record ID"
        text Codigo "Store code (e.g., 153)"
        text CodigoC "Central code"
        text Direccion "Address"
        text Poblacion "City"
        text Provincia "Province"
        text Postal "Postal code"
        text Telefono "Phone"
        text Cajero "Default cashier"
        float UltimaActualizacion "Last sync timestamp"
        text TipoTienda "Store type"
        boolean Outlet "Is outlet store"
        boolean Transito "Is transit/logistics store"
        boolean Franquiciado "Is franchised"
        boolean Extranjero "Is foreign store"
        boolean Anulada "Is inactive"
        float Superficie "Store area in m²"
        float PrecioM2 "Rent per m²"
        text HoraApertura "Opening time"
        text Pais "Country"
        text ComunidadAutonoma "Autonomous community"
        text Responsable "Store manager"
        int NCajas "Number of cash registers"
        int NEmpleados "Number of employees"
        text GrupoStock "Stock group"
        text GrupoBalanceo "Stock balancing group"
        text GrupoPromocion "Promotion group"
        text GrupoCuestionario "Survey group"
        text GrupoStockB2C "B2C stock group"
        text IdentificadorTienda "External system ID 1"
        text IdentificadorTienda1 "External system ID 2"
        text IdentificadorTienda2 "External system ID 3"
        text IdentificadorTienda3 "External system ID 4"
        text A3CodigoTienda "A3 ERP store code"
        text A3CodigoEmpresa "A3 ERP company code"
        text CodigoE "External code"
        text IdSerie "Series ID"
        text IdSendcloud "Sendcloud logistics ID"
        text ConVentas "Sales account"
        text ConIva1 "VAT account 1"
        text ConCaja "Cash account"
        text ConClientes "Clients account"
        text ConBanco "Bank account"
        text ConGastos "Expenses account"
        text ConIngresos "Income account"
        text ConIva2 "VAT account 2"
        text ConIva3 "VAT account 3"
        text CongCod1 "GC account code 1"
        text CongCod6 "GC account code 6"
        text CongCue1 "GC account description 1"
        text CongCue6 "GC account description 6"
        text AENA_Aeropuerto "Airport code"
        text AENA_Contrato "Airport concession contract ref"
        text AENA_Local "Terminal/local identifier"
        text AENA_TPV0 "POS terminal ID 0"
        text AENA_TPV1 "POS terminal ID 1"
        text AENA_TPV2 "POS terminal ID 2"
        float AENA_Renta_Fija_Mes "Fixed monthly rent"
        float AENA_Renta_Var_MesCI "Variable monthly rent incl. VAT"
        float AENA_Renta_Var_MesSI "Variable monthly rent excl. VAT"
        float AENA_Renta_Min_Mes "Minimum monthly rent"
        float AENA_Renta_Min_Anual "Minimum annual rent"
        boolean AnuladosOmnicanal "Deactivated for omnichannel"
        boolean B2CNoReponerDomingos "No B2C replenishment on Sundays"
        boolean SoSirveDestdeCentral "Served from central warehouse"
        text WebPrioridad "Web display priority"
        float ControlVFecha "Reconciliation control date"
        float ControlVVentas "Reconciliation sales count"
        float ControlVLineas "Reconciliation line count"
        float ControlVPagos "Reconciliation payment count"
        date FechaModifica "Last modified date"
    }

    RRHHEmpleados {
        float RegEmpleado PK "Employee record ID"
        text CodigoEmpleado "Employee code"
        text Nombre "First name"
        text Apellidos "Last name"
        text DNI "National ID"
        text Tienda "Assigned store"
        text PuestoTrabajo "Job position"
        text Departamento "Department"
        text Categoria "Category"
        float Comision "Commission rate"
        boolean Operativo "Is active"
        date FechaAlta "Hire date"
        date FechaBaja "Termination date"
        text TipoContrato "Contract type"
        int HorasSemanales "Weekly hours"
        boolean PDFuturShop "FuturShop access"
        boolean PDAdministrador "Admin access"
    }

    FormasPago {
        text FormaPago "Payment method name"
        text Forma "Short form code"
        boolean Activo "Is active"
        boolean Compra "Used for purchases"
        boolean Venta "Used for sales"
        boolean Remesable "Can be remitted (bank remittance)"
        int DiaA "Payment day A"
        int DiaC "Payment day C (2nd term)"
        int GCDPP "Early payment days (wholesale)"
        boolean GCSinImpuestos "Wholesale: exclude taxes"
        text NuestroBanco "Our bank account"
        text SuBanco "Customer's bank account"
        int MesComienzo "Starting month for payment calendar"
        boolean VencimientoMes "Payments expire end-of-month"
        text VP1..VP12 "12 payment installment slots"
        text PTForma "Purchase terms code"
        text CodigoDatisa "Datisa ERP code"
        text Objeto "Object/type code"
        boolean WebAnticipado "Web: advance payment required"
    }

    CobrosFacturas {
        float RegCobroRefAde PK "Collection record ID"
        float NumFactura FK "-> GCFacturas.RegFactura"
        float NumCliente FK "-> Clientes.RegCliente"
        text Cliente "Customer name"
        float Importe "Amount"
        date Fecha "Collection date"
        boolean Pagado "Is paid"
        text Forma "Payment method"
        int Mes "YYYYMM period"
        text Tienda "Store"
        boolean Abono "Is credit"
        float NumComercial FK "-> GCComerciales"
        boolean DRDevuelto "Is returned/bounced"
        text DRMotivoDevol "Return reason"
    }

    Vales {
        float Numero PK "Voucher number"
        date Entrega "Issue date"
        date Recepcion "Redemption date"
        text CliEntrega "Issuing customer"
        text CliRecepcion "Redeeming customer"
        float Importe "Voucher value"
        text TiendaEnt "Issuing store"
        text TiendaRec "Redeeming store"
        boolean VentaBorrada "Sale voided"
        boolean AnuladoCentral "Voided by HQ"
    }

    TarjetasRegalo {
        text NTarjeta PK "Gift card number"
        text Tienda "Store"
        date Fecha "Issue date"
        text Responsable "Issuing person"
        float Importe "Card value"
        float Consumido "Amount spent"
        float Disponible "Remaining balance"
        boolean Anulada "Is cancelled"
    }

    Monedas {
        text Moneda "Currency name"
    }

    MonedasBilletes {
        text Denominacion "Bill/coin denomination"
    }

    TablaImpuestos {
        float Porcentaje "Tax percentage"
        text Descripcion "Tax description"
    }

    Paises {
        text Pais "Country name"
        text ISO "ISO code"
    }

    Provincias {
        text Provincia "Province name"
        text Codigo "Province code"
    }

    Listas {
        text Codigo "List code"
        text Descripcion "List description"
    }

    Contadores {
        text Tipo "Counter type"
        float Valor "Current value"
    }

    RRHHAcceso {
        float RegEmpleado FK "-> RRHHEmpleados"
        date Fecha "Access date"
        time Hora "Access time"
    }

    Tiendas ||--o{ RRHHEmpleados : "store assignment"
    Tiendas ||--o{ Vales : "TiendaEnt"
    Tiendas ||--o{ TarjetasRegalo : "Tienda"
    CobrosFacturas }o--|| GCFacturas : "NumFactura"
    RRHHEmpleados ||--o{ RRHHAcceso : "RegEmpleado"
```

## Table Descriptions

| Table | Rows | Columns | Description |
|-------|------|---------|-------------|
| **Tiendas** | 51 | 208 | Store master. Address, phone, responsible person, cash register count, franchise code, and extensive configuration (208 columns via Tiendas_SQL view). Includes accounting chart of accounts per store, airport concession financial data (AENA_*), store type flags, multiple grouping dimensions, and external system identifiers. Discovered 2026-04-05. |
| **RRHHEmpleados** | 15 | 104 | Employee master. Personal data, contract, position, permissions for each PowerShop module, and commission rates. |
| **FormasPago** | 24 | 30 | Payment method definitions (cash, card types, transfers, etc.). Lookup for POS and wholesale. |
| **CobrosFacturas** | 12,459 | 30 | Invoice payment collections. Tracks payments received against wholesale invoices, including bounced payments. |
| **Vales** | 54,414 | 11 | Vouchers/credit notes. Store credit issued and redeemed across stores. |
| **TarjetasRegalo** | 9 | 9 | Gift cards with balance tracking (loaded, spent, available). |
| **Monedas** | 3 | -- | Currency definitions (e.g., EUR, USD). |
| **MonedasBilletes** | 15 | -- | Bill/coin denominations for cash counting. |
| **TablaImpuestos** | 15 | -- | Tax rate table. |
| **Paises** | 11 | 10 | Country reference data. |
| **Provincias** | 70 | 3 | Province/region reference data. |
| **Listas** | 40 | 5 | Generic lookup lists (wish lists, reservations). |
| **Contadores** | 31 | -- | Auto-increment counters for document numbering. |
| **RRHHAcceso** | 937 | -- | Employee system access log. |

## Supporting Tables

| Table | Rows | Description |
|-------|------|-------------|
| Informes | 51,706 | Report definitions and cached results |
| Exportaciones | 2,055,751 | Export/sync log (largest table by rows) |
| Control | 3,256 | System control records |
| Controles | 1,284 | Additional control/audit records |
| Comunica | 2,716 | Inter-store communication messages |
| PNMensajes | 108 | Push notification messages |
| PSCComentarios | 39,924 | Product/service comments (PSCommerce) |
| Bloqueos | 172 | Record lock tracking |
| SaftAnulados | 1,071 | SAFT voided document records |
| DetalleSaftAnula | 45,542 | SAFT void details |
| CambiosSeries | 9 | Document series changes |
| IvaXPais | 2 | VAT rates by country |
| Acceso | 1 | System access configuration |
| AUXIndexList | 1,783 | Index management auxiliary table |

## Empty / Unused Tables -- HR Module

| Table | Description |
|-------|-------------|
| RRHHAusencias | Employee absences |
| RRHHBajas | Employee terminations |
| RRHHBeneficios | Employee benefits |
| RRHHComisiones | Commission calculations |
| RRHHComportamiento | Behavior/performance records |
| RRHHConocimientos | Skills/knowledge |
| RRHHContratos | Contract documents |
| RRHHControlPresencia | Attendance tracking |
| RRHHExperiencia | Work experience |
| RRHHFamiliares | Family members |
| RRHHHistorial | Employment history |
| RRHHHorasExtras | Overtime tracking |
| RRHHHuellas | Fingerprint data |
| RRHHSalarios | Salary records |
| RRHHTitulaciones | Qualifications |
| RRHHTurnos | Work shift definitions |
| RRHHVacaciones | Vacation tracking |

## Empty / Unused Tables -- Finance & Config

| Table | Description |
|-------|-------------|
| CuentasBancarias | Bank account definitions |
| Bancos | Bank master data |
| Tarifas | Price list definitions |
| TarjetasTienda | Store-specific card config |
| Cierres | Period closings |
| Presupuestos | Budgets |
| Comisiones | Commission calculations |
| MotivosDescuento | Discount reason codes |
| MotivosDevolucion | Return reason codes |
| MotivosAusencia | Absence reason codes |
| MotivosBajas | Termination reason codes |
| PuestosTienda | Store position definitions |
| Postales | Postal code lookups |

## SQL Views

The following SQL views are queryable via the P4D driver (discovered 2026-04-05):

| View | Description |
|------|-------------|
| `Tiendas_SQL` | Full Tiendas table with 208 columns — use instead of `Tiendas` for complete column access |
| `RRHHEmpleados_SQL` | Full RRHHEmpleados table |
| `RRHHControlPresencia_SQL` | Attendance control records |
| `RRHHBajas_SQL` | Employee termination records |
| `RRHHAusencias_SQL` | Employee absence records |

## Tiendas Field Groups

The Tiendas table (208 columns) is organized into distinct functional clusters:

### 1. Identity and Location
Core store identification: `CODIGO`, `REGTIENDA`, `CODIGOC`, `CODIGOE`, `DIRECCION`, `POBLACION`, `PROVINCIA`, `POSTAL`, `TELEFONO`, `FAX`, `PAIS`, `COMUNIDADAUTONOMA`, `RESPONSABLE`, `DEPARTAMENTO`.

### 2. Store Type Flags
Boolean flags that classify the store's operational mode:
- `OUTLET` — outlet/clearance store
- `TRANSITO` — transit/logistics node (not a retail store)
- `FRANQUICIADO` — franchised store
- `EXTRANJERO` — foreign/international store
- `ANULADA` — inactive/closed store
- `NODISPONIBLE` — temporarily unavailable
- `TIPOTIENDA` — store type code

### 3. Physical Store Data
- `SUPERFICIE` — store area in m²
- `PRECIOM2` — rent per m² (used for cost allocation)
- `HORAAPERTURA` — opening time
- `HORACAJA` — cash register open time
- `NCAJAS` — number of cash registers
- `NEMPLEADOS` — number of employees

### 4. Store Groupings
Each store belongs to multiple grouping dimensions (versions 1-3 for each group type):
- `GRUPOSTOCK` / `VERGRUPOSTOCK` / `VERGRUPOSTOCK2` / `VERGRUPOSTOCK3` — stock visibility groups (controls which stores see each other's stock)
- `GRUPOBALANCEO` / `GRUPOBALANCEO2` / `GRUPOBALANCEO3` — stock balancing groups (for inter-store transfers)
- `GRUPOPROMOCION` / `GRUPOPROMOCION2` / `GRUPOPROMOCION3` — promotion groups (which promotions apply)
- `GRUPOCUESTIONARIO` / `GRUPOCUESTIONARIO2` / `GRUPOCUESTIONARIO3` — survey/questionnaire groups
- `GRUPOSTOCKB2C` / `GRUPOSTOCKB2C2` — B2C online stock groups

### 5. Accounting Configuration (CON* fields)
Each store has its own accounting chart of accounts mapping — enabling per-store P&L in the ERP:
- `CONVENTAS` — sales revenue account
- `CONIVA1` / `CONIVA2` / `CONIVA3` — VAT accounts (multiple rates)
- `CONCAJA` — cash account
- `CONCLIENTES` — accounts receivable
- `CONBANCO` — bank account
- `CONGASTOS` — expenses account
- `CONINGRESOS` — income account
- `CONGCOD1`..`CONGCOD6` — GC (wholesale) account codes
- `CONGCUE1`..`CONGCUE6` — GC account descriptions

### 6. Airport Concession Data (AENA_* fields)
Complete financial data for airport stores operating under AENA concessions:
- `AENA_AEROPUERTO` — airport IATA/AENA code
- `AENA_CONTRATO` — concession contract reference
- `AENA_LOCAL` — terminal and local/unit identifier
- `AENA_TPV0` / `AENA_TPV1` / `AENA_TPV2` — POS terminal IDs registered with AENA
- `AENA_RENTA_FIJA_MES` — fixed monthly rent
- `AENA_RENTA_VAR_MESCI` — variable monthly rent incl. VAT
- `AENA_RENTA_VAR_MESSI` — variable monthly rent excl. VAT
- `AENA_RENTA_MIN_MES` — minimum monthly rent floor
- `AENA_RENTA_MIN_ANUAL` — minimum annual rent floor

### 7. External System Identifiers
Stores may be registered in multiple external systems:
- `IDENTIFICADORTIENDA` / `IDENTIFICADORTIENDA1` / `IDENTIFICADORTIENDA2` / `IDENTIFICADORTIENDA3` — four slots for external system IDs
- `A3CODIGOTIENDA` — store code in A3 accounting ERP
- `A3CODIGOEMPRESA` — company code in A3 ERP
- `CODIGOE` — generic external code
- `IDSERIE` — document series ID
- `IDSENDCLOUD` — Sendcloud logistics platform store ID

### 8. Module Access Permissions (AP* fields)
Controls which PowerShop modules each store has enabled:
- `APARTICULOS` — articles/products module
- `APCOMPRAST` / `APCOMPRASA` — purchasing (transfer/supplier)
- `APCOMPRASTU` / `APCOMPRASAU` — purchasing uploads
- `APCOMPRASTP` / `APCOMPRASAP` — purchasing approvals

### 9. Omnichannel / Web Flags
- `ANULADOSTOMNICANAL` — store deactivated for omnichannel orders
- `B2CNOREPONERDOMINGOS` — suppress B2C stock replenishment on Sundays
- `SOSIRVEDESDECENTRAL` — orders served from central warehouse (not store)
- `WEBPRIORIDAD` — web display priority ranking
- `WEBNOREPOMI` / `WEBNOREPOMA` — web replenishment exclusion flags

### 10. Reconciliation Control Fields
Used for data integrity checking between store and central server:
- `CONTROLVFECHA` — reference date for last reconciliation
- `CONTROLVVENTAS` / `CONTROLVVENTASC` — sales count (store vs central)
- `CONTROLVLINEAS` / `CONTROLVLINEASC` — line count (store vs central)
- `CONTROLVPAGOS` / `CONTROLVPAGOSC` — payment count (store vs central)

### 11. Sync / Update Tracking
- `ULTIMAACTUALIZACION` — last sync timestamp from store
- `FECHAMODIFICA` — last modification date
- `FECHAMODIFICASTOCK` / `HORAMODIFICASTOCK` — last stock modification datetime

## Notes

- **Tiendas** has 208 columns (via `Tiendas_SQL` view) covering store identity, multi-register config, franchise data, fiscal settings, web/commerce flags, airport concession financials, and operational parameters. Column count corrected from 209 to 208 on 2026-04-05.
- **Exportaciones** (2M+ rows) is the largest table by row count -- it logs all data synchronization events between stores and the central server.
- **RRHHEmpleados** includes per-module access flags (PDFuturShop, PDWarehouse, PDFinancials, PDCommerce, PDAdministrador, etc.) acting as a permission system.
- The full HR module (RRHH*) has 17+ tables but only RRHHEmpleados (15 rows) and RRHHAcceso (937 rows) contain data. The rest of the HR functionality is unused.
- **Vales** (54K rows) tracks vouchers/store credit across stores, with both issuance and redemption tracked by store.
- **FormasPago** is a shared lookup used by POS, wholesale, and purchasing modules. Has 30 columns including 12 payment installment slots (`VP1..VP12`), bank remittance flags, Datisa ERP integration code (`CodigoDatisa`), and wholesale-specific flags (`GCDPP`, `GCSinImpuestos`). Referenced as `FormaPago` FK from Clientes, Ventas, GCPedidos, GCFacturas.
- **AENA_* fields** are only populated for stores operating inside airports under AENA concessions — null for all regular stores.
- The `CON*` accounting fields map store transactions to the chart of accounts in the connected accounting ERP. Each store can have a different account structure.

---

## LLM:tables

```json
[
  {
    "table": "ps_tiendas",
    "alias": "Tienda",
    "description": "Tiendas. 99=almacén central, 97=online.",
    "keyColumns": ["reg_tienda (PK)", "codigo"]
  }
]
```
