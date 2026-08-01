"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConversationsTable } from "@/components/ConversationsTable";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { NewConversationDialog } from "@/components/NewConversationDialog";
import { isApiErrorResponse, type ApiErrorResponse } from "@/lib/errors";
import type { ConversationRow } from "@/app/conversations/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODES = ["generate", "modify", "analyze", "suggest", "gap", "summary", "title"];
const CONTEXT_KINDS = ["dashboard", "home", "admin", "global"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiUrl(params: {
  q: string;
  modes: string[];
  contextKinds: string[];
  since: string;
  onlyArchived: boolean;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  params.modes.forEach((m) => sp.append("mode", m));
  params.contextKinds.forEach((k) => sp.append("context_kind", k));
  if (params.since) sp.set("since", params.since);
  if (params.onlyArchived) sp.set("only_archived", "true");
  sp.set("limit", "100");
  const qs = sp.toString();
  return `/api/conversations${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------
// MultiSelectDropdown — compact button + checkbox panel
// ---------------------------------------------------------------------------

interface MultiSelectDropdownProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  testId?: string;
}

function MultiSelectDropdown({ label, options, selected, onChange, testId }: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (item: string) => {
    onChange(
      selected.includes(item) ? selected.filter((x) => x !== item) : [...selected, item]
    );
  };

  const btnStyle: React.CSSProperties = {
    background: selected.length > 0 ? "var(--accent)" : "var(--bg-2)",
    border: `1px solid ${selected.length > 0 ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 6,
    color: selected.length > 0 ? "var(--accent-fg, #fff)" : "var(--fg-muted)",
    fontSize: 12,
    padding: "5px 10px",
    cursor: "pointer",
    fontFamily: "inherit",
    height: 30,
    display: "flex",
    alignItems: "center",
    gap: 4,
    whiteSpace: "nowrap",
  };

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 50,
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 0",
    minWidth: 140,
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  };

  const optionStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 12px",
    fontSize: 12,
    cursor: "pointer",
    color: active ? "var(--accent)" : "var(--fg)",
    fontWeight: active ? 600 : 400,
    background: "transparent",
    border: "none",
    width: "100%",
    textAlign: "left",
    fontFamily: "inherit",
  });

  const countLabel = selected.length > 0 ? ` (${selected.length})` : "";

  return (
    <div ref={ref} style={{ position: "relative" }} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={btnStyle}
        aria-expanded={open}
        aria-haspopup="true"
        data-testid={testId ? `${testId}-btn` : undefined}
      >
        {label}{countLabel} ▾
      </button>
      {open && (
        <div style={panelStyle}>
          {options.map((opt) => {
            const active = selected.includes(opt);
            return (
              <label
                key={opt}
                style={optionStyle(active)}
                data-testid={testId ? `${testId}-opt-${opt}` : undefined}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(opt)}
                  style={{ position: "absolute", opacity: 0, width: 1, height: 1, overflow: "hidden" }}
                />
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent)" : "transparent",
                    flexShrink: 0,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {active && (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M1.5 4L3.5 6L6.5 2" stroke="var(--accent-fg, #fff)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </span>
                {opt}
              </label>
            );
          })}
          {selected.length > 0 && (
            <>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
              <button
                type="button"
                onClick={() => { onChange([]); setOpen(false); }}
                style={{ ...optionStyle(false), color: "var(--fg-muted)", fontSize: 11 }}
                data-testid={testId ? `${testId}-clear` : undefined}
              >
                Limpiar filtro
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar sub-component
// ---------------------------------------------------------------------------

interface FilterBarProps {
  q: string;
  modes: string[];
  contextKinds: string[];
  since: string;
  onlyArchived: boolean;
  onQChange: (v: string) => void;
  onModesChange: (v: string[]) => void;
  onContextKindsChange: (v: string[]) => void;
  onSinceChange: (v: string) => void;
  onOnlyArchivedChange: (v: boolean) => void;
}

function FilterBar({
  q,
  modes,
  contextKinds,
  since,
  onlyArchived,
  onQChange,
  onModesChange,
  onContextKindsChange,
  onSinceChange,
  onOnlyArchivedChange,
}: FilterBarProps) {
  const inputStyle: React.CSSProperties = {
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--fg)",
    fontSize: 12,
    padding: "5px 10px",
    outline: "none",
    fontFamily: "inherit",
    height: 30,
  };

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        padding: "10px 20px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
      data-testid="filter-bar"
    >
      {/* Search */}
      <input
        type="search"
        placeholder="Buscar…"
        value={q}
        onChange={(e) => onQChange(e.target.value)}
        style={{ ...inputStyle, width: 180 }}
        data-testid="search-input"
        aria-label="Buscar conversaciones"
      />

      {/* Mode multi-select dropdown */}
      <MultiSelectDropdown
        label="Tipo"
        options={MODES}
        selected={modes}
        onChange={onModesChange}
        testId="mode-filter"
      />

      {/* Context kind multi-select dropdown */}
      <MultiSelectDropdown
        label="Contexto"
        options={CONTEXT_KINDS}
        selected={contextKinds}
        onChange={onContextKindsChange}
        testId="context-kind-filter"
      />

      {/* Since date */}
      <label
        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--fg-muted)" }}
      >
        Desde:
        <input
          type="date"
          value={since}
          onChange={(e) => onSinceChange(e.target.value)}
          style={{ ...inputStyle, width: 130 }}
          data-testid="since-input"
          aria-label="Desde fecha"
        />
      </label>

      {/* Ver archivadas toggle */}
      <label
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: "var(--fg-muted)" }}
        data-testid="archived-toggle-label"
      >
        <input
          type="checkbox"
          checked={onlyArchived}
          onChange={(e) => onOnlyArchivedChange(e.target.checked)}
          data-testid="archived-toggle"
          style={{ cursor: "pointer" }}
        />
        Ver archivadas
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function ConversationsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read filter state from URL
  const [q, setQ] = useState(() => searchParams?.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(() => searchParams?.get("q") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [modes, setModes] = useState<string[]>(() =>
    searchParams?.getAll("mode") ?? []
  );
  const [contextKinds, setContextKinds] = useState<string[]>(() =>
    searchParams?.getAll("context_kind") ?? []
  );
  const [since, setSince] = useState(() => searchParams?.get("since") ?? "");
  const [onlyArchived, setOnlyArchived] = useState(
    () => searchParams?.get("archived") === "1"
  );

  const [showNewConversationDialog, setShowNewConversationDialog] = useState(false);

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);

  // Persist filter state to URL
  const persistFilters = useCallback(
    (next: {
      q: string;
      modes: string[];
      contextKinds: string[];
      since: string;
      onlyArchived: boolean;
    }) => {
      const params = new URLSearchParams();
      if (next.q) params.set("q", next.q);
      next.modes.forEach((m) => params.append("mode", m));
      next.contextKinds.forEach((k) => params.append("context_kind", k));
      if (next.since) params.set("since", next.since);
      if (next.onlyArchived) params.set("archived", "1");
      router.replace(`/conversations?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  // Setters that also persist to URL
  const handleQChange = useCallback(
    (v: string) => {
      setQ(v);
      persistFilters({ q: v, modes, contextKinds, since, onlyArchived });
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setDebouncedQ(v), 350);
    },
    [modes, contextKinds, since, onlyArchived, persistFilters]
  );
  const handleModesChange = useCallback(
    (v: string[]) => {
      setModes(v);
      persistFilters({ q, modes: v, contextKinds, since, onlyArchived });
    },
    [q, contextKinds, since, onlyArchived, persistFilters]
  );
  const handleContextKindsChange = useCallback(
    (v: string[]) => {
      setContextKinds(v);
      persistFilters({ q, modes, contextKinds: v, since, onlyArchived });
    },
    [q, modes, since, onlyArchived, persistFilters]
  );
  const handleSinceChange = useCallback(
    (v: string) => {
      setSince(v);
      persistFilters({ q, modes, contextKinds, since: v, onlyArchived });
    },
    [q, modes, contextKinds, onlyArchived, persistFilters]
  );
  const handleOnlyArchivedChange = useCallback(
    (v: boolean) => {
      setOnlyArchived(v);
      persistFilters({ q, modes, contextKinds, since, onlyArchived: v });
    },
    [q, modes, contextKinds, since, persistFilters]
  );

  // Fetch conversations
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = buildApiUrl({ q: debouncedQ, modes, contextKinds, since, onlyArchived });
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          setConversations([]);
          return;
        }
        // Try to surface the rich error envelope from the API so the user
        // sees code / requestId / details, not just "HTTP 500".
        const body = await res.json().catch(() => null);
        if (isApiErrorResponse(body)) {
          setError(body);
        } else {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      const data = await res.json();
      setConversations(Array.isArray(data) ? data : data.conversations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar conversaciones");
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, modes, contextKinds, since, onlyArchived]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Archive toggle
  const handleArchiveToggle = useCallback(
    async (id: string, currentlyArchived: boolean) => {
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: !currentlyArchived }),
        });
        if (res.ok) {
          // When showing only archived, archiving removes a row; unarchiving also removes it
          // When showing only active (default), archiving removes the row
          setConversations((prev) => prev.filter((c) => c.id !== id));
        }
      } catch {
        // Ignore network errors
      }
    },
    []
  );

  // Rename
  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title } : c))
        );
      }
    } catch {
      // Ignore
    }
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "20px 20px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--fg)",
              margin: 0,
              letterSpacing: "-0.02em",
            }}
          >
            Conversaciones
          </h1>
          <p style={{ marginTop: 3, fontSize: 12, color: "var(--fg-muted)", margin: "3px 0 0" }}>
            Historial de todas las interacciones con la IA
          </p>
        </div>

        <button
          type="button"
          data-testid="new-conversation-btn"
          onClick={() => setShowNewConversationDialog(true)}
          style={{
            background: "var(--accent)",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            padding: "8px 16px",
            cursor: "pointer",
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
          }}
        >
          + Nueva conversación
        </button>
      </div>

      <NewConversationDialog
        open={showNewConversationDialog}
        onClose={() => setShowNewConversationDialog(false)}
      />

      {/* Filter bar */}
      <FilterBar
        q={q}
        modes={modes}
        contextKinds={contextKinds}
        since={since}
        onlyArchived={onlyArchived}
        onQChange={handleQChange}
        onModesChange={handleModesChange}
        onContextKindsChange={handleContextKindsChange}
        onSinceChange={handleSinceChange}
        onOnlyArchivedChange={handleOnlyArchivedChange}
      />

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 20px 24px" }}>
        {loading && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "48px 0",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                border: "3px solid var(--border)",
                borderTopColor: "var(--accent)",
                animation: "spin 0.8s linear infinite",
              }}
              role="status"
              aria-label="Cargando"
            />
          </div>
        )}

        {!loading && error && (
          <div data-testid="error-message">
            <ErrorDisplay
              error={error}
              title="No se pudieron cargar las conversaciones"
              onRetry={fetchConversations}
            />
          </div>
        )}

        {!loading && !error && (
          <ConversationsTable
            conversations={conversations}
            onArchiveToggle={handleArchiveToggle}
            onRename={handleRename}
          />
        )}
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense>
      <ConversationsPageContent />
    </Suspense>
  );
}
