"use client";

import { useState, useCallback } from "react";
import type { ToolCallRecord } from "@/lib/conversation-types";

interface InlineToolCallProps {
  call: ToolCallRecord;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface SqlPreviewProps {
  rows: unknown[];
  columns: string[];
}

function SqlResultPreview({ rows, columns }: SqlPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = expanded ? rows : rows.slice(0, 5);
  const previewCols = expanded ? columns : columns.slice(0, 5);

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            fontSize: 11,
            borderCollapse: "collapse",
            width: "100%",
            fontFamily: "var(--font-jetbrains, monospace)",
          }}
        >
          <thead>
            <tr>
              {previewCols.map((col) => (
                <th
                  key={col}
                  style={{
                    padding: "3px 8px",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border)",
                    textAlign: "left",
                    color: "var(--fg-muted)",
                    fontWeight: 600,
                  }}
                >
                  {col}
                </th>
              ))}
              {!expanded && columns.length > 5 && (
                <th
                  style={{
                    padding: "3px 8px",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border)",
                    color: "var(--fg-subtle)",
                  }}
                >
                  +{columns.length - 5}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, ri) => {
              const r = row as Record<string, unknown>;
              return (
                <tr key={ri}>
                  {previewCols.map((col) => (
                    <td
                      key={col}
                      style={{
                        padding: "3px 8px",
                        border: "1px solid var(--border)",
                        color: "var(--fg)",
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {String(r[col] ?? "")}
                    </td>
                  ))}
                  {!expanded && columns.length > 5 && (
                    <td style={{ padding: "3px 8px", border: "1px solid var(--border)" }} />
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(rows.length > 5 || columns.length > 5) && (
        <button
          onClick={() => setExpanded((e) => !e)}
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--accent)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
          }}
        >
          {expanded
            ? "Colapsar"
            : `Ver completo (${rows.length} filas × ${columns.length} cols)`}
        </button>
      )}
    </div>
  );
}

function isSqlResult(result: unknown): result is { rows: unknown[]; columns: string[] } {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return Array.isArray(r.rows) && Array.isArray(r.columns);
}

export function InlineToolCall({ call }: InlineToolCallProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyResult = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formatJson(call.result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }, [call.result]);

  const statusColor = call.success === false ? "var(--down)" : "var(--up)";
  const statusLabel = call.success === false ? "Error" : "OK";

  return (
    <div
      style={{
        marginTop: 4,
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      {/* Header row — always visible */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-1)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 12,
        }}
        aria-expanded={open}
      >
        <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontWeight: 600, color: "var(--fg)" }}>{call.name}</span>
        {call.duration_ms !== undefined && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{call.duration_ms} ms</span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontWeight: 600,
            color: statusColor,
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {statusLabel}
        </span>
      </button>

      {/* Expanded body */}
      {open && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--bg-0, var(--bg))",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Arguments */}
          <div>
            <p
              style={{
                margin: "0 0 4px",
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--fg-muted)",
              }}
            >
              Argumentos
            </p>
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                fontFamily: "var(--font-jetbrains, monospace)",
                color: "var(--fg)",
                background: "var(--bg-1)",
                borderRadius: 4,
                padding: "6px 8px",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {formatJson(call.arguments)}
            </pre>
          </div>

          {/* Result */}
          {call.result !== undefined && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--fg-muted)",
                  }}
                >
                  Resultado
                </p>
                <button
                  onClick={copyResult}
                  style={{
                    fontSize: 10,
                    color: "var(--accent)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    fontFamily: "inherit",
                  }}
                >
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </div>
              {isSqlResult(call.result) ? (
                <SqlResultPreview
                  rows={call.result.rows}
                  columns={call.result.columns}
                />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    fontSize: 11,
                    fontFamily: "var(--font-jetbrains, monospace)",
                    color: "var(--fg)",
                    background: "var(--bg-1)",
                    borderRadius: 4,
                    padding: "6px 8px",
                    overflowX: "auto",
                    maxHeight: 300,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {formatJson(call.result)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
