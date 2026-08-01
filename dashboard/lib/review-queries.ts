/**
 * Predefined SQL queries for the weekly business review.
 *
 * Organized by domain: Ventas Retail, Canal Mayorista, Stock, Compras.
 * All queries are read-only and follow the SQL rules from lib/prompts.ts:
 *   - total_si for retail revenue (sin IVA)
 *   - fecha_creacion for dates
 *   - tienda <> '99' to exclude warehouse
 *   - entrada = true for sales, false for returns
 *   - base1+base2+base3 for wholesale revenue
 */

import type { QueryResult } from "./db";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewQuery {
  name: string;
  sql: string;
  domain: "ventas_retail" | "canal_mayorista" | "stock" | "compras";
}

export interface ReviewQueryResult {
  query: ReviewQuery;
  result?: QueryResult;
  error?: string;
}

// ─── SQL helper: text formatter ───────────────────────────────────────────────

/**
 * Format a query result as a readable text table.
 * Used to build the text context for the LLM prompt.
 *
 * If lib/data-serializer.ts covers this use case in future, replace this.
 */
export function formatQueryResultAsText(
  name: string,
  columns: string[],
  rows: unknown[][]
): string {
  if (rows.length === 0) {
    return `${name}: (sin datos)`;
  }

  // Format numbers with locale
  const fmtVal = (v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "number") return v.toLocaleString("es-ES");
    if (v instanceof Date) return v.toISOString().split("T")[0];
    return String(v);
  };

  const colWidths = columns.map((c, ci) => {
    const maxDataWidth = rows.reduce(
      (max, row) => Math.max(max, fmtVal(row[ci]).length),
      0
    );
    return Math.max(c.length, maxDataWidth);
  });

  const header = columns
    .map((c, i) => c.padEnd(colWidths[i]))
    .join(" | ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const dataRows = rows.map((row) =>
    row.map((v, i) => fmtVal(v).padEnd(colWidths[i])).join(" | ")
  );

  return [`${name}:`, header, separator, ...dataRows].join("\n");
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Weekly review SQL uses $1 = Monday of the **closed** ISO week under analysis (inclusive)
 * and $2 = Monday of the following week (exclusive upper bound). The API sets these to the
 * last completed calendar week — never the in-progress current week.
 */
export const REVIEW_QUERIES: ReviewQuery[] = [
  // ── Ventas Retail ──────────────────────────────────────────────────────────

  {
    name: "ventas_semana_cerrada",
    domain: "ventas_retail",
    sql: `SELECT
  COALESCE(SUM(total_si), 0) AS ventas_netas,
  COUNT(DISTINCT reg_ventas) AS num_tickets,
  ROUND(COALESCE(SUM(total_si), 0) / NULLIF(COUNT(DISTINCT reg_ventas), 0), 2) AS ticket_medio
FROM ps_ventas
WHERE entrada = true
  AND tienda <> '99'
  AND fecha_creacion >= $1::date
  AND fecha_creacion < $2::date`,
  },
  {
    name: "ventas_semana_previa",
    domain: "ventas_retail",
    sql: `SELECT
  COALESCE(SUM(total_si), 0) AS ventas_netas,
  COUNT(DISTINCT reg_ventas) AS num_tickets,
  ROUND(COALESCE(SUM(total_si), 0) / NULLIF(COUNT(DISTINCT reg_ventas), 0), 2) AS ticket_medio
FROM ps_ventas
WHERE entrada = true
  AND tienda <> '99'
  AND fecha_creacion >= ($1::date - INTERVAL '7 days')
  AND fecha_creacion < $1::date`,
  },
  {
    name: "top3_tiendas_semana_cerrada",
    domain: "ventas_retail",
    sql: `SELECT
  tienda,
  COALESCE(SUM(total_si), 0) AS ventas_netas,
  COUNT(DISTINCT reg_ventas) AS num_tickets
FROM ps_ventas
WHERE entrada = true
  AND tienda <> '99'
  AND fecha_creacion >= $1::date
  AND fecha_creacion < $2::date
GROUP BY tienda
ORDER BY ventas_netas DESC
LIMIT 3`,
  },
  {
    name: "bottom3_tiendas_semana_cerrada",
    domain: "ventas_retail",
    sql: `SELECT
  tienda,
  COALESCE(SUM(total_si), 0) AS ventas_netas,
  COUNT(DISTINCT reg_ventas) AS num_tickets
FROM ps_ventas
WHERE entrada = true
  AND tienda <> '99'
  AND fecha_creacion >= $1::date
  AND fecha_creacion < $2::date
GROUP BY tienda
ORDER BY ventas_netas ASC
LIMIT 3`,
  },
  {
    name: "top5_articulos_unidades_semana_cerrada",
    domain: "ventas_retail",
    sql: `SELECT
  lv.codigo,
  COALESCE(a.ccrefejofacm, lv.codigo) AS referencia,
  COALESCE(a.descripcion, lv.codigo) AS descripcion,
  SUM(lv.unidades) AS unidades_vendidas,
  COALESCE(SUM(lv.total_si), 0) AS importe_neto
FROM ps_lineas_ventas lv
JOIN ps_ventas v ON v.reg_ventas = lv.num_ventas
LEFT JOIN ps_articulos a ON a.codigo = lv.codigo
WHERE v.entrada = true
  AND lv.tienda <> '99'
  AND lv.fecha_creacion >= $1::date
  AND lv.fecha_creacion < $2::date
  AND lv.unidades > 0
GROUP BY lv.codigo, a.ccrefejofacm, a.descripcion
ORDER BY unidades_vendidas DESC
LIMIT 5`,
  },
  {
    name: "tasa_devolucion_semana_cerrada",
    domain: "ventas_retail",
    sql: `SELECT
  COALESCE(SUM(CASE WHEN entrada = true THEN total_si ELSE 0 END), 0) AS ventas_brutas_si,
  COALESCE(ABS(SUM(CASE WHEN entrada = false THEN total_si ELSE 0 END)), 0) AS importe_devoluciones_si,
  COUNT(CASE WHEN entrada = true THEN 1 END) AS num_ventas,
  COUNT(CASE WHEN entrada = false THEN 1 END) AS num_devoluciones,
  ROUND(
    100.0 * COUNT(CASE WHEN entrada = false THEN 1 END) /
    NULLIF(COUNT(CASE WHEN entrada = true THEN 1 END), 0),
    2
  ) AS tasa_devolucion_pct
FROM ps_ventas
WHERE tienda <> '99'
  AND fecha_creacion >= $1::date
  AND fecha_creacion < $2::date`,
  },

  // ── Canal Mayorista ────────────────────────────────────────────────────────

  {
    name: "facturacion_mayorista_semana_cerrada",
    domain: "canal_mayorista",
    sql: `SELECT
  COALESCE(SUM(base1 + base2 + base3), 0) AS facturacion_neta,
  COUNT(*) AS num_facturas
FROM ps_gc_facturas
WHERE abono = false
  AND fecha_factura >= $1::date
  AND fecha_factura < $2::date`,
  },
  {
    // ps_gc_facturas.num_cliente actually stores the parent's `reg_cliente`
    // PK (the `.990`-suffixed Real, not the `.000` `NumCliente` code), so the
    // join key on the right side is `ps_clientes.reg_cliente`. Joining on
    // `c.num_cliente` returned zero matches and the COALESCE fell back to
    // the numeric ID instead of the textual name.
    name: "top3_clientes_mayorista_semana_cerrada",
    domain: "canal_mayorista",
    sql: `SELECT
  f.num_cliente,
  COALESCE(c.nombre, f.num_cliente::text) AS nombre_cliente,
  COALESCE(SUM(f.base1 + f.base2 + f.base3), 0) AS facturacion_neta,
  COUNT(*) AS num_facturas
FROM ps_gc_facturas f
LEFT JOIN ps_clientes c ON c.reg_cliente = f.num_cliente
WHERE f.abono = false
  AND f.fecha_factura >= $1::date
  AND f.fecha_factura < $2::date
GROUP BY f.num_cliente, c.nombre
ORDER BY facturacion_neta DESC
LIMIT 3`,
  },
  {
    name: "albaranes_pendientes_facturar",
    domain: "canal_mayorista",
    sql: `SELECT COUNT(*) AS albaranes_pendientes
FROM ps_gc_albaranes a
WHERE NOT EXISTS (
    SELECT 1 FROM ps_gc_facturas f
    WHERE f.num_cliente = a.num_cliente
      AND f.abono = false
      AND f.fecha_factura >= a.fecha_envio
      AND f.fecha_factura < a.fecha_envio + INTERVAL '30 days'
  )
  AND a.fecha_envio >= $1::date - INTERVAL '30 days'
  AND a.fecha_envio < $2::date`,
  },

  // ── Stock ──────────────────────────────────────────────────────────────────

  {
    // Warehouse stock lives in ps_stock_central (sourced from 4D CCStock per
    // D-017), NOT in ps_stock_tienda — there is no `tienda='99'` row in the
    // store-level mirror. CTEs aggregate each table once (count + sum) so
    // PostgreSQL doesn't re-scan the 12 M-row stock_tienda for every column.
    name: "stock_total_unidades",
    domain: "stock",
    sql: `WITH tiendas AS (
  SELECT COUNT(DISTINCT codigo) AS refs, COALESCE(SUM(stock), 0) AS stk
  FROM ps_stock_tienda
  WHERE stock > 0 AND tienda <> '99'
),
almacen AS (
  SELECT COUNT(*) AS refs, COALESCE(SUM(stock), 0) AS stk
  FROM ps_stock_central
  WHERE stock > 0
)
SELECT
  tiendas.refs AS referencias_tiendas,
  almacen.refs AS referencias_almacen,
  tiendas.stk  AS stock_tiendas,
  almacen.stk  AS stock_almacen,
  tiendas.stk + almacen.stk AS stock_total
FROM tiendas, almacen`,
  },
  {
    name: "articulos_stock_critico",
    domain: "stock",
    sql: `SELECT
  codigo,
  SUM(stock) AS stock_total
FROM ps_stock_tienda
GROUP BY codigo
HAVING SUM(stock) < 5 AND SUM(stock) > 0
ORDER BY stock_total ASC
LIMIT 20`,
  },
  {
    name: "traspasos_semana_cerrada",
    domain: "stock",
    sql: `SELECT
  COUNT(DISTINCT reg_traspaso) AS num_traspasos,
  COALESCE(SUM(unidades_s), 0) AS unidades_enviadas,
  COALESCE(SUM(unidades_e), 0) AS unidades_recibidas
FROM ps_traspasos
WHERE (fecha_s >= $1::date AND fecha_s < $2::date)
   OR (fecha_e >= $1::date AND fecha_e < $2::date)`,
  },

  // ── Compras ────────────────────────────────────────────────────────────────
  // Header counts come from ps_compras (fecha_pedido). Amount + unit totals
  // come from ps_lineas_compras (CCLineasCompr; total_si and unidades both
  // populated, confirmed 2026-05-01). The two counts can diverge: a header
  // can exist without lines (open POs not yet detailed) — we surface both
  // so the model can flag the gap.

  {
    // Single-pass aggregation: pedidos count from ps_compras, line metrics
    // from ps_lineas_compras filtered through the same date range. Cross-join
    // produces one row with all five columns and avoids re-scanning either
    // table per scalar subquery.
    name: "compras_semana_cerrada",
    domain: "compras",
    sql: `WITH pedidos AS (
  SELECT COUNT(*) AS n
  FROM ps_compras
  WHERE fecha_pedido >= $1::date AND fecha_pedido < $2::date
),
lineas AS (
  SELECT
    COUNT(DISTINCT lc.num_pedido) AS pedidos_con_lineas,
    COUNT(*) AS num_lineas,
    COALESCE(SUM(lc.unidades), 0) AS unidades,
    COALESCE(SUM(lc.total_si), 0) AS importe
  FROM ps_lineas_compras lc
  JOIN ps_compras c ON c.reg_pedido = lc.num_pedido
  WHERE c.fecha_pedido >= $1::date AND c.fecha_pedido < $2::date
)
SELECT
  pedidos.n               AS num_pedidos,
  lineas.pedidos_con_lineas,
  lineas.num_lineas,
  lineas.unidades         AS unidades_compradas,
  lineas.importe          AS importe_neto_si
FROM pedidos, lineas`,
  },
  {
    name: "compras_semana_previa",
    domain: "compras",
    sql: `WITH pedidos AS (
  SELECT COUNT(*) AS n
  FROM ps_compras
  WHERE fecha_pedido >= ($1::date - INTERVAL '7 days') AND fecha_pedido < $1::date
),
lineas AS (
  SELECT
    COUNT(DISTINCT lc.num_pedido) AS pedidos_con_lineas,
    COUNT(*) AS num_lineas,
    COALESCE(SUM(lc.unidades), 0) AS unidades,
    COALESCE(SUM(lc.total_si), 0) AS importe
  FROM ps_lineas_compras lc
  JOIN ps_compras c ON c.reg_pedido = lc.num_pedido
  WHERE c.fecha_pedido >= ($1::date - INTERVAL '7 days') AND c.fecha_pedido < $1::date
)
SELECT
  pedidos.n               AS num_pedidos,
  lineas.pedidos_con_lineas,
  lineas.num_lineas,
  lineas.unidades         AS unidades_compradas,
  lineas.importe          AS importe_neto_si
FROM pedidos, lineas`,
  },
  {
    name: "top3_proveedores_compras_semana_cerrada",
    domain: "compras",
    sql: `SELECT
  COALESCE(p.nombre, lc.num_proveedor::text) AS proveedor,
  COUNT(DISTINCT lc.num_pedido) AS num_pedidos,
  COALESCE(SUM(lc.unidades), 0) AS unidades,
  COALESCE(SUM(lc.total_si), 0) AS importe_neto_si
FROM ps_lineas_compras lc
JOIN ps_compras c ON c.reg_pedido = lc.num_pedido
LEFT JOIN ps_proveedores p ON p.reg_proveedor = lc.num_proveedor
WHERE c.fecha_pedido >= $1::date
  AND c.fecha_pedido < $2::date
GROUP BY p.nombre, lc.num_proveedor
ORDER BY importe_neto_si DESC NULLS LAST
LIMIT 3`,
  },
  {
    name: "top5_articulos_compras_semana_cerrada",
    domain: "compras",
    sql: `SELECT
  COALESCE(a.ccrefejofacm, a.codigo, lc.num_articulo::text) AS referencia,
  COALESCE(a.descripcion, '') AS descripcion,
  COALESCE(SUM(lc.unidades), 0) AS unidades,
  COALESCE(SUM(lc.total_si), 0) AS importe_neto_si
FROM ps_lineas_compras lc
JOIN ps_compras c ON c.reg_pedido = lc.num_pedido
LEFT JOIN ps_articulos a ON a.reg_articulo = lc.num_articulo
WHERE c.fecha_pedido >= $1::date
  AND c.fecha_pedido < $2::date
GROUP BY a.ccrefejofacm, a.codigo, a.descripcion, lc.num_articulo
ORDER BY unidades DESC NULLS LAST
LIMIT 5`,
  },
];

// ─── Query executor ───────────────────────────────────────────────────────────

/**
 * Execute all review queries using the provided query function.
 *
 * Accepts a query executor (to allow testing with mocks). If a query fails,
 * the error is captured and remaining queries continue (partial results are
 * better than no review at all).
 *
 * If a connection-level error is detected (ECONNREFUSED, ENOTFOUND, etc.) it
 * is re-thrown immediately so the API route can return a 503 without incurring
 * LLM cost.
 *
 * @param queryFn - Function that accepts SQL and optional `$1,$2` params (week bounds)
 * @param weekStart - Monday of the closed review week (YYYY-MM-DD), inclusive
 * @param weekEndExclusive - Monday after the review week (YYYY-MM-DD), exclusive upper bound
 * @returns Array of ReviewQueryResult (success or error per query)
 */
/**
 * Highest `$N` placeholder referenced by a SQL string. PostgreSQL's bind
 * protocol rejects extra parameters with "wrong number of parameters for
 * prepared statement" — a query that only references `$1` must receive
 * exactly one parameter, not two. We use this to size the per-query param
 * array correctly even when callers always pass `[weekStart, weekEnd]`.
 */
function highestPlaceholder(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

export async function executeReviewQueries(
  queryFn: (sql: string, params?: unknown[]) => Promise<QueryResult>,
  weekStart: string,
  weekEndExclusive: string,
): Promise<ReviewQueryResult[]> {
  const weekParams = [weekStart, weekEndExclusive];
  const results = await Promise.allSettled(
    REVIEW_QUERIES.map((q) => {
      const n = highestPlaceholder(q.sql);
      // Slice to exactly the placeholders this query uses (n=0 → no params).
      // If a query references `$N` beyond the supplied `weekParams`, slice
      // returns the full array and the driver surfaces a missing-parameter
      // error — that's the expected loud failure for a malformed query.
      const params = n === 0 ? undefined : weekParams.slice(0, n);
      return queryFn(q.sql, params);
    })
  );

  return REVIEW_QUERIES.map((q, i) => {
    const settled = results[i];
    if (settled.status === "fulfilled") {
      return { query: q, result: settled.value };
    } else {
      const err = settled.reason;
      // Re-throw connection-level errors — the caller should return 503
      // rather than waste an LLM call with an empty result set
      if (err instanceof Error) {
        const name = err.constructor?.name ?? "";
        if (
          name === "ConnectionError" ||
          (err as { code?: string }).code === "ECONNREFUSED" ||
          (err as { code?: string }).code === "ENOTFOUND" ||
          (err as { code?: string }).code === "ETIMEDOUT"
        ) {
          throw err;
        }
      }
      return {
        query: q,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Normalize a raw execution error message for inclusion in LLM context.
 *
 * Avoids leaking operational details (host names, SQL text, connection strings)
 * from database/driver error messages while preserving enough signal for the
 * model to understand that a query failed.
 */
function normalizeErrorForLlm(error: string): string {
  const normalized = error.trim().toLowerCase();

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("statement timeout")
  ) {
    return "tiempo de espera agotado al ejecutar la consulta";
  }

  if (
    normalized.includes("permission denied") ||
    normalized.includes("not authorized") ||
    normalized.includes("insufficient privilege") ||
    normalized.includes("access denied")
  ) {
    return "sin permisos para ejecutar la consulta";
  }

  if (
    normalized.includes("connection") ||
    normalized.includes("connect") ||
    normalized.includes("econnrefused") ||
    normalized.includes("could not translate host name") ||
    normalized.includes("no route to host")
  ) {
    return "fallo de conexión a la base de datos";
  }

  if (
    normalized.includes("syntax error") ||
    normalized.includes("does not exist") ||
    normalized.includes("undefined table") ||
    normalized.includes("undefined column") ||
    normalized.includes("invalid input syntax")
  ) {
    return "consulta inválida o incompatible con el esquema";
  }

  return "error interno al ejecutar la consulta";
}

/**
 * Format all query results as a single text block for LLM context.
 */
export function formatAllResults(results: ReviewQueryResult[]): string {
  const sections = results.map((r) => {
    if (r.error) {
      return `${r.query.name}: (error: ${normalizeErrorForLlm(r.error)})`;
    }
    if (!r.result) {
      return `${r.query.name}: (sin datos)`;
    }
    return formatQueryResultAsText(
      r.query.name,
      r.result.columns,
      r.result.rows
    );
  });

  return sections.join("\n\n");
}
