"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import type { ConversationRow } from "@/app/conversations/types";

interface ConversationListSidebarProps {
  selectedId: string;
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}sem`;
  return new Date(ts).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export function ConversationListSidebar({ selectedId }: ConversationListSidebarProps) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const loadConversations = useCallback(async () => {
    try {
      // No mode/context_kind filter — the split-view route is reachable from
      // all conversation types (free-chat, analyze, modify), so the sidebar
      // must list all of them. Original spec filtered to free-chat only,
      // which made the sidebar empty when viewing a dashboard conversation.
      const res = await fetch("/api/conversations?limit=50");
      if (!res.ok) return;
      const data = await res.json();
      const rows: ConversationRow[] = Array.isArray(data) ? data : data.conversations ?? [];
      // Sort by last_interaction_at DESC
      rows.sort(
        (a, b) =>
          new Date(b.last_interaction_at).getTime() -
          new Date(a.last_interaction_at).getTime(),
      );
      setConversations(rows);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title?.toLowerCase().includes(q) ||
        c.first_user_prompt?.toLowerCase().includes(q) ||
        c.last_message_preview?.toLowerCase().includes(q),
    );
  }, [conversations, query]);

  // Optimistically clear the unread dot for the currently selected conversation.
  useEffect(() => {
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, is_unread: false } : c)),
    );
  }, [selectedId]);

  return (
    <div
      data-testid="conversation-list-sidebar"
      style={{
        width: 280,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        overflowY: "auto",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Sidebar header */}
      <div
        style={{
          padding: "12px 14px 8px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          fontWeight: 700,
          color: "var(--fg-muted)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        Conversaciones
      </div>

      {/* Search */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <input
          type="search"
          aria-label="Buscar conversaciones"
          placeholder="Buscar…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            padding: "5px 8px",
            fontSize: 12,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--fg)",
            fontFamily: "inherit",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {loading && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "24px 0",
          }}
        >
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              border: "2px solid var(--border)",
              borderTopColor: "var(--accent)",
              animation: "spin 0.8s linear infinite",
            }}
          />
        </div>
      )}

      {!loading && conversations.length === 0 && (
        <div
          style={{
            padding: "16px 14px",
            fontSize: 12,
            color: "var(--fg-muted)",
          }}
        >
          Sin conversaciones
        </div>
      )}

      {!loading &&
        filtered.map((conv) => {
          const title =
            conv.title?.trim() ||
            (conv.first_user_prompt
              ? conv.first_user_prompt.slice(0, 50)
              : "Sin título");
          const isSelected = conv.id === selectedId;
          const isUnread = conv.is_unread === true;
          const isRunning = conv.last_status === "running";

          return (
            <Link
              key={conv.id}
              href={`/conversations/${conv.id}`}
              data-testid={`sidebar-conv-${conv.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                textDecoration: "none",
                color: "var(--fg)",
                background: isSelected ? "var(--bg-3)" : "transparent",
                borderLeft: isSelected
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                minWidth: 0,
              }}
            >
              {/* Running spinner or unread dot */}
              {isRunning ? (
                <span
                  aria-label="Procesando"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "2px solid var(--accent)",
                    borderTopColor: "transparent",
                    flexShrink: 0,
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              ) : (
                <span
                  aria-label={isUnread ? "No leído" : undefined}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: isUnread ? "var(--accent)" : "transparent",
                    flexShrink: 0,
                  }}
                />
              )}

              {/* Title + timestamp */}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: isSelected || isUnread ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--fg)",
                  }}
                >
                  {title}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--fg-muted)",
                  }}
                >
                  {formatRelativeTime(conv.last_interaction_at)}
                </span>
              </span>
            </Link>
          );
        })}
      {!loading && query.trim() && filtered.length === 0 && (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--fg-muted)" }}>
          Sin resultados
        </div>
      )}
    </div>
  );
}
