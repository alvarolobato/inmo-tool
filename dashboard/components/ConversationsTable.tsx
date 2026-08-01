"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getModePillStyle } from "@/lib/conversation-mode-style";
import { ConversationRowActions } from "@/components/ConversationRowActions";
import { getConversationDisplayTitle } from "@/lib/conversation-types";
import type { ConversationRow } from "@/app/conversations/types";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffH = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffH / 24);

  if (diffSec < 60) return "hace un momento";
  if (diffMin < 60) return `hace ${diffMin} min`;
  if (diffH < 24) return `hace ${diffH} hora${diffH !== 1 ? "s" : ""}`;
  if (diffDays === 1) return "ayer";
  if (diffDays < 7) return `hace ${diffDays} días`;
  const weeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return `hace ${weeks} semana${weeks !== 1 ? "s" : ""}`;
  const months = Math.floor(diffDays / 30);
  return `hace ${months} mes${months !== 1 ? "es" : ""}`;
}

function absoluteDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} días`;
}

function formatTokens(n: number): string {
  if (n <= 0) return "0";
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    generate: "Generar",
    modify: "Modificar",
    analyze: "Analizar",
    suggest: "Sugerir",
    gap: "Hueco",
    summary: "Resumen",
    title: "Título",
  };
  return labels[mode] ?? mode;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortCol = "last_interaction_at" | "created_at";

interface SortState {
  col: SortCol;
  dir: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConversationsTableProps {
  conversations: ConversationRow[];
  onArchiveToggle: (id: string, currentlyArchived: boolean) => void;
  onRename: (id: string, title: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConversationsTable({
  conversations,
  onArchiveToggle,
  onRename,
}: ConversationsTableProps) {
  const router = useRouter();
  const [sort, setSort] = useState<SortState>({
    col: "last_interaction_at",
    dir: "desc",
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Sort
  const sorted = useMemo(
    () =>
      [...conversations].sort((a, b) => {
        const aVal = a[sort.col];
        const bVal = b[sort.col];
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return sort.dir === "desc" ? -cmp : cmp;
      }),
    [conversations, sort.col, sort.dir]
  );

  const toggleSort = (col: SortCol) => {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" }
    );
  };

  // Selection
  const allSelected =
    sorted.length > 0 && sorted.every((r) => selected.has(r.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((r) => r.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Bulk archive
  const handleBulkArchive = (archive: boolean) => {
    selected.forEach((id) => {
      const row = conversations.find((r) => r.id === id);
      if (!row) return;
      const isCurrentlyArchived = row.archived_at !== null;
      if (archive !== isCurrentlyArchived) {
        onArchiveToggle(id, isCurrentlyArchived);
      }
    });
    setSelected(new Set());
  };

  // Inline rename
  const startRename = (row: ConversationRow) => {
    setRenamingId(row.id);
    setRenameValue(getConversationDisplayTitle(row));
  };

  const commitRename = (id: string) => {
    if (renameValue.trim()) {
      onRename(id, renameValue.trim());
    }
    setRenamingId(null);
  };

  // Styles — headers always sticky at top: 0; bulk bar placed outside the
  // scrollable div with zIndex: 11 so it never covers column headers.
  const thStyle: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 600,
    textAlign: "left",
    color: "var(--fg-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
    background: "var(--bg-1)",
    position: "sticky" as const,
    top: 0,
    zIndex: 1,
  };

  // Base cell style — NO overflow/truncation here so the checkbox and
  // action columns don't get clipped. Apply truncation per-column below.
  const tdStyle: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 12,
    color: "var(--fg)",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "middle",
  };

  // Truncating cell style for fixed-width columns (mode, duration, tokens, activity).
  const tdTrunc: React.CSSProperties = {
    ...tdStyle,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const sortBtn = (col: SortCol, label: string) => (
    <button
      type="button"
      onClick={() => toggleSort(col)}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        color: sort.col === col ? "var(--fg)" : "var(--fg-muted)",
        fontWeight: sort.col === col ? 700 : 600,
        fontSize: 11,
        textTransform: "uppercase" as const,
        letterSpacing: "0.04em",
        padding: 0,
        fontFamily: "inherit",
        display: "flex",
        alignItems: "center",
        gap: 3,
      }}
      aria-label={`Ordenar por ${label}`}
    >
      {label}
      {sort.col === col && (
        <span aria-hidden="true">{sort.dir === "desc" ? "↓" : "↑"}</span>
      )}
    </button>
  );

  if (conversations.length === 0) {
    return (
      <div
        style={{
          padding: "48px 24px",
          textAlign: "center",
          color: "var(--fg-muted)",
          fontSize: 14,
        }}
        data-testid="empty-state"
      >
        No hay conversaciones aún. Empieza una desde un panel o desde una acción
        del Inicio.
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {/* Bulk action bar — placed outside the scrollable div so it never
          overlaps the sticky column headers (which are at top: 0 inside the
          scroll container). zIndex 11 keeps it above headers (zIndex 1). */}
      {selected.size > 0 && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 11,
            background: "var(--bg-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            fontSize: 13,
          }}
          data-testid="bulk-action-bar"
        >
          <span style={{ color: "var(--fg-muted)" }}>
            {selected.size} seleccionada{selected.size !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            style={{
              background: "var(--bg-3)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 12,
              cursor: "pointer",
              color: "var(--fg)",
              fontFamily: "inherit",
            }}
            onClick={() => handleBulkArchive(true)}
            data-testid="bulk-archive-btn"
          >
            Archivar seleccionadas
          </button>
          <button
            type="button"
            style={{
              background: "var(--bg-3)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 12,
              cursor: "pointer",
              color: "var(--fg)",
              fontFamily: "inherit",
            }}
            onClick={() => handleBulkArchive(false)}
            data-testid="bulk-unarchive-btn"
          >
            Desarchivar seleccionadas
          </button>
          <button
            type="button"
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--fg-muted)",
              fontSize: 12,
              fontFamily: "inherit",
            }}
            onClick={() => setSelected(new Set())}
          >
            Cancelar
          </button>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
          data-testid="conversations-table"
        >
          <colgroup>
            <col style={{ width: 36 }} />           {/* checkbox */}
            <col />                                  {/* title — takes all remaining space */}
            <col style={{ width: 90 }} />            {/* tipo/mode */}
            <col style={{ width: 160 }} />           {/* contexto */}
            <col style={{ width: 150 }} />           {/* última actividad */}
            <col style={{ width: 155 }} />           {/* creada — needs room for "14/05/2026, 06:40" */}
            <col style={{ width: 75 }} />            {/* duración */}
            <col style={{ width: 145 }} />           {/* actividad */}
            <col style={{ width: 75 }} />            {/* tokens */}
            <col style={{ width: 90 }} />            {/* acciones */}
          </colgroup>
          <thead>
            <tr>
              {/* Checkbox header — width matches the colgroup col (36px) */}
              <th style={{ ...thStyle, width: 36 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Seleccionar todas"
                  data-testid="select-all-checkbox"
                  style={{ cursor: "pointer" }}
                />
              </th>
              <th style={thStyle}>Título</th>
              <th style={thStyle}>Tipo</th>
              <th style={thStyle}>Contexto</th>
              <th style={thStyle}>{sortBtn("last_interaction_at", "Última actividad")}</th>
              <th style={thStyle}>{sortBtn("created_at", "Creada")}</th>
              <th style={thStyle}>Duración</th>
              <th style={thStyle}>Actividad</th>
              <th style={thStyle}>Tokens</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const modeStyle = getModePillStyle(row.mode);
              const displayTitle =
                row.title ??
                row.first_user_prompt ??
                "(sin título)";

              return (
                <tr
                  key={row.id}
                  style={{
                    background: selected.has(row.id)
                      ? "var(--accent-soft)"
                      : "transparent",
                    transition: "background 80ms",
                  }}
                  data-testid={`conversation-row-${row.id}`}
                >
                  {/* Checkbox */}
                  <td style={{ ...tdStyle, width: 36 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggleSelect(row.id)}
                      aria-label={`Seleccionar ${displayTitle}`}
                      style={{ cursor: "pointer" }}
                    />
                  </td>

                  {/* Título — click navigates to /c/:id; pencil icon triggers rename */}
                  <td style={{ ...tdStyle, maxWidth: 0 }}>
                    {renamingId === row.id ? (
                      <input
                        type="text"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(row.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        style={{
                          background: "var(--bg-2)",
                          border: "1px solid var(--accent)",
                          borderRadius: 3,
                          color: "var(--fg)",
                          fontSize: 12,
                          padding: "2px 6px",
                          width: "100%",
                          fontFamily: "inherit",
                          outline: "none",
                        }}
                        data-testid={`rename-input-${row.id}`}
                      />
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          overflow: "hidden",
                        }}
                      >
                        <a
                          href={`/conversations/${row.id}`}
                          title={displayTitle}
                          style={{
                            color: "inherit",
                            textDecoration: "none",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                            minWidth: 0,
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            router.push(`/conversations/${row.id}`);
                          }}
                          data-testid={`title-cell-${row.id}`}
                        >
                          {displayTitle}
                        </a>
                        <button
                          type="button"
                          title="Renombrar"
                          aria-label="Renombrar"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(row);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--fg-subtle, var(--fg-muted))",
                            fontSize: 12,
                            padding: "0 2px",
                            flexShrink: 0,
                            lineHeight: 1,
                            fontFamily: "inherit",
                          }}
                          data-testid={`rename-btn-${row.id}`}
                        >
                          ✎
                        </button>
                      </div>
                    )}
                  </td>

                  {/* Tipo — mode pill */}
                  <td style={{ ...tdTrunc }}>
                    <span
                      className={`${modeStyle.bg} ${modeStyle.fg}`}
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                      data-mode={row.mode}
                      data-testid={`mode-pill-${row.id}`}
                    >
                      {modeLabel(row.mode)}
                    </span>
                  </td>

                  {/* Contexto */}
                  <td style={{ ...tdTrunc }} data-testid={`context-cell-${row.id}`}>
                    {row.context_kind === "dashboard" ? (
                      row.context_dashboard_name != null ? (
                        <a
                          href={`/dashboard/${row.context_ref}`}
                          style={{
                            color: "var(--accent)",
                            textDecoration: "none",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                          }}
                          data-testid={`context-link-${row.id}`}
                        >
                          {row.context_dashboard_name}
                        </a>
                      ) : (
                        <span
                          style={{ color: "var(--fg-muted)" }}
                          data-testid={`context-deleted-${row.id}`}
                        >
                          {`Dashboard #${row.context_ref} (eliminado)`}
                        </span>
                      )
                    ) : row.context_kind === "home" ? (
                      <span style={{ color: "var(--fg-muted)" }}>Inicio</span>
                    ) : row.context_kind === "admin" ? (
                      <span style={{ color: "var(--fg-muted)" }}>Admin</span>
                    ) : (
                      <span style={{ color: "var(--fg-muted)" }}>Libre</span>
                    )}
                  </td>

                  {/* Última actividad */}
                  <td style={{ ...tdTrunc, fontWeight: 500 }}>
                    {relativeTime(row.last_interaction_at)}
                  </td>

                  {/* Creada */}
                  <td
                    style={{
                      ...tdTrunc,
                      color: "var(--fg-muted)",
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 11,
                    }}
                  >
                    {absoluteDate(row.created_at)}
                  </td>

                  {/* Duración */}
                  <td style={{ ...tdTrunc, color: "var(--fg-muted)" }}>
                    {formatDuration(row.duration_seconds)}
                  </td>

                  {/* Actividad */}
                  <td style={{ ...tdTrunc, color: "var(--fg-muted)" }}>
                    {row.message_count} msg
                    {row.tool_calls_count > 0 &&
                      ` · ${row.tool_calls_count} herr`}
                    {row.rounds_count > 0 && ` · ${row.rounds_count} rondas`}
                  </td>

                  {/* Tokens */}
                  <td
                    style={{
                      ...tdTrunc,
                      color: "var(--fg-muted)",
                      fontFamily: "var(--font-jetbrains, monospace)",
                      fontSize: 11,
                    }}
                  >
                    {formatTokens(row.token_total)}
                  </td>

                  {/* Acciones */}
                  <td style={{ ...tdStyle, textAlign: "right", overflow: "visible" }}>
                    <ConversationRowActions
                      conversation={row}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
