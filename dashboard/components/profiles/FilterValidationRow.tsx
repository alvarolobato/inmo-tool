"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { withValidateSignal } from "@/lib/extension-validate";
import type { LoosenedConstraint } from "@/lib/search-url";
import type { ProfileConnectorFilterSource } from "@/lib/db/profile-connector-filter";

/**
 * One connector row on the "Validar filtros" page (issue #478 P2/P3).
 *
 * Shows, for a (profile × connector × section): a source badge (pinned vs
 * derived), the copyable search URL, the decoded filter chips + any mismatch
 * warnings against the profile scope, the resolver's loosened flags, and the
 * owner controls — an editable URL field with Guardar (PUT), Quitar (DELETE,
 * only when pinned) and Abrir.
 *
 * Phase 3: "Abrir" opens the URL tagged with the extension's VALIDATION signal
 * (`withValidateSignal`), so the extension enters validation mode on that tab —
 * no batch autostart, no listing banner, no detail auto-capture — and the popup
 * offers "Usar esta URL como filtro" to pin the (tuned) URL back. The owner
 * tunes the search on the portal and hands the URL back with one click.
 */
export function FilterValidationRow({
  profileId,
  connector,
  label,
  url,
  sectionKey,
  overridden,
  source,
  loosened,
  chips,
  warnings,
  unparseable,
  verbatimOnly = false,
}: {
  profileId: number;
  connector: string;
  label: string;
  /** The URL the resolver produced (pinned or derived); "" for an empty row. */
  url: string;
  /** The section_key a PUT/DELETE must target so tier 0 matches this task. */
  sectionKey: string;
  /** True when the URL came from a profile_connector_filter override (pinned). */
  overridden: boolean;
  /** The pin's origin, when pinned. */
  source?: ProfileConnectorFilterSource;
  loosened: LoosenedConstraint[];
  chips: string[];
  warnings: string[];
  unparseable: boolean;
  /**
   * The portal has NO verified search grammar (no builder, no parser) — e.g.
   * altamira (Akamai WAF, issue #497). Its URL can only be pinned + used
   * verbatim: no chips, no inference, no mismatch warnings. The row shows an
   * honest note instead of the misleading "no se pudo descodificar" one.
   */
  verbatimOnly?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(url);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSave() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/connector-filters`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector, sectionKey, url: draft, source: "manual" }),
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
      const params = new URLSearchParams({ connector, sectionKey });
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
    // Phase 3: open in VALIDATION MODE — tag the URL with `#inmo-validate=<pid>:
    // <connector>` so the extension suppresses all capture on that tab and the
    // popup can pin the tuned URL back. withValidateSignal returns the URL
    // untouched if it can't be parsed, so this never breaks the open.
    if (url && typeof window !== "undefined") {
      window.open(
        withValidateSignal(url, profileId, connector),
        "_blank",
        "noopener,noreferrer",
      );
    }
  }

  async function onCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is best-effort; the URL is visible for manual copy anyway.
    }
  }

  const badgeLabel = overridden
    ? source === "extension"
      ? "URL fijada (extensión)"
      : "URL fijada"
    : verbatimOnly
      ? "sin URL fijada"
      : "derivada del perfil";

  return (
    <div
      data-testid="filter-validation-row"
      data-connector={connector}
      data-section={sectionKey}
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
          data-testid="filter-source-badge"
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

      {/* Copyable URL (verbatim). Empty row → an explicit note. */}
      {url ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <code
            data-testid="filter-url"
            title={url}
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
            {url}
          </code>
          <button
            type="button"
            data-testid="filter-copy"
            onClick={onCopy}
            style={ghostButtonStyle}
          >
            {copied ? "Copiado ✓" : "Copiar"}
          </button>
        </div>
      ) : (
        <p data-testid="filter-no-url" style={{ fontSize: 12, color: "var(--fg-muted)", margin: 0 }}>
          Este conector aún no tiene una URL de búsqueda. Pega una abajo y guárdala para fijarla.
        </p>
      )}

      {/* Decoded chips. */}
      {chips.length > 0 && (
        <div data-testid="filter-chips" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {chips.map((chip) => (
            <span
              key={chip}
              style={{
                fontSize: 11,
                color: "var(--fg)",
                background: "var(--bg-2)",
                borderRadius: 6,
                padding: "2px 8px",
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {/* Verbatim-only portal (no verified grammar / WAF, e.g. altamira #497):
          an honest note is shown always — there is no inference to offer, so a
          pinned URL is simply used as typed. This REPLACES the generic
          "no se pudo descodificar" note below (which would be misleading). */}
      {verbatimOnly && (
        <p data-testid="filter-verbatim-note" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0, lineHeight: 1.5 }}>
          Este portal no tiene gramática verificada (WAF de Akamai): no se puede inferir ni validar la
          URL. Se guarda y se usa tal cual.
        </p>
      )}

      {/* Unparseable → verbatim note. Not shown for verbatim-only portals: for
          those the honest note above already explains why nothing decodes. */}
      {url && unparseable && !verbatimOnly && (
        <p data-testid="filter-unparseable" style={{ fontSize: 11, color: "var(--fg-muted)", margin: 0 }}>
          No se pudo descodificar la URL; se usará tal cual.
        </p>
      )}

      {/* Mismatch warnings (URL broader than / differs from the profile scope). */}
      {warnings.length > 0 && (
        <ul
          data-testid="filter-warnings"
          style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}
        >
          {warnings.map((w) => (
            <li
              key={w}
              style={{ fontSize: 11, color: "var(--warn)", background: "var(--warn-bg)", borderRadius: 6, padding: "2px 8px" }}
            >
              {w}
            </li>
          ))}
        </ul>
      )}

      {/* Resolver loosened flags. */}
      {loosened.length > 0 && (
        <ul
          data-testid="filter-loosened"
          style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}
        >
          {loosened.map((l) => (
            <li
              key={l.constraint}
              style={{ fontSize: 11, color: "var(--warn)", background: "var(--warn-bg)", borderRadius: 6, padding: "2px 8px" }}
            >
              <strong>ampliada:</strong> {l.reason}
            </li>
          ))}
        </ul>
      )}

      {/* Editable URL + actions. */}
      <input
        data-testid="filter-url-input"
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
          data-testid="filter-save"
          onClick={onSave}
          disabled={busy !== null || draft.trim() === "" || draft === url}
          style={primaryButtonStyle(busy !== null || draft.trim() === "" || draft === url)}
        >
          {busy === "save" ? "Guardando…" : "Guardar como filtro"}
        </button>
        {overridden && (
          <button
            type="button"
            data-testid="filter-remove"
            onClick={onRemove}
            disabled={busy !== null}
            style={ghostButtonStyle}
          >
            {busy === "remove" ? "Quitando…" : "Quitar"}
          </button>
        )}
        <button
          type="button"
          data-testid="filter-open"
          onClick={onOpen}
          disabled={!url}
          title={url || undefined}
          style={ghostButtonStyle}
        >
          Abrir ↗
        </button>
      </div>

      {error && (
        <p data-testid="filter-error" style={{ fontSize: 12, color: "var(--down)", margin: 0 }}>
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
