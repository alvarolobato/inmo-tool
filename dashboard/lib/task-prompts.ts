/**
 * Task-oriented prompts for the "¿Qué necesitas hacer?" section of the New Dashboard page.
 *
 * These are 6 hardcoded, decision-support prompts for common business tasks.
 * Each prompt is pre-optimised for the LLM and references the correct table names.
 * Retail-focused prompts apply the standard business rules (total_si, entrada=true,
 * tienda<>'99'); wholesale prompts use the mayorista tables and rules (base1+base2+base3,
 * abono=false). Not all rules apply to every prompt — see each entry for details.
 */

export interface TaskPrompt {
  id: string;
  title: string;
  description: string;
  icon: string;
  prompt: string;
}

export const TASK_PROMPTS: TaskPrompt[] = [
  {
    id: "weekly-sales-meeting",
    title: "Preparar la reunión semanal de ventas",
    description: "Tendencias semana vs semana anterior, KPIs y ranking de tiendas",
    icon: "📊",
    prompt:
      "Crea un cuadro de mandos para la reunión semanal de ventas. Incluye: KPIs clave de la semana actual (ventas netas usando total_si, tickets, ticket medio, unidades) comparados con la semana anterior usando ps_ventas con entrada=true y tienda<>'99'; gráfico de barras con ventas por tienda ordenado de mayor a menor; gráfico de líneas con la tendencia diaria de ventas de las últimas 4 semanas; tabla con las 5 tiendas con mayor crecimiento y las 5 con mayor caída vs semana anterior; y gráfico de barras con ventas por familia de producto (JOIN ps_lineas_ventas con ps_ventas para filtrar entrada=true, luego JOIN con ps_articulos y ps_familias). Filtra siempre entrada=true en ps_ventas y tienda<>'99'. Nota: ps_lineas_ventas NO tiene campo entrada — aplica el filtro siempre vía JOIN con ps_ventas. Usa total_si para importes. Muestra deltas porcentuales donde sea posible.",
  },
  {
    id: "replenishment",
    title: "Decidir qué reponer esta semana",
    description: "Stock bajo, sell-through, cobertura de días y sugerencias de reposición",
    icon: "📦",
    prompt:
      "Crea un cuadro de mandos para decisiones de reposición semanal. Incluye: KPIs de stock (artículos con ps_stock_tienda.stock=0, artículos con cobertura <7 días, ventas totales últimos 7 días usando total_si de ps_ventas con entrada=true) uniendo ps_stock_tienda con ps_lineas_ventas y ps_articulos; tabla con los 20 artículos con menor cobertura de días estimada (ps_stock_tienda.stock / MAX(1, SUM(lv.unidades)/14) calculado sobre últimas 2 semanas) uniendo ps_stock_tienda con ps_lineas_ventas y ps_articulos; gráfico de barras con rotación por familia (SUM unidades vendidas del último mes / AVG stock actual) para priorizar familias con alta rotación y poco stock; tabla con los top 20 artículos más vendidos en unidades del último mes que tienen ps_stock_tienda.stock < 10; y distribución de stock total por tienda en gráfico de barras. Usa ps_articulos.ccrefejofacm como referencia y filtra entrada=true vía JOIN con ps_ventas. Muestra descripcion, referencia, stock actual, unidades vendidas últimas 2 semanas y días estimados de cobertura.",
  },
  {
    id: "store-performance",
    title: "Revisar el rendimiento de una tienda",
    description: "Ranking de tiendas, KPIs comparativos y contribución de cada tienda a la cadena",
    icon: "🏪",
    prompt:
      "Crea un cuadro de mandos para el análisis comparativo de rendimiento de tiendas retail. Incluye: KPIs del mes actual de la cadena (ventas netas totales usando total_si, tickets, ticket medio) usando ps_ventas con entrada=true y tienda<>'99'; gráfico de barras horizontales con ranking de tiendas por ventas netas del mes (excluir tienda 99); tabla con métricas por tienda (ventas total_si, tickets, ticket medio, variación % vs mes anterior) ordenada por ventas; gráfico de líneas con evolución semanal de las top 5 tiendas en las últimas 8 semanas; y gráfico de barras con contribución porcentual de cada tienda a las ventas totales de la cadena. Filtra siempre entrada=true y tienda<>'99'. Usa total_si para todos los importes.",
  },
  {
    id: "wholesale-analysis",
    title: "Analizar el canal mayorista",
    description: "KPIs mayoristas, top clientes, albaranes pendientes y márgenes",
    icon: "🤝",
    prompt:
      "Crea un cuadro de mandos para el análisis del canal mayorista. Incluye: KPIs clave mayoristas (facturación base1+base2+base3, número de facturas, clientes activos del mes, ticket medio mayorista) del mes actual usando ps_gc_facturas; tabla con top 10 clientes mayoristas por facturación del trimestre (JOIN ps_gc_facturas con ps_clientes usando num_cliente = reg_cliente); gráfico de barras con facturación mayorista por mes de los últimos 6 meses usando ps_gc_facturas; tabla con albaranes del mes que aún no tienen factura asociada (ps_gc_albaranes sin correspondiente en ps_gc_facturas) con cliente, importe base1+base2+base3 y fecha_envio; y gráfico de donut con distribución de ventas mayoristas por familia de artículo (JOIN ps_gc_lin_facturas con ps_articulos y ps_familias). Excluir abono=true en todas las consultas. Usar base1+base2+base3 NUNCA total_factura para importes mayoristas.",
  },
  {
    id: "month-end",
    title: "Preparar el cierre de mes",
    description: "Totales mensuales vs objetivo, YTD, evolución de márgenes y tasa de devolución",
    icon: "📅",
    prompt:
      "Crea un cuadro de mandos para el cierre mensual. Incluye: KPIs del mes (ventas netas total_si, devoluciones, ventas brutas, tasa de devolución %, ticket medio, tickets totales) usando ps_ventas para el rango de fechas seleccionado; gráfico de barras con ventas por mes de los últimos 12 meses (agrupa por mes truncando fecha_creacion al mes, no uses un campo 'mes'); tabla con top 10 categorías/familias del mes por ventas netas (JOIN ps_lineas_ventas con ps_ventas para filtrar entrada=true, luego JOIN con ps_articulos y ps_familias); gráfico de líneas con evolución mensual YTD del año actual; y tabla comparativa por tienda con ventas del mes, mes anterior y variación %. Filtra entrada=true para ventas y entrada=false para devoluciones. Usa total_si para todos los importes. Excluir tienda 99.",
  },
  {
    id: "period-comparison",
    title: "Comparar periodos de ventas",
    description: "Análisis delta entre dos periodos: tiendas, categorías y KPIs clave",
    icon: "🔄",
    prompt:
      "Crea un cuadro de mandos para la comparación de dos periodos de ventas. Incluye: KPIs comparativos (ventas netas, tickets, ticket medio, unidades) para el trimestre actual vs trimestre anterior usando ps_ventas; gráfico de barras agrupado con ventas por tienda en ambos periodos (excluir tienda 99); tabla con variación por tienda (ventas periodo 1, periodo 2, delta €, delta %) ordenada por mayor caída; gráfico de barras con ventas por familia de producto comparando ambos periodos (JOIN con ps_articulos y ps_familias); y tabla con los 10 artículos con mayor crecimiento y los 10 con mayor caída entre periodos. Usa total_si y filtra entrada=true. Muestra siempre los deltas absolutos y porcentuales.",
  },
];
