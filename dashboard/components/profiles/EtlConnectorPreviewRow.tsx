"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProfileConnectorFilterSource } from "@/lib/db/profile-connector-filter";
import type {
  SearchPreview,
  SearchParamSource,
  SearchParamView,
} from "@/lib/db/connector-search-preview";
import { inferParams, rejection, type SearchUrlGrammar } from "@/lib/connector-url/parse";

/** Human label for a param's origin (issue #491) — shown as the chip badge. */
const SOURCE_LABEL: Record<SearchParamSource, string> = {
  profile: "perfil",
  connector_config: "config",
  constant: "constante",
  derived: "derivada",
};

/**
 * Concrete explanation for each grammar reject-reason key (issue #493). Keyed by
 * the reason the grammar publishes — a generic, portal-agnostic catalogue (no
 * per-connector TypeScript): a rejected URL is one discover() could never open
 * (robots.txt-forbidden), so saving it is BLOCKED with the matching message.
 */
const REJECT_REASON_MESSAGE: Record<string, string> = {
  "robots-query-params":
    "Este portal prohíbe por robots.txt los filtros en la query (?…) de las URLs de búsqueda; esta URL no puede usarse como filtro (el ETL nunca podría abrirla).",
  "robots-bare-geography":
    "Este portal prohíbe por robots.txt el segmento de ciudad «desnudo» (p. ej. /madrid/); usa el slug con guion (p. ej. madrid-capital).",
  "robots-faceted-search":
    "Este portal prohíbe por robots.txt su búsqueda facetada; el conector solo puede usar el sitemap de provincia, así que esta URL no puede fijarse como filtro.",
};

function rejectReasonMessage(reason: string): string {
  return (
    REJECT_REASON_MESSAGE[reason] ??
    "Esta URL infringe una restricción de robots.txt del portal y no puede usarse como filtro."
  );
}

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
  derivedUrl = null,
  homeUrl = null,
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
  /**
   * Issue #513: a URL built on demand from the grammar when the ETL has no
   * preview row yet (so the row is never URL-less). Best-effort, unverified by
   * the ETL — shown with a "derivada (sin verificar por ETL)" badge/note.
   */
  derivedUrl?: string | null;
  /**
   * Issue #515: the connector's public home page (connector_registry.home_url).
   * When the row resolves to no URL, "Abrir" falls back to this so the owner can
   * still reach the portal. HTTP connectors open it plainly (no validate signal —
   * that is a capture-portal concern). null → no fallback.
   */
  homeUrl?: string | null;
}) {
  const router = useRouter();
  // Issue #513: when neither a pin nor an ETL-computed URL exists, fall back to
  // the on-demand derived URL so the row is never blank.
  const isDerived = !overridden && !preview?.url && Boolean(derivedUrl);
  // What the connector will actually use: the pin, else the ETL-derived URL,
  // else the on-demand grammar-built one.
  const effectiveUrl =
    (overridden ? pinnedUrl : (preview?.url ?? derivedUrl)) ?? "";
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
  // Issue #493: a reasoned rejection (a robots-forbidden shape) takes precedence
  // over parsing — it BLOCKS Guardar, distinct from an unparseable URL (kept
  // verbatim). Checked first so a rejected URL never shows an inference panel.
  const rejectedReason = inferable
    ? rejection(grammar as SearchUrlGrammar, draftTrimmed)
    : null;
  const inferred =
    inferable && rejectedReason === null
      ? inferParams(grammar as SearchUrlGrammar, draftTrimmed)
      : null;
  const unparseable = inferable && rejectedReason === null && inferred === null;
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

  // Issue #515: "Abrir" opens the resolved URL when present, else the portal
  // home page — so a URL-less row is never a dead button. HTTP connectors open
  // the page plainly (the validation signal is a capture-portal concern).
  const openTarget = effectiveUrl || homeUrl || "";
  const openIsHome = !effectiveUrl && Boolean(homeUrl);

  function onOpen() {
    if (openTarget && typeof window !== "undefined") {
      window.open(openTarget, "_blank", "noopener,noreferrer");
    }
  }

  // For a non-tunable connector (national sitemap / catalogue API) the preview
  // URL is a machine endpoint the owner can't navigate — its "Abrir portal"
  // affordance always targets the browseable home page (issue #515).
  function onOpenHome() {
    if (homeUrl && typeof window !== "undefined") {
      window.open(homeUrl, "_blank", "noopener,noreferrer");
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
      : isDerived
        ? "derivada (sin verificar por ETL)"
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

      {/* Issue #513: the URL was built on demand from the grammar (no ETL sweep
          for this profile yet) — an honest "unverified" note; «Recalcular» sigue
          siendo la fuente autoritativa. */}
      {isDerived && (
        <p data-testid="etl-derived-note" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0, lineHeight: 1.5 }}>
          URL derivada de la gramática del conector, aún sin verificar por el ETL. Pulsa
          «Recalcular» para obtener la que ejecutará realmente el ETL, o fíjala tal cual si te sirve.
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
              data-consumed={p.consumed ? "true" : "false"}
              title={
                p.consumed
                  ? (p.notes ?? undefined)
                  : `${p.notes ? p.notes + " " : ""}Este portal admite este parámetro en su URL; el conector todavía no lo aplica.`
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                // A param the connector doesn't act on yet is dimmed and dashed,
                // so the page never advertises a filter the ETL ignores
                // (issue #494/#495).
                color: p.consumed ? "var(--fg)" : "var(--fg-muted)",
                background: "var(--bg-2)",
                border: p.consumed ? "1px solid var(--border)" : "1px dashed var(--border)",
                borderRadius: 999,
                padding: "2px 8px",
                opacity: p.consumed ? 1 : 0.7,
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>{p.label}</span>
              <strong>{p.value ?? "—"}</strong>
              {!p.consumed && (
                <span data-testid="etl-param-not-consumed" style={{ fontSize: 10, fontStyle: "italic" }}>
                  no consumido aún
                </span>
              )}
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

      {/* Non-tunable connectors: read-only explanation, no owner controls.
          Issue #515: they still get an "Abrir portal" affordance (the preview URL
          is a sitemap/API endpoint, not a browseable page) so the row is never a
          dead end — opens the connector's public home page. */}
      {!tunable && (
        <>
          <p data-testid="etl-readonly" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0 }}>
            El filtrado de este conector es por datos; no hay una URL de búsqueda que fijar.
          </p>
          {homeUrl && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                data-testid="etl-open"
                onClick={onOpenHome}
                title="No hay URL derivada; se abre la portada del portal"
                style={ghostButtonStyle}
              >
                Abrir portal ↗
              </button>
            </div>
          )}
        </>
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
              disabled={
                busy !== null ||
                draft.trim() === "" ||
                draft === effectiveUrl ||
                rejectedReason !== null
              }
              style={primaryButtonStyle(
                busy !== null ||
                  draft.trim() === "" ||
                  draft === effectiveUrl ||
                  rejectedReason !== null,
              )}
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
              disabled={!openTarget}
              title={
                openIsHome
                  ? "No hay URL derivada; se abre la portada del portal"
                  : effectiveUrl || undefined
              }
              style={ghostButtonStyle}
            >
              {openIsHome ? "Abrir portal ↗" : "Abrir ↗"}
            </button>
          </div>

          {/* Issue #493: a robots-forbidden URL is a HARD, reasoned block —
              Guardar is disabled and this explains why (distinct from the
              verbatim-kept "unparseable" note below). */}
          {rejectedReason !== null && (
            <p
              data-testid="etl-inference-rejected"
              data-reject-reason={rejectedReason}
              style={{
                fontSize: 11,
                color: "var(--down)",
                background: "var(--warn-bg)",
                borderRadius: 6,
                padding: "6px 8px",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {rejectReasonMessage(rejectedReason)}
            </p>
          )}

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
                  // A param the connector doesn't act on yet (issue #494/#495):
                  // shown so the owner sees it was inferred, but dimmed with an
                  // explicit "no consumido" tag so the page never implies the
                  // ETL will apply it.
                  const notConsumed = paramMeta[key]?.consumed === false;
                  return (
                    <span
                      key={key}
                      data-testid="etl-inferred-chip"
                      data-param-key={key}
                      data-differs={differs ? "true" : "false"}
                      data-consumed={notConsumed ? "false" : "true"}
                      title={
                        notConsumed
                          ? "Este portal admite este parámetro en su URL; el conector todavía no lo aplica."
                          : undefined
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: differs ? "var(--warn)" : notConsumed ? "var(--fg-muted)" : "var(--fg)",
                        background: differs ? "var(--warn-bg)" : "var(--bg-1)",
                        border: notConsumed ? "1px dashed var(--border)" : "1px solid var(--border)",
                        borderRadius: 999,
                        padding: "2px 8px",
                        opacity: notConsumed && !differs ? 0.7 : 1,
                      }}
                    >
                      <span style={{ color: "var(--fg-muted)" }}>{metaLabel}</span>
                      <strong>{value}</strong>
                      {differs && (
                        <span style={{ fontSize: 10 }}>
                          ≠ {derived ?? "—"}
                        </span>
                      )}
                      {notConsumed && (
                        <span data-testid="etl-inferred-not-consumed" style={{ fontSize: 10, fontStyle: "italic" }}>
                          no consumido aún
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
