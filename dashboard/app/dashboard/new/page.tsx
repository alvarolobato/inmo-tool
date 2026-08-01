"use client";

import { useState, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { DashboardSpec } from "@/lib/schema";
import { TEMPLATES, type DashboardTemplate } from "@/lib/templates";
import { TASK_PROMPTS } from "@/lib/task-prompts";
import { DataFreshnessBanner } from "@/components/DataFreshnessBanner";
import { DashboardGenerateProgressDialog, type ProgressLine, inferKind } from "@/components/DashboardGenerateProgressDialog";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { isApiErrorResponse } from "@/lib/errors";
import type { ApiErrorResponse } from "@/lib/errors";
import { runDashboardGenerateStream, type GenerateProgressLine } from "@/lib/run-dashboard-generate-stream";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DashboardListItem {
  id: number;
  name: string;
  description: string | null;
  updated_at: string;
}

interface DashboardWithSpec extends DashboardListItem {
  spec: DashboardSpec;
}

interface Gap {
  area: string;
  description: string;
  suggestedPrompt: string;
}

type CreationTab = "templates" | "free";

const CREATION_TAB_ORDER: CreationTab[] = ["templates", "free"];

function focusCreationTabButton(id: CreationTab) {
  requestAnimationFrame(() => {
    document.getElementById(`creation-tab-${id}-btn`)?.focus();
  });
}

// ─── Badges (IA vs plantilla) ───────────────────────────────────────────────

function BadgeUsesAi() {
  return (
    <span className="mb-2 inline-block rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800 dark:bg-violet-400/20 dark:text-violet-100">
      Usa IA
    </span>
  );
}

function BadgeNoAi() {
  return (
    <span className="mb-2 inline-block rounded-full bg-emerald-600/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100">
      Sin IA · instantáneo
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewDashboard() {
  const router = useRouter();
  const [tab, setTab] = useState<CreationTab>("templates");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Free-form generation state
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorResponse | string | null>(null);
  const [lastErrorSource, setLastErrorSource] = useState<"generate" | "template" | null>(
    null,
  );

  const [cachedDashboardList, setCachedDashboardList] = useState<DashboardListItem[] | null>(null);

  const [loadingGaps, setLoadingGaps] = useState(false);
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [gapsError, setGapsError] = useState<string | null>(null);

  const [agenticOpen, setAgenticOpen] = useState(false);
  const [agenticLines, setAgenticLines] = useState<ProgressLine[]>([]);
  const [agenticRequestId, setAgenticRequestId] = useState<string | null>(null);
  const [agenticPhase, setAgenticPhase] = useState<"running" | "error" | "success">("running");
  const [agenticErrorSummary, setAgenticErrorSummary] = useState<ReactNode>(null);
  const [agenticPrompt, setAgenticPrompt] = useState<string | null>(null);
  const [agenticConversationUrl, setAgenticConversationUrl] = useState<string | null>(null);

  const dismissAgenticDialog = () => {
    setAgenticOpen(false);
    setAgenticLines([]);
    setAgenticRequestId(null);
    setAgenticPhase("running");
    setAgenticErrorSummary(null);
    setAgenticPrompt(null);
    setAgenticConversationUrl(null);
  };

  const getDashboardList = async (): Promise<DashboardListItem[]> => {
    if (cachedDashboardList !== null) {
      return cachedDashboardList;
    }
    const listRes = await fetch("/api/dashboards");
    if (!listRes.ok) {
      const errBody = await listRes.json().catch(() => null);
      throw new Error(
        (errBody?.error as string) || "Error al cargar los dashboards existentes",
      );
    }
    const data = (await listRes.json()) as DashboardListItem[];
    setCachedDashboardList(data);
    return data;
  };

  // Client-side save — used only for templates (no LLM involved). LLM-generated
  // dashboards are saved SERVER-SIDE by /api/dashboard/generate and arrive here
  // already persisted (see generateFromPrompt).
  const saveAndRedirect = async (
    name: string,
    description: string | null,
    spec: DashboardSpec,
  ) => {
    const saveRes = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, spec }),
    });

    if (!saveRes.ok) {
      const errBody = await saveRes.json().catch(() => null);
      if (isApiErrorResponse(errBody)) {
        throw errBody;
      }
      throw new Error((errBody?.error as string) || "Error al guardar el dashboard");
    }

    const saved = await saveRes.json();
    router.push(`/dashboard/${saved.id}`);
  };

  const generateFromPrompt = async (
    promptText: string,
    source: "generate" | "template" = "generate",
  ) => {
    const trimmed = promptText.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setLastErrorSource(null);
    setAgenticOpen(true);
    setAgenticLines([]);
    setAgenticRequestId(null);
    setAgenticPhase("running");
    setAgenticErrorSummary(null);
    setAgenticPrompt(trimmed);
    setAgenticConversationUrl(null);

    try {
      const result = await runDashboardGenerateStream(trimmed, {
        onMeta: (rid, lines, fullPrompt) => {
          setAgenticRequestId(rid);
          if (fullPrompt) setAgenticPrompt(fullPrompt);
          setAgenticLines((prev) => [...prev, ...lines.map((text) => ({ text, kind: inferKind(text) as ProgressLine["kind"] }))]);
        },
        onConversation: (_convId, cUrl) => {
          setAgenticConversationUrl(cUrl);
        },
        onLine: (line: GenerateProgressLine, replace) => {
          const progressLine: ProgressLine = { text: line.text, body: line.body, kind: inferKind(line.text) as ProgressLine["kind"] };
          setAgenticLines((prev) => {
            if (replace && prev.length > 0) {
              return [...prev.slice(0, -1), progressLine];
            }
            return [...prev, progressLine];
          });
        },
      });

      dismissAgenticDialog();
      if (result.dashboardId !== null) {
        // Server already saved the dashboard and linked the conversation.
        router.push(`/dashboard/${result.dashboardId}`);
      } else {
        // Legacy JSON fallback (no server-side save) — persist client-side.
        const name = result.spec.title || "Dashboard sin título";
        await saveAndRedirect(name, result.spec.description || null, result.spec);
      }
    } catch (err) {
      setAgenticPhase("error");
      if (isApiErrorResponse(err)) {
        setError(err);
        setAgenticErrorSummary(<ErrorDisplay error={err} />);
      } else {
        const msg = err instanceof Error ? err.message : "Error inesperado";
        setError(msg);
        setAgenticErrorSummary(<ErrorDisplay error={msg} />);
      }
      setLastErrorSource(source);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    await generateFromPrompt(prompt, "generate");
  };

  const handleUseTemplate = async (template: DashboardTemplate) => {
    if (loading || loadingTemplate) return;

    setLoadingTemplate(template.slug);
    setError(null);
    setLastErrorSource(null);

    try {
      await saveAndRedirect(
        template.spec.title,
        template.description,
        template.spec,
      );
    } catch (err) {
      if (isApiErrorResponse(err)) {
        setError(err);
      } else {
        setError(
          err instanceof Error ? err.message : "Error inesperado al usar la plantilla",
        );
      }
      setLastErrorSource("template");
    } finally {
      setLoadingTemplate(null);
    }
  };

  const handleChipClick = (chipPrompt: string) => {
    setPrompt(chipPrompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleAnalyzeGaps = async () => {
    if (isDisabled) return;

    setGaps(null);
    setGapsError(null);
    setLoadingGaps(true);

    try {
      const listData = await getDashboardList();

      const dashboardsWithSpecs: {
        title: string;
        description: string;
        widgetTitles: string[];
      }[] = await Promise.all(
        listData.slice(0, 30).map(async (d) => {
          try {
            const specRes = await fetch(`/api/dashboard/${d.id}`);
            if (!specRes.ok) {
              return { title: d.name, description: d.description || "", widgetTitles: [] };
            }
            const full: DashboardWithSpec = await specRes.json();
            const widgetTitles = (full.spec?.widgets ?? [])
              .map((w) => ("title" in w ? (w.title as string) : ""))
              .filter(Boolean);
            return {
              title: d.name,
              description: d.description || "",
              widgetTitles,
            };
          } catch {
            return { title: d.name, description: d.description || "", widgetTitles: [] };
          }
        }),
      );

      const gapsRes = await fetch("/api/dashboard/gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ existingDashboards: dashboardsWithSpecs }),
      });

      if (!gapsRes.ok) {
        const errBody = await gapsRes.json().catch(() => null);
        throw new Error(
          (errBody?.error as string) || "Error al analizar la cobertura",
        );
      }

      const data = await gapsRes.json();
      setGaps((data.gaps as Gap[]) || []);
    } catch (err) {
      setGapsError(
        err instanceof Error ? err.message : "Error inesperado al analizar cobertura",
      );
    } finally {
      setLoadingGaps(false);
    }
  };

  const isDisabled = loading || loadingTemplate !== null || loadingGaps;

  const handleCreationTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, current: CreationTab) => {
    const idx = CREATION_TAB_ORDER.indexOf(current);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = CREATION_TAB_ORDER[(idx + 1) % CREATION_TAB_ORDER.length]!;
      setTab(next);
      focusCreationTabButton(next);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        CREATION_TAB_ORDER[(idx - 1 + CREATION_TAB_ORDER.length) % CREATION_TAB_ORDER.length]!;
      setTab(next);
      focusCreationTabButton(next);
    } else if (e.key === "Home") {
      e.preventDefault();
      const next = CREATION_TAB_ORDER[0]!;
      setTab(next);
      focusCreationTabButton(next);
    } else if (e.key === "End") {
      e.preventDefault();
      const next = CREATION_TAB_ORDER[CREATION_TAB_ORDER.length - 1]!;
      setTab(next);
      focusCreationTabButton(next);
    }
  };

  const tabDefs: { id: CreationTab; label: string; hint: string }[] = [
    { id: "templates", label: "Plantillas", hint: "Sin IA, inmediato" },
    { id: "free", label: "Crear con IA", hint: "Atajos + prompt libre" },
  ];

  return (
    <div className="space-y-8">
      <DataFreshnessBanner />

      <div>
        <h1 className="text-2xl font-bold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Nuevo Dashboard
        </h1>
        <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
          Elige cómo quieres crear tu cuadro de mando
        </p>
      </div>

      {error && lastErrorSource === "template" && (
        <ErrorDisplay error={error} />
      )}

      {/* Mapa mental — issue #377 */}
      <section
        className="rounded-lg border border-tremor-border bg-tremor-background-subtle p-4 text-sm text-tremor-content dark:border-dark-tremor-border dark:bg-dark-tremor-background-subtle dark:text-dark-tremor-content"
        aria-labelledby="new-dash-how-heading"
      >
        <h2
          id="new-dash-how-heading"
          className="font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong"
        >
          Dos formas de crear tu cuadro de mando
        </h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
          <li>
            <strong>Plantillas</strong>: partimos de un panel ya montado; se guarda al instante{" "}
            <em>sin</em> llamar al modelo de IA.
          </li>
          <li>
            <strong>Crear con IA</strong>: usa los atajos de negocio para pre-rellenar el prompt o
            escribe lo que necesitas; el modelo genera el panel con IA (puede tardar unos segundos y
            consume presupuesto de uso).
          </li>
        </ul>
      </section>

      <div>
        <p id="creation-tabs-label" className="sr-only">
          Modo de creación
        </p>
        <div
          role="tablist"
          aria-labelledby="creation-tabs-label"
          className="flex flex-wrap gap-1 border-b border-tremor-border dark:border-dark-tremor-border"
        >
          {tabDefs.map((t) => {
            const selected = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                id={`creation-tab-${t.id}-btn`}
                aria-controls={selected ? `creation-tab-panel-${t.id}` : undefined}
                tabIndex={selected ? 0 : -1}
                data-testid={`creation-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => handleCreationTabKeyDown(e, t.id)}
                className={`relative -mb-px rounded-t-md border border-b-0 px-4 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  selected
                    ? "border-tremor-border bg-tremor-background text-blue-600 dark:border-dark-tremor-border dark:bg-dark-tremor-background dark:text-blue-400"
                    : "border-transparent text-tremor-content hover:text-blue-500 dark:text-dark-tremor-content dark:hover:text-blue-400"
                }`}
              >
                <span>{t.label}</span>
                <span className="mt-0.5 block text-[10px] font-normal opacity-80">{t.hint}</span>
              </button>
            );
          })}
        </div>

        {/* ─── Plantillas ─────────────────────────────────────────────────── */}
        <div
          id="creation-tab-panel-templates"
          role="tabpanel"
          aria-labelledby="creation-tab-templates-btn"
          hidden={tab !== "templates"}
          className="pt-8"
        >
            <div>
              <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                Plantillas predefinidas
              </h2>
              <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
                Usa una plantilla para empezar con un dashboard listo al instante (sin generación
                por IA).
              </p>

              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.slug}
                    type="button"
                    onClick={() => handleUseTemplate(template)}
                    disabled={isDisabled}
                    data-testid={`template-card-${template.slug}`}
                    className="flex flex-col items-start rounded-lg border border-emerald-500/25 bg-tremor-background-subtle p-5 text-left shadow-sm hover:border-emerald-500/50 hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed dark:border-emerald-500/20 dark:bg-dark-tremor-background-subtle dark:hover:border-emerald-500/40"
                  >
                    <BadgeNoAi />
                    <h3 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                      {template.name}
                    </h3>
                    <p className="mt-1 text-xs text-tremor-content dark:text-dark-tremor-content line-clamp-2">
                      {template.description}
                    </p>
                    <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      {loadingTemplate === template.slug ? (
                        <>
                          <span
                            className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent"
                            role="status"
                            aria-label="Cargando plantilla"
                          />
                          Creando...
                        </>
                      ) : (
                        "Usar plantilla"
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
        </div>

        {/* ─── Crear con IA ────────────────────────────────────────────────── */}
        <div
          id="creation-tab-panel-free"
          role="tabpanel"
          aria-labelledby="creation-tab-free-btn"
          hidden={tab !== "free"}
          className="pt-8"
        >
            <h2 className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
              Crear con IA
            </h2>
            <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
              Describe el cuadro de mando con tus propias palabras o usa un atajo de negocio para
              pre-rellenar el prompt; generamos el panel con IA.
            </p>

            {/* Shortcut chips */}
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Atajos de negocio">
              {TASK_PROMPTS.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => handleChipClick(task.prompt)}
                  disabled={isDisabled}
                  data-testid={`task-chip-${task.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/25 bg-tremor-background-subtle px-3 py-1.5 text-xs font-medium text-tremor-content-strong hover:border-violet-500/50 hover:text-violet-700 disabled:opacity-50 disabled:cursor-not-allowed dark:border-violet-400/20 dark:bg-dark-tremor-background-subtle dark:text-dark-tremor-content-strong dark:hover:border-violet-400/40 dark:hover:text-violet-300"
                >
                  <span aria-hidden="true">{task.icon}</span>
                  {task.title}
                </button>
              ))}
            </div>

            <div className="mt-4 max-w-2xl space-y-4">
              <BadgeUsesAi />
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isDisabled}
                placeholder="Describe el dashboard que necesitas..."
                rows={6}
                className="w-full resize-none rounded-lg border border-tremor-border bg-tremor-background px-4 py-3 text-sm text-tremor-content-emphasis placeholder:text-tremor-content-subtle focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 dark:border-dark-tremor-border dark:bg-dark-tremor-background dark:text-dark-tremor-content-emphasis dark:placeholder:text-dark-tremor-content-subtle"
              />

              {error && lastErrorSource === "generate" && !agenticOpen && (
                <ErrorDisplay error={error} onRetry={handleGenerate} />
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={isDisabled || prompt.trim() === ""}
                style={{ borderRadius: 6, background: "var(--accent)", padding: "10px 24px", fontSize: 13, fontWeight: 500, color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, opacity: (isDisabled || prompt.trim() === "") ? 0.5 : 1 }}
              >
                {loading && (
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                    role="status"
                    aria-label="Generando"
                  />
                )}
                {loading ? "Generando..." : "Generar Dashboard"}
              </button>
            </div>

            {/* Gap analysis section */}
            <div className="mt-8 border-t border-tremor-border pt-6 dark:border-dark-tremor-border">
              <h3 className="text-base font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                ¿Qué me falta?
              </h3>
              <p className="mt-1 text-sm text-tremor-content dark:text-dark-tremor-content">
                Analiza tus paneles actuales y descubre áreas de negocio poco cubiertas.
              </p>

              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleAnalyzeGaps}
                  disabled={isDisabled || loadingGaps}
                  data-testid="analyze-gaps-button"
                  className="inline-flex items-center gap-2 rounded-lg border border-violet-500/25 bg-tremor-background-subtle px-4 py-2 text-sm font-medium text-tremor-content-strong hover:border-violet-500/50 hover:text-violet-800 disabled:opacity-50 disabled:cursor-not-allowed dark:border-violet-400/20 dark:bg-dark-tremor-background-subtle dark:text-dark-tremor-content-strong dark:hover:text-violet-200"
                >
                  {loadingGaps ? (
                    <>
                      <span
                        className="h-4 w-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent"
                        role="status"
                        aria-label="Analizando cobertura"
                      />
                      Analizando...
                    </>
                  ) : (
                    "Analizar cobertura"
                  )}
                </button>
              </div>

              {gapsError && <p className="mt-4 text-sm text-red-400">{gapsError}</p>}

              {gaps && gaps.length > 0 && (
                <div className="mt-4 space-y-3">
                  {gaps.map((g, i) => (
                    <div
                      key={`${g.area}-${i}`}
                      className="flex items-start justify-between gap-4 rounded-lg border border-violet-500/20 bg-tremor-background-subtle p-4 shadow-sm dark:border-violet-400/15 dark:bg-dark-tremor-background-subtle"
                    >
                      <div className="flex-1">
                        <BadgeUsesAi />
                        <h4 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                          {g.area}
                        </h4>
                        <p className="mt-1 text-xs text-tremor-content dark:text-dark-tremor-content">
                          {g.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleChipClick(g.suggestedPrompt)}
                        disabled={isDisabled}
                        className="shrink-0 self-center rounded-md border border-violet-500/30 bg-tremor-background-subtle px-3 py-1.5 text-xs font-medium text-violet-700 hover:border-violet-500/60 hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-violet-400/25 dark:bg-dark-tremor-background-subtle dark:text-violet-300 dark:hover:bg-violet-950/30"
                      >
                        Usar este prompt
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {gaps && gaps.length === 0 && (
                <p className="mt-4 text-sm text-tremor-content dark:text-dark-tremor-content">
                  ¡Excelente! Tu cobertura de dashboards parece completa.
                </p>
              )}
            </div>
        </div>
      </div>

      <DashboardGenerateProgressDialog
        open={agenticOpen}
        title="Generando panel con IA"
        requestId={agenticRequestId}
        lines={agenticLines}
        phase={agenticPhase}
        errorSummary={agenticErrorSummary}
        fullPrompt={agenticPrompt ?? undefined}
        conversationUrl={agenticConversationUrl ?? undefined}
        onDismiss={dismissAgenticDialog}
      />
    </div>
  );
}
