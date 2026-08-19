"use client";

import { useEffect, useRef, useState } from "react";
import { fmtEUR0, fmtInt } from "@/components/widgets/format";
import { PROPERTY_TYPE_LABELS, type PROPERTY_TYPES } from "@/lib/profiles-schema";
import type { DedupActionRow, DedupListingSide, DedupSuggestion } from "@/lib/dedup-shared";
import { MATCH_BASIS_LABELS } from "@/lib/dedup-shared";
import { dedupDetailSummary } from "./dedupDetailSummary";

const POLL_INTERVAL_MS = 1500;
// The ETL container's poll loop drains suggested_merge_action every ~3s
// (etl/dedup/actions.py). 20 polls * 1.5s = 30s covers that plus a full
// margin for a busy poll cycle — long enough that a timeout means
// something is actually stuck, not just unlucky timing.
const MAX_POLLS = 20;

function typeLabel(propertyType: string | null): string | null {
  if (propertyType === null) return null;
  return propertyType in PROPERTY_TYPE_LABELS
    ? PROPERTY_TYPE_LABELS[propertyType as (typeof PROPERTY_TYPES)[number]]
    : propertyType;
}

function factsLine(side: DedupListingSide): string {
  const facts: string[] = [];
  const t = typeLabel(side.property_type);
  if (t) facts.push(t);
  if (side.m2_built !== null) facts.push(`${fmtInt(side.m2_built)} m²`);
  if (side.rooms !== null) facts.push(`${side.rooms} hab.`);
  if (side.bathrooms !== null) facts.push(`${side.bathrooms} ${side.bathrooms === 1 ? "baño" : "baños"}`);
  return facts.length > 0 ? facts.join(" · ") : "Sin datos estructurados";
}

function ListingSidePanel({ side }: { side: DedupListingSide }) {
  const photos = side.photo_urls.slice(0, 4);
  return (
    // flexBasis 280 (not the shorthand `flex: 1`, which is `1 1 0%`) is
    // load-bearing: a 0% basis is what made the parent's flexWrap inert
    // (#576) — the panel always "fit" by shrinking to nothing instead of
    // wrapping. With equal basis + equal grow on both panels, the resolved
    // width above the wrap threshold is provably identical to the old
    // basis-0 behaviour (both converge to half the available space), so
    // desktop (>=768px, where the row never wraps) is unaffected; below the
    // threshold the row wraps and each panel grows to fill its own line.
    <div className="dedup-side-panel" style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        data-testid="dedup-side-source"
        style={{
          alignSelf: "flex-start",
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.02em",
          padding: "1px 6px",
          borderRadius: 3,
          background: "var(--bg-2)",
          color: "var(--fg-muted)",
        }}
      >
        {side.source}
      </span>

      {photos.length > 0 ? (
        // 4 across is fine once the panel itself is full desktop width, but
        // at a stacked mobile panel width (~300-350px) that's ~70px-wide,
        // ~55px-tall thumbnails — too small for "are these the same flat?"
        // comparison. .dedup-photo-grid switches to 2 columns below 768px
        // (globals.css) so each thumbnail roughly doubles in both
        // dimensions; desktop keeps repeat(4, 1fr) unchanged.
        <div className="dedup-photo-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
          {photos.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- external, unpredictable-domain listing photos
            <img
              key={url}
              src={url}
              alt={`Foto ${i + 1} de ${side.source}`}
              style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 4, display: "block" }}
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            aspectRatio: "16 / 9",
            borderRadius: 4,
            background: "var(--bg-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--fg-subtle)",
          }}
        >
          Sin fotos
        </div>
      )}

      <p
        data-testid="dedup-side-price"
        style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--fg)" }}
      >
        {side.current_price !== null ? fmtEUR0(side.current_price) : "Precio no disponible"}
      </p>
      <p
        data-testid="dedup-side-address"
        title={side.address ?? undefined}
        style={{
          margin: 0,
          fontSize: 12,
          color: "var(--fg-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {[side.address, side.city].filter(Boolean).join(", ") || "Dirección no disponible"}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "var(--fg-subtle)" }}>{factsLine(side)}</p>
      {side.url && (
        <a
          href={side.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: "var(--accent)" }}
        >
          Ver anuncio original ↗
        </a>
      )}
    </div>
  );
}

export function SuggestionCard({
  suggestion,
  onResolved,
}: {
  suggestion: DedupSuggestion;
  /** Called once the enqueued action reaches 'done' — the parent removes
   * this suggestion from the queue. */
  onResolved: (suggestionId: number) => void;
}) {
  const [pendingAction, setPendingAction] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollCountRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    // Explicitly reset on (re-)mount, not just declared via useRef(false)'s
    // initial value — React 18 StrictMode (dev only, on by default in this
    // app's next.config.js) mounts every component, immediately triggers
    // this effect's cleanup once, then re-mounts, specifically to catch
    // exactly this class of bug. Without this reset, that dev-only
    // mount→cleanup→remount dance leaves cancelledRef permanently `true`
    // after the *real* mount, so pollAction's very first line silently
    // no-ops forever — confirm/reject looked like they hung, with no
    // network request, no error, nothing: reproduced and confirmed via a
    // standalone Playwright script before this fix (see PR description).
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const pollAction = async (actionId: number, action: "confirm" | "reject") => {
    if (cancelledRef.current) return;
    pollCountRef.current += 1;
    try {
      const res = await fetch(`/api/dedup/actions/${actionId}`);
      if (!res.ok) {
        setError("No se pudo consultar el estado de la solicitud.");
        setPendingAction(null);
        return;
      }
      const body: DedupActionRow = await res.json();
      if (body.status === "done") {
        onResolved(suggestion.id);
        return;
      }
      if (body.status === "failed") {
        setError(body.error_msg ?? "La solicitud no se pudo completar.");
        setPendingAction(null);
        return;
      }
      // still 'pending' — poll again unless we've been at this too long
      if (pollCountRef.current >= MAX_POLLS) {
        setError(
          "Sigue en cola en el motor de deduplicación — se completará en breve; " +
            "vuelve a esta sugerencia en unos segundos.",
        );
        setPendingAction(null);
        return;
      }
      setTimeout(() => pollAction(actionId, action), POLL_INTERVAL_MS);
    } catch {
      setError("No se pudo consultar el estado de la solicitud.");
      setPendingAction(null);
    }
  };

  const submit = async (action: "confirm" | "reject") => {
    setError(null);
    setPendingAction(action);
    pollCountRef.current = 0;
    try {
      const res = await fetch(`/api/dedup/suggestions/${suggestion.id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "No se pudo enviar la solicitud.");
        setPendingAction(null);
        return;
      }
      const body: { action_id: number } = await res.json();
      pollAction(body.action_id, action);
    } catch {
      setError("No se pudo enviar la solicitud.");
      setPendingAction(null);
    }
  };

  const confidencePct = Math.round(suggestion.confidence * 100);

  return (
    <div
      data-testid="dedup-suggestion-card"
      data-suggestion-id={suggestion.id}
      data-match-basis={suggestion.match_basis}
      data-profile-relevant={suggestion.profile_relevant ? "true" : "false"}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-1)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            data-testid="dedup-match-basis"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
              background: "var(--accent-soft)",
              color: "var(--accent)",
            }}
          >
            {MATCH_BASIS_LABELS[suggestion.match_basis]}
          </span>
          <span data-testid="dedup-confidence" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            Confianza: {confidencePct}%
          </span>
          {suggestion.profile_relevant && (
            <span
              data-testid="dedup-profile-relevant-badge"
              title="Al menos uno de los anuncios coincide con un perfil de búsqueda activo"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              En tus perfiles
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
          {dedupDetailSummary(suggestion.match_basis, suggestion.detail)}
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <ListingSidePanel side={suggestion.listing_a} />
        {/* dedup-vs-icon: forced to flex-basis 100% below 768px (globals.css)
            so it lands on its own centered row between the two stacked
            panels instead of squeezing onto panel A's line — see the
            SuggestionCard-row comment above for why the wrap is only real
            below the desktop breakpoint. */}
        <div
          className="dedup-vs-icon"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-subtle)", fontSize: 18 }}
        >
          ≟
        </div>
        <ListingSidePanel side={suggestion.listing_b} />
      </div>

      {error && (
        <p role="alert" data-testid="dedup-error" style={{ margin: 0, fontSize: 12, color: "var(--danger, #ff9b9b)" }}>
          {error}
        </p>
      )}

      {/*
        dedup-actions-row / dedup-action-btn: confirm/reject are a
        destructive-ish call made with a thumb, so below 768px (globals.css)
        each button gets a real 44px minimum hit area (WCAG 2.5.5) instead
        of the ~29px this padding/font-size alone produce. flexWrap here is
        unconditional and harmless on desktop — it only activates if the row
        genuinely doesn't fit, which it always does above the breakpoint.
      */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button
          type="button"
          data-testid="dedup-reject"
          className="dedup-action-btn"
          disabled={pendingAction !== null}
          onClick={() => submit("reject")}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            cursor: pendingAction !== null ? "default" : "pointer",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            opacity: pendingAction !== null ? 0.6 : 1,
          }}
        >
          {pendingAction === "reject" ? "Rechazando…" : "Rechazar"}
        </button>
        <button
          type="button"
          data-testid="dedup-confirm"
          className="dedup-action-btn"
          disabled={pendingAction !== null}
          onClick={() => submit("confirm")}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: pendingAction !== null ? "default" : "pointer",
            border: "1px solid var(--up)",
            background: "var(--up)",
            color: "var(--bg)",
            opacity: pendingAction !== null ? 0.6 : 1,
          }}
        >
          {pendingAction === "confirm" ? "Confirmando…" : "Confirmar fusión"}
        </button>
      </div>
    </div>
  );
}
