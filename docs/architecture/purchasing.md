# Purchasing & Invoicing Domain

> Purchase orders, supplier management, retail invoicing, and delivery notes.

## Entity Relationship Diagram -- Purchasing

```mermaid
erDiagram
    Compras {
        float RegPedido PK "Purchase order record ID"
        float NPedido "Order number"
        date FechaPedido "Order date"
        float NumProveedor FK "-> Proveedores.RegProveedor"
        text Proveedor "Supplier name (denorm)"
        float Total "Order total"
        float ImpBruto "Gross amount"
        float BaseImponible "Tax base"
        text FormaPago "Payment method"
        int NLineas "Number of lines"
        float Pedidos "Units ordered"
        float Recibidos "Units received"
        float Facturados "Units invoiced"
        text Temporada "Season"
        float NumTemporada FK "-> CCOPTempTipo"
        text Tienda "Destination store"
        float NumTienda FK "-> Tiendas"
        boolean LlevaIVA "Subject to VAT"
        boolean LlevaRE "Subject to surcharge"
        boolean Abono "Is credit note"
        boolean Deposito "Is deposit"
        boolean Reposicion "Is replenishment"
        boolean Fabricacion "Is manufacturing order"
        text NAlbaran "Delivery note ref"
        text Facturas "Invoice refs"
        int Serie "Document series"
    }

    LineasCompras {
        float NumPedido FK "-> Compras.RegPedido"
        float NumArticulo FK "-> Articulos.RegArticulo"
        text Codigo "Article code"
        float PrecioCoste "Unit cost"
        float Unidades "Quantity"
        float Total "Line total"
    }

    Proveedores {
        float RegProveedor PK "Supplier record ID"
        float Codigo "Supplier code"
        text Proveedor "Supplier name"
        text CIF "Tax ID"
        text Direccion "Address"
        text Poblacion "City"
        text Provincia "Province"
        text Postal "Postal code"
        text Telefono1 "Phone"
        text Movil "Mobile"
        text email "Email"
        text FormaPago "Default payment method"
        float PDescPP "Early payment discount %"
        float PDescCom "Commercial discount %"
        boolean LlevaIva "Subject to VAT"
        boolean LlevaRE "Subject to surcharge"
        boolean Fabricante "Is also manufacturer"
        boolean Anulado "Disabled"
        text IMPIBAN "International IBAN"
        text IMPIncoterm "Incoterm"
        float Coeficiente1 "Markup coefficient 1"
    }

    CCLineasCompr {
        float NumPedido FK "-> Compras.RegPedido"
        float NumArticulo FK "-> Articulos"
        text Codigo "Article code"
        text Descripcion "Description"
        float Unidades "Quantity"
    }

    FacturasCompra {
        float RegFactura PK "Purchase invoice ID"
        float NumProveedor FK "-> Proveedores"
        text Proveedor "Supplier name"
        float Total "Invoice total"
        date FechaFactura "Invoice date"
    }

    PagosCompras {
        float RegPago PK "Payment record ID"
        float NumProveedor FK "-> Proveedores"
        float Importe "Payment amount"
        date Fecha "Payment date"
        boolean Pagado "Is paid"
    }

    DivisionCompra {
        float NumPedido FK "-> Compras"
        text Tienda "Store allocation"
        float Unidades "Allocated units"
    }

    Compras ||--o{ LineasCompras : "RegPedido -> NumPedido"
    Compras ||--o{ CCLineasCompr : "RegPedido -> NumPedido"
    Compras ||--o{ DivisionCompra : "allocation per store"
    Compras }o--|| Proveedores : "NumProveedor -> RegProveedor"
    FacturasCompra }o--|| Proveedores : "NumProveedor"
    PagosCompras }o--|| Proveedores : "NumProveedor"
```

## Entity Relationship Diagram -- Retail Invoicing

```mermaid
erDiagram
    Facturas {
        float RegFactura PK "Invoice record ID"
        float NFactura "Invoice number"
        date FechaFactura "Invoice date"
        int SerieFV "Invoice series"
        float NumCliente FK "-> Clientes.RegCliente"
        text Cliente "Customer name"
        float Total "Invoice total"
        float BaseImponible "Tax base"
        float ImporteBruto "Gross amount"
        text FormaPago "Payment method"
        boolean LlevaIva "Subject to VAT"
        boolean Abono "Is credit note"
        boolean CobrosGenerado "Collections created"
        boolean Rectificativa "Is corrective"
        text Tienda "Store code"
        text Exportado "Export status"
    }

    Albaranes {
        float RegAlbaran PK "Delivery note ID"
        float NAlbaran "Delivery note number"
        date FechaRecibido "Receipt date"
        float NumProveedor FK "-> Proveedores"
        text Proveedor "Supplier name"
        float NPedido FK "-> Compras"
        float Total "Total amount"
        float BaseImponible "Tax base"
        int NLineas "Number of lines"
        text TiendaEntrada "Receiving store"
        text FormaPago "Payment method"
        boolean LlevaIVA "Subject to VAT"
        boolean Abono "Is credit note"
        int Serie "Document series"
    }

    LinAlbaranes {
        float NumAlbaran FK "-> Albaranes.RegAlbaran"
        float NumArticulo FK "-> Articulos.RegArticulo"
        text Codigo "Article code"
        text Articulo "Article name"
        float PrecioBruto "Gross price"
        float PrecioNeto "Net price"
        float Unidades "Quantity"
        float Total "Line total"
    }

    Albaranes ||--o{ LinAlbaranes : "RegAlbaran -> NumAlbaran"
    Albaranes }o--|| Proveedores : "NumProveedor"
```

## Table Descriptions

| Table | Rows | Columns | Description |
|-------|------|---------|-------------|
| **Compras** | 2,697 | 129 | Purchase orders to suppliers. Contains totals, VAT, payment terms, season, and fulfillment status. |
| **LineasCompras** | 0 | 57 | Purchase order line items. Currently empty (see CCLineasCompr). |
| **CCLineasCompr** | 44,395 | -- | Alternative purchase line items table (populated). |
| **Proveedores** | 518 | 115 | Supplier master. Address, contacts, bank, payment terms, import terms (Incoterm, IBAN). |
| **FacturasCompra** | 3,884 | -- | Purchase invoices from suppliers. |
| **PagosCompras** | 11,415 | -- | Payments to suppliers. |
| **DivisionCompra** | 10,981 | -- | Purchase order allocation across stores. |
| **Facturas** | 2,356 | 118 | Retail invoices. Formal fiscal documents from POS sales with TBAI/SAFT compliance. |
| **Albaranes** | 3,669 | 68 | Retail delivery notes for goods received from suppliers. |
| **LinAlbaranes** | 44,335 | 109 | Line items on delivery notes with size-level detail (Talla1-17). |

## Empty / Unused Tables

| Table | Description |
|-------|-------------|
| LineasCompras | Purchase order lines (empty -- CCLineasCompr is used instead) |
| CargosProveedores | Supplier charges |
| ComprasExternas | External purchases |
| OFFComprasDetail | Offline purchase details |
| OFFComprasHeader | Offline purchase headers |
| STDivisionCompra | Stock division for purchases |

## Notes

- **Two purchase line tables exist**: `LineasCompras` (empty, 57 cols) and `CCLineasCompr` (44,395 rows). The CC-prefixed version appears to be the active one.
- **Purchase flow**: Compras (order) -> Albaranes (receipt) -> FacturasCompra (supplier invoice) -> PagosCompras (payment).
- **Retail invoicing**: `Facturas` are formal invoices generated from POS sales (Ventas), separate from wholesale invoices (GCFacturas).
- **LinAlbaranes** has size-level columns (Talla1-17) matching the CCStock wide format for receiving goods per size.
- **DivisionCompra** (10,981 rows) tracks how purchase orders are allocated across multiple stores.
- Proveedores links to Articulos via `Articulos.NumProveedor -> Proveedores.RegProveedor`.

## Field Discoveries (confirmed via _USER_COLUMNS, 2026-05-01)

### CCLineasCompr (→ ps_lineas_compras)
All confirmed `DATA_TYPE=6` (Real, 8 bytes):
- `Unidades` — quantity ordered (maps to `ps_lineas_compras.unidades`)
- `PrecioCoste` — unit cost (maps to `precio_coste`)
- `PrecioNetoSI` — net unit price ex-VAT (maps to `precio_neto_si`)
- `TotalSI` — line total ex-VAT (maps to `total_si`)
- `NumProveedor` — FK → Proveedores.RegProveedor (maps to `num_proveedor`)

### Albaranes (→ ps_albaranes)
All confirmed `DATA_TYPE=6` (Real) or `DATA_TYPE=10` (text):
- `NPedido` (Real) — FK → Compras.RegPedido (maps to `num_pedido`)
- `NumProveedor` (Real) — FK → Proveedores.RegProveedor (maps to `num_proveedor`)
- `Proveedor` (text, 100 chars) — denormalised supplier name (maps to `proveedor`)

### Proveedores (→ ps_proveedores)
- `Proveedor` (text, 100 chars) — **the actual supplier name**. Maps to `ps_proveedores.nombre`.
- `NombreComercial` (text, 160 chars) — **empty for all 520 rows** in 4D. Do NOT map this field to `nombre`.
- `Codigo` (Real) — supplier code (not mapped to mirror currently).

---

## LLM:tables

```json
[
  {
    "table": "ps_compras",
    "alias": "PedidoCompra",
    "description": "Pedidos de compra a proveedores. La fecha del pedido es fecha_pedido (NO fecha_creacion). fecha_recibido es NULL mientras el pedido está pendiente de recibir.",
    "keyColumns": ["reg_pedido (PK)", "num_proveedor (FK)", "fecha_pedido", "fecha_recibido", "modificada"]
  },
  {
    "table": "ps_lineas_compras",
    "alias": "LineaPedidoCompra",
    "description": "Líneas de pedido de compra. NOTA: la tabla NO tiene columnas codigo ni unidades; el artículo se referencia por num_articulo (FK NUMERIC) y la tienda por num_tienda.",
    "keyColumns": ["reg_linea_compra (PK)", "num_pedido (FK → ps_compras.reg_pedido)", "num_tienda (FK)", "num_articulo (FK)", "fecha"]
  },
  {
    "table": "ps_albaranes",
    "alias": "AlbaranRecepcion",
    "description": "Albaranes de recepción de mercancía. La fecha de recepción es fecha_recibido (NO fecha_creacion).",
    "keyColumns": ["reg_albaran (PK)", "fecha_recibido", "modificada"]
  },
  {
    "table": "ps_facturas_compra",
    "alias": "FacturaCompra",
    "description": "Facturas de compra a proveedores.",
    "keyColumns": ["reg_factura (PK)"]
  },
  {
    "table": "ps_proveedores",
    "alias": "Proveedor",
    "description": "Proveedores de mercancía.",
    "keyColumns": ["reg_proveedor (PK)", "nombre"]
  }
]
```

## LLM:relationships

```json
[
  {"from": "ps_lineas_compras", "fromColumn": "num_pedido",    "to": "ps_compras",      "toColumn": "reg_pedido",     "type": "MANY_TO_ONE"},
  {"from": "ps_compras",        "fromColumn": "num_proveedor", "to": "ps_proveedores",  "toColumn": "reg_proveedor",  "type": "MANY_TO_ONE"}
]
```
