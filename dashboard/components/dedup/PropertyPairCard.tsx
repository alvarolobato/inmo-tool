"use client";

import { useEffect, useRef, useState } from "react";
import type { DedupActionRow, DedupEvidenceItem, DedupPropertyPairSuggestion } from "@/lib/dedup-shared";
import { MATCH_BASIS_LABELS } from "@/lib/dedup-shared";
import { dedupDetailSummary } from "./dedupDetailSummary";
import { ListingSidePanel } from "./ListingSidePanel";

const POLL_INTERVAL_MS = 1500;
// Same margin as the old per-listing SuggestionCard: the ETL container's
// poll loop drains suggested_merge_action every ~3s.
const MAX_POLLS = 20;

/** One collapsed evidence row (not the primary/strongest pair, which
 * renders as the full ListingSidePanel comparison above this list) — a
 * compact line so a 38-row group doesn't turn into 38 photo grids. */
function EvidenceRow({ evidence }: { evidence: DedupEvidenceItem }) {
  return (
    <li
      data-testid="dedup-evidence-row"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        flexWrap: "wrap",
        fontSize: 12,
        color: "var(--fg-muted)",
        padding: "4px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--fg)" }}>{MATCH_BASIS_LABELS[evidence.match_basis]}</span>
      <span>{Math.round(evidence.confidence * 100)}%</span>
      <span>
        {evidence.listing_lo.source} ↔ {evidence.listing_hi.source}
      </span>
      <span style={{ color: "var(--fg-subtle)" }}>{dedupDetailSummary(evidence.match_basis, evidence.detail)}</span>
    </li>
  );
}

/** Polls one enqueued confirm/reject-pair action to completion. Both group
 * actions are a single `suggested_merge_action` row (issue #605 Part 2
 * revision, PR #611 review — the engine derives the whole property pair
 * from one representative suggestion_id), so there is exactly one poll
 * loop per action, never a fan-out to babysit. */
function pollDedupAction(
  actionId: number,
  cancelledRef: React.RefObject<boolean>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let polls = 0;
    const tick = async () => {
      if (cancelledRef.current) {
        resolve({ ok: false, error: "cancelado" });
        return;
      }
      polls += 1;
      try {
        const res = await fetch(`/api/dedup/actions/${actionId}`);
        if (!res.ok) {
          resolve({ ok: false, error: "No se pudo consultar el estado de la solicitud." });
          return;
        }
        const body: DedupActionRow = await res.json();
        if (body.status === "done") {
          resolve({ ok: true });
          return;
        }
        if (body.status === "failed") {
          resolve({ ok: false, error: body.error_msg ?? "La solicitud no se pudo completar." });
          return;
        }
        if (polls >= MAX_POLLS) {
          resolve({
            ok: false,
            error:
              "Sigue en cola en el motor de deduplicación — se completará en breve; recarga en unos segundos.",
          });
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      } catch {
        resolve({ ok: false, error: "No se pudo consultar el estado de la solicitud." });
      }
    };
    tick();
  });
}

// The route segment differs from the action kind only for reject-pair
// (`reject-pair`, hyphenated, vs. the `reject_pair` DedupActionKind) —
// mapped explicitly rather than string-munged so a future action kind
// can't silently produce the wrong URL.
const ACTION_ROUTE_SEGMENT: Record<"confirm" | "reject_pair", string> = {
  confirm: "confirm",
  reject_pair: "reject-pair",
};

async function submitAction(
  suggestionId: number,
  action: "confirm" | "reject_pair",
): Promise<{ ok: true; actionId: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `/api/dedup/suggestions/${suggestionId}/${ACTION_ROUTE_SEGMENT[action]}`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: body?.error ?? "No se pudo enviar la solicitud." };
    }
    const body: { action_id: number } = await res.json();
    return { ok: true, actionId: body.action_id };
  } catch {
    return { ok: false, error: "No se pudo enviar la solicitud." };
  }
}

export function PropertyPairCard({
  pair,
  onResolved,
}: {
  pair: DedupPropertyPairSuggestion;
  /** Called once EVERY underlying suggestion in the group has resolved —
   * the parent removes this card from the queue. */
  onResolved: (pairKey: string) => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "reject_pair" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Rejecting a whole property pair on the strength of ONE listing
  // comparison is a bigger commitment than the old per-listing reject
  // (it permanently freezes every pending row in the group — D-024/#605).
  // A second, explicit tap makes that blast radius visible before it fires,
  // instead of one click silently rejecting up to 38 pairs.
  const [confirmingReject, setConfirmingReject] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    // See SuggestionCard's identical comment: React 18 StrictMode's dev-only
    // mount→cleanup→remount would otherwise leave this permanently `true`.
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const primary = pair.evidence[0];
  const corroborating = pair.evidence.slice(1);

  const runConfirm = async () => {
    setError(null);
    setConfirmingReject(false);
    setBusy("confirm");
    const submitted = await submitAction(primary.suggestion_id, "confirm");
    if (!submitted.ok) {
      setError(submitted.error);
      setBusy(null);
      return;
    }
    const result = await pollDedupAction(submitted.actionId, cancelledRef);
    if (cancelledRef.current) return;
    if (!result.ok) {
      setError(result.error);
      setBusy(null);
      return;
    }
    // The merge lands on the representative row only; every sibling row in
    // this group becomes invisible immediately (issue #605 Part 1's
    // same-property filter, once the merge updates listing.property_id) and
    // formally resolves to 'confirmed' on the dedup engine's next pass
    // (D-024/#604) — no separate action needed per sibling.
    onResolved(pair.pair_key);
  };

  const runReject = async () => {
    setError(null);
    setConfirmingReject(false);
    setBusy("reject_pair");
    // ONE atomic action against the representative suggestion — the
    // engine (etl.dedup.engine.reject_property_pair) derives the whole
    // property pair from its listings and rejects every currently-pending
    // row between the two properties itself. Not a per-evidence-row
    // fan-out: issue #605 Part 2 revision (PR #611 review B1/M3) — a
    // fan-out of N independent HTTP requests has no atomicity, so a
    // partial failure could strand the card (some pairs rejected, some
    // not, no clean retry). A single action either resolves or fails as
    // one unit.
    const submitted = await submitAction(primary.suggestion_id, "reject_pair");
    if (!submitted.ok) {
      setError(submitted.error);
      setBusy(null);
      return;
    }
    const result = await pollDedupAction(submitted.actionId, cancelledRef);
    if (cancelledRef.current) return;
    if (!result.ok) {
      setError(result.error);
      setBusy(null);
      return;
    }
    onResolved(pair.pair_key);
  };

  const confidencePct = Math.round(pair.top_confidence * 100);

  return (
    <div
      className="dedup-card"
      data-testid="dedup-pair-card"
      data-pair-key={pair.pair_key}
      data-match-basis={pair.top_match_basis}
      data-profile-relevant={pair.profile_relevant ? "true" : "false"}
      data-pair-count={pair.pair_count}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
            {MATCH_BASIS_LABELS[pair.top_match_basis]}
          </span>
          <span data-testid="dedup-confidence" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            Confianza: {confidencePct}%
          </span>
          {pair.profile_relevant && (
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
          {pair.pair_count > 1 && (
            <span
              data-testid="dedup-pair-count-badge"
              title="Cuántas comparaciones de anuncios corroboran esta misma pregunta — puede haber menos anuncios distintos que pares, si un anuncio aparece en más de uno"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--bg-2)",
                color: "var(--fg-muted)",
              }}
            >
              {pair.pair_count} pares corroborantes
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
          {dedupDetailSummary(primary.match_basis, primary.detail)}
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <ListingSidePanel side={primary.listing_lo} />
        <div
          className="dedup-vs-icon"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-subtle)", fontSize: 18 }}
        >
          ≟
        </div>
        <ListingSidePanel side={primary.listing_hi} />
      </div>

      {corroborating.length > 0 && (
        <div data-testid="dedup-evidence-section">
          {/* dedup-evidence-toggle: this is the ONLY route to the
              corroborating evidence D-133 leans on for an informed bulk
              decision, so it needs a real tap target on a phone, not just
              confirm/reject/cancel (PR #611 review M1 — measured 18px
              tall with no class, `padding: 0`, before this fix). `padding`
              is the only value that differs by breakpoint, so — per
              D-121's ladder for a static (no prop/state-dependent) value
              — it's deleted from the inline style below and owned
              entirely by this class; the mobile override in globals.css
              adds the same 44px min-height + centering `.dedup-action-btn`
              already gets. Every other inline property here (color,
              fontSize, cursor, layout) is identical at every width, so it
              stays inline. */}
          <button
            type="button"
            data-testid="dedup-evidence-toggle"
            className="dedup-evidence-toggle"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "none",
              border: "none",
              fontSize: 12,
              color: "var(--accent)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {expanded ? "Ocultar" : "Ver"} los otros {corroborating.length} pares que corroboran esta pareja de propiedades
          </button>
          {expanded && (
            <ul data-testid="dedup-evidence-list" style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
              {corroborating.map((e) => (
                <EvidenceRow key={e.suggestion_id} evidence={e} />
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" data-testid="dedup-error" style={{ margin: 0, fontSize: 12, color: "var(--danger, #ff9b9b)" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", alignItems: "center" }}>
        {confirmingReject && (
          <span data-testid="dedup-reject-warning" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
            {pair.pair_count > 1
              ? `Se rechazarán los ${pair.pair_count} pares de esta pareja de propiedades, para siempre.`
              : "Este rechazo es permanente."}
          </span>
        )}
        {confirmingReject && (
          <button
            type="button"
            data-testid="dedup-reject-cancel"
            className="dedup-action-btn"
            disabled={busy !== null}
            onClick={() => setConfirmingReject(false)}
            style={{
              borderRadius: 6,
              fontSize: 13,
              cursor: busy !== null ? "default" : "pointer",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--fg)",
            }}
          >
            Cancelar
          </button>
        )}
        <button
          type="button"
          data-testid="dedup-reject"
          className="dedup-action-btn"
          disabled={busy !== null}
          onClick={() => (confirmingReject ? runReject() : setConfirmingReject(true))}
          style={{
            borderRadius: 6,
            fontSize: 13,
            cursor: busy !== null ? "default" : "pointer",
            border: confirmingReject ? "1px solid var(--danger, #ff9b9b)" : "1px solid var(--border)",
            background: "transparent",
            color: confirmingReject ? "var(--danger, #ff9b9b)" : "var(--fg)",
            opacity: busy !== null ? 0.6 : 1,
          }}
        >
          {busy === "reject_pair"
            ? "Rechazando…"
            : confirmingReject
              ? "Sí, rechazar"
              : pair.pair_count > 1
                ? `Rechazar (${pair.pair_count} pares)`
                : "Rechazar"}
        </button>
        <button
          type="button"
          data-testid="dedup-confirm"
          className="dedup-action-btn"
          disabled={busy !== null || confirmingReject}
          onClick={runConfirm}
          style={{
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: busy !== null || confirmingReject ? "default" : "pointer",
            border: "1px solid var(--up)",
            background: "var(--up)",
            color: "var(--bg)",
            opacity: busy !== null || confirmingReject ? 0.6 : 1,
          }}
        >
          {busy === "confirm" ? "Confirmando…" : "Confirmar fusión"}
        </button>
      </div>
    </div>
  );
}
