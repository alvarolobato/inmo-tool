---
id: D-015
title: Deep schema extraction from application server files
date: 2026-04-05
---

# D-015: Deep schema extraction from application server files

*Decided: 2026-04-05*

**Context**: Issue #142 identified gaps in our data model knowledge. A copy of the production application server, client, and database files became available locally.
**Decision**: Perform string extraction on the compiled `.4DC` structure file (360 MB) and query all SQL views (`_USER_VIEWS`) directly from the live server.
**Findings**:
- 5.7M string lines extracted from `PowerShop.4DC` — yielded 324 confirmed tables, 2,522+ field names, 130 WS_JS_* SOAP methods
- 100 SQL views discovered (`_USER_VIEWS`): 50 `*_SQL` + 50 `*_BI` — vendor's intended query patterns
- `Exportaciones_SQL` confirmed 34 stock slots (Stock1-34, Talla1-34), not 17 as partially documented
- `Ventas_SQL` has 150 columns including TBAI, marketplace, tax-free, Aena airport, SAF-T fiscal fields
- `Tiendas_SQL` has 208 columns including per-store accounting codes, Aena airport concession rents, store groupings
- `GCLinPedidos_SQL` has 239 columns: 34-slot × 5 quantity dimensions (Pedidas/Entregadas/Asignadas/Original/Talla)
- `FamiGrupMarc.SERIETALLAS` maps product family to size series — key for interpreting the 34-slot matrix
- 10 new business modules discovered: airport/Aena, B2B/B2C e-commerce, jewelry/couture manufacturing, RFID, TicketBAI, corners/concessions, ADIDAS data feeds, SAF-T, CRM/marketing
**Rationale**: String extraction from compiled binaries is non-destructive and yields the same schema information as `EXPORT STRUCTURE` XML without vendor cooperation. SQL views are readable via the standard p4d SQL driver.
**See**: [sql-views.md](../sql-views.md), [schema-discovery.md](../schema-discovery.md), GitHub issue #142.
