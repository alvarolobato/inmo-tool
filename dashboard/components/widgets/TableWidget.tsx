"use client";

import { useState, useMemo } from "react";
import type { TableWidget as TableWidgetSpec, GlossaryItem } from "@/lib/schema";
import type { OnDataPointClick, WidgetData } from "./types";
import { EMPTY_MESSAGE } from "./types";
import { applyGlossary } from "@/lib/glossary";
import { toTitleCase } from "./format";

interface TableWidgetProps {
  widget: TableWidgetSpec;
  data: WidgetData | null;
  glossary?: GlossaryItem[];
  onDataPointClick?: OnDataPointClick;
  /** When false, removes internal padding so the table is edge-to-edge. Default true. */
  padded?: boolean;
}

type SortDir = "asc" | "desc";

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Detect format hints from column name suffixes. */
function detectFormat(colName: string): string {
  const lower = colName.toLowerCase();
  if (lower.includes("ref") || lower.startsWith("ref")) return "ref";
  if (lower.includes("familia") || lower.includes("family") || lower.includes("tag")) return "tag";
  if (lower.includes("margen") || lower.includes("margin") || lower.includes("pct") || lower.includes("%")) return "margin_pct";
  return "default";
}

function formatCellValue(value: unknown): string {
  if (isNullish(value)) return "—";
  if (typeof value === "number") {
    return value.toLocaleString("es-ES", { maximumFractionDigits: 2 });
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num.toLocaleString("es-ES", { maximumFractionDigits: 2 });
    }
  }
  return String(value);
}

function HeatCell({
  value,
  max,
  color = "var(--accent)",
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const barWidthPx = max > 0 ? Math.min(80, (Math.abs(value) / max) * 80) : 0;
  const display = value.toLocaleString("es-ES", { maximumFractionDigits: 0 });
  return (
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        justifyContent: "flex-end",
        minWidth: 120,
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          width: barWidthPx,
          height: 14,
          background: color,
          opacity: 0.15,
          borderRadius: 2,
          zIndex: 0,
        }}
      />
      <span
        style={{
          position: "relative",
          zIndex: 1,
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
        }}
      >
        {display}
      </span>
    </div>
  );
}

export function TableWidget({
  widget,
  data,
  glossary,
  onDataPointClick,
  padded = true,
}: TableWidgetProps) {
  const titleNode = applyGlossary(widget.title, glossary);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sortedRows = useMemo(() => {
    if (!data || sortCol === null) return data?.rows ?? [];
    const rows = [...data.rows];
    rows.sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (isNullish(va) && isNullish(vb)) return 0;
      if (isNullish(va)) return 1;
      if (isNullish(vb)) return -1;
      const na = Number(va);
      const nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return sortDir === "asc" ? na - nb : nb - na;
      }
      const sa = String(va);
      const sb = String(vb);
      return sortDir === "asc"
        ? sa.localeCompare(sb, "es")
        : sb.localeCompare(sa, "es");
    });
    return rows;
  }, [data, sortCol, sortDir]);

  function handleSort(colIdx: number) {
    if (sortCol === colIdx) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colIdx);
      setSortDir("asc");
    }
  }

  // Compute column max values for heat cells
  const colMaxValues = useMemo(() => {
    if (!data) return [];
    return data.columns.map((_, cIdx) => {
      let max = 0;
      for (const row of data.rows) {
        const v = Number(row[cIdx]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      return max;
    });
  }, [data]);

  if (!data || data.rows.length === 0) {
    return (
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
            {titleNode}
          </h3>
        </div>
        <p style={{ padding: "16px 12px", textAlign: "center", fontSize: 13, color: "var(--fg-muted)" }}>
          {EMPTY_MESSAGE}
        </p>
      </div>
    );
  }

  const colFormats = data.columns.map(detectFormat);

  // Per-column numeric detection (right-aligned headers + cells).
  //
  // A column counts as numeric when the clear majority (≥80%) of non-null
  // cells are finite numbers. The "at least one" rule we used before
  // misclassified identifier columns like "Temporada" — values are mostly
  // codes ("S26", "VER", "P25-V") but a few rows happen to be a pure year
  // ("2024"). With the old rule the header right-aligned, the numeric rows
  // rendered as right-aligned heat cells, and the text rows fell through to
  // left-aligned text — so each row in the same column landed in a different
  // place. The majority rule keeps mixed-content identifier columns
  // consistently left-aligned. `ref` and `tag` formatted columns stay
  // left-aligned by design; `margin_pct` is always numeric.
  const colIsNumericRight = data.columns.map((_col, idx) => {
    const fmt = colFormats[idx];
    if (fmt === "ref" || fmt === "tag") return false;
    if (fmt === "margin_pct") return true;
    let total = 0;
    let numeric = 0;
    for (const row of data.rows) {
      const cell = row[idx];
      if (cell === null || cell === undefined || cell === "") continue;
      total += 1;
      if (typeof cell === "number" && Number.isFinite(cell)) {
        numeric += 1;
        continue;
      }
      if (typeof cell === "string") {
        const n = Number(cell);
        if (Number.isFinite(n)) numeric += 1;
      }
    }
    if (total === 0) return false;
    return numeric / total >= 0.8;
  });

  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)", letterSpacing: "-0.005em" }}>
          {titleNode}
        </h3>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", padding: padded ? "var(--pad, 0)" : 0 }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
          title={onDataPointClick ? "Clic para explorar" : undefined}
        >
          <thead>
            <tr>
              {data.columns.map((col, idx) => (
                <th
                  key={`${idx}-${col}`}
                  style={{
                    textAlign: colIsNumericRight[idx] ? "right" : "left",
                    padding: "10px 12px",
                    fontWeight: 500,
                    borderBottom: "1px solid var(--border)",
                    fontFamily: "var(--font-inter, sans-serif)",
                    fontSize: 11,
                    letterSpacing: "0.04em",
                    color: "var(--fg-subtle)",
                    whiteSpace: "nowrap",
                  }}
                  aria-sort={
                    sortCol === idx
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => handleSort(idx)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "inherit",
                      fontFamily: "inherit",
                      fontSize: "inherit",
                      textTransform: "inherit" as React.CSSProperties["textTransform"],
                      letterSpacing: "inherit",
                      padding: 0,
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: colIsNumericRight[idx] ? "flex-end" : "flex-start",
                      gap: 4,
                    }}
                  >
                    {col}
                    {sortCol === idx && (
                      <span>{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rIdx) => (
              <tr
                key={rIdx}
                style={{
                  borderTop: "1px solid var(--border)",
                  cursor: onDataPointClick ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onClick={
                  onDataPointClick
                    ? () =>
                        onDataPointClick({
                          label: String(row[0] ?? ""),
                          value: "",
                          widgetTitle: widget.title,
                          widgetType: "table",
                        })
                    : undefined
                }
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = "var(--bg-2)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = "";
                }}
              >
                {row.map((cell, cIdx) => {
                  const fmt = colFormats[cIdx];
                  const colMax = colMaxValues[cIdx];
                  const numVal = Number(cell);
                  const isNumeric = !isNullish(cell) && Number.isFinite(numVal);

                  // Rank column (first column, integer-looking)
                  if (cIdx === 0 && isNumeric && numVal >= 0 && numVal < 1000) {
                    return (
                      <td
                        key={cIdx}
                        style={{ padding: "10px 12px", color: "var(--fg)" }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-jetbrains, monospace)",
                            color: "var(--fg-subtle)",
                            fontSize: 11,
                          }}
                        >
                          {String(Math.round(numVal)).padStart(2, "0")}
                        </span>
                      </td>
                    );
                  }

                  if (fmt === "ref") {
                    return (
                      <td key={cIdx} style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            fontFamily: "var(--font-jetbrains, monospace)",
                            color: "var(--accent)",
                            fontSize: 11,
                          }}
                        >
                          {String(cell ?? "")}
                        </span>
                      </td>
                    );
                  }

                  if (fmt === "tag") {
                    return (
                      <td key={cIdx} style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 3,
                            background: "var(--bg-2)",
                            color: "var(--fg-muted)",
                            fontFamily: "var(--font-jetbrains, monospace)",
                          }}
                        >
                          {toTitleCase(String(cell ?? ""))}
                        </span>
                      </td>
                    );
                  }

                  if (fmt === "margin_pct" && isNumeric) {
                    const color =
                      numVal > 60
                        ? "var(--up)"
                        : numVal > 50
                        ? "var(--fg)"
                        : "var(--warn)";
                    return (
                      <td key={cIdx} style={{ padding: "10px 12px", textAlign: "right" }}>
                        <span
                          style={{
                            color,
                            fontFamily: "var(--font-jetbrains, monospace)",
                            fontSize: 11,
                          }}
                        >
                          {numVal.toFixed(1)}%
                        </span>
                      </td>
                    );
                  }

                  // Numeric columns get heat cells. Gate on the column-level
                  // decision so a single numeric-looking value inside an
                  // identifier column (e.g. a "2024" inside Temporada) does
                  // not render right-aligned while its sibling rows render
                  // left-aligned as text.
                  if (isNumeric && colIsNumericRight[cIdx] && colMax > 0) {
                    return (
                      <td key={cIdx} style={{ padding: "10px 12px", textAlign: "right" }}>
                        <HeatCell value={numVal} max={colMax} />
                      </td>
                    );
                  }

                  // String columns: apply toTitleCase when value looks like words
                  const str = String(cell ?? "");
                  const looksLikeWords = str.length > 3 && !/^\d+/.test(str) && /[A-Za-z]/.test(str);
                  return (
                    <td key={cIdx} style={{ padding: "10px 12px", color: "var(--fg)" }}>
                      {looksLikeWords ? toTitleCase(str) : formatCellValue(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
