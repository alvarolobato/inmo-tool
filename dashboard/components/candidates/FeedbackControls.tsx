"use client";

import { useEffect, useState } from "react";
import type { StateFeedbackType } from "@/lib/db/feedback";

interface FeedbackResponse {
  currentState: StateFeedbackType | null;
}

/**
 * Inline accept/reject/star toggle + note input for one candidate (task 3.1,
 * #20). Deliberately rendered as a sibling of CandidateCard's <Link>, not
 * nested inside it — these are buttons a user clicks *instead of* navigating
 * to the property detail page, and relying on stopPropagation to suppress
 * Link navigation from inside an anchor is a common source of subtle bugs
 * (keyboard activation, middle-click) this side-steps entirely.
 *
 * Optimistic UI: the clicked toggle highlights immediately, then reconciles
 * against the server response — issue #1 §2 frames this as a "queue-clearing
 * session", so per-click round-trip latency shouldn't be visible.
 *
 * Fetches its own current state on mount (rather than requiring the
 * candidate list API to embed it) — keeps this task's changes additive
 * (new files only) instead of reshaping lib/candidates.ts's response, at
 * the cost of one extra request per visible card. Fine at today's list
 * sizes; worth batching later if it becomes a real cost.
 */
export function FeedbackControls({
  profileId,
  propertyId,
}: {
  profileId: number;
  propertyId: number;
}) {
  const [state, setState] = useState<StateFeedbackType | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/profiles/${profileId}/candidates/${propertyId}/feedback`)
      .then((res) => (res.ok ? (res.json() as Promise<FeedbackResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setState(body.currentState);
      })
      .catch(() => {
        /* best-effort — leave the toggles unselected rather than erroring on load */
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, propertyId]);

  const submit = async (feedbackType: StateFeedbackType | "note") => {
    setError(null);
    const previous = state;
    // Re-clicking the already-active state is a real no-op server-side (no
    // dedicated "clear" event type in the schema) — don't optimistically
    // toggle it off locally either, since that used to show a deselect that
    // immediately snapped back to selected once the (unchanged) server
    // response arrived. Clicking a *different* state still updates instantly.
    if (feedbackType !== "note" && feedbackType !== previous) {
      setState(feedbackType);
    }
    try {
      const res = await fetch(`/api/profiles/${profileId}/candidates/${propertyId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          feedbackType === "note" ? { feedbackType: "note", note: noteText.trim() } : { feedbackType },
        ),
      });
      if (!res.ok) {
        setState(previous);
        setError("No se pudo guardar el feedback.");
        return;
      }
      const body: FeedbackResponse = await res.json();
      if (feedbackType !== "note") {
        setState(body.currentState);
      } else {
        setNoteStatus("saved");
        setNoteText("");
        setTimeout(() => setNoteStatus("idle"), 2000);
      }
    } catch {
      if (feedbackType !== "note") setState(previous);
      setError("No se pudo guardar el feedback.");
    }
  };

  const toggleButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--accent-fg, #fff)" : "var(--fg-muted)",
  });

  return (
    <div
      // Stops a click from bubbling into an ancestor <Link> if this
      // component is ever nested inside one in the future — defense in
      // depth on top of the sibling-not-child layout described above.
      onClick={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 14px 12px" }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          data-testid="feedback-accept"
          aria-pressed={state === "accept"}
          style={toggleButtonStyle(state === "accept")}
          onClick={() => submit("accept")}
        >
          ✓ Aceptar
        </button>
        <button
          type="button"
          data-testid="feedback-reject"
          aria-pressed={state === "reject"}
          style={toggleButtonStyle(state === "reject")}
          onClick={() => submit("reject")}
        >
          ✗ Rechazar
        </button>
        <button
          type="button"
          data-testid="feedback-star"
          aria-pressed={state === "star"}
          style={toggleButtonStyle(state === "star")}
          onClick={() => submit("star")}
        >
          ★ Destacar
        </button>
        <button
          type="button"
          data-testid="feedback-note-toggle"
          style={{ ...toggleButtonStyle(false), marginLeft: "auto" }}
          onClick={() => setNoteOpen((v) => !v)}
        >
          {noteOpen ? "Cerrar nota" : "+ Nota"}
        </button>
      </div>

      {noteOpen && (
        <div style={{ display: "flex", gap: 6 }}>
          <textarea
            data-testid="feedback-note-input"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Añade una nota…"
            rows={2}
            style={{
              flex: 1,
              fontSize: 13,
              padding: 6,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-1)",
              color: "var(--fg)",
              resize: "vertical",
            }}
          />
          <button
            type="button"
            data-testid="feedback-note-submit"
            disabled={noteText.trim().length === 0 || noteStatus === "saving"}
            onClick={() => submit("note")}
            style={{
              ...toggleButtonStyle(false),
              opacity: noteText.trim().length === 0 ? 0.5 : 1,
              alignSelf: "flex-start",
            }}
          >
            {noteStatus === "saved" ? "Guardada ✓" : "Guardar"}
          </button>
        </div>
      )}

      {error && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--danger, #d33)" }}>{error}</p>
      )}
    </div>
  );
}
