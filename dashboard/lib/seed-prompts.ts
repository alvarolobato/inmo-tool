// Seed prompts for action-to-chat flows (issue #504)

export const WEEKLY_SUMMARY_SEED = `Necesito un resumen ejecutivo del rendimiento del negocio de **la semana ISO en curso** comparada con la semana anterior y con la misma semana hace un año.

Usa las herramientas disponibles (validate_query, execute_query, list_ps_tables, describe_ps_table) para consultar datos en tiempo real. Valida cada consulta antes de ejecutarla. No estimes ni supongas cifras — extráelas directamente de las tablas ps_*.

Estructura el resumen en estas secciones:

## 1. Ventas totales
- Ventas netas retail (ps_ventas): importe total (total_si), número de tickets, ticket medio
  - Filtros obligatorios: entrada = true (sólo tickets de entrada), tienda != '99' (excluye almacén central)
- Comparativa semana anterior y misma semana año anterior (variación % y valor absoluto)
- Ventas mayorista: usa ps_gc_facturas (una fila por factura) con abono = false para excluir abonos/notas de crédito; importe neto = base1 + base2 + base3

## 2. Top 3 tiendas por ventas netas
- Tabla con: tienda, ventas netas semana, variación vs semana anterior (%)
- Usar ps_ventas agrupado por tienda, uniendo con ps_tiendas para el nombre

## 3. Margen
- Margen bruto % de la semana si hay campos de coste disponibles en ps_lineas_ventas (usa describe_ps_table para verificar nombres de columnas antes de calcular)
- Tendencia: ¿mejora o empeora respecto a la semana anterior?

## 4. Anomalías
- Identifica cualquier KPI que se desvíe más de 3 sigma respecto a la media de las últimas 8 semanas
- Tiendas con caída brusca o pico inusual de ventas
- Productos o familias con comportamiento atípico

## 5. Recomendaciones de acción
- Lista de 3-5 acciones concretas ordenadas por impacto estimado
- Cada recomendación debe referenciar la métrica que la justifica

Ventana temporal: semana ISO en curso (desde el lunes hasta hoy). Para comparativas usa DATE_TRUNC('week', CURRENT_DATE) en PostgreSQL.

Responde en español, usa markdown con tablas y números formateados (€ para importes, % para variaciones).`;
