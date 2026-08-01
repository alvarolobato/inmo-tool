"use client";

import { useState, useEffect, useCallback } from "react";
import ReviewDisplay from "@/components/ReviewDisplay";
import { ReviewActionsBoard } from "@/components/ReviewActionsBoard";
import { ReviewRevisionTimeline } from "@/components/ReviewRevisionTimeline";
import { ReviewDiffPanel } from "@/components/ReviewDiffPanel";
import ErrorDisplay from "@/components/ErrorDisplay";
import LogBlock from "@/components/LogBlock";
import type { LogLine } from "@/components/LogBlock";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import type { ReviewContent } from "@/lib/review-schema";
import type { ReviewActionRow } from "@/lib/review-actions-db";
import { agenticEventToLogLine } from "@/lib/format-agentic-progress";
import type { AgenticProgressEvent } from "@/lib/llm";

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Error thrown from the generate flow that may carry the structured ApiErrorResponse. */
type GenerateError = Error & { apiError?: ApiErrorResponse };

/**
 * Build a `GenerateError` that preserves the full `ApiErrorResponse` when the
 * server payload looks like one. The catch block in handleGenerate/handleRegenerate
 * unwraps `.apiError` and feeds it to <ErrorDisplay>, which renders the
 * AGENTIC_RUNNER diagnostic ("Detalles técnicos" with provider / CLI / tool / limits).
 * This is the same shape ChatSidebar uses for /generate and /modify.
 */
function generateErrorFromPayload(payload: unknown, fallbackMessage: string): GenerateError {
  const apiError = isApiErrorResponse(payload) ? (payload as ApiErrorResponse) : undefined;
  const err: GenerateError = new Error(apiError?.error ?? fallbackMessage);
  if (apiError) err.apiError = apiError;
  return err;
}

/** Pull the structured ApiErrorResponse off a thrown error, when present. */
function apiErrorOf(err: unknown): ApiErrorResponse | undefined {
  if (err && typeof err === "object" && "apiError" in err) {
    const candidate = (err as { apiError?: unknown }).apiError;
    if (isApiErrorResponse(candidate)) return candidate;
  }
  return undefined;
}

// ─── NDJSON stream reader ─────────────────────────────────────────────────────

async function* readNdjsonStream<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          yield JSON.parse(t) as T;
        } catch {
          /* skip malformed line */
        }
      }
    }
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as T;
      } catch {
        /* skip */
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ReviewWeekSummary {
  week_start: string;
  latest_id: number;
  latest_revision: number;
  revision_count: number;
  executive_summary: string;
  created_at: string;
}

interface RevisionMeta {
  id: number;
  week_start: string;
  revision: number;
  generation_mode: string;
  created_at: string;
  preview: string;
}

interface FullReviewState {
  id: number;
  week_start: string;
  revision: number;
  generation_mode: string;
  content: ReviewContent;
  /** Freeform Spanish message from the model (set after generation, null for loaded reviews). */
  modelMessage?: string | null;
}

function formatWeekDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatRelativeTime(isoStr: string): string {
  try {
    const date = new Date(isoStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 2) return "hace un momento";
    if (diffMins < 60) return `hace ${diffMins} min`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `hace ${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `hace ${diffDays} días`;
  } catch {
    return isoStr;
  }
}

// ─── Regenerate-mode copy (single source of truth) ───────────────────────────
// Describes each regenerate mode for the select `title`, the option `title`s,
// and the accessible visible hint below the <select>. Keeping one map prevents
// these strings from drifting out of sync.

type RegenMode = "refresh_data" | "alternate_angle";

interface RegenModeCopy {
  label: string;
  /** Short description used in option/select tooltips and the hint text. */
  description: string;
}

const REGEN_MODE_COPY: Record<RegenMode, RegenModeCopy> = {
  refresh_data: {
    label: "Actualizar datos",
    description: "Vuelve a ejecutar las consultas SQL para traer datos actualizados.",
  },
  alternate_angle: {
    label: "Reformular análisis (nuevo enfoque)",
    description:
      "Vuelve a analizar los mismos datos con un enfoque distinto; no vuelve a ejecutar SQL.",
  },
};

/** Fallback hint shown when no mode is selected or an unknown value slips in. */
const REGEN_MODE_DEFAULT_HINT =
  "Elige cómo regenerar: actualizar datos reejecuta SQL; reformular análisis pide al modelo otro enfoque sobre los mismos datos.";

/** Type guard — true iff `value` is a recognised regenerate mode. */
function isRegenMode(value: string): value is RegenMode {
  return Object.prototype.hasOwnProperty.call(REGEN_MODE_COPY, value);
}

function regenModeHint(mode: RegenMode | null): string {
  // Defensive: if an unexpected DOM value ever reaches state (e.g. a stale
  // option from a previous build), fall back to the default hint rather than
  // crashing on `REGEN_MODE_COPY[mode]` returning `undefined`.
  if (mode === null || !isRegenMode(mode)) return REGEN_MODE_DEFAULT_HINT;
  const copy = REGEN_MODE_COPY[mode];
  return `${copy.label}: ${copy.description}`;
}

function ReviewSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" role="status">
      <p className="text-sm text-tremor-content dark:text-dark-tremor-content text-center py-2">
        Generando revisión... esto puede tardar hasta un minuto
      </p>
      <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-5 space-y-3">
        <div className="h-4 w-40 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        <div className="space-y-2">
          <div className="h-3 w-full rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
          <div className="h-3 w-5/6 rounded bg-tremor-background-subtle dark:bg-dark-tremor-background-subtle" />
        </div>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const [view, setView] = useState<"list" | "loading" | "review" | "error">("list");
  const [pastReviews, setPastReviews] = useState<ReviewWeekSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<ApiErrorResponse | string | null>(null);
  const [current, setCurrent] = useState<FullReviewState | null>(null);
  const [actions, setActions] = useState<ReviewActionRow[]>([]);
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [priorContent, setPriorContent] = useState<ReviewContent | null>(null);
  const [reviewError, setReviewError] = useState<ApiErrorResponse | string | null>(null);
  const [regenMode, setRegenMode] = useState<RegenMode | null>(null);
  /** Live log lines while a review is being generated (streaming). */
  const [streamingLog, setStreamingLog] = useState<LogLine[] | null>(null);
  const startedAtRef = { current: Date.now() };

  const fetchPastReviews = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/review");
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        setListError(isApiErrorResponse(errBody) ? errBody : "Error al cargar las revisiones");
        return;
      }
      const data: ReviewWeekSummary[] = await res.json();
      setPastReviews(data);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Error al cargar las revisiones");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPastReviews();
  }, [fetchPastReviews]);

  const loadReviewById = useCallback(
    async (id: number, revList: RevisionMeta[]) => {
      const res = await fetch(`/api/review/${id}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw isApiErrorResponse(errBody)
          ? errBody
          : new Error((errBody?.error as string) || "Error al cargar la revisión");
      }
      const data = (await res.json()) as {
        id: number;
        week_start: string;
        revision: number;
        generation_mode: string;
        content: ReviewContent;
        actions: ReviewActionRow[];
      };
      setCurrent({
        id: data.id,
        week_start: data.week_start,
        revision: data.revision,
        generation_mode: data.generation_mode,
        content: data.content,
      });
      setActions(data.actions ?? []);

      const idx = revList.findIndex((r) => r.id === id);
      if (idx !== -1 && idx < revList.length - 1) {
        const prevId = revList[idx + 1].id;
        const pr = await fetch(`/api/review/${prevId}`);
        if (pr.ok) {
          const pd = (await pr.json()) as { content: ReviewContent };
          setPriorContent(pd.content);
        } else {
          setPriorContent(null);
        }
      } else {
        setPriorContent(null);
      }
    },
    [],
  );

  const openWeek = useCallback(
    async (weekStart: string, preferredId?: number) => {
      setView("loading");
      setReviewError(null);
      setCurrent(null);
      setActions([]);
      setPriorContent(null);
      try {
        const revRes = await fetch(`/api/review/week/${encodeURIComponent(weekStart)}`);
        if (!revRes.ok) {
          const errBody = await revRes.json().catch(() => null);
          throw isApiErrorResponse(errBody)
            ? errBody
            : new Error("Error al cargar versiones de la semana");
        }
        const revList = (await revRes.json()) as RevisionMeta[];
        setRevisions(revList);
        const targetId = preferredId ?? revList[0]?.id;
        if (!targetId) {
          setReviewError("No hay revisiones para esa semana.");
          setView("error");
          return;
        }
        await loadReviewById(targetId, revList);
        setView("review");
      } catch (err) {
        setReviewError(err instanceof Error ? err.message : String(err));
        setView("error");
      }
    },
    [loadReviewById],
  );

  const handleLoadFromList = useCallback(
    async (row: ReviewWeekSummary) => {
      await openWeek(row.week_start, row.latest_id);
    },
    [openWeek],
  );

  /**
   * Shared NDJSON streaming handler for generate and regenerate flows.
   * Emits streaming log events in real-time and resolves when the review is saved.
   */
  const callGenerateStreaming = useCallback(
    async (body: Record<string, unknown>): Promise<{
      week_start: string;
      id: number;
      message?: string;
    } | null> => {
      setStreamingLog([]);
      startedAtRef.current = Date.now();

      const res = await fetch("/api/review/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
      });

      const ct = res.headers.get("content-type") ?? "";

      // Check for 409 conflict (review exists) — returned as JSON even in stream mode.
      if (res.status === 409) {
        const payload = await res.json().catch(() => null);
        if (
          isApiErrorResponse(payload) &&
          payload.code === "REVIEW_EXISTS" &&
          typeof payload.week_start === "string" &&
          typeof payload.existing_id === "number"
        ) {
          setStreamingLog(null);
          await openWeek(payload.week_start, payload.existing_id);
          void fetchPastReviews();
          return null;
        }
        setStreamingLog(null);
        throw new Error(
          isApiErrorResponse(payload) ? payload.error : "Ya existe una revisión para esa semana.",
        );
      }

      if (!res.ok || !ct.includes("application/x-ndjson")) {
        // Fallback to plain JSON error.
        const payload = await res.json().catch(() => null);
        setStreamingLog(null);
        throw generateErrorFromPayload(payload, "Error al generar la revisión.");
      }

      if (!res.body) {
        setStreamingLog(null);
        throw new Error("La respuesta no tiene cuerpo.");
      }

      type ReviewFrame =
        | { type: "meta"; requestId: string; message: string; weekStart: string; generationMode: string }
        | { type: "phase"; message: string; index?: number; total?: number }
        | { type: "progress"; event: AgenticProgressEvent }
        | { type: "result"; message?: string; review: ReviewContent & { id: number; week_start: string; revision: number; generation_mode: string } }
        | { type: "error"; httpStatus: number; error: string; code: string; [k: string]: unknown };

      for await (const frame of readNdjsonStream<ReviewFrame>(res.body)) {
        if (frame.type === "progress" && frame.event) {
          const ms = Date.now() - startedAtRef.current;
          const line = agenticEventToLogLine(frame.event, ms);
          if (line) {
            setStreamingLog((prev) => {
              if (!prev) return [line];
              // Coalesce streaming ticks (text_delta and thinking_delta) so
              // each tick replaces the previous one of its own kind. Thinking
              // and text are *separate* rows — once the thinking block ends
              // and text starts streaming, a new "Modelo respondiendo" line
              // appears under the (now frozen) "Claude está razonando".
              const lastLabel = prev[prev.length - 1]?.label;
              const isTextCoalesce =
                frame.event.type === "model_text_delta" && lastLabel === "Modelo respondiendo";
              const isThinkingCoalesce =
                frame.event.type === "model_thinking_delta" && lastLabel === "Claude está razonando";
              if (prev.length > 0 && (isTextCoalesce || isThinkingCoalesce)) {
                return [...prev.slice(0, -1), line];
              }
              return [...prev, line];
            });
          }
        } else if (frame.type === "phase") {
          const ms = Date.now() - startedAtRef.current;
          const ts = `+${(ms / 1000).toFixed(1)}s`;
          setStreamingLog((prev) => [
            ...(prev ?? []),
            { timestamp: ts, kind: "reason" as const, label: frame.message },
          ]);
        } else if (frame.type === "result") {
          setStreamingLog(null);
          return { week_start: frame.review.week_start, id: frame.review.id, message: frame.message };
        } else if (frame.type === "error") {
          setStreamingLog(null);
          throw generateErrorFromPayload(frame, "Error al generar la revisión.");
        }
      }

      setStreamingLog(null);
      throw new Error("La respuesta de generación terminó sin resultado.");
    },
    [fetchPastReviews, openWeek],
  );

  const handleGenerate = useCallback(async () => {
    setView("loading");
    setReviewError(null);
    setCurrent(null);
    setActions([]);
    setPriorContent(null);
    try {
      const result = await callGenerateStreaming({});
      if (result) {
        await openWeek(result.week_start, result.id);
        // Store the model's freeform message alongside the review state.
        if (result.message) {
          setCurrent((prev) => prev ? { ...prev, modelMessage: result.message } : prev);
        }
        void fetchPastReviews();
      }
    } catch (err) {
      setStreamingLog(null);
      const detail = apiErrorOf(err);
      setReviewError(
        detail ?? (err instanceof Error ? err.message : "Error al generar la revisión"),
      );
      setView("error");
    }
  }, [fetchPastReviews, openWeek, callGenerateStreaming]);

  const handleRegenerate = useCallback(async () => {
    if (!current || !regenMode) return;
    setView("loading");
    setReviewError(null);
    try {
      const result = await callGenerateStreaming({
        week_start: current.week_start,
        regenerate: true,
        mode: regenMode,
      });
      if (result) {
        setRegenMode(null);
        await openWeek(result.week_start, result.id);
        if (result.message) {
          setCurrent((prev) => prev ? { ...prev, modelMessage: result.message } : prev);
        }
        void fetchPastReviews();
      }
    } catch (err) {
      setStreamingLog(null);
      const detail = apiErrorOf(err);
      setReviewError(detail ?? (err instanceof Error ? err.message : "Error al regenerar"));
      setView("error");
    }
  }, [current, callGenerateStreaming, fetchPastReviews, openWeek, regenMode]);

  const handleBackToList = () => {
    setCurrent(null);
    setActions([]);
    setRevisions([]);
    setPriorContent(null);
    setReviewError(null);
    setRegenMode(null);
    setStreamingLog(null);
    setView("list");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
            Revisión Semanal
          </h1>
          <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
            Análisis con evidencias y seguimiento de acciones para Dirección
          </p>
        </div>
        {(view === "list" || view === "error") && (
          <button
            type="button"
            onClick={() => void handleGenerate()}
            className="btn-accent"
            style={{
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "inherit",
            }}
            data-testid="generate-button"
          >
            Generar revisión semanal
          </button>
        )}
      </div>

      {view === "loading" && (
        <div className="space-y-3">
          {streamingLog && streamingLog.length > 0 ? (
            <LogBlock lines={streamingLog} streaming />
          ) : (
            <ReviewSkeleton />
          )}
        </div>
      )}

      {view === "review" && current && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={handleBackToList}
            className="text-sm text-tremor-content dark:text-dark-tremor-content hover:text-tremor-content-strong dark:hover:text-dark-tremor-content-strong"
          >
            ← Volver a la lista
          </button>

          <div className="flex flex-wrap items-center gap-3 print:hidden">
            <ReviewRevisionTimeline
              revisions={revisions.map((r) => ({
                id: r.id,
                revision: r.revision,
                generation_mode: r.generation_mode,
                created_at: r.created_at,
              }))}
              selectedId={current.id}
              onSelect={(id) => {
                void (async () => {
                  setView("loading");
                  try {
                    await loadReviewById(id, revisions);
                    setView("review");
                  } catch (e) {
                    setReviewError(e instanceof Error ? e.message : String(e));
                    setView("error");
                  }
                })();
              }}
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label htmlFor="regen-mode-select" className="sr-only">
                  Modo de regeneración
                </label>
                <select
                  id="regen-mode-select"
                  className="text-xs rounded border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-2 py-1"
                  value={regenMode ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Only accept recognised modes; anything else resets to null
                    // so downstream consumers (hint, regenerate) stay consistent.
                    setRegenMode(v === "" || !isRegenMode(v) ? null : v);
                  }}
                  data-testid="regen-mode-select"
                  aria-label="Modo de regeneración de la revisión semanal"
                  aria-describedby="regen-mode-hint"
                  title={regenModeHint(regenMode)}
                >
                  <option value="">Regenerar…</option>
                  {(Object.keys(REGEN_MODE_COPY) as RegenMode[]).map((mode) => (
                    <option
                      key={mode}
                      value={mode}
                      title={REGEN_MODE_COPY[mode].description}
                    >
                      {REGEN_MODE_COPY[mode].label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!regenMode}
                  onClick={() => void handleRegenerate()}
                  className="btn-secondary"
                  style={{
                    borderRadius: 6,
                    padding: "4px 12px",
                    fontSize: 12,
                    fontWeight: 500,
                    fontFamily: "inherit",
                    opacity: regenMode ? 1 : 0.4,
                  }}
                  data-testid="regenerate-button"
                >
                  Regenerar
                </button>
              </div>
              {/*
                Accessible hint — visible to all users (not just hover). Native
                `<option title>` tooltips are unreliable across browsers/touch
                devices and not announced by screen readers, so we expose the
                current mode's meaning here and wire it via `aria-describedby`.
              */}
              <p
                id="regen-mode-hint"
                data-testid="regen-mode-hint"
                className="text-[11px] leading-tight text-tremor-content dark:text-dark-tremor-content"
              >
                {regenModeHint(regenMode)}
              </p>
            </div>
          </div>

          <ReviewDiffPanel prior={priorContent} current={current.content} />

          <ReviewDisplay
            review={{ ...current.content, id: current.id, week_start: current.week_start }}
            modelMessage={current.modelMessage ?? undefined}
          />

          {current.id > 0 && (
            <ReviewActionsBoard
              reviewId={current.id}
              actions={actions}
              onActionPatched={(row) =>
                setActions((prev) => prev.map((a) => (a.action_key === row.action_key ? row : a)))
              }
            />
          )}
        </div>
      )}

      {view === "error" && reviewError && (
        <ErrorDisplay error={reviewError} onRetry={() => void handleGenerate()} />
      )}

      {view === "list" && (
        <div className="space-y-4">
          {listLoading && (
            <div className="flex justify-center py-8">
              <div
                className="h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
                style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }}
                role="status"
                aria-label="Cargando revisiones"
              />
            </div>
          )}

          {!listLoading && listError && <ErrorDisplay error={listError} onRetry={fetchPastReviews} />}

          {!listLoading && !listError && pastReviews.length === 0 && (
            <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-8 text-center">
              <p className="text-sm text-tremor-content-strong dark:text-dark-tremor-content-strong font-medium">
                No hay revisiones anteriores
              </p>
              <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
                Genera la primera revisión semanal del negocio.
              </p>
            </div>
          )}

          {!listLoading && !listError && pastReviews.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-tremor-content dark:text-dark-tremor-content mb-3">
                Semanas revisadas
              </h2>
              <div className="space-y-2">
                {pastReviews.map((r) => (
                  <button
                    key={r.week_start}
                    type="button"
                    onClick={() => void handleLoadFromList(r)}
                    data-testid={`past-review-${r.latest_id}`}
                    className="w-full text-left rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background p-4 hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-tremor-content-strong dark:text-dark-tremor-content-strong">
                          Semana del {formatWeekDate(r.week_start)}
                        </p>
                        <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                          Última versión: v{r.latest_revision} · {r.revision_count} versiones
                        </p>
                        {r.executive_summary && (
                          <p className="mt-1 text-xs text-tremor-content dark:text-dark-tremor-content line-clamp-2">
                            {r.executive_summary}
                          </p>
                        )}
                      </div>
                      <span className="flex-shrink-0 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                        {formatRelativeTime(r.created_at)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
