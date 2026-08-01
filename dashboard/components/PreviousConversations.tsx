"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string;
  title: string | null;
  first_user_prompt: string | null;
  last_interaction_at: string;
  created_at: string;
  message_count: number;
  archived_at: string | null;
  last_status: string | null;
}

interface PreviousConversationsProps {
  dashboardId: number;
  mode: "modify" | "analyze";
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return "hace un momento";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "(sin título)";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// PreviousConversations — popover panel listing past conversations
// ---------------------------------------------------------------------------

export default function PreviousConversations({
  dashboardId,
  mode,
  onClose,
}: PreviousConversationsProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchConversations = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(false);
      fetch(
        `/api/conversations?context_kind=dashboard&context_ref=${dashboardId}&mode=${mode}&include_archived=true`,
        signal ? { signal } : undefined,
      )
        .then(async (res) => {
          if (res.status === 404) {
            // Route not yet available (Task 2 / #537) — treat as empty list
            setConversations([]);
            setLoading(false);
            return;
          }
          if (!res.ok) {
            setError(true);
            setLoading(false);
            return;
          }
          const data = await res.json();
          const list: ConversationSummary[] = Array.isArray(data) ? data : (data.conversations ?? []);
          setConversations(list);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(true);
          setLoading(false);
        });
    },
    [dashboardId, mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchConversations(controller.signal);
    return () => controller.abort();
  }, [fetchConversations]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleConversationClick = (conv: ConversationSummary) => {
    // TODO(#539): Once Task 4 (#539) merges and /k/<id> route is available,
    // replace this stub with router.push(`/k/${conv.id}`)
    window.location.href = `/k/${conv.id}`;
  };

  const active = conversations.filter((c) => !c.archived_at);
  const displayedConversations = showArchived ? conversations : active;

  return (
    <div
      ref={panelRef}
      data-testid="previous-conversations-panel"
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        width: 340,
        maxHeight: 420,
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      role="dialog"
      aria-label="Conversaciones anteriores"
    >
      {/* Panel header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>
          Conversaciones anteriores
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: "var(--fg-muted)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              data-testid="show-archived-toggle"
              style={{ cursor: "pointer" }}
            />
            Mostrar archivadas
          </label>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar panel de conversaciones"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--fg-muted)",
              fontSize: 14,
              padding: "2px 4px",
              borderRadius: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {loading && (
          <div
            style={{
              padding: "24px 14px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-subtle)",
            }}
          >
            Cargando…
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: "24px 14px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-muted)",
            }}
          >
            No se pudo cargar el historial.{" "}
            <button
              type="button"
              onClick={() => fetchConversations()}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--accent)",
                fontSize: 12,
                padding: 0,
                textDecoration: "underline",
                fontFamily: "inherit",
              }}
            >
              Reintentar
            </button>
          </div>
        )}

        {!loading && !error && displayedConversations.length === 0 && (
          <div
            style={{
              padding: "24px 14px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-subtle)",
            }}
          >
            {showArchived
              ? "No hay conversaciones guardadas."
              : "No hay conversaciones anteriores. ¡Empieza una nueva!"}
          </div>
        )}

        {!loading && !error && displayedConversations.length > 0 && (
          <ul
            style={{ listStyle: "none", margin: 0, padding: 0 }}
            data-testid="conversations-list"
          >
            {displayedConversations.map((conv) => {
              const isArchived = !!conv.archived_at;
              const displayTitle = conv.title
                ? truncate(conv.title, 55)
                : truncate(conv.first_user_prompt, 55);

              return (
                <li key={conv.id}>
                  <button
                    type="button"
                    onClick={() => handleConversationClick(conv)}
                    data-testid={`conversation-row-${conv.id}`}
                    style={{
                      width: "100%",
                      background: "none",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      padding: "10px 14px",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      opacity: isArchived ? 0.65 : 1,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "var(--bg-2)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "none";
                    }}
                    title={`Abrir en contexto — /k/${conv.id}`}
                  >
                    {/* Row top: title + status badges */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "nowrap",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--fg)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayTitle}
                      </span>

                      {isArchived && (
                        <span
                          data-testid={`archived-badge-${conv.id}`}
                          style={{
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 8,
                            background: "var(--bg-2)",
                            border: "1px solid var(--border)",
                            color: "var(--fg-muted)",
                            flexShrink: 0,
                          }}
                        >
                          Archivada
                        </span>
                      )}

                      {conv.last_status === "error" && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 8,
                            background: "rgba(220,38,38,0.1)",
                            border: "1px solid rgba(220,38,38,0.3)",
                            color: "#f87171",
                            flexShrink: 0,
                          }}
                        >
                          Error
                        </span>
                      )}
                    </div>

                    {/* Row bottom: metadata */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 11,
                        color: "var(--fg-subtle)",
                      }}
                    >
                      <span>{relativeTime(conv.last_interaction_at)}</span>
                      {typeof conv.message_count === "number" && (
                        <>
                          <span style={{ opacity: 0.4 }}>·</span>
                          <span>{conv.message_count} mens.</span>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
