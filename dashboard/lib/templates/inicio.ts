/**
 * Template: Pantalla de Inicio (Home Dashboard)
 *
 * Panel fijo de "estado del negocio de un vistazo" que se muestra en /inicio.
 * NO es editable por el usuario ni se persiste en BD — se renderiza
 * directamente desde este módulo como un read-only dashboard.
 *
 * ## Decisiones de diseño (D-026)
 *
 *   - Sin `:curr_from` / `:curr_to`: los rangos temporales son implícitos
 *     mediante `CURRENT_DATE` / `DATE_TRUNC`. No hay date-picker en la página.
 *   - Sin filtros globales (`filters: []`): el panel es de lectura y no expone
 *     controles de filtrado.
 *   - Sin chat sidebar, sin botón Guardar, sin botón Modificar.
 *   - Hereda las reglas de negocio de ventas.ts y general.ts:
 *       · tienda = '99' excluida (tienda fantasma).
 *       · entrada = true para ventas, entrada = false para devoluciones.
 *       · total_si = importe sin IVA.
 *       · total_coste_si = coste sin IVA (para margen).
 *       · ps_gc_facturas.abono = false para facturación mayorista.
 *
 * ## Mapa de dominios → etl_watermarks (validado 2026-05-02)
 *
 *   | Widget KPI               | table_name en etl_watermarks                      |
 *   |--------------------------|---------------------------------------------------|
 *   | Ventas (h desde sync)    | ventas, lineas_ventas                             |
 *   | Stock (h desde sync)     | stock                                             |
 *   | Compras (h desde sync)   | compras, lineas_compras, facturas_compra          |
 *   | Mayorista (h desde sync) | gc_facturas, gc_lin_facturas, gc_pedidos          |
 *
 * ## ps_tiendas (validado 2026-05-02)
 *
 *   La tabla tiene solo 3 columnas: reg_tienda, codigo, fecha_modifica.
 *   NO existe campo activa/anulada. Widget 9 lista todas las tiendas excepto '99'.
 *
 * ## LineChartWidget (validado 2026-05-02)
 *
 *   El componente LineChartWidget.tsx soporta una sola serie (columnas x/y).
 *   No soporta un campo `series` para multi-serie. Por tanto, el widget 6
 *   agrega TODAS las tiendas en una sola línea de evolución total diaria.
 *   Esto es preferible a mostrar solo N tiendas, y evita añadir un tipo de
 *   widget nuevo.
 */
import type { DashboardSpec } from "@/lib/schema";

export const name = "Inicio";

export const description =
  "Estado del negocio de un vistazo: datos frescos, ventas hoy/semana/mes vs período anterior y YoY, evolución diaria, top tiendas, mayorista y alertas.";

export const spec: DashboardSpec = {
  title: "Pantalla de Inicio — Estado del Negocio",
  description,
  filters: [],
  widgets: [
    // -----------------------------------------------------------------------
    // Widget 1: Estado de los datos (frescura por dominio)
    // -----------------------------------------------------------------------
    {
      id: "inicio-freshness",
      type: "kpi_row",
      items: [
        {
          label: "Ventas (h desde sync)",
          // Horas desde la última sincronización del dominio de ventas.
          // MAX sobre dos tablas del mismo dominio para usar la más reciente.
          sql: `SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(last_sync_at)))/3600.0, 1) AS value
FROM "public"."etl_watermarks"
WHERE table_name IN ('ventas','lineas_ventas')`,
          format: "decimal",
        },
        {
          label: "Stock (h desde sync)",
          sql: `SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(last_sync_at)))/3600.0, 1) AS value
FROM "public"."etl_watermarks"
WHERE table_name IN ('stock')`,
          format: "decimal",
        },
        {
          label: "Compras (h desde sync)",
          sql: `SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(last_sync_at)))/3600.0, 1) AS value
FROM "public"."etl_watermarks"
WHERE table_name IN ('compras','lineas_compras','facturas_compra')`,
          format: "decimal",
        },
        {
          label: "Mayorista (h desde sync)",
          sql: `SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(last_sync_at)))/3600.0, 1) AS value
FROM "public"."etl_watermarks"
WHERE table_name IN ('gc_facturas','gc_lin_facturas','gc_pedidos')`,
          format: "decimal",
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 2: Ventas Hoy vs Ayer vs Hoy año pasado
    // -----------------------------------------------------------------------
    {
      id: "inicio-ventas-hoy",
      type: "kpi_row",
      items: [
        {
          label: "Ventas Hoy",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion"::date = CURRENT_DATE`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Ventas Ayer",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion"::date = CURRENT_DATE - INTERVAL '1 day'`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Ventas Hoy (año pasado)",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion"::date = (CURRENT_DATE - INTERVAL '1 year')::date`,
          format: "currency",
          prefix: "€",
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 3: Ventas Esta Semana vs Semana pasada vs Semana YoY
    // -----------------------------------------------------------------------
    {
      id: "inicio-ventas-semana",
      type: "kpi_row",
      items: [
        {
          label: "Ventas Esta Semana",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('week', CURRENT_DATE)::date
  AND v."fecha_creacion" < (DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week')::date`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Semana Pasada",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')::date
  AND v."fecha_creacion" < (DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week') + INTERVAL '1 week')::date`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Esta Semana (año pasado)",
          // La semana que contiene la fecha de hace exactamente 1 año.
          // DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 year') devuelve el
          // lunes de la semana en que cae la misma fecha del año anterior; no
          // garantiza semana ISO equivalente si CURRENT_DATE es lunes (cruce de
          // semana ISO). Para el propósito del panel de inicio esta aproximación
          // es suficiente y consistente con la lógica del resto de comparativas YoY.
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 year')::date
  AND v."fecha_creacion" < (DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 year') + INTERVAL '1 week')::date`,
          format: "currency",
          prefix: "€",
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 4: Ventas Este Mes vs Mes Pasado vs Mes YoY
    // -----------------------------------------------------------------------
    {
      id: "inicio-ventas-mes",
      type: "kpi_row",
      items: [
        {
          label: "Ventas Este Mes",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('month', CURRENT_DATE)::date
  AND v."fecha_creacion" < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Mes Pasado",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::date
  AND v."fecha_creacion" < DATE_TRUNC('month', CURRENT_DATE)::date`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Este Mes (año pasado)",
          sql: `SELECT COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 year')::date
  AND v."fecha_creacion" < (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 year') + INTERVAL '1 month')::date`,
          format: "currency",
          prefix: "€",
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 5: KPIs operativos (hoy + mes actual)
    // -----------------------------------------------------------------------
    {
      id: "inicio-kpis-operativos",
      type: "kpi_row",
      items: [
        {
          label: "Tickets Hoy",
          sql: `SELECT COUNT(DISTINCT v."reg_ventas") AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion"::date = CURRENT_DATE`,
          format: "number",
        },
        {
          label: "Ticket Medio Hoy",
          // NULLIF evita división por cero cuando no hay ventas hoy.
          sql: `SELECT ROUND(
  SUM(v."total_si") / NULLIF(COUNT(DISTINCT v."reg_ventas"), 0), 2
) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion"::date = CURRENT_DATE`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Margen del Mes (%)",
          // Margen bruto retail del mes actual. Solo líneas con total_si > 0
          // para excluir líneas regalo / coste cero (mismo criterio que ventas.ts).
          sql: `SELECT ROUND(
  (SUM(lv."total_si") - SUM(lv."total_coste_si"))
  / NULLIF(SUM(lv."total_si"), 0) * 100, 1
) AS value
FROM "public"."ps_lineas_ventas" lv
JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
WHERE v."entrada" = true
  AND lv."tienda" <> '99'
  AND lv."total_si" > 0
  AND lv."fecha_creacion" >= DATE_TRUNC('month', CURRENT_DATE)::date
  AND lv."fecha_creacion" < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date`,
          format: "percent",
        },
        {
          label: "Devoluciones Hoy (%)",
          // Devoluciones (entrada=false) sobre bruto de hoy (entrada=true).
          // `inverted: true` indica al renderer que un valor que sube es malo.
          sql: `SELECT ROUND(
  COALESCE(SUM(CASE WHEN v."entrada" = false THEN ABS(v."total_si") ELSE 0 END), 0)
  / NULLIF(
      COALESCE(SUM(CASE WHEN v."entrada" = true THEN v."total_si" ELSE 0 END), 0),
    0) * 100, 1
) AS value
FROM "public"."ps_ventas" v
WHERE v."tienda" <> '99'
  AND v."fecha_creacion"::date = CURRENT_DATE`,
          format: "percent",
          inverted: true,
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 6: Evolución diaria de ventas — últimos 30 días (total agregado)
    //
    // LineChartWidget solo soporta una serie (columnas x/y). No hay soporte
    // para un campo `series`. Se agrega el total de todas las tiendas en una
    // única línea de tendencia diaria. Ver nota en la cabecera del módulo.
    // -----------------------------------------------------------------------
    {
      id: "inicio-evolucion-diaria",
      type: "line_chart",
      title: "Evolución Diaria de Ventas — Últimos 30 Días (todas las tiendas)",
      sql: `SELECT v."fecha_creacion"::date AS x, COALESCE(SUM(v."total_si"), 0) AS y
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY v."fecha_creacion"::date
ORDER BY x`,
      x: "x",
      y: "y",
    },

    // -----------------------------------------------------------------------
    // Widget 7: Top 10 tiendas — mes actual
    // -----------------------------------------------------------------------
    {
      id: "inicio-top-tiendas",
      type: "bar_chart",
      title: "Top 10 Tiendas por Ventas — Mes Actual",
      sql: `SELECT v."tienda" AS label, COALESCE(SUM(v."total_si"), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= DATE_TRUNC('month', CURRENT_DATE)::date
  AND v."fecha_creacion" < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date
GROUP BY v."tienda"
ORDER BY value DESC
LIMIT 10`,
      x: "label",
      y: "value",
    },

    // -----------------------------------------------------------------------
    // Widget 8: KPIs mayorista + compras + stock
    // -----------------------------------------------------------------------
    {
      id: "inicio-kpis-operaciones",
      type: "kpi_row",
      items: [
        {
          label: "Facturación Mayorista (mes)",
          // Suma de las tres bases imponibles de las facturas mayorista del mes actual.
          // `abono = false` excluye las notas de crédito/abono (misma regla que general.ts).
          // Range predicate instead of DATE_TRUNC on the column, so any
          // future index on fecha_factura can be used.
          sql: `SELECT COALESCE(SUM("base1" + "base2" + "base3"), 0) AS value
FROM "public"."ps_gc_facturas"
WHERE "abono" = false
  AND "fecha_factura" >= DATE_TRUNC('month', CURRENT_DATE)::date
  AND "fecha_factura" < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date`,
          format: "currency",
          prefix: "€",
        },
        {
          label: "Pedidos Mayorista Pendientes",
          // Pedidos abiertos con unidades pendientes de entregar.
          // Mismos predicados que general.ts (pedido_cerrado, abono, pendientes).
          sql: `SELECT COUNT(DISTINCT "reg_pedido") AS value
FROM "public"."ps_gc_pedidos"
WHERE "pedido_cerrado" = false
  AND "abono" = false
  AND "pendientes" > 0`,
          format: "number",
        },
        {
          label: "Pedidos de Compra Pendientes",
          // ps_compras.fecha_recibido IS NULL = pedido sin recibir todavía.
          // No existe campo "cerrado" en ps_compras (validado 2026-05-02 con \d).
          sql: `SELECT COUNT(*) AS value
FROM "public"."ps_compras"
WHERE "fecha_recibido" IS NULL`,
          format: "number",
        },
        {
          label: "Valor Stock al Coste",
          // Aproximación del capital inmovilizado: unidades × precio_coste.
          // Excluye artículos anulados y líneas con stock ≤ 0.
          // Misma query que general.ts (validado).
          sql: `SELECT COALESCE(ROUND(SUM(s."stock" * p."precio_coste")::numeric, 2), 0) AS value
FROM "public"."ps_stock_tienda" s
JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo"
WHERE s."stock" > 0 AND p."anulado" = false`,
          format: "currency",
          prefix: "€",
        },
      ],
    },

    // -----------------------------------------------------------------------
    // Widget 9: Alertas — tiendas sin venta hoy
    //
    // ps_tiendas solo tiene: reg_tienda, codigo, fecha_modifica.
    // No existe campo activa/anulada (validado 2026-05-02 con \d ps_tiendas).
    // Se listan todas las tiendas excepto '99', con fecha de última modificación
    // del registro de tienda como referencia.
    // -----------------------------------------------------------------------
    {
      id: "inicio-tiendas-sin-venta",
      type: "table",
      title: "Alertas: Tiendas Sin Venta Hoy",
      sql: `SELECT t."codigo" AS "Tienda", t."fecha_modifica" AS "Última Modif. Registro"
FROM "public"."ps_tiendas" t
LEFT JOIN "public"."ps_ventas" v
  ON v."tienda" = t."codigo"
  AND v."entrada" = true
  AND v."fecha_creacion"::date = CURRENT_DATE
WHERE t."codigo" <> '99'
  AND v."reg_ventas" IS NULL
ORDER BY t."codigo"`,
    },
  ],
};
