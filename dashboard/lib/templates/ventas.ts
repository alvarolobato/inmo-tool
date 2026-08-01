/**
 * Template: Responsable de Ventas (retail)
 *
 * Panel diario para el responsable de tienda / ventas retail. Cubre la pregunta
 * de la mañana — "¿cómo vamos hoy?" — y el cierre de día/semana/mes:
 *   - KPIs de actividad (ventas netas, tickets, ticket medio, unidades/ticket)
 *   - Comparativas (% devoluciones, YoY)
 *   - Desglose por tienda (volumen + margen)
 *   - Tendencia diaria
 *   - Mix de formas de pago
 *   - Top artículos con margen
 *
 * Decisiones de negocio (mantener consistentes en todos los widgets):
 *   - Tienda 99 excluida en todas las queries de retail (es la "tienda fantasma"
 *     usada para movimientos internos / no comerciales).
 *   - "Ventas Netas" = SUM(total_si) sobre tickets con entrada=true (importe sin
 *     impuestos). Las devoluciones (entrada=false) se muestran aparte y NO se
 *     restan del KPI principal — coherente con el desglose por tienda.
 *   - Margen: solo líneas con total_si > 0 (excluye líneas regalo / coste cero).
 *   - Marketplace / web: actualmente todo retail está consolidado (campo
 *     `pedido_web` está casi vacío, ver `ps_ventas`). Si se quiere desglose
 *     online vs físico habrá que segmentar por `pedido_web IS NOT NULL`.
 *   - IVA: `total_si` excluye impuestos (sufijo `_si` = sin impuestos).
 *
 * Tokens:
 *   - `:curr_from` / `:curr_to`  — rango temporal (todos los widgets reaccionan).
 *   - `__gf_tienda__`            — filtro tienda (todos los widgets reaccionan).
 *   - `__gf_familia__` / `__gf_temporada__` / `__gf_marca__` /
 *     `__gf_sexo__` / `__gf_departamento__` — solo widgets que se unen a
 *     `ps_articulos` (margen y top artículos). Los KPIs sobre `ps_ventas` no
 *     se filtran por estos campos (no hay join), expandiéndose a TRUE.
 */
import type { DashboardSpec } from "@/lib/schema";
import { templateGlobalFiltersRetail } from "@/lib/template-global-filters";

export const name = "Responsable de Ventas";

export const description =
  "Panel para el responsable de ventas retail: KPIs (ventas netas, tickets, ticket medio, unidades por ticket), % devoluciones y YoY, desglose por tienda, tendencia diaria, formas de pago, margen por tienda y top artículos.";

export const spec: DashboardSpec = {
  title: "Cuadro de Mandos — Ventas Retail",
  description,
  filters: templateGlobalFiltersRetail,
  widgets: [
    {
      id: "ventas-kpis",
      type: "kpi_row",
      items: [
        {
          label: "Ventas Netas",
          // SUM(total_si) sobre tickets de venta (entrada=true). No incluye IVA.
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
          label: "Tickets",
          // COUNT(DISTINCT reg_ventas) — un ticket puede tener varias líneas.
          sql: `SELECT COUNT(DISTINCT v."reg_ventas") AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__`,
          format: "number",
        },
        {
          label: "Ticket Medio",
          // Importe medio por ticket = SUM(total_si) / COUNT(DISTINCT reg_ventas).
          // NULLIF protege contra rango sin tickets (división por cero).
          sql: `SELECT ROUND(SUM(v."total_si") / NULLIF(COUNT(DISTINCT v."reg_ventas"), 0), 2) AS value
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
          label: "Unidades por Ticket",
          // Unidades vendidas / tickets. Indicador de "cesta media".
          // El denominador cuenta tickets con al menos una línea — si ningún
          // ticket tiene líneas, NULLIF evita la división por cero.
          // COALESCE evita "—" cuando el rango no tiene líneas.
          // Usa format: "decimal" porque es un ratio fraccional (p.ej. 1,69):
          // "number" lo redondearía a entero (→ 2) y perdería precisión.
          sql: `SELECT COALESCE(ROUND(SUM(lv."unidades")::numeric / NULLIF(COUNT(DISTINCT v."reg_ventas"), 0), 2), 0) AS value
FROM "public"."ps_lineas_ventas" lv
JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas"
WHERE v."entrada" = true
  AND lv."tienda" <> '99'
  AND lv."fecha_creacion" >= :curr_from
  AND lv."fecha_creacion" <= :curr_to
  AND __gf_tienda__`,
          format: "decimal",
        },
        {
          label: "Devoluciones",
          // ABS(SUM(total_si)) sobre tickets de devolución (entrada=false).
          // ABS porque los importes vienen negativos.
          // `inverted: true` indica al renderer que un valor que sube es malo.
          sql: `SELECT COALESCE(ABS(SUM(v."total_si")), 0) AS value
FROM "public"."ps_ventas" v
WHERE v."entrada" = false
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__`,
          format: "currency",
          prefix: "€",
          inverted: true,
        },
        {
          label: "% Devoluciones",
          // Devoluciones como % del flujo bruto (ventas + devoluciones absolutas).
          // Denominador NULLIF para rangos vacíos.
          sql: `SELECT ROUND(
  COALESCE(devo.imp, 0) / NULLIF(ven.imp + COALESCE(devo.imp, 0), 0) * 100, 1
) AS value
FROM (
  SELECT COALESCE(SUM(v."total_si"), 0) AS imp
  FROM "public"."ps_ventas" v
  WHERE v."entrada" = true AND v."tienda" <> '99'
    AND v."fecha_creacion" >= :curr_from
    AND v."fecha_creacion" <= :curr_to
    AND __gf_tienda__
) ven,
(
  SELECT COALESCE(ABS(SUM(v."total_si")), 0) AS imp
  FROM "public"."ps_ventas" v
  WHERE v."entrada" = false AND v."tienda" <> '99'
    AND v."fecha_creacion" >= :curr_from
    AND v."fecha_creacion" <= :curr_to
    AND __gf_tienda__
) devo`,
          format: "percent",
          inverted: true,
        },
        {
          label: "Ventas YoY %",
          // Comparativa con el mismo período un año antes.
          // `:curr_from::date - INTERVAL '1 year'` — el cast a ::date es necesario
          // para que PostgreSQL interprete el token como fecha (ver test
          // "YoY-style SQL uses :curr_*::date before INTERVAL" en templates.test.ts).
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
      id: "ventas-por-tienda",
      type: "bar_chart",
      title: "Ventas Netas por Tienda (período seleccionado)",
      sql: `SELECT v."tienda" AS label, SUM(v."total_si") AS value
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
      id: "ventas-tendencia-diaria",
      type: "line_chart",
      title: "Tendencia Diaria de Ventas (período seleccionado)",
      // Bucketización diaria: para 30 días produce 30 puntos (más útil que
      // 4-5 puntos semanales en el rango por defecto). Para rangos largos
      // (>1 año) considerar cambiar a 'week' o 'month' en una versión futura.
      sql: `SELECT v."fecha_creacion" AS x, SUM(v."total_si") AS y
FROM "public"."ps_ventas" v
WHERE v."entrada" = true
  AND v."tienda" <> '99'
  AND v."fecha_creacion" >= :curr_from
  AND v."fecha_creacion" <= :curr_to
  AND __gf_tienda__
GROUP BY v."fecha_creacion"
ORDER BY x`,
      x: "x",
      y: "y",
    },
    {
      id: "ventas-formas-pago",
      type: "donut_chart",
      title: "Mix de Formas de Pago (período seleccionado)",
      // p.entrada = true filtra los pagos que son cobros (no devoluciones de pago).
      // Sin este filtro aparecerían formas como "Devolución Vale" / "Devolución
      // Metálico" mezcladas con los cobros normales y distorsionarían el mix.
      // El filtro v.entrada = true asegura que solo miramos tickets de venta.
      sql: `SELECT p."forma" AS label,
       SUM(p."importe_cob") AS value
FROM "public"."ps_pagos_ventas" p
JOIN "public"."ps_ventas" v ON p."num_ventas" = v."reg_ventas"
WHERE v."entrada" = true
  AND p."entrada" = true
  AND p."tienda" <> '99'
  AND p."fecha_creacion" >= :curr_from
  AND p."fecha_creacion" <= :curr_to
  AND __gf_tienda__
GROUP BY p."forma"
ORDER BY value DESC`,
      x: "label",
      y: "value",
    },
    {
      id: "ventas-margen-tienda",
      type: "bar_chart",
      title: "Margen Bruto % por Tienda (período seleccionado)",
      // Margen = (ventas - coste) / ventas * 100.
      // total_si > 0 excluye líneas regalo / promocionales con importe 0
      // que distorsionan el margen calculado.
      // NULLIF evita división por cero cuando todas las líneas son 0.
      sql: `SELECT lv."tienda" AS label,
       ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si"))
         / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS value
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
GROUP BY lv."tienda"
ORDER BY value DESC`,
      x: "label",
      y: "value",
    },
    {
      id: "ventas-top-articulos",
      type: "table",
      title: "Top 10 Artículos por Ventas (período seleccionado)",
      // Columna "Ventas Netas (€)" — incluye sufijo de unidad para que el
      // usuario sepa que es importe (TableWidget no aplica símbolo €
      // automáticamente). "Margen %" se renderiza con formato de porcentaje
      // (detectado por el sufijo "%").
      sql: `SELECT p."ccrefejofacm" AS "Referencia",
       p."descripcion" AS "Descripción",
       SUM(lv."unidades") AS "Unidades",
       ROUND(SUM(lv."total_si")::numeric, 2) AS "Ventas Netas (€)",
       ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si"))
         / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS "Margen %"
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
GROUP BY p."ccrefejofacm", p."descripcion"
ORDER BY "Ventas Netas (€)" DESC
LIMIT 10`,
    },
  ],
};
