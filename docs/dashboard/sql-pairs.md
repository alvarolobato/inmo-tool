# Dashboard SQL Pairs

Curated question → SQL examples for the dashboard LLM prompt.

These pairs teach the LLM how to translate natural-language business questions
into correct PostgreSQL queries against the `ps_*` mirror tables.

**Rules for new pairs:**
- Always use `:curr_from` / `:curr_to` for current-period date ranges (never `CURRENT_DATE` or bare `INTERVAL`).
- Use `:comp_from` / `:comp_to` only for explicitly comparative questions (YoY, año anterior, etc.).
- Always use `total_si` (not `total`) for sales amounts.
- Always filter `entrada = true` for sales, `entrada = false` for returns. **`entrada` exists only on `ps_ventas`, NOT on `ps_lineas_ventas`** — when querying `ps_lineas_ventas`, JOIN `ps_ventas v ON lv.num_ventas = v.reg_ventas` and filter `v.entrada`.
- Exclude tienda `'99'` from retail store rankings.
- Test new SQL against the local mirror with `ps sql query "..."`.

---

## LLM:sql-pairs

### ¿Cuáles son los 10 artículos más vendidos por cantidad?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(lv."unidades") AS "Unidades Vendidas" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" WHERE v."entrada" = true GROUP BY p."ccrefejofacm", p."descripcion" ORDER BY "Unidades Vendidas" DESC LIMIT 10
```

### ¿Cuáles son las ventas netas por tienda este mes?
```sql
SELECT v."tienda" AS "Tienda", SUM(v."total_si") AS "Ventas Netas", COUNT(DISTINCT v."reg_ventas") AS "Tickets" FROM "public"."ps_ventas" v WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true AND v."tienda" <> '99' GROUP BY v."tienda" ORDER BY "Ventas Netas" DESC
```

### ¿Cuáles son las ventas de la semana pasada por tienda?
```sql
SELECT v."tienda" AS "Tienda", SUM(v."total_si") AS "Ventas Netas", COUNT(DISTINCT v."reg_ventas") AS "Tickets" FROM "public"."ps_ventas" v WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true AND v."tienda" <> '99' GROUP BY v."tienda" ORDER BY "Ventas Netas" DESC
```

### ¿Cuál es el ticket medio?
```sql
SELECT ROUND(SUM("total_si") / COUNT(DISTINCT "reg_ventas"), 2) AS "Ticket Medio" FROM "public"."ps_ventas" WHERE "entrada" = true AND "tienda" <> '99' AND "fecha_creacion" BETWEEN :curr_from AND :curr_to
```

### ¿Cuántas devoluciones hubo este mes?
```sql
SELECT COUNT(*) AS "Devoluciones", ABS(SUM("total_si")) AS "Importe Devuelto" FROM "public"."ps_ventas" WHERE "entrada" = false AND "fecha_creacion" BETWEEN :curr_from AND :curr_to
```

### ¿Cuáles son las ventas de hoy?
```sql
SELECT v."tienda" AS "Tienda", SUM(v."total_si") AS "Ventas Netas", COUNT(DISTINCT v."reg_ventas") AS "Tickets" FROM "public"."ps_ventas" v WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true AND v."tienda" <> '99' GROUP BY v."tienda" ORDER BY "Ventas Netas" DESC
```

### ¿Cuánto vendimos ayer?
```sql
SELECT SUM("total_si") AS "Ventas Netas", COUNT(DISTINCT "reg_ventas") AS "Tickets" FROM "public"."ps_ventas" WHERE "fecha_creacion" BETWEEN :curr_from AND :curr_to AND "entrada" = true
```

### ¿Ventas netas acumuladas del año (YTD) comparadas con el año anterior?
```sql
SELECT 'Este año' AS "Período", SUM("total_si") AS "Ventas Netas", COUNT(DISTINCT "reg_ventas") AS "Tickets" FROM "public"."ps_ventas" WHERE "fecha_creacion" BETWEEN :curr_from AND :curr_to AND "entrada" = true UNION ALL SELECT 'Año anterior' AS "Período", SUM("total_si") AS "Ventas Netas", COUNT(DISTINCT "reg_ventas") AS "Tickets" FROM "public"."ps_ventas" WHERE "fecha_creacion" BETWEEN :comp_from AND :comp_to AND "entrada" = true
```

### ¿Ventas mensuales por tienda en el año actual?
```sql
SELECT DATE_TRUNC('month', v."fecha_creacion") AS "Mes", v."tienda" AS "Tienda", SUM(v."total_si") AS "Ventas Netas", COUNT(DISTINCT v."reg_ventas") AS "Tickets" FROM "public"."ps_ventas" v WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true AND v."tienda" <> '99' GROUP BY DATE_TRUNC('month', v."fecha_creacion"), v."tienda" ORDER BY "Mes", v."tienda"
```

### ¿Cuántas unidades vendimos la semana pasada?
```sql
SELECT SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true
```

### ¿Ventas por día de la semana?
```sql
SELECT TO_CHAR(v."fecha_creacion", 'Day') AS "Día", EXTRACT(DOW FROM v."fecha_creacion") AS "Num Día", SUM(v."total_si") AS "Ventas Netas", COUNT(DISTINCT v."reg_ventas") AS "Tickets" FROM "public"."ps_ventas" v WHERE v."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true AND v."tienda" <> '99' GROUP BY TO_CHAR(v."fecha_creacion", 'Day'), EXTRACT(DOW FROM v."fecha_creacion") ORDER BY EXTRACT(DOW FROM v."fecha_creacion")
```

### ¿Cuáles son los 10 artículos más vendidos por importe?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(lv."total_si") AS "Importe Neto", SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" WHERE v."entrada" = true GROUP BY p."ccrefejofacm", p."descripcion" ORDER BY "Importe Neto" DESC LIMIT 10
```

### ¿Qué familias de producto venden más?
```sql
SELECT fm."fami_grup_marc" AS "Familia", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia" WHERE v."entrada" = true GROUP BY fm."fami_grup_marc" ORDER BY "Ventas Netas" DESC
```

### ¿Ventas por departamento?
```sql
SELECT d."depa_secc_fabr" AS "Departamento", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" JOIN "public"."ps_departamentos" d ON p."num_departament" = d."reg_departament" WHERE v."entrada" = true GROUP BY d."depa_secc_fabr" ORDER BY "Ventas Netas" DESC
```

### ¿Ventas por temporada de la colección?
```sql
SELECT p."clave_temporada" AS "Temporada", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."unidades") AS "Unidades", COUNT(DISTINCT p."ccrefejofacm") AS "Artículos" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" WHERE v."entrada" = true GROUP BY p."clave_temporada" ORDER BY "Ventas Netas" DESC
```

### ¿Ventas por marca?
```sql
SELECT m."marca" AS "Marca", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" JOIN "public"."ps_marcas" m ON p."num_marca" = m."reg_marca" WHERE v."entrada" = true GROUP BY m."marca" ORDER BY "Ventas Netas" DESC
```

### ¿Cuántos artículos activos hay en el catálogo?
```sql
SELECT COUNT(*) AS "Total Artículos", SUM(CASE WHEN "ccrefejofacm" IS NULL OR "ccrefejofacm" NOT LIKE 'M%' THEN 1 ELSE 0 END) AS "Retail", SUM(CASE WHEN "ccrefejofacm" LIKE 'M%' THEN 1 ELSE 0 END) AS "Mayorista" FROM "public"."ps_articulos" WHERE "anulado" = false
```

### ¿Cuál es el stock total por tienda?
```sql
SELECT s."tienda" AS "Tienda", SUM(s."stock") AS "Stock Total", COUNT(DISTINCT s."codigo") AS "Artículos" FROM "public"."ps_stock_tienda" s WHERE s."stock" > 0 GROUP BY s."tienda" ORDER BY "Stock Total" DESC
```

### ¿Qué artículos tienen más stock en el almacén central?
```sql
SELECT s."codigo" AS "Código", p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(s."stock") AS "Stock" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."tienda" = '99' AND s."stock" > 0 GROUP BY s."codigo", p."ccrefejofacm", p."descripcion" ORDER BY "Stock" DESC LIMIT 20
```

### ¿Cuál es el valor del stock al coste?
```sql
SELECT SUM(s."stock" * p."precio_coste") AS "Valor al Coste", SUM(s."stock") AS "Unidades Totales", COUNT(DISTINCT s."codigo") AS "Referencias" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" > 0 AND p."anulado" = false
```

### ¿Stock por artículo y talla?
```sql
SELECT s."codigo" AS "Código", p."ccrefejofacm" AS "Referencia", s."talla" AS "Talla", SUM(s."stock") AS "Stock" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" > 0 GROUP BY s."codigo", p."ccrefejofacm", s."talla" ORDER BY p."ccrefejofacm", s."talla"
```

### ¿Artículos con stock negativo?
```sql
SELECT s."codigo" AS "Código", p."ccrefejofacm" AS "Referencia", s."tienda" AS "Tienda", s."talla" AS "Talla", s."stock" AS "Stock" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" < 0 ORDER BY s."stock" ASC LIMIT 50
```

### ¿Stock por familia de producto?
```sql
SELECT fm."fami_grup_marc" AS "Familia", SUM(s."stock") AS "Unidades", ROUND(SUM(s."stock" * p."precio_coste"), 2) AS "Valor Coste" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia" WHERE s."stock" > 0 AND p."anulado" = false GROUP BY fm."fami_grup_marc" ORDER BY "Unidades" DESC
```

### ¿Artículos con stock pero sin ventas recientes (dead stock)?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(s."stock") AS "Stock", p."clave_temporada" AS "Temporada" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" > 10 AND p."anulado" = false AND p."codigo" NOT IN (SELECT DISTINCT lv."codigo" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" WHERE lv."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true) GROUP BY p."ccrefejofacm", p."descripcion", p."clave_temporada" ORDER BY "Stock" DESC LIMIT 30
```

### ¿Top artículos vendidos con su stock actual?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(lv."unidades") AS "Unidades Vendidas", COALESCE(SUM(s."stock"), 0) AS "Stock Actual" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" LEFT JOIN "public"."ps_stock_tienda" s ON lv."codigo" = s."codigo" WHERE lv."fecha_creacion" BETWEEN :curr_from AND :curr_to AND v."entrada" = true GROUP BY p."ccrefejofacm", p."descripcion" ORDER BY "Unidades Vendidas" DESC LIMIT 20
```

### ¿Distribución de stock por talla?
```sql
SELECT s."talla" AS "Talla", SUM(s."stock") AS "Unidades" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" > 0 AND s."tienda" <> '99' AND p."anulado" = false GROUP BY s."talla" ORDER BY s."talla" ASC
```

### ¿Qué familias y tallas tienen más roturas de stock (referencias sin stock)?
```sql
WITH stock_por_codigo AS (SELECT COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), 'Sin clasificar') AS familia, s."talla", s."codigo", SUM(s."stock") AS stock_total FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia" WHERE s."tienda" <> '99' AND p."anulado" = false GROUP BY COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), 'Sin clasificar'), s."talla", s."codigo") SELECT familia AS "Familia", "talla" AS "Talla", COUNT(CASE WHEN stock_total <= 0 THEN 1 END) AS "Sin Stock", COUNT(CASE WHEN stock_total > 0 THEN 1 END) AS "Con Stock", COUNT(*) AS "Total Refs", ROUND(COUNT(CASE WHEN stock_total <= 0 THEN 1 END)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS "% Rotura" FROM stock_por_codigo GROUP BY familia, "talla" HAVING COUNT(CASE WHEN stock_total <= 0 THEN 1 END) > 0 ORDER BY "% Rotura" DESC
```

### ¿Qué artículos acumulan más stock por talla?
```sql
SELECT COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), 'Sin clasificar') AS "Familia", s."talla" AS "Talla", COALESCE(NULLIF(p."ccrefejofacm", ''), '—') AS "Referencia", COALESCE(NULLIF(p."descripcion", ''), '—') AS "Descripción", SUM(s."stock") AS "Stock" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" LEFT JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia" WHERE s."stock" > 0 AND s."tienda" <> '99' AND p."anulado" = false GROUP BY COALESCE(NULLIF(TRIM(fm."fami_grup_marc"), ''), 'Sin clasificar'), s."talla", COALESCE(NULLIF(p."ccrefejofacm", ''), '—'), COALESCE(NULLIF(p."descripcion", ''), '—') ORDER BY "Stock" DESC LIMIT 50
```

### ¿Cuál es la facturación mayorista por comercial?
```sql
SELECT c."comercial" AS "Comercial", COUNT(DISTINCT f."reg_factura") AS "Facturas", SUM(f."base1" + f."base2" + f."base3") AS "Facturación Neta" FROM "public"."ps_gc_facturas" f JOIN "public"."ps_gc_comerciales" c ON f."num_comercial" = c."reg_comercial" WHERE f."abono" = false GROUP BY c."comercial" ORDER BY "Facturación Neta" DESC
```

### ¿Facturación mayorista mensual del año actual?
```sql
SELECT DATE_TRUNC('month', f."fecha_factura") AS "Mes", COUNT(DISTINCT f."reg_factura") AS "Facturas", SUM(f."base1" + f."base2" + f."base3") AS "Importe Neto" FROM "public"."ps_gc_facturas" f WHERE f."fecha_factura" BETWEEN :curr_from AND :curr_to AND f."abono" = false GROUP BY DATE_TRUNC('month', f."fecha_factura") ORDER BY "Mes"
```

### ¿Cuáles son los principales clientes mayoristas por facturación?
```sql
SELECT c."nombre" AS "Cliente", COUNT(DISTINCT f."reg_factura") AS "Facturas", SUM(f."base1" + f."base2" + f."base3") AS "Facturación Neta" FROM "public"."ps_gc_facturas" f JOIN "public"."ps_clientes" c ON f."num_cliente" = c."reg_cliente" WHERE f."abono" = false GROUP BY c."nombre" ORDER BY "Facturación Neta" DESC LIMIT 20
```

### ¿Cuántos albaranes mayoristas se enviaron este mes?
```sql
SELECT COUNT(*) AS "Albaranes", SUM("entregadas") AS "Unidades", SUM("base1" + "base2" + "base3") AS "Importe Neto" FROM "public"."ps_gc_albaranes" WHERE "fecha_envio" BETWEEN :curr_from AND :curr_to AND "abono" = false
```

### ¿Notas de crédito mayoristas (abonos) del año?
```sql
SELECT c."nombre" AS "Cliente", COUNT(*) AS "Abonos", SUM(a."base1" + a."base2" + a."base3") AS "Total Abonado" FROM "public"."ps_gc_albaranes" a JOIN "public"."ps_clientes" c ON a."num_cliente" = c."reg_cliente" WHERE a."abono" = true AND a."fecha_envio" BETWEEN :curr_from AND :curr_to GROUP BY c."nombre" ORDER BY "Total Abonado" DESC LIMIT 20
```

### ¿Productos más vendidos en canal mayorista?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(lf."unidades") AS "Unidades", SUM(lf."total") AS "Importe" FROM "public"."ps_gc_lin_facturas" lf JOIN "public"."ps_articulos" p ON lf."codigo" = p."codigo" WHERE lf."unidades" > 0 GROUP BY p."ccrefejofacm", p."descripcion" ORDER BY "Unidades" DESC LIMIT 20
```

### ¿Cuáles son los mejores clientes retail por compras?
```sql
SELECT c."nombre" AS "Cliente", COUNT(DISTINCT v."reg_ventas") AS "Compras", SUM(v."total_si") AS "Total Gastado" FROM "public"."ps_ventas" v JOIN "public"."ps_clientes" c ON v."num_cliente" = c."reg_cliente" WHERE v."num_cliente" > 0 AND v."entrada" = true AND v."fecha_creacion" BETWEEN :curr_from AND :curr_to GROUP BY c."nombre" ORDER BY "Total Gastado" DESC LIMIT 20
```

### ¿Cuántos clientes únicos compraron este mes?
```sql
SELECT COUNT(DISTINCT "num_cliente") AS "Clientes Identificados", SUM(CASE WHEN "num_cliente" = 0 THEN 1 ELSE 0 END) AS "Tickets Anónimos", COUNT(*) AS "Total Tickets" FROM "public"."ps_ventas" WHERE "fecha_creacion" BETWEEN :curr_from AND :curr_to AND "entrada" = true
```

### ¿Nuevos clientes registrados este año?
```sql
SELECT COUNT(*) AS "Nuevos Clientes", SUM(CASE WHEN "mayorista" = false THEN 1 ELSE 0 END) AS "Retail", SUM(CASE WHEN "mayorista" = true THEN 1 ELSE 0 END) AS "Mayoristas" FROM "public"."ps_clientes" WHERE "fecha_creacion" BETWEEN :curr_from AND :curr_to
```

### ¿Frecuencia de compra de clientes?
```sql
SELECT CASE WHEN compras = 1 THEN '1 compra' WHEN compras BETWEEN 2 AND 3 THEN '2-3 compras' WHEN compras BETWEEN 4 AND 10 THEN '4-10 compras' ELSE 'Más de 10' END AS "Segmento", COUNT(*) AS "Clientes" FROM (SELECT "num_cliente", COUNT(DISTINCT "reg_ventas") AS compras FROM "public"."ps_ventas" WHERE "num_cliente" > 0 AND "entrada" = true AND "fecha_creacion" BETWEEN :curr_from AND :curr_to GROUP BY "num_cliente") t GROUP BY 1 ORDER BY 2 DESC
```

### ¿Ingresos por método de pago este mes?
```sql
SELECT p."forma" AS "Forma de Pago", COUNT(*) AS "Transacciones", SUM(p."importe_cob") AS "Importe Cobrado" FROM "public"."ps_pagos_ventas" p WHERE p."fecha_creacion" BETWEEN :curr_from AND :curr_to AND p."entrada" = true GROUP BY p."forma" ORDER BY "Importe Cobrado" DESC
```

### ¿Mix de formas de pago por tienda?
```sql
SELECT p."tienda" AS "Tienda", p."forma" AS "Forma de Pago", COUNT(*) AS "Transacciones", SUM(p."importe_cob") AS "Importe" FROM "public"."ps_pagos_ventas" p WHERE p."fecha_creacion" BETWEEN :curr_from AND :curr_to AND p."entrada" = true AND p."tienda" <> '99' GROUP BY p."tienda", p."forma" ORDER BY p."tienda", "Importe" DESC
```

### ¿Efectivo vs tarjeta por tienda?
```sql
SELECT p."tienda" AS "Tienda", SUM(CASE WHEN p."codigo_forma" = '01' THEN p."importe_cob" ELSE 0 END) AS "Efectivo", SUM(CASE WHEN p."codigo_forma" <> '01' THEN p."importe_cob" ELSE 0 END) AS "Tarjeta/Otro", SUM(p."importe_cob") AS "Total" FROM "public"."ps_pagos_ventas" p WHERE p."fecha_creacion" BETWEEN :curr_from AND :curr_to AND p."entrada" = true AND p."tienda" <> '99' GROUP BY p."tienda" ORDER BY "Total" DESC
```

### ¿Evolución diaria de ingresos por forma de pago?
```sql
SELECT p."fecha_creacion" AS "Fecha", p."forma" AS "Forma de Pago", SUM(p."importe_cob") AS "Importe" FROM "public"."ps_pagos_ventas" p WHERE p."fecha_creacion" BETWEEN :curr_from AND :curr_to AND p."entrada" = true GROUP BY p."fecha_creacion", p."forma" ORDER BY p."fecha_creacion", p."forma"
```

### ¿Margen bruto por familia de producto?
```sql
SELECT fm."fami_grup_marc" AS "Familia", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."total_coste_si") AS "Coste Total", ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si")) / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS "Margen %" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" JOIN "public"."ps_familias" fm ON p."num_familia" = fm."reg_familia" WHERE v."entrada" = true AND lv."total_si" > 0 GROUP BY fm."fami_grup_marc" ORDER BY "Margen %" DESC
```

### ¿Margen bruto por tienda?
```sql
SELECT lv."tienda" AS "Tienda", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."total_coste_si") AS "Coste Total", ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si")) / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS "Margen %" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" WHERE v."entrada" = true AND lv."total_si" > 0 AND lv."tienda" <> '99' GROUP BY lv."tienda" ORDER BY "Margen %" DESC
```

### ¿Productos con bajo margen (menos del 30%)?
```sql
SELECT p."ccrefejofacm" AS "Referencia", p."descripcion" AS "Descripción", SUM(lv."total_si") AS "Ventas Netas", ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si")) / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS "Margen %" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" WHERE v."entrada" = true AND lv."total_si" > 0 GROUP BY p."ccrefejofacm", p."descripcion" HAVING (SUM(lv."total_si") - SUM(lv."total_coste_si")) / NULLIF(SUM(lv."total_si"), 0) < 0.30 ORDER BY "Margen %" ASC LIMIT 30
```

### ¿Margen bruto por departamento?
```sql
SELECT d."depa_secc_fabr" AS "Departamento", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."total_coste_si") AS "Coste Total", ROUND((SUM(lv."total_si") - SUM(lv."total_coste_si")) / NULLIF(SUM(lv."total_si"), 0) * 100, 1) AS "Margen %" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" JOIN "public"."ps_departamentos" d ON p."num_departament" = d."reg_departament" WHERE v."entrada" = true AND lv."total_si" > 0 GROUP BY d."depa_secc_fabr" ORDER BY "Margen %" DESC
```

### ¿Margen mayorista por comercial?
```sql
SELECT c."comercial" AS "Comercial", SUM(lf."total") AS "Ingreso", SUM(lf."total_coste") AS "Coste", ROUND((SUM(lf."total") - SUM(lf."total_coste")) / NULLIF(SUM(lf."total"), 0) * 100, 1) AS "Margen %" FROM "public"."ps_gc_lin_facturas" lf JOIN "public"."ps_gc_facturas" f ON lf."num_factura" = f."n_factura" JOIN "public"."ps_gc_comerciales" c ON f."num_comercial" = c."reg_comercial" WHERE lf."total" > 0 GROUP BY c."comercial" ORDER BY "Margen %" DESC
```

### ¿Volumen de traspasos por ruta?
```sql
SELECT t."tienda_salida" AS "Tienda Origen", t."tienda_entrada" AS "Tienda Destino", COUNT(*) AS "Traspasos", SUM(t."unidades_s") AS "Unidades" FROM "public"."ps_traspasos" t WHERE t."entrada" = false AND t."fecha_s" BETWEEN :curr_from AND :curr_to GROUP BY t."tienda_salida", t."tienda_entrada" ORDER BY "Unidades" DESC LIMIT 20
```

### ¿Traspasos diarios de stock?
```sql
SELECT t."fecha_s" AS "Fecha", COUNT(*) AS "Traspasos", SUM(t."unidades_s") AS "Unidades" FROM "public"."ps_traspasos" t WHERE t."entrada" = false AND t."fecha_s" BETWEEN :curr_from AND :curr_to GROUP BY t."fecha_s" ORDER BY t."fecha_s"
```

### ¿Movimientos de stock de un artículo?
```sql
SELECT t."fecha_s" AS "Fecha", t."tienda_salida" AS "Origen", t."tienda_entrada" AS "Destino", t."talla" AS "Talla", t."unidades_s" AS "Unidades", t."tipo" AS "Tipo" FROM "public"."ps_traspasos" t JOIN "public"."ps_articulos" p ON t."codigo" = p."codigo" WHERE p."ccrefejofacm" = 'REFERENCIA_AQUI' AND t."entrada" = false ORDER BY t."fecha_s" DESC LIMIT 50
```

### ¿Cuántos artículos hay por temporada?
```sql
SELECT t."temporada_tipo" AS "Temporada", COUNT(p."reg_articulo") AS "Artículos", SUM(CASE WHEN p."anulado" = false THEN 1 ELSE 0 END) AS "Activos" FROM "public"."ps_articulos" p JOIN "public"."ps_temporadas" t ON p."num_temporada" = t."reg_temporada" GROUP BY t."temporada_tipo" ORDER BY "Artículos" DESC
```

### ¿Stock por temporada de colección?
```sql
SELECT p."clave_temporada" AS "Temporada", COUNT(DISTINCT p."ccrefejofacm") AS "Referencias", SUM(s."stock") AS "Unidades", ROUND(SUM(s."stock" * p."precio_coste"), 2) AS "Valor Coste" FROM "public"."ps_stock_tienda" s JOIN "public"."ps_articulos" p ON s."codigo" = p."codigo" WHERE s."stock" > 0 AND p."anulado" = false GROUP BY p."clave_temporada" ORDER BY "Unidades" DESC
```

### ¿Ventas por temporada de origen del artículo?
```sql
SELECT p."clave_temporada" AS "Temporada", SUM(lv."total_si") AS "Ventas Netas", SUM(lv."unidades") AS "Unidades" FROM "public"."ps_lineas_ventas" lv JOIN "public"."ps_ventas" v ON lv."num_ventas" = v."reg_ventas" JOIN "public"."ps_articulos" p ON lv."codigo" = p."codigo" WHERE v."entrada" = true AND lv."fecha_creacion" BETWEEN :curr_from AND :curr_to GROUP BY p."clave_temporada" ORDER BY "Ventas Netas" DESC
```

### ¿Rendimiento YTD por tienda con comparativa año anterior?
```sql
SELECT v."tienda" AS "Tienda", SUM(CASE WHEN v."fecha_creacion" BETWEEN :curr_from AND :curr_to THEN v."total_si" ELSE 0 END) AS "Ventas Este Año", SUM(CASE WHEN v."fecha_creacion" BETWEEN :comp_from AND :comp_to THEN v."total_si" ELSE 0 END) AS "Ventas Año Anterior" FROM "public"."ps_ventas" v WHERE v."entrada" = true AND v."tienda" <> '99' AND (v."fecha_creacion" BETWEEN :curr_from AND :curr_to OR v."fecha_creacion" BETWEEN :comp_from AND :comp_to) GROUP BY v."tienda" ORDER BY "Ventas Este Año" DESC
```

### ¿Ticket medio por tienda?
```sql
SELECT v."tienda" AS "Tienda", COUNT(DISTINCT v."reg_ventas") AS "Tickets", ROUND(SUM(v."total_si") / NULLIF(COUNT(DISTINCT v."reg_ventas"), 0), 2) AS "Ticket Medio" FROM "public"."ps_ventas" v WHERE v."entrada" = true AND v."tienda" <> '99' AND v."fecha_creacion" BETWEEN :curr_from AND :curr_to GROUP BY v."tienda" ORDER BY "Ticket Medio" DESC
```

### ¿Ventas por tienda del período de comparación?
```sql
SELECT v."tienda" AS "label", SUM(v."total_si") AS "value" FROM "public"."ps_ventas" v WHERE v."entrada" = true AND v."tienda" <> '99' AND v."fecha_creacion" BETWEEN :comp_from AND :comp_to GROUP BY v."tienda" ORDER BY "value" DESC
```
