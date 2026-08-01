---
id: D-026
title: Pantalla de Inicio — read-only home dashboard at /inicio
date: 2026-05-01
---

# D-026: Pantalla de Inicio — read-only home dashboard at /inicio

*Decided: 2026-05-01*

**Context**: Issue #449. Users needed a "state of the business at a glance" panel accessible from the TopBar as the first navigation item, summarising the most important KPIs without requiring a prompt or selecting a saved dashboard. (Note: `/` still shows the dashboard list — `/inicio` is reached via the TopBar link or direct bookmark, not by automatic redirect.)
**Decision**:
- New route `/inicio` (Next.js App Router) renders the template `dashboard/lib/templates/inicio.ts` directly via `DashboardRenderer` in read-only mode. No chat sidebar, no save flow, no modify flow, no Analizar con IA launcher.
- The home template is **not** added to `TEMPLATES` (user-pickable templates array) — it is not a template to generate dashboards from; it is a fixed panel maintained in code.
- **No date-picker, no global filters**: all temporal ranges are implicit via `CURRENT_DATE` / `DATE_TRUNC`. The spec has `filters: []`. This eliminates the complexity of deciding which `:curr_from`/`:curr_to` applies to a panel that is "always current".
- **TopBar**: added `{ href: "/inicio", label: "Inicio" }` as the first nav item (order: `Inicio · Paneles · Revisión · Wren`).
- **`/` root** (at D-026 time): unchanged — still showed the dashboard list. **Superseded by [D-027](D-027-inicio-redesign.md) on 2026-05-02**: `/` now re-exports `inicio/page` and the dashboard list moved to `/paneles`.
- **9 widgets** in the catalog: (1) data freshness per domain, (2) ventas hoy/ayer/YoY, (3) ventas semana/anterior/YoY, (4) ventas mes/anterior/YoY, (5) KPIs operativos (tickets, ticket medio, margen mes, devoluciones %), (6) evolución diaria últimos 30 días, (7) top 10 tiendas mes actual, (8) KPIs mayorista+compras+stock, (9) tiendas sin venta hoy.
- **`ps_tiendas` finding (2026-05-02)**: the table has only `reg_tienda`, `codigo`, `fecha_modifica` — no `activa`/`anulada` field. Widget 9 lists all tiendas except '99'.
- **LineChartWidget capability finding (2026-05-02)**: the component supports a single series (columns `x`/`y`) driven by `resolveXY()`. No `series` column for multi-series. Widget 6 aggregates all tiendas into one total daily series rather than adding a new widget type.
- **`etl_watermarks` table_name mapping (2026-05-02)**: ventas domain = `ventas`+`lineas_ventas`; stock = `stock`; compras = `compras`+`lineas_compras`+`facturas_compra`; mayorista = `gc_facturas`+`gc_lin_facturas`+`gc_pedidos`. All 22 rows confirmed.
**Alternatives rejected**:
- Making `/` redirect to `/inicio`: breaks existing bookmarks; deferred to a separate issue.
- Adding multi-series capability to LineChartWidget for widget 6: out of scope, new behaviour; the aggregated single-series approach is sufficient and readable.
- Adding the home template to `TEMPLATES`: it is not a user-pickable template — it has no filters and should not be instantiated as a new dashboard.
**See**: `dashboard/lib/templates/inicio.ts`, `dashboard/app/inicio/page.tsx`, `dashboard/components/TopBar.tsx`.
