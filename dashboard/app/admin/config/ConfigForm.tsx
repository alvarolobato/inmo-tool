"use client";

/**
 * Admin Configuration Page — /admin/config
 *
 * Shows all system configuration keys grouped by section.
 * Requires admin authentication (cookie session — same as all /admin/* pages).
 *
 * The page is protected by middleware (ps_admin cookie check). All API calls
 * use same-origin fetch() without explicit auth headers; the browser sends
 * the ps_admin httpOnly cookie automatically, which adminApiKeyValid() accepts.
 * This keeps the raw admin key out of JavaScript/HTML entirely.
 *
 * Features:
 * - Source badges (env / file / default)
 * - Sensitive fields use SecretField with eye-toggle + server reveal
 * - "Save to file" per-key for env-sourced keys
 * - "Import all env vars" global button
 * - Restart-required banners per section when changed
 * - Inline editing with save
 */

import { useCallback, useEffect, useState } from "react";
import SecretField from "@/components/SecretField";
import {
  EnumSelect,
  PROVIDER_OPTIONS,
  CLAUDE_CLI_MODEL_OPTIONS,
} from "@/components/admin/EnumSelect";
import { OpenRouterModelCombobox } from "@/components/admin/OpenRouterModelCombobox";

// Sí / No options for bool keys.
const BOOL_OPTIONS = [
  { value: "true", label: "Sí" },
  { value: "false", label: "No" },
];

// `value_display` for bool keys can come back as "true"/"false"/"1"/"0"/"yes"/"no" —
// the system loader is permissive. Normalize to the canonical "true"/"false"
// strings the dropdown expects so an unknown value doesn't blank out the select.
function normalizeBoolString(v: string): string {
  const trimmed = (v ?? "").trim().toLowerCase();
  if (trimmed === "1" || trimmed === "yes" || trimmed === "y" || trimmed === "on") return "true";
  if (trimmed === "0" || trimmed === "no" || trimmed === "n" || trimmed === "off" || trimmed === "") return "false";
  return trimmed === "true" ? "true" : trimmed === "false" ? "false" : "false";
}

// ---------------------------------------------------------------------------
// Types (mirror server response shape)
// ---------------------------------------------------------------------------

interface ConfigKey {
  key: string;
  env: string;
  section: string;
  description: string;
  type: "string" | "int" | "bool" | "enum";
  enum_values?: string[];
  sensitive: boolean;
  source: "env" | "file" | "default";
  requires_restart: string[];
  editable: boolean;
  value_display: string;
  has_value: boolean;
}

interface ConfigSection {
  name: string;
  keys: ConfigKey[];
}

interface ConfigData {
  sections: ConfigSection[];
  values: ConfigKey[];
}

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: "env" | "file" | "default" }) {
  const styles = {
    env: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    file: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    default: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  };
  const labels = {
    env: "Variable de entorno",
    file: "Fichero",
    default: "Valor por defecto",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[source]}`}
    >
      {labels[source]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Restart banner
// ---------------------------------------------------------------------------

function RestartBanner({ services }: { services: string[] }) {
  if (!services.length) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
      </svg>
      Requiere reiniciar: {services.join(", ")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single config key row
// ---------------------------------------------------------------------------

interface ConfigRowProps {
  item: ConfigKey;
  onSaved: () => void;
  /** The currently saved value of `dashboard.llm_provider`. Used to grey
   *  out fields that are inert under the active provider (e.g. all
   *  `dashboard.llm_model_openrouter*` keys when provider=cli). */
  llmProvider: string;
}

/**
 * ConfigRow uses same-origin fetch() without explicit auth headers.
 * The browser sends the ps_admin httpOnly cookie automatically.
 */
function ConfigRow({ item, onSaved, llmProvider }: ConfigRowProps) {
  const [editValue, setEditValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedToFile, setSavedToFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);

  // Provider-aware "inert" flag: keys whose value cannot influence
  // anything under the currently saved provider are surfaced read-only
  // with an explanatory note so the operator doesn't try to edit them.
  const isOpenRouterModelKey = item.key.startsWith("dashboard.llm_model_openrouter");
  const isCliModelKey =
    item.key === "dashboard.llm_model_cli" || item.key === "dashboard.llm_cli_driver" ||
    item.key === "dashboard.llm_cli_bin" || item.key.startsWith("dashboard.llm_cli_");
  const inertUnderProvider =
    (llmProvider === "cli" && isOpenRouterModelKey) ||
    (llmProvider === "openrouter" && isCliModelKey);

  const canEdit = item.editable && !inertUnderProvider;

  // Keys whose real value can never be returned by the server (intentional
  // security policy — see REVEAL_BLOCKED_KEYS in the reveal route).
  // For these we skip the reveal API call and show a tooltip instead.
  const REVEAL_BLOCKED = new Set(["dashboard.admin_api_key"]);
  const canReveal = !REVEAL_BLOCKED.has(item.key);

  async function handleReveal() {
    if (!canReveal) return; // blocked — eye button should not be clickable
    try {
      const res = await fetch(`/api/admin/config/reveal?key=${encodeURIComponent(item.key)}`);
      if (!res.ok) {
        if (res.status === 401) throw new Error("Sesión caducada. Recarga e inicia sesión de nuevo.");
        throw new Error(`Error ${res.status}`);
      }
      const data = await res.json();
      setRevealedValue(data.value as string);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startEdit() {
    // For sensitive fields: only pre-fill with the revealed real value; otherwise
    // start with empty string so the user must deliberately type a new value,
    // preventing accidental overwrites with the masked "••••1234" placeholder.
    if (item.sensitive) {
      setEditValue(revealedValue ?? "");
    } else {
      setEditValue(item.value_display);
    }
    setIsEditing(true);
    setError(null);
  }

  function cancelEdit() {
    setIsEditing(false);
    setError(null);
  }

  async function saveValue() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { [item.key]: editValue } }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error((body as { error?: string }).error ?? "Error al guardar");
      }
      setIsEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveToFile() {
    // For sensitive keys: require the real value to be revealed first to
    // avoid persisting the masked "••••1234" placeholder into config.yaml.
    if (item.sensitive && revealedValue === null) {
      setError("Revela el valor primero (icono ojo) antes de guardar en fichero.");
      return;
    }
    const valueToSave = item.sensitive ? revealedValue! : item.value_display;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { [item.key]: valueToSave } }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error((body as { error?: string }).error ?? "Error al guardar");
      }
      setSavedToFile(true);
      setTimeout(() => setSavedToFile(false), 3000);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-tremor-border dark:border-dark-tremor-border py-3 last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {/* Key name + description */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
              {item.key}
            </span>
            <span className="font-mono text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              ${item.env}
            </span>
            <SourceBadge source={item.source} />
            {!item.editable && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-400">
                Solo lectura
              </span>
            )}
          </div>
          {item.description && (
            <p className="mt-0.5 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              {item.description}
            </p>
          )}
        </div>

        {/* Value area */}
        <div className="w-full sm:w-auto sm:min-w-[42rem] sm:max-w-[56rem]">
          {isEditing ? (
            <div className="space-y-1">
              {item.sensitive ? (
                <SecretField
                  value={editValue}
                  revealed={editValue}
                  onChange={setEditValue}
                  placeholder="Introduce el valor..."
                />
              ) : item.key === "dashboard.llm_provider" ? (
                <EnumSelect
                  value={editValue}
                  onChange={setEditValue}
                  options={PROVIDER_OPTIONS}
                  ariaLabel="Proveedor LLM"
                />
              ) : item.type === "enum" && item.enum_values && item.enum_values.length > 0 ? (
                <EnumSelect
                  value={editValue}
                  onChange={setEditValue}
                  options={item.enum_values.map((v) => ({ value: v, label: v }))}
                  ariaLabel={item.key}
                />
              ) : item.key.startsWith("dashboard.llm_model_openrouter") ? (
                <OpenRouterModelCombobox
                  value={editValue}
                  onChange={setEditValue}
                />
              ) : item.key === "dashboard.llm_model_cli" ? (
                <EnumSelect
                  value={editValue}
                  onChange={setEditValue}
                  options={CLAUDE_CLI_MODEL_OPTIONS}
                  ariaLabel="Modelo CLI de Claude Code"
                />
              ) : item.type === "bool" ? (
                <EnumSelect
                  value={normalizeBoolString(editValue)}
                  onChange={setEditValue}
                  options={BOOL_OPTIONS}
                  ariaLabel={item.key}
                />
              ) : (
                <input
                  type={item.type === "int" ? "number" : "text"}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full rounded-md border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background px-3 py-1.5 text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              )}
              <div className="flex gap-2">
                <button
                  onClick={saveValue}
                  disabled={saving}
                  className="rounded-md px-3 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  {saving ? "Guardando..." : "Guardar"}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={saving}
                  className="rounded-md border px-3 py-1 text-xs font-medium hover:brightness-110 disabled:opacity-50"
                  style={{
                    background: "var(--bg-2)",
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {item.sensitive ? (
                <SecretField
                  value={item.value_display}
                  revealed={revealedValue}
                  onReveal={canReveal ? handleReveal : undefined}
                  readOnly
                  title={canReveal ? undefined : "Esta clave no puede revelarse por motivos de seguridad"}
                />
              ) : (
                <span className="font-mono text-sm text-tremor-content-emphasis dark:text-dark-tremor-content-emphasis">
                  {item.value_display || (
                    <span className="italic text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                      (sin valor)
                    </span>
                  )}
                </span>
              )}
              {canEdit && (
                <button
                  onClick={startEdit}
                  className="rounded-md border border-tremor-border dark:border-dark-tremor-border px-2 py-0.5 text-xs hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle"
                >
                  Editar
                </button>
              )}
              {item.source === "env" && canEdit && (
                <button
                  onClick={saveToFile}
                  disabled={saving}
                  title="Copia el valor actual al fichero config.yaml"
                  className="rounded-md border px-2 py-0.5 text-xs hover:brightness-110 disabled:opacity-50"
                  style={{
                    background: "var(--bg-2)",
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }}
                >
                  {savedToFile ? "Guardado" : "Guardar en fichero"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Env precedence warning */}
      {item.source === "env" && (
        <p className="mt-1 text-xs text-purple-700 dark:text-purple-400">
          Variable de entorno activa — tiene prioridad sobre el fichero hasta que la elimines del entorno.
        </p>
      )}

      {/* Inert under current provider */}
      {inertUnderProvider && (
        <p className="mt-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          Inactivo: este ajuste solo aplica cuando <code className="font-mono">dashboard.llm_provider</code> es{" "}
          <code className="font-mono">{isOpenRouterModelKey ? "openrouter" : "cli"}</code>.
        </p>
      )}

      {/* Admin key env-only notice */}
      {item.key === "dashboard.admin_api_key" && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Solo configurable mediante variable de entorno (<code>ADMIN_API_KEY</code>). Los cambios en config.yaml son ignorados para esta clave por motivos de seguridad. El valor no puede revelarse desde la UI.
        </p>
      )}

      {/* Restart warning (shown after edit) */}
      {item.requires_restart?.length > 0 && isEditing && (
        <RestartBanner services={item.requires_restart} />
      )}

      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section card
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  onRefresh,
  llmProvider,
}: {
  section: ConfigSection;
  onRefresh: () => void;
  llmProvider: string;
}) {
  const restartServices = Array.from(
    new Set(section.keys.flatMap((k) => k.requires_restart)),
  );

  return (
    <div className="rounded-lg border border-tremor-border dark:border-dark-tremor-border bg-tremor-background dark:bg-dark-tremor-background">
      <div className="flex items-center justify-between border-b border-tremor-border dark:border-dark-tremor-border px-4 py-2">
        <h2 className="text-sm font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          {section.name}
        </h2>
        {restartServices.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            Cambios requieren reinicio
          </span>
        )}
      </div>
      <div className="px-4">
        {section.keys.map((item) => (
          <ConfigRow
            key={item.key}
            item={item}
            onSaved={onRefresh}
            llmProvider={llmProvider}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

/**
 * Uses same-origin fetch() without explicit auth headers.
 * The browser sends the ps_admin httpOnly cookie automatically for same-origin
 * requests; adminApiKeyValid() now accepts it. The raw key never appears in JS.
 */
export default function ConfigPageClient() {
  const [data, setData] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // No explicit auth header — browser sends ps_admin cookie automatically
      const res = await fetch("/api/admin/config");
      if (res.status === 401) {
        setError("Sesión caducada. Recarga e inicia sesión de nuevo.");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const json = (await res.json()) as ConfigData;
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function handleImportAll() {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/admin/config/import-env", { method: "POST" });
      const body = await res.json() as { message?: string; error?: string };
      setImportResult(body.message ?? body.error ?? "Hecho");
      await loadConfig();
    } catch (e) {
      setImportResult((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
          Configuración del sistema
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void loadConfig()}
            disabled={loading}
            className="rounded-md border border-tremor-border dark:border-dark-tremor-border px-3 py-1.5 text-sm hover:bg-tremor-background-subtle dark:hover:bg-dark-tremor-background-subtle disabled:opacity-50"
          >
            Recargar
          </button>
          <button
            onClick={() => void handleImportAll()}
            disabled={importing || loading}
            title="Copia todas las variables de entorno activas al fichero config.yaml"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {importing ? "Importando..." : "Importar todas las env al fichero"}
          </button>
        </div>
      </div>

      {importResult && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
          {importResult}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
          Cargando configuración...
        </div>
      )}

      {data && !loading && (() => {
        const llmProvider = String(
          data.values.find((v) => v.key === "dashboard.llm_provider")?.value_display ?? "cli",
        );
        return (
          <div className="space-y-4">
            <p className="text-sm text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
              {data.values.length} claves de configuración en {data.sections.length} secciones.
              Los cambios en el fichero se aplican inmediatamente para ajustes LLM/agentic; las
              conexiones de base de datos requieren reiniciar el contenedor correspondiente.
            </p>
            {data.sections.map((section) => (
              <SectionCard
                key={section.name}
                section={section}
                onRefresh={() => void loadConfig()}
                llmProvider={llmProvider}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}
