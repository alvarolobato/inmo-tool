"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProfileConnectorFilterSource } from "@/lib/db/profile-connector-filter";
import type {
  SearchPreview,
  SearchParamSource,
  SearchParamView,
} from "@/lib/db/connector-search-preview";
import { inferParams, type SearchUrlGrammar } from "@/lib/connector-url/parse";

/** Human label for a param's origin (issue #491) — shown as the chip badge. */
const SOURCE_LABEL: Record<SearchParamSource, string> = {
  profile: "perfil",
  connector_config: "config",
  constant: "constante",
  derived: "derivada",
};

/**
 * One ETL-connector row on the "Validar filtros" page (issue #478 P4).
 *
 * Renders what the connector's discover() will execute for this profile — the
 * entry URL / sitemap / endpoint (by `kind`) plus an honest note. TUNABLE
 * connectors (a real host-scoped search URL) get owner controls: an editable URL
 * with Guardar (PUT) / Quitar (DELETE, when pinned) / Abrir. NON-TUNABLE
 * connectors (national sitemap / catalogue API) are read-only with their note —
 * their recall is by data, not by a tunable URL.
 *
 * Saving a tunable HTTP connector's URL persists it but has NO recall effect yet
 * (the override_url → discover() wiring is Phase 5); the route validates the
 * pinned URL's host against the registry's override_host_suffix.
 */
export function EtlConnectorPreviewRow({
  profileId,
  connector,
  preview,
  tunable,
  grammar,
  computedAt,
  overridden,
  pinnedUrl,
  source,
}: {
  profileId: number;
  connector: string;
  /** The primary preview (first entry), or null when none computed yet. */
  preview: SearchPreview | null;
  /** Whether the connector accepts a pinned URL (has an override_host_suffix). */
  tunable: boolean;
  /** The connector's URL grammar (issue #491), or null when it publishes none. */
  grammar: SearchUrlGrammar | null;
  /** When the ETL last computed this connector's previews (ISO), or null. */
  computedAt: string | null;
  /** True when an owner override is pinned for this connector (section ''). */
  overridden: boolean;
  /** The pinned URL, when overridden. */
  pinnedUrl: string | null;
  /** The pin's origin, when pinned. */
  source?: ProfileConnectorFilterSource;
}) {
  const router = useRouter();
  // What the connector will actually use: the pin (if any) else the derived URL.
  const effectiveUrl = (overridden ? pinnedUrl : preview?.url) ?? "";
  const [draft, setDraft] = useState(effectiveUrl);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const label = preview?.label ?? connector;
  const kind = preview?.kind ?? "search_page";
  const notes = preview?.notes ?? null;

  // Issue #491: the resolved params this connector uses for the profile.
  const params: SearchParamView[] = preview?.params ?? [];
  // The derived values of the params that DO travel in the URL, keyed by grammar
  // key — the baseline the live inference is diffed against.
  const derivedByKey = new Map<string, string | null>(
    params.filter((p) => p.inUrl).map((p) => [p.key, p.value]),
  );

  // Live inference (only for a tunable connector with a published grammar, and
  // only once the draft URL diverges from what the ETL derived). `null` inferred
  // = the URL doesn't fit the grammar → it's saved verbatim with a warning
  // (Guardar is NOT blocked — consistent with #478 P5's verbatim-pin policy).
  const canInfer = tunable && grammar !== null;
  const draftTrimmed = draft.trim();
  const inferable = canInfer && draftTrimmed !== "";
  const inferred = inferable ? inferParams(grammar as SearchUrlGrammar, draftTrimmed) : null;
  const unparseable = inferable && inferred === null;
  const paramMeta = grammar?.params ?? {};

  async function onSave() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/connector-filters`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector, sectionKey: "", url: draft, source: "manual" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo guardar el filtro.");
        return;
      }
      router.refresh();
    } catch {
      setError("No se pudo guardar el filtro.");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("remove");
    setError(null);
    try {
      const params = new URLSearchParams({ connector, sectionKey: "" });
      const res = await fetch(
        `/api/profiles/${profileId}/connector-filters?${params.toString()}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo quitar el filtro.");
        return;
      }
      router.refresh();
    } catch {
      setError("No se pudo quitar el filtro.");
    } finally {
      setBusy(null);
    }
  }

  function onOpen() {
    if (effectiveUrl && typeof window !== "undefined") {
      window.open(effectiveUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function onCopy() {
    if (!effectiveUrl) return;
    try {
      await navigator.clipboard.writeText(effectiveUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort
    }
  }

  const kindLabel =
    kind === "sitemap" ? "sitemap" : kind === "api" ? "endpoint API" : "página de búsqueda";
  const badgeLabel = !tunable
    ? "no afinable"
    : overridden
      ? source === "extension"
        ? "URL fijada (extensión)"
        : "URL fijada"
      : "derivada del perfil";

  return (
    <div
      data-testid="etl-connector-row"
      data-connector={connector}
      data-tunable={tunable ? "true" : "false"}
      data-overridden={overridden ? "true" : "false"}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-1)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14, color: "var(--fg)" }}>{label}</strong>
        <span
          data-testid="etl-kind-badge"
          style={{
            fontSize: 11,
            fontWeight: 500,
            padding: "2px 8px",
            borderRadius: 999,
            color: "var(--fg-muted)",
            background: "var(--bg-2)",
          }}
        >
          {kindLabel}
        </span>
        <span
          data-testid="etl-source-badge"
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            color: overridden ? "var(--accent)" : "var(--fg-muted)",
            background: "var(--bg-2)",
          }}
        >
          {badgeLabel}
        </span>
      </div>

      {/* URL / endpoint (copyable). No preview yet → pending note. */}
      {effectiveUrl ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <code
            data-testid="etl-url"
            title={effectiveUrl}
            style={{
              fontSize: 12,
              color: "var(--fg-muted)",
              background: "var(--bg-2)",
              borderRadius: 6,
              padding: "4px 8px",
              // Single line — never wrap; the Copiar button gives the full value.
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
            }}
          >
            {effectiveUrl}
          </code>
          <button type="button" data-testid="etl-copy" onClick={onCopy} style={ghostButtonStyle}>
            {copied ? "Copiado ✓" : "Copiar"}
          </button>
        </div>
      ) : (
        <p data-testid="etl-pending" style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
          {preview === null
            ? "Previsualización pendiente de la próxima ejecución del ETL."
            : "Este conector no resuelve a una URL para este perfil."}
        </p>
      )}

      {/* Issue #491: the exact params this connector receives, each with its
          origin badge (perfil / config / constante / derivada). Rendered for
          EVERY connector that has params, tunable or not. */}
      {params.length > 0 && (
        <div
          data-testid="etl-params"
          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        >
          {params.map((p) => (
            <span
              key={p.key}
              data-testid="etl-param-chip"
              data-param-key={p.key}
              data-param-source={p.source}
              title={p.notes ?? undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--fg)",
                background: "var(--bg-2)",
                border: "1px solid var(--border)",
                borderRadius: 999,
                padding: "2px 8px",
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>{p.label}</span>
              <strong>{p.value ?? "—"}</strong>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--fg-muted)",
                  background: "var(--bg-1)",
                  borderRadius: 999,
                  padding: "1px 6px",
                }}
              >
                {SOURCE_LABEL[p.source]}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Issue #491 ground truth: the profile's price/size/type filters are NOT
          sent to the connector — they are applied downstream by data. Say so
          honestly wherever this connector actually receives params. */}
      {params.length > 0 && (
        <p
          data-testid="etl-downstream-note"
          style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0, lineHeight: 1.5 }}
        >
          Los filtros de precio/tamaño/tipo del perfil no viajan en esta búsqueda; se aplican
          después por datos.
        </p>
      )}

      {/* Honest note (why non-tunable, or how the sweep works). */}
      {notes && (
        <p data-testid="etl-notes" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0 }}>
          {notes}
        </p>
      )}

      {/* Non-tunable connectors: read-only explanation, no owner controls. */}
      {!tunable && (
        <p data-testid="etl-readonly" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0 }}>
          El filtrado de este conector es por datos; no hay una URL de búsqueda que fijar.
        </p>
      )}

      {/* Tunable connectors: editable URL + actions. */}
      {tunable && (
        <>
          <input
            data-testid="etl-url-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`URL de búsqueda de ${connector} (pégala aquí para fijarla)`}
            spellCheck={false}
            style={{
              width: "100%",
              fontSize: 12,
              padding: "7px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-2)",
              color: "var(--fg)",
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid="etl-save"
              onClick={onSave}
              disabled={busy !== null || draft.trim() === "" || draft === effectiveUrl}
              style={primaryButtonStyle(busy !== null || draft.trim() === "" || draft === effectiveUrl)}
            >
              {busy === "save" ? "Guardando…" : "Guardar como filtro"}
            </button>
            {overridden && (
              <button
                type="button"
                data-testid="etl-remove"
                onClick={onRemove}
                disabled={busy !== null}
                style={ghostButtonStyle}
              >
                {busy === "remove" ? "Quitando…" : "Quitar"}
              </button>
            )}
            <button
              type="button"
              data-testid="etl-open"
              onClick={onOpen}
              disabled={!effectiveUrl}
              title={effectiveUrl || undefined}
              style={ghostButtonStyle}
            >
              Abrir ↗
            </button>
          </div>

          {/* Issue #491: live "Esta URL significa…" — re-infer params from the
              edited URL using the published grammar (in the browser). Params
              that differ from the derived baseline are highlighted in amber. */}
          {canInfer && inferred !== null && (
            <div
              data-testid="etl-inference-panel"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-2)",
                padding: "8px 10px",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-muted)" }}>
                Esta URL significa:
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {Object.entries(inferred).map(([key, value]) => {
                  const derived = derivedByKey.get(key);
                  const differs = derivedByKey.has(key) && derived !== value;
                  const metaLabel =
                    (paramMeta[key] && paramMeta[key].label) || key;
                  return (
                    <span
                      key={key}
                      data-testid="etl-inferred-chip"
                      data-param-key={key}
                      data-differs={differs ? "true" : "false"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: differs ? "var(--warn)" : "var(--fg)",
                        background: differs ? "var(--warn-bg)" : "var(--bg-1)",
                        border: "1px solid var(--border)",
                        borderRadius: 999,
                        padding: "2px 8px",
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>{metaLabel}</span>
                      <strong>{value}</strong>
                      {differs && (
                        <span style={{ fontSize: 10 }}>
                          ≠ {derived ?? "—"}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Unparseable edit: kept verbatim with a warning; Guardar stays
              enabled (consistent with #478 P5's verbatim pin policy). */}
          {unparseable && (
            <p
              data-testid="etl-inference-warning"
              style={{
                fontSize: 11,
                color: "var(--warn)",
                background: "var(--warn-bg)",
                borderRadius: 6,
                padding: "4px 8px",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              No se pueden inferir parámetros de esta URL; se usará tal cual.
            </p>
          )}
        </>
      )}

      {computedAt && (
        <p data-testid="etl-computed-at" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0 }}>
          Calculada el {new Date(computedAt).toLocaleString("es-ES")}
        </p>
      )}

      {error && (
        <p data-testid="etl-error" style={{ fontSize: 12, color: "var(--down)", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

const ghostButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--fg)",
  cursor: "pointer",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}
