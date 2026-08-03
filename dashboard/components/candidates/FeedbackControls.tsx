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
 *
 * Icon-only buttons sized for the card's photo overlay (#152), with the note
 * editor as a popover instead of an inline expander — an inline textarea
 * would resize the card and reflow the grid around it. Labels move to
 * `aria-label`/`title`, so the controls stay identifiable to screen readers
 * and on hover despite showing only a glyph.
 *
 * This used to also render a non-compact, inline (non-overlay) variant behind
 * a `compact` prop, but CandidateCard is its only call site and always passed
 * `compact` — the alternate branch was dead code, and it had drifted enough
 * to ship a real bug (the star button's compact/non-compact label ternary
 * had been dropped, so it silently always rendered the bare glyph). Deleted
 * per this project's "no dual code paths" default (#152 review) rather than
 * fixed in place, since nothing exercises it.
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
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    borderRadius: 5,
    fontSize: 13,
    lineHeight: 1,
    cursor: "pointer",
    border: active ? "1px solid var(--accent)" : "1px solid rgba(255,255,255,0.25)",
    background: active ? "var(--accent)" : "rgba(0,0,0,0.35)",
    color: active ? "var(--accent-fg, #fff)" : "#fff",
  });

  return (
    <div
      // Stops a click from bubbling into an ancestor <Link> if this
      // component is ever nested inside one in the future — defense in
      // depth on top of the sibling-not-child layout described above.
      onClick={(e) => e.stopPropagation()}
      style={{ position: "relative", display: "flex", gap: 3, padding: 3 }}
    >
      <div style={{ display: "flex", gap: 3 }}>
        <button
          type="button"
          data-testid="feedback-accept"
          aria-pressed={state === "accept"}
          aria-label="Aceptar"
          title="Aceptar"
          style={toggleButtonStyle(state === "accept")}
          onClick={() => submit("accept")}
        >
          ✓
        </button>
        <button
          type="button"
          data-testid="feedback-reject"
          aria-pressed={state === "reject"}
          aria-label="Rechazar"
          title="Rechazar"
          style={toggleButtonStyle(state === "reject")}
          onClick={() => submit("reject")}
        >
          ✗
        </button>
        <button
          type="button"
          data-testid="feedback-star"
          aria-pressed={state === "star"}
          aria-label="Destacar"
          title="Destacar"
          style={toggleButtonStyle(state === "star")}
          onClick={() => submit("star")}
        >
          ★
        </button>
        <button
          type="button"
          data-testid="feedback-note-toggle"
          aria-label={noteOpen ? "Cerrar nota" : "Añadir nota"}
          aria-expanded={noteOpen}
          title={noteOpen ? "Cerrar nota" : "Añadir nota"}
          style={toggleButtonStyle(false)}
          onClick={() => setNoteOpen((v) => !v)}
        >
          ✎
        </button>
      </div>

      {noteOpen && (
        <div
          data-testid="feedback-note-popover"
          style={{
            // Popover rather than an inline expander: growing the card
            // in place would reflow the whole candidate grid (#150).
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 3,
            width: 220,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-1)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <textarea
            data-testid="feedback-note-input"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Añade una nota…"
            rows={3}
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
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--fg-muted)",
              opacity: noteText.trim().length === 0 ? 0.5 : 1,
              alignSelf: "flex-end",
            }}
          >
            {noteStatus === "saved" ? "Guardada ✓" : "Guardar"}
          </button>
        </div>
      )}

      {error && (
        // The bare "!" this used to render put the actual message only in
        // `title`, which a touch user has no way to reach (no hover) — the
        // message is now real, visible text (#152 review). Positioned like
        // the note popover so it doesn't reflow the card/grid, and kept
        // small enough to fit the photo-overlay context it lives in.
        <div
          role="alert"
          data-testid="feedback-error"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 3,
            maxWidth: 200,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--danger, #d33)",
            background: "var(--bg-1)",
            fontSize: 11,
            lineHeight: 1.3,
            color: "var(--danger, #ff9b9b)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
