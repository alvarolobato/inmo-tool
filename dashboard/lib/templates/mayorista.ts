/**
 * Template: Director Mayorista
 *
 * Wholesale channel: invoicing KPIs, breakdown by sales rep, top clients,
 * pending orders (with aging), recent delivery notes, top products and
 * monthly trend.
 *
 * ## Channel discipline (read before changing the SQL)
 *
 * The retail vs wholesale separation in PowerShop is enforced AT THE TABLE
 * LEVEL: every `ps_gc_*` table holds wholesale data only and `ps_ventas` /
 * `ps_lineas_ventas` hold retail data only. The often-cited
 * `ccrefejofacm LIKE 'M%'` rule is a *retail-side* filter to drop wholesale
 * articles that drift into ps_articulos — it is **not** a primary key for
 * channel selection, and applying it to GC lines drops ~96% of legitimate
 * wholesale invoice rows. So: do **not** add `ccrefejofacm LIKE 'M%'` (or
 * any equivalent codigo prefix predicate) to the GC widgets below.
 *
 * ## Quantity decoder reminder (D-017)
 *
 * `GCLin*` line quantities (e.g. ps_gc_lin_facturas.unidades, .total,
 * .total_coste) come from 4D Real columns and can legitimately exceed
 * 32767. The signed-int16 decoder applies *only* to
 * Exportaciones.Stock1..Stock34 and must NOT be invoked here.
 *
 * ## Foreign-key gotcha
 *
 * The line-to-header join in the GC tables is
 *   `ps_gc_lin_facturas.num_factura  = ps_gc_facturas.reg_factura`
 *   `ps_gc_lin_albarane.num_albaran  = ps_gc_albaranes.reg_albaran`
 *   `ps_gc_lin_pedidos.num_pedido    = ps_gc_pedidos.reg_pedido`
 * i.e. the line `num_<parent>` matches the header's record id (`reg_*`),
 * NOT the human-friendly `n_<parent>` number. Joining on `n_*` returns
 * zero rows and silently produces NULL margins.
 *
 * ## Customer name fallback
 *
 * `ps_clientes.nombre` mirrors 4D's NombreComercial column, which is empty
 * for the majority of wholesale customers (only ~2% populated). We
 * COALESCE down to nif and then to a synthetic "Cliente <num>" label so
 * the user sees stable, distinct rows in tables and the global filter
 * dropdown.
 *
 * All date filters use :curr_from / :curr_to tokens set by the date picker.
 */
import type { DashboardSpec } from "@/lib/schema";
import { templateGlobalFiltersMayorista } from "@/lib/template-global-filters";

export const name = "Director Mayorista";

export const description =
  "Panel para el director del canal mayorista: facturacion neta, margen, desglose por comercial, top clientes, pedidos pendientes, albaranes recientes, top productos y comparativa mensual.";

/**
 * Reusable SQL fragment: customer label with NombreComercial → NIF →
 * synthetic-num → static fallback. Inline as a SELECT expression where
 * `c` is aliased to ps_clientes.
 *
 * The final 'Cliente desconocido' fallback guarantees the expression is
 * NEVER NULL even if num_cliente is itself NULL (which would make the
 * `'Cliente ' || num_cliente::text` arm collapse to NULL).
 */
const CLIENTE_LABEL = `COALESCE(NULLIF(TRIM(c."nombre"), ''),
                NULLIF(TRIM(c."nif"), ''),
                NULLIF('Cliente ' || COALESCE(c."num_cliente"::text, ''), 'Cliente '),
                'Cliente desconocido')`;

export const spec: DashboardSpec = {
  title: "Cuadro de Mandos — Mayorista",
  description,
  filters: templateGlobalFiltersMayorista,
  widgets: [
    {
      id: "mayorista-kpis",
      type: "kpi_row",
      items: [
        {
          label: "Facturacion Neta",
          // NULL-safe per-base COALESCE inside SUM so that if a single
          // base column is NULL (schema allows it; current data has none)
          // the row still contributes its non-null bases instead of being
          // silently dropped from the aggregate. Outer COALESCE handles
          // the empty-result case.
          sql: `SELECT COALESCE(SUM(COALESCE(f."base1", 0)
                  + COALESCE(f."base2", 0)
                  + COALESCE(f."base3", 0)), 0) AS value
FROM "public"."ps_gc_facturas" f
WHERE f."abono" = false
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Facturas",
          sql: `SELECT COUNT(DISTINCT f."reg_factura") AS value
FROM "public"."ps_gc_facturas" f
WHERE f."abono" = false
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__`,
          format: "number",
        },
        {
          // Margen % at the line level. We LEFT JOIN ps_articulos / ps_familias
          // so that lines whose codigo does not resolve to a current article
          // (~4% in production) still contribute to the aggregate. The filter
          // joins are only INNER-effective when the user picks a value, since
          // an unmatched LEFT JOIN row has NULL on the bind_expr column and
          // `__gf_*__ = ANY(:gf_*)` evaluates to NULL → filtered out only
          // when the filter is active. Result: TRUE-token (no selection)
          // keeps all lines; selecting a familia/marca/temporada filters as
          // expected.
          //
          // Join key: lf.num_factura = f.reg_factura (NOT f.n_factura).
          label: "Margen Mayorista",
          sql: `SELECT ROUND(
  (SUM(lf."total") - SUM(lf."total_coste"))
  / NULLIF(SUM(lf."total"), 0) * 100, 1
) AS value
FROM "public"."ps_gc_lin_facturas" lf
JOIN "public"."ps_gc_facturas" f ON lf."num_factura" = f."reg_factura"
LEFT JOIN "public"."ps_articulos" p ON lf."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE lf."total" > 0
  AND f."abono" = false
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__`,
          format: "percent",
        },
        {
          label: "Clientes Activos",
          sql: `SELECT COUNT(DISTINCT f."num_cliente") AS value
FROM "public"."ps_gc_facturas" f
WHERE f."abono" = false
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__`,
          format: "number",
        },
      ],
    },
    {
      // LEFT JOIN ps_gc_comerciales so invoices with num_comercial = 0 (the
      // unassigned default in this dataset) still surface, labelled
      // "(Sin comercial asignado)", instead of vanishing from the chart.
      id: "mayorista-por-comercial",
      type: "bar_chart",
      title: "Facturacion por Comercial",
      sql: `SELECT COALESCE(NULLIF(TRIM(c."comercial"), ''),
                '(Sin comercial asignado)') AS label,
       SUM(COALESCE(f."base1", 0)
           + COALESCE(f."base2", 0)
           + COALESCE(f."base3", 0)) AS value
FROM "public"."ps_gc_facturas" f
LEFT JOIN "public"."ps_gc_comerciales" c ON f."num_comercial" = c."reg_comercial"
WHERE f."abono" = false
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__
GROUP BY 1
ORDER BY value DESC`,
      x: "label",
      y: "value",
    },
    {
      // Top 10 clientes — facturacion neta + margen.
      // Using the corrected line-to-header join lf.num_factura = f.reg_factura.
      id: "mayorista-top-clientes",
      type: "table",
      title: "Top 10 Clientes Mayorista",
      sql: `WITH facturas_periodo AS (
  SELECT f."reg_factura",
         f."num_cliente",
         (COALESCE(f."base1", 0)
          + COALESCE(f."base2", 0)
          + COALESCE(f."base3", 0)) AS neto
  FROM "public"."ps_gc_facturas" f
  WHERE f."abono" = false
    AND f."fecha_factura" >= :curr_from
    AND f."fecha_factura" <= :curr_to
    AND __gf_cliente_mayorista__
), margenes AS (
  SELECT lf."num_factura",
         SUM(lf."total")       AS total_ingreso,
         SUM(lf."total_coste") AS total_coste
  FROM "public"."ps_gc_lin_facturas" lf
  WHERE lf."num_factura" IN (SELECT "reg_factura" FROM facturas_periodo)
  GROUP BY lf."num_factura"
)
SELECT ${CLIENTE_LABEL} AS "Cliente",
       COUNT(DISTINCT fy."reg_factura") AS "Facturas",
       SUM(fy.neto) AS "Facturacion Neta",
       ROUND((SUM(m.total_ingreso) - SUM(m.total_coste))
         / NULLIF(SUM(m.total_ingreso), 0) * 100, 1) AS "Margen %",
       MAX(c."ultima_compra_f") AS "Última Compra"
FROM facturas_periodo fy
JOIN "public"."ps_clientes" c ON fy."num_cliente" = c."reg_cliente"
LEFT JOIN margenes m ON m."num_factura" = fy."reg_factura"
GROUP BY c."reg_cliente", c."nombre", c."nif", c."num_cliente"
ORDER BY "Facturacion Neta" DESC
LIMIT 10`,
    },
    {
      // Pedidos pendientes con AGING (días desde emisión).
      //
      // This widget intentionally does NOT filter by :curr_from/:curr_to —
      // a wholesale director needs to see the full pending backlog,
      // independent of the time-picker. It DOES still react to
      // __gf_cliente_mayorista__ (we alias ps_gc_pedidos as `f` so the
      // filter's `bind_expr = f."num_cliente"` resolves).
      id: "mayorista-pedidos-pendientes",
      type: "table",
      title: "Pedidos Pendientes (con aging)",
      sql: `SELECT ${CLIENTE_LABEL} AS "Cliente",
       (f."n_pedido")::bigint AS "Pedido",
       f."fecha_pedido" AS "Fecha",
       (CURRENT_DATE - f."fecha_pedido")::int AS "Días",
       f."unidades" AS "Pedidas",
       f."entregadas" AS "Entregadas",
       f."pendientes" AS "Pendientes",
       ROUND(COALESCE(f."entregadas", 0)
             / NULLIF(f."unidades", 0) * 100, 1) AS "% Cumplimiento",
       f."temporada" AS "Temporada"
FROM "public"."ps_gc_pedidos" f
JOIN "public"."ps_clientes" c ON f."num_cliente" = c."reg_cliente"
WHERE f."pedido_cerrado" = false
  AND f."abono" = false
  AND COALESCE(f."pendientes", 0) > 0
  AND __gf_cliente_mayorista__
ORDER BY (CURRENT_DATE - f."fecha_pedido") DESC,
         f."pendientes" DESC
LIMIT 20`,
    },
    {
      // Recent albaranes. ps_gc_albaranes is aliased as `f` so the cliente
      // filter (bind_expr = f."num_cliente") applies.
      id: "mayorista-albaranes-recientes",
      type: "table",
      title: "Albaranes Recientes",
      sql: `SELECT (f."n_albaran")::bigint AS "Albarán",
       ${CLIENTE_LABEL} AS "Cliente",
       f."fecha_envio" AS "Fecha",
       f."entregadas" AS "Unidades",
       (COALESCE(f."base1",0) + COALESCE(f."base2",0)
        + COALESCE(f."base3",0)) AS "Importe Neto"
FROM "public"."ps_gc_albaranes" f
JOIN "public"."ps_clientes" c ON f."num_cliente" = c."reg_cliente"
WHERE f."abono" = false
  AND f."fecha_envio" >= :curr_from
  AND f."fecha_envio" <= :curr_to
  AND __gf_cliente_mayorista__
ORDER BY f."fecha_envio" DESC, f."reg_albaran" DESC
LIMIT 20`,
    },
    {
      // Top 10 productos vendidos en el canal mayorista.
      // LEFT JOIN ps_articulos / ps_familias (see KPI Margen comment for
      // rationale on why this is LEFT, not INNER).
      // Join key: lf.num_factura = f.reg_factura.
      id: "mayorista-top-productos",
      type: "table",
      title: "Top 10 Productos Mayorista",
      sql: `SELECT COALESCE(NULLIF(TRIM(p."ccrefejofacm"), ''),
                NULLIF(TRIM(lf."codigo"), ''),
                '—') AS "Referencia",
       COALESCE(NULLIF(TRIM(p."descripcion"), ''),
                NULLIF(TRIM(lf."descripcion"), ''),
                '—') AS "Descripción",
       SUM(lf."unidades") AS "Unidades",
       SUM(lf."total") AS "Importe",
       ROUND((SUM(lf."total") - SUM(lf."total_coste"))
         / NULLIF(SUM(lf."total"), 0) * 100, 1) AS "Margen %"
FROM "public"."ps_gc_lin_facturas" lf
JOIN "public"."ps_gc_facturas" f ON lf."num_factura" = f."reg_factura"
LEFT JOIN "public"."ps_articulos" p ON lf."codigo" = p."codigo"
LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia"
WHERE f."abono" = false
  AND lf."unidades" > 0
  AND f."fecha_factura" >= :curr_from
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__
  AND __gf_familia__
  AND __gf_temporada__
  AND __gf_marca__
GROUP BY 1, 2
ORDER BY "Importe" DESC
LIMIT 10`,
    },
    {
      // Tendencia mensual con un mínimo de 12 meses de contexto.
      //
      // The chart anchors to :curr_to and shows AT LEAST the last 12 months
      // ending there. If the user picks a wider time-picker range than 12
      // months, the chart expands to cover :curr_from..:curr_to instead —
      // we accomplish that with `LEAST(:curr_from::date, anchor_12m_back)`.
      // A narrow time-picker (e.g. 7 days) therefore still produces a
      // legible 13-point monthly trend, while a 24-month picker shows the
      // full 24 months.
      //
      // Both :curr_from and :curr_to are referenced so the widget honours
      // the time-picker invariant enforced by templates.test.ts.
      id: "mayorista-comparativa-mensual",
      type: "line_chart",
      title: "Facturación Mensual (últimos 12 meses o más)",
      sql: `SELECT DATE_TRUNC('month', f."fecha_factura")::date AS x,
       SUM(COALESCE(f."base1", 0)
           + COALESCE(f."base2", 0)
           + COALESCE(f."base3", 0)) AS y
FROM "public"."ps_gc_facturas" f
WHERE f."abono" = false
  AND f."fecha_factura" >= LEAST(
        :curr_from::date,
        (DATE_TRUNC('month', :curr_to::date) - INTERVAL '12 months')::date)
  AND f."fecha_factura" <= :curr_to
  AND __gf_cliente_mayorista__
GROUP BY 1
ORDER BY 1`,
      x: "x",
      y: "y",
    },
  ],
};
