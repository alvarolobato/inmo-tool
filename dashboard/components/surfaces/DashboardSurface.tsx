"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DashboardRenderer } from "@/components/DashboardRenderer";
import { DashboardFiltersBar } from "@/components/DashboardFiltersBar";
import type { GlobalFilterValues } from "@/lib/sql-filters";
import type { WidgetState } from "@/components/DashboardRenderer";
import { DataFreshnessBanner } from "@/components/DataFreshnessBanner";
import ChatSidebar from "@/components/ChatSidebar";
import type { ChatMessage } from "@/components/ChatSidebar";
import AnalyzeLauncher from "@/components/AnalyzeLauncher";
import {
  DateRangePicker,
  computeComparisonRange,
  startOfDay,
  endOfDay,
} from "@/components/DateRangePicker";
import type { DateRange, ComparisonRange } from "@/components/DateRangePicker";
import { GlossaryPanel } from "@/components/GlossaryPanel";
import { VersionHistory } from "@/components/VersionHistory";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { DashboardSpec } from "@/lib/schema";
import type { ApiErrorResponse } from "@/lib/errors";
import type { DrillDownContext } from "@/components/widgets/types";
import type { ConversationWithMessages } from "@/lib/conversation-types";
import { convertConversationMessages } from "@/components/conversation/convertConversationMessages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardRecord {
  id: number;
  name: string;
  description: string | null;
  spec: DashboardSpec;
  created_at: string;
  updated_at: string;
}

const REFRESH_INTERVALS = [5, 15, 30] as const;
type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

function getDefaultDashboardDateRange(): DateRange {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    23,
    59,
    59,
    999,
  );
  return { from, to };
}

function defaultComparisonRangeFor(primary: DateRange): ComparisonRange | undefined {
  const r = computeComparisonRange(primary, "previous_period");
  if (!r) return undefined;
  return { type: "previous_period", ...r };
}

function formatWidgetDataAsText(spec: DashboardSpec): string {
  const lines: string[] = [];
  lines.push(spec.title);
  if (spec.description) lines.push(spec.description);
  lines.push("---");
  for (const widget of spec.widgets) {
    if (widget.type === "kpi_row") {
      for (const item of widget.items) {
        lines.push(`${item.label}: [SQL: ${item.sql}]`);
      }
    } else if (widget.type === "insights_strip") {
      lines.push(`[insights_strip]: [static widget]`);
    } else if (widget.type === "ranked_bars") {
      lines.push(`${widget.title}: [static widget]`);
    } else {
      lines.push(`${widget.title}: [SQL: ${widget.sql}]`);
    }
  }
  return lines.join("\n");
}

function parseIsoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DashboardSurfaceProps {
  /** Dashboard ID to load. */
  dashboardId: string;
  /**
   * When provided, preload this conversation into the chat sidebar.
   * Used by /k/<id> when context_kind='dashboard'.
   */
  preloadedConversation?: ConversationWithMessages | null;
  /**
   * Which sidebar tab to open the preloaded conversation in.
   * Derived from conversation.mode at the /k/<id> page level.
   */
  initialChatTabMode?: "modificar" | "analizar";
  /**
   * When true, renders in /k/<id> mode:
   * - Shows "Ver solo el panel" button in the sidebar header area.
   * - No URL changes happen from within this component (URL stays /k/<id>).
   */
  kMode?: boolean;
  /** The native surface URL for "Ver solo el panel" — only used when kMode=true. */
  contextUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DashboardSurface({
  dashboardId,
  preloadedConversation,
  initialChatTabMode,
  kMode,
  contextUrl,
}: DashboardSurfaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = dashboardId;

  // ?continue=:convId — conversation ID to load into the Modify tab (free-chat handoff).
  // ?tab=modify — open the Modify tab explicitly (sent together with ?continue).
  const continueConvId = searchParams.get("continue") ?? undefined;
  const tabParam = searchParams.get("tab");

  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [chatOpen, setChatOpen] = useState(
    () => !!preloadedConversation || !!kMode || !!continueConvId
  );
  const [chatInitialMode, setChatInitialMode] = useState<"modificar" | "analizar" | undefined>(
    initialChatTabMode ?? (continueConvId || tabParam === "modify" ? "modificar" : undefined),
  );

  const [pendingModify, setPendingModify] = useState<{ prompt: string; id: number } | null>(null);
  const [pendingAnalyze, setPendingAnalyze] = useState<{ prompt: string; id: number } | null>(null);
  const drillDownIdRef = useRef(0);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [widgetData, setWidgetData] = useState<Map<number, WidgetState>>(new Map());
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiErrorResponse | string | null>(null);
  const saveCounter = useRef(0);
  const latestSpecRef = useRef<DashboardSpec | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(15);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDashboardDateRange());
  const [comparisonRange, setComparisonRange] = useState<ComparisonRange | undefined>(() =>
    defaultComparisonRangeFor(getDefaultDashboardDateRange()),
  );
  const [globalFilterValues, setGlobalFilterValues] = useState<GlobalFilterValues>({});
  const appliedUrlRange = useRef(false);

  // Sync chatOpen and chatInitialMode when handoff URL params change via client-side navigation.
  // useState initializers only run on first mount, so without this effect a subsequent
  // navigation to ?continue=:id would leave the sidebar closed on the previous tab.
  useEffect(() => {
    if (continueConvId || tabParam === "modify") {
      setChatOpen(true);
      setChatInitialMode((prev) => prev ?? "modificar");
    }
  }, [continueConvId, tabParam]);

  const handleDateRangeChange = useCallback(
    ({ primary, comparison }: { primary: DateRange; comparison?: ComparisonRange }) => {
      setDateRange(primary);
      setComparisonRange(comparison);
      setRefreshKey((k) => k + 1);
    },
    [],
  );

  const handleGlobalFilterChange = useCallback((next: GlobalFilterValues) => {
    setGlobalFilterValues(next);
    setRefreshKey((k) => k + 1);
  }, []);

  const [exportOpen, setExportOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await fetch(`/api/dashboard/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (isApiErrorResponse(errBody)) {
          setError(errBody);
        } else {
          setError("Error al cargar el dashboard");
        }
        return;
      }
      const data: DashboardRecord = await res.json();
      setDashboard(data);
      setNameValue(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar el dashboard");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    appliedUrlRange.current = false;
  }, [id]);

  // Deep-link from weekly review — only apply when not in kMode
  useEffect(() => {
    if (kMode) return;
    if (appliedUrlRange.current) return;
    const cf = searchParams.get("curr_from");
    const ct = searchParams.get("curr_to");
    const pf = searchParams.get("comp_from");
    const pt = searchParams.get("comp_to");
    if (!cf || !ct || !pf || !pt) return;
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(cf) || !iso.test(ct) || !iso.test(pf) || !iso.test(pt)) return;
    appliedUrlRange.current = true;
    const primary: DateRange = {
      from: startOfDay(parseIsoToLocalDate(cf)),
      to: endOfDay(parseIsoToLocalDate(ct)),
    };
    const comparison: ComparisonRange = {
      type: "custom",
      from: startOfDay(parseIsoToLocalDate(pf)),
      to: endOfDay(parseIsoToLocalDate(pt)),
    };
    setDateRange(primary);
    setComparisonRange(comparison);
    setRefreshKey((k) => k + 1);
  }, [searchParams, id, kMode]);

  useEffect(() => {
    setGlobalFilterValues({});
  }, [id]);

  useEffect(() => {
    if (dashboard) latestSpecRef.current = dashboard.spec;
  }, [dashboard]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setLastRefreshed(new Date());
  }, []);

  useEffect(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (autoRefresh) {
      const intervalMs = refreshInterval * 60 * 1000;
      setSecondsUntilRefresh(refreshInterval * 60);
      autoRefreshRef.current = setInterval(() => {
        setRefreshKey((k) => k + 1);
        setLastRefreshed(new Date());
        setSecondsUntilRefresh(refreshInterval * 60);
      }, intervalMs);
      countdownRef.current = setInterval(() => {
        setSecondsUntilRefresh((s) => Math.max(0, s - 1));
      }, 1000);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshInterval]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    }
    if (exportOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [exportOpen]);

  const handleCopyData = useCallback(async () => {
    if (!dashboard) return;
    const text = formatWidgetDataAsText(dashboard.spec);
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      /* Fallback not available */
    }
    setExportOpen(false);
  }, [dashboard]);

  const handlePrint = useCallback(() => {
    setExportOpen(false);
    window.print();
  }, []);

  const saveSpec = useCallback(
    async (spec: DashboardSpec, prompt?: string) => {
      const thisCount = ++saveCounter.current;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(`/api/dashboard/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spec, prompt }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          if (isApiErrorResponse(errBody)) {
            throw errBody;
          }
          throw new Error("Error al guardar");
        }
        const updated: DashboardRecord = await res.json();
        if (thisCount === saveCounter.current) {
          setDashboard(updated);
        }
      } catch (err) {
        if (thisCount === saveCounter.current) {
          if (isApiErrorResponse(err)) {
            setSaveError(err);
          } else {
            setSaveError(err instanceof Error ? err.message : "Error al guardar");
          }
        }
      } finally {
        if (thisCount === saveCounter.current) {
          setSaving(false);
        }
      }
    },
    [id],
  );

  const handlePendingModifyInputConsumed = useCallback(() => {
    setPendingModify(null);
  }, []);

  const handleDataPointClick = useCallback((ctx: DrillDownContext) => {
    const value = typeof ctx.value === "string" ? ctx.value.trim() : ctx.value;
    const hasValue = value !== "" && value !== null && value !== undefined;
    const labelStr = String(ctx.label ?? "").trim();
    const title = ctx.widgetTitle ?? "";
    let prompt: string;
    if (ctx.widgetType === "bar_chart" || ctx.widgetType === "donut_chart") {
      prompt = hasValue
        ? `En el widget "${title}", el segmento "${labelStr}" muestra ${value}. ¿Por qué tiene ese valor? Compara con los demás segmentos visibles en el dashboard, identifica si es una anomalía y sugiere qué acción tomar.`
        : `En el widget "${title}", el segmento "${labelStr}". ¿Por qué destaca? Compara con los demás segmentos visibles en el dashboard, identifica si es una anomalía y sugiere qué acción tomar.`;
    } else if (ctx.widgetType === "line_chart" || ctx.widgetType === "area_chart") {
      prompt = hasValue
        ? `En el widget "${title}", el punto "${labelStr}" tiene un valor de ${value}. ¿Qué factores explican ese nivel? Compara con el período anterior y con otras tiendas o categorías del dashboard.`
        : `En el widget "${title}", el punto "${labelStr}". ¿Qué factores explican ese nivel? Compara con el período anterior y con otras tiendas o categorías del dashboard.`;
    } else if (ctx.widgetType === "table" || ctx.widgetType === "ranked_bars") {
      prompt = hasValue
        ? `En el widget "${title}", la fila "${labelStr}" tiene ${value}. ¿Es un valor atípico respecto al resto? ¿Qué lo explica y qué se puede hacer?`
        : `En el widget "${title}", la fila "${labelStr}". ¿Es atípica respecto al resto? ¿Qué la explica y qué se puede hacer?`;
    } else {
      prompt = hasValue
        ? `En el widget "${title}", el elemento "${labelStr}" muestra ${value}. Dame más detalle y contexto sobre este dato.`
        : `En el widget "${title}", dame más detalle y contexto sobre "${labelStr}".`;
    }
    setGlossaryOpen(false);
    setHistoryOpen(false);
    drillDownIdRef.current += 1;
    setPendingAnalyze({ prompt, id: drillDownIdRef.current });
    setChatInitialMode("analizar");
    setChatOpen(true);
  }, []);

  const handlePendingAnalyzeInputConsumed = useCallback(() => {
    setPendingAnalyze(null);
  }, []);

  const handleChatToggle = useCallback(() => {
    setChatOpen((prev) => {
      const nextOpen = !prev;
      if (nextOpen) {
        setGlossaryOpen(false);
        setHistoryOpen(false);
      } else {
        setChatInitialMode(undefined);
      }
      return nextOpen;
    });
  }, []);

  const handleOpenChatSidebar = useCallback(() => {
    setGlossaryOpen(false);
    setHistoryOpen(false);
    setChatOpen(true);
  }, []);

  // Called by AnalyzeLauncher when the user clicks the rail button.
  // Opens the sidebar in analyze mode with the seed prompt pre-filled.
  // No conversation is created here — the sidebar handles that lazily.
  const handleAnalyzeLauncherOpen = useCallback((seedPrompt: string) => {
    setGlossaryOpen(false);
    setHistoryOpen(false);
    drillDownIdRef.current += 1;
    setPendingAnalyze({ prompt: seedPrompt, id: drillDownIdRef.current });
    setChatInitialMode("analizar");
    setChatOpen(true);
  }, []);

  // Chat-driven modifications arrive via the spec_update SSE event AFTER the
  // server has already persisted the new spec (with a version snapshot of the
  // previous one) through updateDashboardSpecWithVersion in turn-background.
  // The server is the single writer for that path — here we only sync local
  // state. Re-saving from the client would version the already-updated spec,
  // destroying the pre-change snapshot (undo would become a no-op).
  const handleSpecUpdate = useCallback((newSpec: DashboardSpec) => {
    setDashboard((prev) => (prev ? { ...prev, spec: newSpec } : prev));
  }, []);


  const handleNameSave = useCallback(async () => {
    const trimmed = nameValue.trim();
    if (!trimmed || !dashboard) {
      setEditingName(false);
      setNameValue(dashboard?.name || "");
      return;
    }
    setEditingName(false);
    setNameValue(trimmed);
    if (trimmed === dashboard.name) return;

    setDashboard((prev) => (prev ? { ...prev, name: trimmed } : prev));
    const currentSpec = latestSpecRef.current ?? dashboard.spec;
    const thisCount = ++saveCounter.current;
    try {
      const res = await fetch(`/api/dashboard/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: currentSpec, name: trimmed, skipVersion: true }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (isApiErrorResponse(errBody)) throw errBody;
        throw new Error((errBody?.error as string) || "Error al guardar el nombre");
      }
      const updated: DashboardRecord = await res.json();
      if (thisCount === saveCounter.current) {
        setDashboard(updated);
      }
    } catch (err) {
      if (thisCount === saveCounter.current) {
        setDashboard((prev) => (prev ? { ...prev, name: dashboard.name } : prev));
        setNameValue(dashboard.name);
        if (isApiErrorResponse(err)) {
          showToast(err.error);
        } else {
          showToast(err instanceof Error ? err.message : "No se pudo guardar el nombre del dashboard.");
        }
      }
    }
  }, [nameValue, dashboard, id, showToast]);

  const handleSave = useCallback(() => {
    if (dashboard) saveSpec(dashboard.spec);
  }, [dashboard, saveSpec]);

  function formatTime(date: Date): string {
    return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }

  function formatCountdown(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Resolve initial messages and LLM context for the sidebar from preloaded conversation
  const preloadedAnalyzeMessages =
    preloadedConversation && preloadedConversation.mode === "analyze"
      ? convertConversationMessages(preloadedConversation.messages)
      : undefined;
  const preloadedModifyMessages =
    preloadedConversation && preloadedConversation.mode === "modify"
      ? convertConversationMessages(preloadedConversation.messages)
      : undefined;
  const preloadedModifyContext =
    preloadedConversation && preloadedConversation.mode === "modify"
      ? preloadedConversation.initial_context
      : undefined;
  const preloadedAnalyzeContext =
    preloadedConversation && preloadedConversation.mode === "analyze"
      ? preloadedConversation.initial_context
      : undefined;

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
          style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
          role="status"
          aria-label="Cargando"
        />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Dashboard no encontrado
        </h1>
        <p className="text-sm text-tremor-content dark:text-dark-tremor-content">
          El dashboard solicitado no existe o fue eliminado.
        </p>
        <button
          onClick={() => router.push("/")}
          style={{ borderRadius: 6, background: "var(--accent)", padding: "8px 16px", fontSize: 13, fontWeight: 500, color: "#fff", border: "none", cursor: "pointer" }}
        >
          Volver a la lista
        </button>
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="space-y-4">
        <ErrorDisplay error={error || "Error al cargar el dashboard"} onRetry={fetchDashboard} />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const outlineBtn: React.CSSProperties = {
    height: 32,
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    color: "var(--fg)",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "inherit",
  };

  const breadcrumbs = dashboard.spec.breadcrumbs ?? ["Retail", "Ventas"];
  const titleParts = dashboard.name.split(/\s*—\s*/);
  const titleMain = titleParts[0] ?? dashboard.name;
  const titleSub = titleParts.length > 1 ? titleParts.slice(1).join(" — ") : null;

  return (
    <div
      data-no-main-padding
      style={{ marginRight: chatOpen ? 380 : 0, transition: "margin 0.2s ease" }}
    >
      {toast && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] rounded-lg bg-red-600 px-4 py-2 text-sm text-white shadow-lg"
          data-testid="toast"
        >
          {toast}
        </div>
      )}

      {/* kMode banner: "Ver solo el panel" — only relative paths allowed to prevent open redirect */}
      {kMode && contextUrl && contextUrl.startsWith("/") && (
        <div
          style={{
            padding: "6px 20px",
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--fg-muted)" }}>Vista de conversación</span>
          <a
            href={contextUrl}
            style={{
              color: "var(--accent)",
              textDecoration: "none",
              fontWeight: 500,
              fontSize: 12,
            }}
            data-testid="ver-solo-panel"
          >
            Ver solo el panel →
          </a>
        </div>
      )}

      {/* Page header */}
      <div className="no-print" style={{ padding: "24px 20px 14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "var(--fg-muted)",
                fontFamily: "var(--font-jetbrains, monospace)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              {breadcrumbs.map((crumb, i) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {i > 0 && <span style={{ color: "var(--fg-subtle)" }}>/</span>}
                  {crumb}
                </span>
              ))}
              <span
                style={{
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  borderRadius: 3,
                  padding: "2px 6px",
                  fontSize: 10,
                  marginLeft: 2,
                }}
              >
                EN VIVO
              </span>
            </div>

            {editingName ? (
              <input
                ref={nameInputRef}
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={() => void handleNameSave()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleNameSave();
                  if (e.key === "Escape") {
                    setEditingName(false);
                    setNameValue(dashboard.name);
                  }
                }}
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.1,
                  background: "transparent",
                  border: "none",
                  borderBottom: "2px solid var(--accent)",
                  outline: "none",
                  color: "var(--fg)",
                  fontFamily: "inherit",
                  width: "100%",
                  maxWidth: 600,
                }}
              />
            ) : (
              <h1
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.1,
                  margin: 0,
                  cursor: "pointer",
                  fontFamily: "var(--font-inter, sans-serif)",
                }}
                onClick={() => setEditingName(true)}
                title="Haz clic para editar el nombre"
              >
                {titleMain}
                {titleSub && (
                  <span style={{ color: "var(--fg-muted)", fontWeight: 500 }}>{" — "}{titleSub}</span>
                )}
              </h1>
            )}

            {dashboard.spec.description && (
              <p style={{ color: "var(--fg-muted)", margin: "8px 0 0", fontSize: 13, maxWidth: 680, lineHeight: 1.5 }}>
                {dashboard.spec.description}
              </p>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--fg-muted)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  style={{ width: 12, height: 12 }}
                  data-testid="auto-refresh-toggle"
                />
                Auto
              </label>
              {autoRefresh && (
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value) as RefreshInterval)}
                  style={{ fontSize: 11, border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px", background: "var(--bg-1)", color: "var(--fg-muted)" }}
                  data-testid="refresh-interval-select"
                >
                  {REFRESH_INTERVALS.map((m) => (
                    <option key={m} value={m}>{m} min</option>
                  ))}
                </select>
              )}
              {autoRefresh && (
                <span style={{ fontSize: 11, color: "var(--accent)" }} data-testid="countdown">
                  {formatCountdown(secondsUntilRefresh)}
                </span>
              )}
            </div>

            <button
              onClick={triggerRefresh}
              style={outlineBtn}
              title={`Última actualización: ${formatTime(lastRefreshed)}`}
              aria-label="Actualizar"
              data-testid="last-refreshed"
            >
              ⟳ Actualizar
            </button>

            <div className="relative" ref={exportRef}>
              <button onClick={() => setExportOpen((prev) => !prev)} style={outlineBtn} aria-label="Exportar">
                {copySuccess ? "Copiado!" : "Exportar"}
              </button>
              {exportOpen && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    marginTop: 4,
                    width: 180,
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: 8,
                    boxShadow: "0 8px 24px -6px rgba(0,0,0,0.4)",
                    zIndex: 50,
                    overflow: "hidden",
                  }}
                >
                  <button
                    onClick={() => void handleCopyData()}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 12, background: "none", border: "none", color: "var(--fg)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Copiar datos
                  </button>
                  <button
                    onClick={handlePrint}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 12, background: "none", border: "none", color: "var(--fg)", cursor: "pointer", fontFamily: "inherit", borderTop: "1px solid var(--border)" }}
                  >
                    Imprimir / PDF
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() =>
                setHistoryOpen((prev) => {
                  const nextOpen = !prev;
                  if (nextOpen) {
                    setChatOpen(false);
                    setGlossaryOpen(false);
                  }
                  return nextOpen;
                })
              }
              style={outlineBtn}
              aria-label={historyOpen ? "Cerrar historial" : "Abrir historial"}
              data-testid="history-button"
            >
              Historial
            </button>

            {dashboard.spec.glossary && dashboard.spec.glossary.length > 0 && (
              <button
                onClick={() =>
                  setGlossaryOpen((prev) => {
                    const nextOpen = !prev;
                    if (nextOpen) {
                      setChatOpen(false);
                      setHistoryOpen(false);
                    }
                    return nextOpen;
                  })
                }
                style={outlineBtn}
                aria-label={glossaryOpen ? "Cerrar glosario" : "Abrir glosario"}
                data-testid="glossary-button"
              >
                Glosario
              </button>
            )}

            {saving && <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>Guardando...</span>}
            {saveError && (
              <span style={{ fontSize: 11, color: "var(--down)" }}>
                {typeof saveError === "string" ? saveError : saveError.error}
              </span>
            )}
            <button onClick={handleSave} disabled={saving} style={{ ...outlineBtn, opacity: saving ? 0.5 : 1 }}>
              Guardar
            </button>
          </div>
        </div>
      </div>

      <DataFreshnessBanner />

      {dashboard.spec.filters && dashboard.spec.filters.length > 0 && (
        <DashboardFiltersBar
          dashboardId={dashboard.id}
          spec={dashboard.spec}
          dateRange={dateRange}
          value={globalFilterValues}
          onChange={handleGlobalFilterChange}
        />
      )}

      <DashboardRenderer
        spec={dashboard.spec}
        refreshKey={refreshKey}
        dateRange={dateRange}
        comparisonRange={comparisonRange}
        globalFilterValues={globalFilterValues}
        onWidgetDataChange={setWidgetData}
        onDataPointClick={handleDataPointClick}
      />

      <AnalyzeLauncher dashboardId={dashboard.id} hidden={chatOpen} onOpen={handleAnalyzeLauncherOpen} />

      <ChatSidebar
        spec={dashboard.spec}
        onSpecUpdate={handleSpecUpdate}
        isOpen={chatOpen}
        hideWhenClosed
        dashboardId={dashboard.id}
        onToggle={handleChatToggle}
        onOpenSidebar={handleOpenChatSidebar}
        widgetData={widgetData}
        initialAnalyzeMessages={
          preloadedAnalyzeMessages ?? []
        }
        initialModifyMessages={
          continueConvId ? [] : (preloadedModifyMessages ?? [])
        }
        pendingModifyInput={pendingModify?.prompt}
        pendingModifyTriggerId={pendingModify?.id}
        onPendingModifyInputConsumed={handlePendingModifyInputConsumed}
        pendingAnalyzeInput={pendingAnalyze?.prompt}
        pendingAnalyzeTriggerId={pendingAnalyze?.id}
        onPendingAnalyzeInputConsumed={handlePendingAnalyzeInputConsumed}
        initialMode={chatInitialMode}
        initialModifyContext={continueConvId ? undefined : preloadedModifyContext}
        initialAnalyzeContext={preloadedAnalyzeContext}
        initialConversationId={continueConvId}
      />

      {dashboard.spec.glossary && dashboard.spec.glossary.length > 0 && (
        <GlossaryPanel
          glossary={dashboard.spec.glossary}
          isOpen={glossaryOpen}
          onClose={() => setGlossaryOpen(false)}
        />
      )}

      <VersionHistory
        dashboardId={dashboard.id}
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={(spec) => {
          setDashboard((prev) => (prev ? { ...prev, spec } : prev));
          setHistoryOpen(false);
        }}
      />
    </div>
  );
}
