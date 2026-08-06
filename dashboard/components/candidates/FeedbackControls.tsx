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
 * State source: when the parent passes `initialState` (the candidate feed now
 * embeds each row's verdict, #379), this component trusts it and skips the
 * mount GET — one fewer request per card and no flash of the wrong mark. When
 * the prop is omitted it self-fetches its current state on mount (the original
 * behaviour). Clicking the already-active toggle un-marks it (records a
 * `clear`), which is how the show-rejected view un-rejects a property.
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
 *
 * #167: whichever accept/reject/star button matches `state` must stay
 * visible even when the card isn't hovered/focused, so a marked property
 * reads as marked while scanning the list — but "visible" alone isn't a
 * strong enough signal, for two reasons this component handles directly
 * rather than deferring to CSS visibility alone:
 *
 *   - On touch, `@media (hover: none)` already makes *every* button in this
 *     row permanently visible (globals.css) — so "is it visible" carries no
 *     information there at all. The active button needs a treatment that
 *     doesn't depend on visibility: it gets a solid, semantically-coloured
 *     fill (`--up` green for accept, `--down` red for reject, `--warn` amber
 *     for star — the same tokens the rest of the app already uses for
 *     positive/negative/attention state) instead of the muted translucent
 *     `rgba(0,0,0,0.35)` every other (inactive, hover-revealed) button gets.
 *     That contrast holds regardless of hover/touch/visibility state, so it
 *     reads as *this property's status*, not as "a button someone is
 *     pointing at".
 *   - Visibility itself is per-button (`.feedback-toggle[data-active="true"]`
 *     in globals.css), not on the shared `.candidate-card-actions` wrapper —
 *     an ancestor's `opacity: 0` would zero out every descendant regardless
 *     of a child's own opacity, so the always-visible exception has to live
 *     on the button, not the row.
 *
 * `getCurrentState` (lib/db/feedback.ts) already collapses accept/reject/star
 * into one mutually-exclusive derived state — "starring a previously-accepted
 * candidate replaces 'accepted' with 'starred'" — so there is never a
 * property with two of these three simultaneously active; the "which one
 * wins" ambiguity #167 flagged as a possible design question doesn't actually
 * arise given how `state` is derived here.
 */
export function FeedbackControls({
  profileId,
  propertyId,
  initialState,
  onStateChange,
}: {
  profileId: number;
  propertyId: number;
  /**
   * #379: the verdict already known from the candidate feed row. When
   * provided (including `null`), this component trusts it and skips the
   * per-card GET on mount — the list already told us the state. Omit it and
   * the component self-fetches (its original behaviour, still used anywhere
   * that renders it without a server-provided state).
   */
  initialState?: StateFeedbackType | null;
  /**
   * #379: called whenever the derived state changes (optimistically and after
   * the server confirms), so a parent (CandidateCard) can drive the
   * "Descartada" treatment and keep a rejected card visible-but-marked until
   * the next fetch rather than removing it.
   */
  onStateChange?: (state: StateFeedbackType | null) => void;
}) {
  const [state, setState] = useState<StateFeedbackType | null>(initialState ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Whether the parent handed us the state (even `null`). Distinguishing
  // "prop omitted" from "prop is null" is what lets a server-known neutral
  // state skip the GET too, not just an accept/reject/star one.
  const hasInitialState = initialState !== undefined;

  useEffect(() => {
    // Skip the self-fetch when the list already provided the state (#379) —
    // saves one request per card and avoids a flash of the wrong mark.
    if (hasInitialState) return;
    let cancelled = false;
    fetch(`/api/profiles/${profileId}/candidates/${propertyId}/feedback`)
      .then((res) => (res.ok ? (res.json() as Promise<FeedbackResponse>) : null))
      .then((body) => {
        if (!cancelled && body) {
          setState(body.currentState);
          onStateChange?.(body.currentState);
        }
      })
      .catch(() => {
        /* best-effort — leave the toggles unselected rather than erroring on load */
      });
    return () => {
      cancelled = true;
    };
    // onStateChange intentionally omitted: parents pass a stable setter and we
    // don't want an inline arrow to re-run the fetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, propertyId, hasInitialState]);

  const applyState = (next: StateFeedbackType | null) => {
    setState(next);
    onStateChange?.(next);
  };

  const submitState = async (clicked: StateFeedbackType) => {
    setError(null);
    const previous = state;
    // #379: clicking the already-active toggle now UN-marks it (records a
    // `clear` event) rather than being an inert no-op — this is how the
    // show-rejected view un-rejects a property. Clicking a different state
    // switches to it. Both update optimistically, then reconcile against the
    // server's derived state.
    const clearing = clicked === previous;
    const target: StateFeedbackType | null = clearing ? null : clicked;
    const wireType = clearing ? "clear" : clicked;
    applyState(target);
    try {
      const res = await fetch(`/api/profiles/${profileId}/candidates/${propertyId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackType: wireType }),
      });
      if (!res.ok) {
        applyState(previous);
        setError("No se pudo guardar el feedback.");
        return;
      }
      const body: FeedbackResponse = await res.json();
      applyState(body.currentState);
    } catch {
      applyState(previous);
      setError("No se pudo guardar el feedback.");
    }
  };

  const submitNote = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/candidates/${propertyId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackType: "note", note: noteText.trim() }),
      });
      if (!res.ok) {
        setError("No se pudo guardar el feedback.");
        return;
      }
      setNoteStatus("saved");
      setNoteText("");
      setTimeout(() => setNoteStatus("idle"), 2000);
    } catch {
      setError("No se pudo guardar el feedback.");
    }
  };

  // Active fill colour is per-type (#167): reusing the app's existing
  // positive/negative/attention design tokens means the active button reads
  // as "what happened" (accepted vs. rejected vs. starred) at a glance, not
  // just as "the highlighted one" — relevant once it's the only thing
  // visible without hovering.
  const ACTIVE_COLORS: Record<StateFeedbackType, string> = {
    accept: "var(--up)",
    reject: "var(--down)",
    star: "var(--warn)",
  };

  const toggleButtonStyle = (active: boolean, activeColor = "var(--accent)"): React.CSSProperties => ({
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
    border: active ? `1px solid ${activeColor}` : "1px solid rgba(255,255,255,0.25)",
    background: active ? activeColor : "rgba(0,0,0,0.35)",
    // `--bg` (not a fixed hex) deliberately: dark theme's --up/--down/--warn
    // are light pastels chosen to pop against a near-black page, and light
    // theme's are darker/more saturated chosen to pop against a near-white
    // page — in both cases the page's own `--bg` token is the contrasting
    // extreme, so it reads legibly on the active fill in either theme
    // without a second colour decision per token.
    color: active ? "var(--bg)" : "#fff",
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
          className="feedback-toggle"
          data-active={state === "accept"}
          aria-pressed={state === "accept"}
          aria-label="Aceptar"
          title="Aceptar"
          style={toggleButtonStyle(state === "accept", ACTIVE_COLORS.accept)}
          onClick={() => submitState("accept")}
        >
          ✓
        </button>
        <button
          type="button"
          data-testid="feedback-reject"
          className="feedback-toggle"
          data-active={state === "reject"}
          aria-pressed={state === "reject"}
          aria-label="Rechazar"
          title="Rechazar"
          style={toggleButtonStyle(state === "reject", ACTIVE_COLORS.reject)}
          onClick={() => submitState("reject")}
        >
          ✗
        </button>
        <button
          type="button"
          data-testid="feedback-star"
          className="feedback-toggle"
          data-active={state === "star"}
          aria-pressed={state === "star"}
          aria-label="Destacar"
          title="Destacar"
          style={toggleButtonStyle(state === "star", ACTIVE_COLORS.star)}
          onClick={() => submitState("star")}
        >
          ★
        </button>
        <button
          type="button"
          data-testid="feedback-note-toggle"
          className="feedback-toggle"
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
            onClick={() => submitNote()}
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
