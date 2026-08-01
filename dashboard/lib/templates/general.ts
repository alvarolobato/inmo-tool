/**
 * Template: Director General
 *
 * Executive overview: retail + wholesale revenue, channel mix, margin,
 * 12-month rolling trend, top product families, and stock value.
 *
 * ## Cross-source discipline (retail + mayorista)
 *
 * This is the only template that mixes two source families:
 *   - Retail: `ps_ventas` / `ps_lineas_ventas` (POS sales, store-scoped, IVA-incluido in `total_si`).
 *   - Mayorista: `ps_gc_facturas` / `ps_gc_lin_facturas` (B2B invoices, NOT store-scoped,
 *     net base in `base1+base2+base3`, costs in `ps_gc_lin_facturas.total_coste`).
 *
 * Rules every future agent MUST preserve:
 *   1. NEVER add the two sums into a single "ventas totales" KPI without making the
 *      double-counting decision explicit. A retail sale of stock that originated from a
 *      wholesale invoice does NOT cross between tables — `ps_ventas` is recorded at the
 *      POS and `ps_gc_facturas` at B2B billing. They are independent revenue streams,
 *      so summing them is safe at the channel level. The mix donut + the 12-month
 *      trend already do this correctly.
 *   2. The retail half is filtered by `__gf_tienda__`; the wholesale half is NOT
 *      (no store column on `ps_gc_facturas`). This is intentional — a global "Tienda"
 *      pick must scope retail only.
 *   3. Selected-period boundary: retail uses `v.fecha_creacion`, wholesale uses
 *      `f.fecha_factura`. Treat them as comparable revenue accruals (both are issuance
 *      dates of the underlying transaction).
 *   4. Devoluciones: retail abonos = `v.entrada = false`; wholesale abonos =
 *      `f.abono = true` (excluded from facturación). The retail "Devoluciones %" KPI
 *      below uses retail-only data — wholesale credit notes are tracked separately.
 *
 * ## YoY definition
 *
 * Comparativa YoY uses the **same dates shifted one year back**:
 *   prev_from = curr_from - INTERVAL '1 year'
 *   prev_to   = curr_to   - INTERVAL '1 year'
 *
 * Side effect: for ranges that cross a leap year / Feb 29, the prior period's
 * day-count may differ by ±1 day. We accept this trade-off because it preserves
 * date alignment year over year and keeps the % comparable for any custom range.
 *
 * ## Tendencia 12 meses
 *
 * The trend chart is anchored to `:curr_to` and covers **at least 12 calendar
 * months**. If the selected period starts earlier than `:curr_to - INTERVAL '11
 * months'`, the chart expands to respect that longer picker range; otherwise it
 * shows the standard rolling 12-month window. This is intentional: an executive
 * scanning the dashboard wants the long arc while still preserving longer
 * user-selected ranges. The selected period remains directly reflected by the
 * other widgets (KPIs, mix, top families). Title makes the minimum rolling window
 * explicit.
 *
 * ## Filters
 *
 * `templateGlobalFiltersRetail` is reused so the chrome stays consistent with the
 * Ventas template. Wholesale widgets do not consume any of these filters (no
 * `__gf_*__` tokens are referenced in mayorista SQL). A future iteration can add a
 * dedicated `templateGlobalFiltersGeneral` with a `canal` (retail/mayorista) toggle
 * — tracked as a follow-up to issue #417.
 *
 * All date filters use `:curr_from` / `:curr_to` tokens set by the date picker.
 */
import type { DashboardSpec } from "@/lib/schema";
import { templateGlobalFiltersRetail } from "@/lib/template-global-filters";

export const name = "Director General";

export const description =
  "Panel ejecutivo: ventas retail, facturacion mayorista, margen global, comparativa YoY, mix de canales, ventas por tienda, tendencia 12 meses, top familias y valor de stock.";

export const spec: DashboardSpec = {
  title: "Cuadro de Mandos — Director General",
  description,
  filters: templateGlobalFiltersRetail,
  widgets: [
    {
      id: "general-kpis",
      type: "kpi_row",
      items: [
        {
          // Retail: POS sales with IVA included; tienda 99 = ghost/no-store excluded.
          label: "Ventas Retail Netas (período seleccionado)",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__`,
          format: "currency",
          prefix: "€",
        },
        {
          // Mayorista: B2B invoice net (base1+base2+base3 = three IVA bases summed).
          // Not store-scoped; __gf_tienda__ intentionally absent.
          label: "Facturacion Mayorista (período seleccionado)",
          sql: `SELECT COALESCE(SUM("base1" + "base2" + "base3"), 0) AS value
FROM "public"."ps_gc_facturas"
WHERE "abono" = false
  AND "fecha_factura" >= :curr_from
  AND "fecha_factura" <= :curr_to`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Margen Global Retail",
          sql: `SELECT ROUND(
  (SUM(lv."total_si") - SUM(lv."total_coste_si"))
  / NULLIF(SUM(lv."total_si"), 0) * 100, 1
) AS value
FROM "public"."ps_lineas_ventas" lv
JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo"
JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE v."entrada" = true
  AND lv."tienda" <> '99'
  AND lv."total_si" > 0
  AND lv."fecha_creacion" >= :curr_from
  AND lv."fecha_creacion" <= :curr_to
  AND __gf_tienda__
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_sexo__
  AND __gf_departamento__`,
          format: "percent",
        },
        {
          // YoY: same day-count window shifted one year (see header note).
          // ::date casts are required before INTERVAL to avoid PG
          // 'invalid input syntax for type interval' on parameter substitution.
          label: "Retail YoY %",
          sql: `SELECT ROUND(
  (curr.ventas - prev.ventas) / NULLIF(ABS(prev.ventas), 0) * 100, 1
) AS value
FROM (
  SELECT COALESCE(SUM(v."total_si"), 0) AS ventas
  FROM "public"."ps_ventas" v
  WHERE v."entrada" = true AND v."tienda" <> '99'
    AND v."fecha_creacion" >= :curr_from
    AND v."fecha_creacion" <= :curr_to
    AND __gf_tienda__
) curr,
(
  SELECT COALESCE(SUM(v."total_si"), 0) AS ventas
  FROM "public"."ps_ventas" v
  WHERE v."entrada" = true AND v."tienda" <> '99'
    AND v."fecha_creacion" >= :curr_from::date - INTERVAL '1 year'
    AND v."fecha_creacion" <= :curr_to::date - INTERVAL '1 year'
    AND __gf_tienda__
) prev`,
          format: "percent",
        },
      ],
    },
    {
      id: "general-kpis-secondary",
      type: "kpi_row",
      items: [
        {
          // Mayorista YoY symmetric to retail YoY (same day-count window).
          label: "Mayorista YoY %",
          sql: `SELECT ROUND(
  (curr.facturacion - prev.facturacion) / NULLIF(ABS(prev.facturacion), 0) * 100, 1
) AS value
FROM (
  SELECT COALESCE(SUM("base1" + "base2" + "base3"), 0) AS facturacion
  FROM "public"."ps_gc_facturas"
  WHERE "abono" = false
    AND "fecha_factura" >= :curr_from
    AND "fecha_factura" <= :curr_to
) curr,
(
  SELECT COALESCE(SUM("base1" + "base2" + "base3"), 0) AS facturacion
  FROM "public"."ps_gc_facturas"
  WHERE "abono" = false
    AND "fecha_factura" >= :curr_from::date - INTERVAL '1 year'
    AND "fecha_factura" <= :curr_to::date - INTERVAL '1 year'
) prev`,
          format: "percent",
        },
        {
          // Mayorista margin via GC invoice lines. Wholesale margin is structurally
          // lower than retail (no end-customer markup); show separately so the exec
          // does not blend the two.
          label: "Margen Global Mayorista",
          sql: `SELECT ROUND(
  (SUM(lf."total") - SUM(lf."total_coste"))
  / NULLIF(SUM(lf."total"), 0) * 100, 1
) AS value
FROM "public"."ps_gc_lin_facturas" lf
JOIN "public"."ps_gc_facturas" f ON lf."num_factura" = f."reg_factura"
WHERE f."abono" = false
  AND lf."total" > 0
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to`,
          format: "percent",
        },
        {
          // Devoluciones retail (entrada=false) as % of bruto retail (entrada=true).
          // Wholesale credit notes (f.abono=true) are excluded from this metric
          // because the executive view treats devoluciones as a retail-quality signal.
          label: "Devoluciones Retail %",
          sql: `SELECT ROUND(
  COALESCE(SUM(CASE WHEN v."entrada" = false THEN ABS(v."total_si") ELSE 0 END), 0)
  / NULLIF(
      COALESCE(SUM(CASE WHEN v."entrada" = true THEN v."total_si" ELSE 0 END), 0),
    0) * 100, 1
) AS value
FROM "public"."ps_ventas" v
WHERE v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__`,
          format: "percent",
        },
      ],
    },
    {
      // Mix Retail vs Mayorista. Both halves are mutually exclusive revenue streams
      // (independent tables), so the donut totals to the sum of the two channel KPIs.
      // Validated 2026-04-26 against `general-kpis` for the same period.
      id: "general-mix-canales",
      type: "donut_chart",
      title: "Mix Retail vs Mayorista (período seleccionado)",
      sql: `SELECT 'Retail' AS label,
       COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__
UNION ALL
SELECT 'Mayorista' AS label,
       COALESCE(SUM("base1" + "base2" + "base3"), 0) AS value
FROM "public"."ps_gc_facturas"
WHERE "abono" = false
  AND "fecha_factura" >= :curr_from
  AND "fecha_factura" <= :curr_to`,
      x: "label",
      y: "value",
    },
    {
      id: "general-ventas-por-tienda",
      type: "bar_chart",
      title: "Ventas Retail por Tienda (período seleccionado)",
      sql: `SELECT v."tienda" AS label, COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__
GROUP BY v."tienda"
ORDER BY value DESC`,
      x: "label",
      y: "value",
    },
    {
      // Tendencia mensual: lower bound = LEAST(:curr_from, :curr_to − 11 months).
      // This guarantees AT LEAST a rolling 12-month arc when the picker is short
      // (executive wants the long view) while still respecting longer ranges
      // (e.g. YTD with 14 months → shows full 14-month range).
      // Upper bound is :curr_to. Retail and mayorista are independent revenue
      // streams (different tables, different transactions) so the UNION does NOT
      // double-count. See header for the cross-source discipline rules.
      id: "general-tendencia-12m",
      type: "line_chart",
      title: "Tendencia Mensual Retail + Mayorista (mín. 12 meses móviles)",
      sql: `SELECT mes AS x, SUM(importe) AS y FROM (
  SELECT DATE_TRUNC('month', v."fecha_creacion") AS mes,
         SUM(v."total_si") AS importe
  FROM "public"."ps_ventas" v
  WHERE v."entrada" = true
    AND v."tienda" <> '99'
    AND v."fecha_creacion" >= LEAST(
      :curr_from::date,
      (DATE_TRUNC('month', :curr_to::date) - INTERVAL '11 months')::date
    )
    AND v."fecha_creacion" <= :curr_to
    AND __gf_tienda__
  GROUP BY DATE_TRUNC('month', v."fecha_creacion")
  UNION ALL
  SELECT DATE_TRUNC('month', "fecha_factura") AS mes,
         SUM("base1" + "base2" + "base3") AS importe
  FROM "public"."ps_gc_facturas"
  WHERE "abono" = false
    AND "fecha_factura" >= LEAST(
      :curr_from::date,
      (DATE_TRUNC('month', :curr_to::date) - INTERVAL '11 months')::date
    )
    AND "fecha_factura" <= :curr_to
  GROUP BY DATE_TRUNC('month', "fecha_factura")
) combined
GROUP BY mes
ORDER BY mes`,
      x: "x",
      y: "y",
    },
    {
      id: "general-top-familias",
      type: "table",
      title: "Top 10 Familias — Ventas, Mix y Comparativa",
      sql: `WITH curr AS (
  SELECT fm."fami_grup_marc" AS familia,
         COALESCE(SUM(lv."total_si"), 0) AS ventas,
         COALESCE(SUM(lv."unidades"), 0) AS unidades,
         COALESCE(SUM(lv."total_coste_si"), 0) AS coste
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo"
  JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."total_si" > 0
    AND lv."fecha_creacion" >= :curr_from
    AND lv."fecha_creacion" <= :curr_to
    AND __gf_tienda__
    AND __gf_familia__
    AND __gf_temporada__
    AND __gf_marca__
    AND __gf_sexo__
    AND __gf_departamento__
  GROUP BY fm."fami_grup_marc"
),
prev AS (
  SELECT fm."fami_grup_marc" AS familia,
         COALESCE(SUM(lv."total_si"), 0) AS ventas
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo"
  JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."total_si" > 0
    AND lv."fecha_creacion" >= :curr_from::date - (:curr_to::date - :curr_from::date + 1)
    AND lv."fecha_creacion" <= :curr_from::date - INTERVAL '1 day'
    AND __gf_tienda__
    AND __gf_familia__
    AND __gf_temporada__
    AND __gf_marca__
    AND __gf_sexo__
    AND __gf_departamento__
  GROUP BY fm."fami_grup_marc"
),
yoy AS (
  SELECT fm."fami_grup_marc" AS familia,
         COALESCE(SUM(lv."total_si"), 0) AS ventas
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo"
  JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."total_si" > 0
    AND lv."fecha_creacion" >= :curr_from::date - INTERVAL '1 year'
    AND lv."fecha_creacion" <= :curr_to::date - INTERVAL '1 year'
    AND __gf_tienda__
    AND __gf_familia__
    AND __gf_temporada__
    AND __gf_marca__
    AND __gf_sexo__
    AND __gf_departamento__
  GROUP BY fm."fami_grup_marc"
)
SELECT c.familia AS "Familia",
       ROUND(c.ventas, 2) AS "Ventas Netas",
       c.unidades AS "Unidades",
       ROUND((c.ventas - c.coste) / NULLIF(c.ventas, 0) * 100, 1) AS "Margen %",
       ROUND(c.ventas / NULLIF(SUM(c.ventas) OVER (), 0) * 100, 1) AS "Mix %",
       ROUND((c.ventas - p.ventas) / NULLIF(ABS(p.ventas), 0) * 100, 1) AS "Δ Per. Ant. %",
       ROUND((c.ventas - y.ventas) / NULLIF(ABS(y.ventas), 0) * 100, 1) AS "Δ Año Ant. %"
FROM curr c
LEFT JOIN prev p ON c.familia = p.familia
LEFT JOIN yoy y ON c.familia = y.familia
ORDER BY c.ventas DESC
LIMIT 10`,
    },
    {
      id: "general-valor-stock",
      type: "kpi_row",
      items: [
        {
          // Working-capital approximation: stock units × precio_coste at item level.
          // Excludes anulado articles. Stock is point-in-time (not period-bound).
          label: "Valor Stock Total al Coste",
          sql: `SELECT COALESCE(ROUND(SUM(s."stock" * p."precio_coste"), 2), 0) AS value
FROM "public"."ps_stock_tienda" s
JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo"
WHERE s."stock" > 0 AND p."anulado" = false`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Unidades en Stock",
          sql: `SELECT COALESCE(SUM("stock"), 0) AS value
FROM "public"."ps_stock_tienda"
WHERE "stock" > 0`,
          format: "number",
        },
        {
          label: "Pedidos Mayorista Pendientes",
          sql: `SELECT COUNT(DISTINCT "reg_pedido") AS value
FROM "public"."ps_gc_pedidos"
WHERE "pedido_cerrado" = false
  AND "abono" = false
  AND "pendientes" > 0`,
          format: "number",
        },
      ],
    },
  ],
};
