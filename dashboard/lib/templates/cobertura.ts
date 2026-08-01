/**
 * Template: Cobertura de Stock
 *
 * Coverage dashboard for the purchasing director: how many days of sales
 * does current stock cover per reference, family and store — and which
 * references are below the supplier lead time?
 *
 * Business decisions documented in this header (see issue #486 / parent #477):
 *
 * 1. **Coverage formula.**  `coverage_dias = stock_total / (units_sold_30d / 30.0)`.
 *    Articles with zero sales in the last 30 days are excluded from averages
 *    (coverage = NULL / shown as "—" in tables).
 *
 * 2. **Point-in-time × fixed 30-day window.**  Stock is point-in-time
 *    (`ps_stock_tienda`). The sales velocity window is always `CURRENT_DATE −
 *    30 days` — **no** `:curr_from` / `:curr_to` tokens anywhere in this
 *    template. The date picker in the dashboard chrome has no effect on
 *    coverage widgets.
 *
 * 3. **Lead time per supplier.**  `AVG(fecha_recibido − fecha_pedido)` from
 *    `ps_compras` where both dates are non-NULL and `fecha_recibido >=
 *    fecha_pedido` (guards against data-entry errors that produce negative
 *    lead times); falls back to 15 days via `COALESCE` when no completed
 *    POs exist for a supplier.
 *
 * 4. **Critical threshold = 7 days.**  Hardcoded in SQL — adjust if business
 *    rule changes.  Overstock threshold = 90 days.
 *
 * 5. **Outlier cap at 365 days.**  Averages and the overstock table exclude
 *    references with coverage > 365 days from the mean (they skew averages
 *    with no actionable signal for the buyer).
 *
 * 6. **Ghost store `'99'` excluded everywhere** (tienda <> '99').
 *
 * 7. **`anulado = false` required** on every join to `ps_articulos`.
 *
 * 8. **Alias conventions.**  Widgets that opt into global filters MUST use
 *    these aliases: `s` → ps_stock_tienda, `p` → ps_articulos,
 *    `fm` → ps_familias.  Coverage CTEs use these aliases internally so that
 *    `__gf_tienda__`, `__gf_familia__`, `__gf_temporada__`, `__gf_marca__`,
 *    `__gf_proveedor__` resolve correctly.
 *
 * 9. **`cobertura-por-tienda` omits `__gf_tienda__` by design.**  That chart's
 *    purpose is to compare *all* stores side-by-side; filtering to a single store
 *    would make it a one-bar chart with no comparative value.  All other widgets
 *    honour `__gf_tienda__`.
 *
 * 10. **Sales velocity scope depends on widget.**
 *    - `cobertura-kpis`, `cobertura-critica`, `cobertura-por-familia`,
 *      `cobertura-sobrestock`: `ventas_30d` is **company-wide** (no `tienda`
 *      filter). `stock_art` respects `__gf_tienda__`. Intentional: the
 *      purchasing director needs demand across all locations to decide reorder.
 *    - `cobertura-por-tienda`: `ventas_30d` is **per-store** (grouped by
 *      `tienda, codigo`) so each store is evaluated against its own velocity.
 *      `__gf_tienda__` is also omitted so all stores appear in the comparison.
 */
import type { DashboardSpec } from "@/lib/schema";
import { templateGlobalFiltersCobertura } from "@/lib/template-global-filters";

export const name = "Cobertura de Stock";

export const description =
  "Panel para el responsable de compras: cobertura en días de venta por referencia, familia y tienda; alertas de stock crítico vs lead time del proveedor; detección de sobrestock.";

export const spec: DashboardSpec = {
  title: "Cuadro de Mandos — Cobertura de Stock",
  description,
  filters: templateGlobalFiltersCobertura,
  widgets: [
    {
      id: "cobertura-kpis",
      type: "kpi_row",
      items: [
        {
          // Count of distinct active articles where point-in-time stock divided
          // by average daily sales over 30 days is below 7 days (critical threshold).
          // Only articles with sales > 0 in the last 30 days are considered.
          label: "Referencias Críticas (< 7 días)",
          sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
)
SELECT COUNT(DISTINCT p."codigo") AS value
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) < 7
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__`,
          format: "number",
          inverted: true,
        },
        {
          // Weighted average coverage in days across articles with coverage < 365
          // (cap at 365 to exclude outliers with very slow-moving stock).
          label: "Cobertura Media (días)",
          sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
)
SELECT COALESCE(
         ROUND(
           (SUM(sa.total_stock) / NULLIF(SUM(vd.unidades_30d) / 30.0, 0))::numeric,
           1
         ),
         0
       ) AS value
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) < 365
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__`,
          format: "decimal",
        },
        {
          // Count of articles with more than 90 days of coverage AND recent sales
          // (i.e. genuinely overstocked — not just slow-moving dead stock).
          label: "Cobertura > 90 días (sobrestock)",
          sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
)
SELECT COUNT(DISTINCT p."codigo") AS value
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) > 90
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) < 365
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__`,
          format: "number",
          inverted: true,
        },
        {
          // Total stock value at cost (stock × precio_coste) for critical articles
          // (coverage < 7 days). Quantifies the capital at risk of stockout.
          label: "Valor Stock en Riesgo (< 7 días)",
          sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
)
SELECT COALESCE(
         ROUND(SUM(sa.total_stock * COALESCE(p."precio_coste", 0)), 2),
         0
       ) AS value
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) < 7
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__`,
          format: "currency",
          prefix: "€",
        },
      ],
    },
    {
      id: "cobertura-critica",
      type: "table",
      title: "Referencias con Cobertura Crítica (orden urgencia)",
      // CTE-based query: joins stock, 30-day sales, article catalog, familia,
      // and per-supplier lead time. Filters: coverage < COALESCE(lead_time, 15).
      // The 15-day fallback applies when no completed PO exists for the supplier.
      sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock,
         COUNT(DISTINCT CASE WHEN s."stock" > 0 THEN s."tienda" END) AS num_tiendas
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
),
lead_time_prov AS (
  SELECT co."num_proveedor",
         ROUND(AVG(co."fecha_recibido" - co."fecha_pedido")::numeric, 1) AS lead_time
  FROM "public"."ps_compras" co
  WHERE co."fecha_recibido" IS NOT NULL
    AND co."fecha_pedido" IS NOT NULL
    AND co."fecha_recibido" >= co."fecha_pedido"
  GROUP BY co."num_proveedor"
)
SELECT
  COALESCE(NULLIF(p."ccrefejofacm", ''), '—') AS "Referencia",
  COALESCE(NULLIF(p."descripcion", ''), '—') AS "Descripción",
  COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), '—') AS "Familia",
  sa.num_tiendas AS "Tiendas",
  sa.total_stock AS "Stock Total",
  ROUND(vd.unidades_30d / 30.0, 2) AS "Ventas/día",
  ROUND(sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0), 1) AS "Cobertura (días)",
  COALESCE(lt.lead_time, 15) AS "Lead Time Prov (días)"
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
LEFT JOIN lead_time_prov lt ON lt.num_proveedor = p."num_proveedor"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0))
        < COALESCE(lt.lead_time, 15)
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__
ORDER BY "Cobertura (días)" ASC
LIMIT 50`,
    },
    {
      id: "cobertura-por-familia",
      type: "bar_chart",
      title: "Cobertura Media por Familia (días)",
      // Average coverage in days per family; outliers > 365 days excluded.
      // Sorted ASC so families nearest stockout appear leftmost.
      sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
),
cobertura_art AS (
  SELECT
    COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), 'Sin clasificar') AS familia,
    sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0) AS cobertura_dias
  FROM "public"."ps_articulos" p
  JOIN stock_art sa ON sa."codigo" = p."codigo"
  JOIN ventas_30d vd ON vd."codigo" = p."codigo"
  LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
  WHERE p."anulado" = false
    AND __gf_familia__
    AND __gf_temporada__
    AND __gf_marca__
    AND __gf_proveedor__
)
-- Simple average (not volume-weighted) so every article weighs equally;
-- this surfaces per-reference risk regardless of volume.
SELECT familia AS label,
       ROUND(AVG(cobertura_dias)::numeric, 1) AS value
FROM cobertura_art
WHERE cobertura_dias < 365
GROUP BY familia
ORDER BY value ASC
LIMIT 15`,
      x: "label",
      y: "value",
    },
    {
      id: "cobertura-por-tienda",
      type: "bar_chart",
      title: "% Referencias Críticas por Tienda (cobertura < 7 días)",
      // Per store: what % of the articles with recent sales have coverage < 7 days.
      // Sorted DESC so the most at-risk stores appear first.
      // __gf_tienda__ is intentionally omitted: this chart compares all stores.
      sql: `WITH ventas_30d AS (
  SELECT lv."tienda",
         lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."tienda", lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_por_tienda AS (
  SELECT s."tienda",
         s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
  GROUP BY s."tienda", s."codigo"
),
cobertura_tienda AS (
  SELECT
    spt."tienda",
    spt.total_stock / NULLIF(vd.unidades_30d / 30.0, 0) AS cobertura_dias
  FROM stock_por_tienda spt
  JOIN ventas_30d vd ON vd."codigo" = spt."codigo" AND vd."tienda" = spt."tienda"
  JOIN "public"."ps_articulos" p ON p."codigo" = spt."codigo"
  LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
  WHERE p."anulado" = false
    AND __gf_familia__
    AND __gf_temporada__
    AND __gf_marca__
    AND __gf_proveedor__
)
SELECT tienda AS label,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE cobertura_dias IS NOT NULL AND cobertura_dias < 7)
         / NULLIF(COUNT(*), 0),
         1
       ) AS value
FROM cobertura_tienda
GROUP BY tienda
ORDER BY value DESC
LIMIT 20`,
      x: "label",
      y: "value",
    },
    {
      id: "cobertura-sobrestock",
      type: "table",
      title: "Sobrestock: Cobertura > 90 días (con ventas en 30 días)",
      // Articles that have recent sales but whose stock would last more than
      // 90 days at the current sales rate. Sorted DESC so worst overstock is first.
      sql: `WITH ventas_30d AS (
  SELECT lv."codigo",
         SUM(lv."unidades") AS unidades_30d
  FROM "public"."ps_lineas_ventas" lv
  JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
  WHERE v."entrada" = true
    AND lv."tienda" <> '99'
    AND lv."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY lv."codigo"
  HAVING SUM(lv."unidades") > 0
),
stock_art AS (
  SELECT s."codigo",
         GREATEST(SUM(s."stock"), 0) AS total_stock
  FROM "public"."ps_stock_tienda" s
  WHERE s."tienda" <> '99'
    AND __gf_tienda__
  GROUP BY s."codigo"
)
SELECT
  COALESCE(NULLIF(p."ccrefejofacm", ''), '—') AS "Referencia",
  COALESCE(NULLIF(p."descripcion", ''), '—') AS "Descripción",
  COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), '—') AS "Familia",
  sa.total_stock AS "Stock",
  ROUND(vd.unidades_30d / 30.0, 2) AS "Ventas/día",
  ROUND(sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0), 1) AS "Cobertura (días)"
FROM "public"."ps_articulos" p
JOIN stock_art sa ON sa."codigo" = p."codigo"
JOIN ventas_30d vd ON vd."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE p."anulado" = false
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) > 90
  AND (sa.total_stock / NULLIF(vd.unidades_30d / 30.0, 0)) < 365
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
  AND __gf_proveedor__
ORDER BY "Cobertura (días)" DESC
LIMIT 50`,
    },
  ],
};
