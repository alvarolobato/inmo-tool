"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-sql";
import { formatPgQueryText } from "@/lib/format-pg-query";

interface QueryOrigin {
  source: string;
  locationHint?: string;
}

interface SlowQuery {
  query: string;
  calls: number;
  mean_exec_time_ms: number;
  max_exec_time_ms: number;
  total_exec_time_ms: number;
  rows: number;
  cache_hit_ratio: number | null;
  origin?: QueryOrigin;
}

interface SlowQueriesData {
  queries: SlowQuery[];
  error?: string;
}

type SortKey = "mean_exec_time_ms" | "max_exec_time_ms" | "total_exec_time_ms" | "calls" | "rows" | "cache_hit_ratio";
type SortDir = "asc" | "desc";

const fmtMs = (v: number) =>
  new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(v);

const fmtInt = (v: number) =>
  new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(v);

/** Escape HTML special characters to prevent XSS in fallback paths. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Highlight SQL with Prism after formatting.
 * Returns HTML-escaped plain text on Prism error so dangerouslySetInnerHTML
 * remains safe even if the grammar is not loaded.
 */
function highlightSql(formatted: string): string {
  try {
    return Prism.highlight(formatted, Prism.languages.sql, "sql");
  } catch {
    return escapeHtml(formatted);
  }
}

/** Arrow indicator for sort direction. */
function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <span style={{ opacity: 0.3, marginLeft: 3, fontSize: 9 }}>⇅</span>
    );
  }
  return (
    <span style={{ marginLeft: 3, fontSize: 9, color: "var(--accent)" }}>
      {dir === "desc" ? "↓" : "↑"}
    </span>
  );
}

/** Collapsible "¿Cómo actuar?" guidance panel. */
function GuidancePanel() {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 14px",
          background: "var(--bg-2)",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-inter, sans-serif)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--fg)",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 11, opacity: 0.7 }}>{open ? "▼" : "▶"}</span>
        ¿Cómo actuar ante consultas lentas?
      </button>
      {open && (
        <div
          style={{
            padding: "12px 16px",
            fontSize: 12,
            color: "var(--fg)",
            lineHeight: 1.7,
            background: "var(--bg)",
          }}
        >
          <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
            <li>
              <strong>Mide primero.</strong> Abre la consulta en{" "}
              <a
                href="/admin"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                /admin
              </a>{" "}
              y usa el endpoint <code>/api/admin/explain</code> para obtener{" "}
              <code>EXPLAIN (ANALYZE, BUFFERS)</code>. Busca{" "}
              <em>Seq Scan</em> en tablas grandes (
              <code>ps_stock_tienda</code> ~12 M filas,{" "}
              <code>ps_lineas_ventas</code> ~1,7 M,{" "}
              <code>ps_ventas</code> ~911 K).
            </li>
            <li>
              <strong>Propón un índice</strong> cuando el filtro usa una columna
              que no está en los índices existentes (ver{" "}
              <code>etl/schema/init.sql</code>). Añádelo ahí para que se
              aplique en cada ETL rebuild.
            </li>
            <li>
              <strong>Refactoriza el widget.</strong> Si el origen apunta a un
              template en <code>dashboard/lib/templates/</code>, revisa el SQL
              del widget: reduce el rango temporal por defecto, añade más
              filtros o agrupa con mayor granularidad.
            </li>
            <li>
              <strong>Materializa la agregación.</strong> Para agregaciones
              pesadas que se repiten (stock por tienda, totales de ventas por
              semana), considera una{" "}
              <code>CREATE MATERIALIZED VIEW</code> refrescada por el ETL. Ver
              los módulos de sync en <code>etl/sync/</code> para añadir un paso
              de refresco.
            </li>
            <li>
              <strong>Ajusta el timeout.</strong> Las consultas del dashboard ya
              usan <code>SET LOCAL statement_timeout</code> (ver{" "}
              <code>dashboard/lib/db.ts</code>). Si una consulta siempre supera
              el timeout, bien la consulta necesita optimización, bien el límite
              puede ajustarse por widget.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

export default function AdminSlowQueriesPage() {
  const [data, setData] = useState<SlowQueriesData | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("mean_exec_time_ms");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedFilter, setDebouncedFilter] = useState("");

  useEffect(() => {
    void fetch("/api/admin/slow-queries")
      .then((r) => r.json())
      .then((d) => setData(d as SlowQueriesData))
      .catch((e) =>
        setData({ queries: [], error: e instanceof Error ? e.message : "Error" }),
      );
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (filterTimerRef.current !== null) clearTimeout(filterTimerRef.current);
    };
  }, []);

  // Debounce filter input — 150 ms
  const handleFilterChange = useCallback((value: string) => {
    setFilter(value);
    if (filterTimerRef.current !== null) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => setDebouncedFilter(value), 150);
  }, []);

  // Memoised formatted + highlighted SQL per query
  const formattedQueries = useMemo(() => {
    if (!data) return [];
    return data.queries.map((q) => {
      const formatted = formatPgQueryText(q.query);
      return {
        formatted,
        highlighted: highlightSql(formatted),
      };
    });
  }, [data]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleExpand(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Filter + sort (client-side)
  const displayRows = useMemo(() => {
    if (!data) return [];
    const lf = debouncedFilter.toLowerCase();
    const filtered = data.queries
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => !lf || q.query.toLowerCase().includes(lf));

    return filtered.sort((a, b) => {
      const va = a.q[sortKey] ?? -Infinity;
      const vb = b.q[sortKey] ?? -Infinity;
      const numA = typeof va === "number" ? va : Number(va);
      const numB = typeof vb === "number" ? vb : Number(vb);
      return sortDir === "desc" ? numB - numA : numA - numB;
    });
  }, [data, debouncedFilter, sortKey, sortDir]);

  const totalCount = data?.queries.length ?? 0;
  const filteredCount = displayRows.length;

  const columns: Array<{ label: string; key?: SortKey; align: "left" | "right" }> = [
    { label: "Consulta", align: "left" },
    { label: "Llamadas", key: "calls", align: "right" },
    { label: "Media ms", key: "mean_exec_time_ms", align: "right" },
    { label: "Máx ms", key: "max_exec_time_ms", align: "right" },
    { label: "Total ms", key: "total_exec_time_ms", align: "right" },
    { label: "Filas", key: "rows", align: "right" },
    { label: "Cache %", key: "cache_hit_ratio", align: "right" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1
        style={{
          fontSize: 17,
          fontWeight: 600,
          color: "var(--fg)",
          margin: 0,
        }}
      >
        Consultas lentas (pg_stat_statements)
      </h1>

      {/* Guidance panel */}
      <GuidancePanel />

      {data?.error && (
        <p
          style={{
            borderRadius: 6,
            border: "1px solid var(--warn)",
            background: "var(--warn-bg, rgba(245,158,11,0.08))",
            padding: "8px 12px",
            fontSize: 13,
            color: "var(--warn)",
          }}
        >
          {data.error}
        </p>
      )}

      {!data && (
        <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>Cargando…</p>
      )}

      {data && (
        <>
          {/* Filter row */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="search"
              value={filter}
              onChange={(e) => handleFilterChange(e.target.value)}
              placeholder="Filtrar por tabla, columna o texto de consulta…"
              aria-label="Filtrar consultas"
              style={{
                flex: 1,
                padding: "7px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-2)",
                color: "var(--fg)",
                fontFamily: "var(--font-inter, sans-serif)",
                fontSize: 12,
                outline: "none",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {filteredCount === totalCount
                ? `${totalCount} consultas`
                : `${filteredCount} de ${totalCount} consultas`}
            </span>
          </div>

          {/* Table */}
          <div
            style={{
              overflowX: "auto",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg-2)" }}>
                  {columns.map((col) => (
                    <th
                      key={col.label}
                      style={{
                        padding: col.key ? "0" : "9px 12px",
                        fontWeight: 500,
                        fontFamily: "var(--font-inter, sans-serif)",
                        fontSize: 11,
                        letterSpacing: "0.04em",
                        color: col.key ? "var(--fg)" : "var(--fg-subtle)",
                        textAlign: col.align,
                        whiteSpace: "nowrap",
                        borderBottom: "1px solid var(--border)",
                      }}
                      aria-sort={
                        col.key
                          ? sortKey === col.key
                            ? sortDir === "desc"
                              ? "descending"
                              : "ascending"
                            : "none"
                          : undefined
                      }
                    >
                      {col.key ? (
                        /* Wrap sortable headers in a button for keyboard + screen-reader accessibility */
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key!)}
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "9px 12px",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            fontWeight: "inherit",
                            letterSpacing: "inherit",
                            color: "inherit",
                            textAlign: col.align,
                            whiteSpace: "nowrap",
                            userSelect: "none",
                          }}
                        >
                          {col.label}
                          <SortArrow active={sortKey === col.key} dir={sortDir} />
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(({ q, i }, displayIndex) => {
                  const fq = formattedQueries[i];
                  const isExpanded = expanded.has(i);
                  return (
                    <tr
                      key={i}
                      style={{
                        /* Use display index for correct stripe pattern after sort/filter */
                        background: displayIndex % 2 === 1 ? "var(--bg-2)" : undefined,
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <td
                        style={{
                          padding: "9px 12px",
                          maxWidth: 460,
                          verticalAlign: "top",
                        }}
                      >
                        {/* Origin badge */}
                        {q.origin && (
                          <div
                            style={{
                              marginBottom: 4,
                              fontSize: 10,
                              color: "var(--accent)",
                              fontFamily: "var(--font-inter, sans-serif)",
                            }}
                          >
                            Posible origen:{" "}
                            {q.origin.locationHint ? (
                              <span title={q.origin.source}>
                                <code style={{ fontSize: 10 }}>
                                  {q.origin.locationHint}
                                </code>
                                {" — "}
                                <span style={{ opacity: 0.8 }}>
                                  {q.origin.source}
                                </span>
                              </span>
                            ) : (
                              <span>{q.origin.source}</span>
                            )}
                          </div>
                        )}

                        {/* SQL body */}
                        <div
                          style={{
                            maxHeight: isExpanded ? "none" : "3.6em",
                            overflow: isExpanded ? "visible" : "hidden",
                            fontFamily: "var(--font-jetbrains, monospace)",
                            fontSize: 11,
                            lineHeight: 1.5,
                            color: "var(--fg)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {/* dangerouslySetInnerHTML is safe here: highlightSql HTML-escapes
                              the fallback path and Prism only produces span elements with
                              class attributes from its own grammar tokeniser. */}
                          <span
                            // biome-ignore lint/security/noDangerouslySetInnerHtml
                            dangerouslySetInnerHTML={{
                              __html: fq ? fq.highlighted : escapeHtml(q.query),
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleExpand(i)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 11,
                            color: "var(--accent)",
                            padding: "2px 0",
                            fontFamily: "inherit",
                          }}
                        >
                          {isExpanded ? "contraer" : "ver completa"}
                        </button>
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtInt(q.calls)}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtMs(q.mean_exec_time_ms)}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtMs(q.max_exec_time_ms)}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtMs(q.total_exec_time_ms)}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtInt(q.rows)}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {q.cache_hit_ratio != null
                          ? `${q.cache_hit_ratio.toFixed(1)}%`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
                {displayRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        padding: "24px 12px",
                        textAlign: "center",
                        color: "var(--fg-muted)",
                        fontSize: 12,
                      }}
                    >
                      {debouncedFilter
                        ? `Sin resultados para "${debouncedFilter}"`
                        : "Sin consultas lentas registradas."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
