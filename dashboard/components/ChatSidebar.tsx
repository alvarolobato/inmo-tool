"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { DashboardSpec } from "@/lib/schema";
import type { WidgetState } from "@/components/DashboardRenderer";
import PreviousConversations from "@/components/PreviousConversations";
import type { InitialContext } from "@/lib/conversation-types";
import type { ChatMessage } from "./conversation/types";
import { useConfiguredModel, displayModelName } from "@/lib/useConfiguredModel";
import {
  ConversationPane,
  type NewConversationConfig,
} from "@/components/ConversationPane";

// ---------------------------------------------------------------------------
// Re-export ChatMessage so existing consumers keep working without changing
// their import paths.
// ---------------------------------------------------------------------------

export type { ChatMessage };

export interface ChatSidebarProps {
  spec: DashboardSpec;
  /** Spec already persisted server-side (versioned writer); sync local state only. */
  onSpecUpdate: (newSpec: DashboardSpec) => void;
  isOpen: boolean;
  onToggle: () => void;
  /** Saved dashboard id for agentic analyze tools (optional). */
  dashboardId?: number;
  /** Live widget data from DashboardRenderer (unused but kept for API compat). */
  widgetData?: Map<number, WidgetState>;
  /** Initial analyze messages — kept for API compat, no longer rendered directly. */
  initialAnalyzeMessages?: ChatMessage[];
  /** Initial modify messages — kept for API compat, no longer rendered directly. */
  initialModifyMessages?: ChatMessage[];
  pendingModifyInput?: string;
  pendingModifyTriggerId?: number;
  onPendingModifyInputConsumed?: () => void;
  pendingAnalyzeInput?: string;
  pendingAnalyzeTriggerId?: number;
  onPendingAnalyzeInputConsumed?: () => void;
  onOpenSidebar?: () => void;
  initialMode?: "modificar" | "analizar";
  hideWhenClosed?: boolean;
  /** LLM initial context from a preloaded modify conversation (unused, kept for API compat). */
  initialModifyContext?: InitialContext | null;
  /** LLM initial context from a preloaded analyze conversation (unused, kept for API compat). */
  initialAnalyzeContext?: InitialContext | null;
  /** Conversation ID to load on mount into the Modify tab. */
  initialConversationId?: string;
}

// ---------------------------------------------------------------------------
// Sidebar sizing
// ---------------------------------------------------------------------------

const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH_VW = 0.65;
const SIDEBAR_STORAGE_KEY = "chat-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 380;

function clampSidebarWidth(w: number): number {
  const maxW =
    typeof window !== "undefined"
      ? window.innerWidth * SIDEBAR_MAX_WIDTH_VW
      : Infinity;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(w, maxW));
}

// ---------------------------------------------------------------------------
// ChatSidebar
// ---------------------------------------------------------------------------

export default function ChatSidebar({
  spec,
  onSpecUpdate,
  isOpen,
  onToggle,
  dashboardId,
  pendingModifyInput,
  pendingModifyTriggerId,
  onPendingModifyInputConsumed,
  pendingAnalyzeInput,
  pendingAnalyzeTriggerId,
  onPendingAnalyzeInputConsumed,
  onOpenSidebar,
  initialMode,
  hideWhenClosed = false,
  initialConversationId,
}: ChatSidebarProps) {
  const configuredModel = useConfiguredModel();
  const [activeTab, setActiveTab] = useState<"modificar" | "analizar">(
    initialMode ?? "modificar",
  );

  // Conversation IDs per tab — null until a conversation exists or is loaded.
  const [modifyConvId, setModifyConvId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [analyzeConvId, setAnalyzeConvId] = useState<string | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [showPreviousConversations, setShowPreviousConversations] =
    useState(false);

  // ── Auto-load latest conversations on mount ──────────────────────────────

  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (dashboardId === undefined) return;
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;

    const ctrl = new AbortController();

    const loadLatest = async (apiMode: "modify" | "analyze") => {
      try {
        const res = await fetch(
          `/api/conversations?context_kind=dashboard&context_ref=${dashboardId}&mode=${apiMode}&limit=1`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as
          | { id: string; archived_at: string | null }[]
          | { conversations: { id: string; archived_at: string | null }[] };
        const list = Array.isArray(data) ? data : data.conversations;
        if (!list?.length) return;
        const conv = list[0];
        if (conv.archived_at) return;
        // Use functional updater to avoid stale-closure race: only set if still null.
        if (apiMode === "modify") {
          setModifyConvId((prev: string | null) => (prev === null ? conv.id : prev));
        } else if (apiMode === "analyze") {
          setAnalyzeConvId((prev: string | null) => (prev === null ? conv.id : prev));
        }
      } catch {
        // silently ignore — API not available
      }
    };

    if (!initialConversationId) void loadLatest("modify");
    void loadLatest("analyze");
    return () => {
      autoLoadedRef.current = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);

  // When initialConversationId changes (e.g. handoff), set it as the modify conv.
  useEffect(() => {
    if (initialConversationId) {
      setModifyConvId(initialConversationId);
      setActiveTab("modificar");
    }
  }, [initialConversationId]);

  // Apply initialMode changes
  useEffect(() => {
    if (initialMode) setActiveTab(initialMode);
  }, [initialMode]);

  // ── Resize ───────────────────────────────────────────────────────────────

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  });
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = resizeStartXRef.current - e.clientX;
      const newWidth = clampSidebarWidth(resizeStartWidthRef.current + delta);
      setSidebarWidth(newWidth);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      const delta = resizeStartXRef.current - e.clientX;
      const newWidth = clampSidebarWidth(resizeStartWidthRef.current + delta);
      localStorage.setItem(SIDEBAR_STORAGE_KEY, newWidth.toString());
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (isResizingRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        isResizingRef.current = false;
      }
    };
  }, []);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  // ── New conversation ─────────────────────────────────────────────────────

  const handleNewConversation = useCallback(() => {
    // Archive current conversation for the active tab, then reset its ID.
    const convId =
      activeTab === "modificar" ? modifyConvId : analyzeConvId;

    if (convId) {
      void fetch(`/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }).catch(() => {});
    }

    if (activeTab === "modificar") {
      setModifyConvId(null);
    } else {
      setAnalyzeConvId(null);
    }
    setShowPreviousConversations(false);
  }, [activeTab, modifyConvId, analyzeConvId]);

  // ── Prefill handling — open sidebar + switch tab if needed ───────────────

  useEffect(() => {
    if (!pendingModifyInput?.trim() || pendingModifyTriggerId === undefined)
      return;
    if (!isOpen) {
      (onOpenSidebar ?? onToggle)();
      return;
    }
    setActiveTab("modificar");
  }, [pendingModifyInput, pendingModifyTriggerId, isOpen, onOpenSidebar, onToggle]);

  useEffect(() => {
    if (!pendingAnalyzeInput?.trim() || pendingAnalyzeTriggerId === undefined)
      return;
    if (!isOpen) {
      (onOpenSidebar ?? onToggle)();
      return;
    }
    setActiveTab("analizar");
  }, [
    pendingAnalyzeInput,
    pendingAnalyzeTriggerId,
    isOpen,
    onOpenSidebar,
    onToggle,
  ]);

  // ── New conversation config for ConversationPane ─────────────────────────

  const modifyConfig: NewConversationConfig | undefined =
    dashboardId !== undefined
      ? {
          conversationMode: "modify",
          contextKind: "dashboard",
          contextRef: String(dashboardId),
        }
      : undefined;

  const analyzeConfig: NewConversationConfig | undefined =
    dashboardId !== undefined
      ? {
          conversationMode: "analyze",
          contextKind: "dashboard",
          contextRef: String(dashboardId),
        }
      : undefined;

  // ── Collapsed state ──────────────────────────────────────────────────────

  if (!isOpen) {
    if (hideWhenClosed) return null;
    return (
      <button
        onClick={onToggle}
        aria-label="Abrir chat"
        style={{
          position: "fixed",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          zIndex: 50,
          background: "var(--accent)",
          color: "#fff",
          border: "none",
          padding: "16px 8px",
          borderTopLeftRadius: 8,
          borderBottomLeftRadius: 8,
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        }}
      >
        <span
          style={{
            writingMode: "vertical-rl",
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          Chat
        </span>
      </button>
    );
  }

  // ── Open state ───────────────────────────────────────────────────────────

  return (
    <aside
      data-testid="chat-sidebar"
      style={{
        position: "fixed",
        top: 56,
        right: 0,
        bottom: 0,
        width: sidebarWidth,
        background: "var(--bg-1)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        zIndex: 15,
      }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 6,
          bottom: 0,
          cursor: "col-resize",
          zIndex: 20,
        }}
        title="Arrastrar para cambiar el ancho"
      />

      {/* Header */}
      <header
        style={{
          padding: "12px 16px 0",
          borderBottom: "1px solid var(--border)",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
              Asistente IA
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                aria-label={
                  isProcessing ? "Estado: procesando" : "Estado: conectado"
                }
                style={{
                  width: isProcessing ? 10 : 5,
                  height: isProcessing ? 10 : 5,
                  borderRadius: "50%",
                  background: isProcessing ? "transparent" : "var(--up)",
                  border: isProcessing ? "2px solid var(--accent)" : "none",
                  borderTopColor: isProcessing ? "transparent" : undefined,
                  animation: isProcessing
                    ? "spin 0.8s linear infinite"
                    : "pulse-dot 2s ease-in-out infinite",
                  display: "inline-block",
                  flexShrink: 0,
                  transition: "all 0.2s",
                }}
              />
              {isProcessing
                ? `Procesando · ${configuredModel ? displayModelName(configuredModel) : "..."}`
                : `Conectado · ${configuredModel ? displayModelName(configuredModel) : "..."}`}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {dashboardId !== undefined && !initialConversationId && (
              <button
                type="button"
                onClick={handleNewConversation}
                aria-label="Nueva conversación"
                data-testid="new-conversation-btn"
                title="Nueva conversación"
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  color: "var(--fg-muted)",
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 6,
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                  whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden="true">+</span>
                <span>Nueva</span>
              </button>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-label="Cerrar chat"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--fg-muted)",
                fontSize: 16,
                padding: "4px 8px",
                borderRadius: 6,
                height: 28,
                display: "flex",
                alignItems: "center",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div
          style={{ display: "flex", gap: 0, marginTop: 6, alignItems: "stretch" }}
          role="tablist"
          aria-label="Pestañas del chat"
        >
          {(["modificar", "analizar"] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              data-testid={`tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1,
                padding: "10px 0",
                background: "transparent",
                border: "none",
                color:
                  activeTab === tab ? "var(--accent)" : "var(--fg-muted)",
                borderBottom: `2px solid ${activeTab === tab ? "var(--accent)" : "transparent"}`,
                fontSize: 12,
                fontWeight: activeTab === tab ? 600 : 500,
                cursor: "pointer",
                fontFamily: "inherit",
                textTransform: "capitalize",
              }}
            >
              {tab === "modificar" ? "Modificar" : "Analizar"}
            </button>
          ))}

          {dashboardId !== undefined && (
            <button
              type="button"
              onClick={() => setShowPreviousConversations((v) => !v)}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Ver conversaciones anteriores"
              aria-expanded={showPreviousConversations}
              data-testid="previous-conversations-btn"
              title="Conversaciones anteriores"
              style={{
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${showPreviousConversations ? "var(--accent)" : "transparent"}`,
                cursor: "pointer",
                color: showPreviousConversations
                  ? "var(--accent)"
                  : "var(--fg-muted)",
                padding: "10px 10px",
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          )}
        </div>

        {showPreviousConversations && dashboardId !== undefined && (
          <PreviousConversations
            dashboardId={dashboardId}
            mode={activeTab === "modificar" ? "modify" : "analyze"}
            onClose={() => setShowPreviousConversations(false)}
          />
        )}
      </header>

      {/* Tab content — ConversationPane */}
      <div
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {activeTab === "modificar" ? (
          <ConversationPane
            key="modify"
            conversationId={modifyConvId}
            mode="panel"
            onSpecUpdate={onSpecUpdate}
            newConversationConfig={modifyConfig}
            onConversationCreated={setModifyConvId}
            onProcessingChange={setIsProcessing}
            prefillText={pendingModifyInput}
            prefillId={pendingModifyTriggerId}
            onPrefillConsumed={onPendingModifyInputConsumed}
          />
        ) : (
          <ConversationPane
            key="analyze"
            conversationId={analyzeConvId}
            mode="panel"
            newConversationConfig={analyzeConfig}
            onConversationCreated={setAnalyzeConvId}
            onProcessingChange={setIsProcessing}
            prefillText={pendingAnalyzeInput}
            prefillId={pendingAnalyzeTriggerId}
            onPrefillConsumed={onPendingAnalyzeInputConsumed}
          />
        )}
      </div>
    </aside>
  );
}
