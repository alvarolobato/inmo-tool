"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NewConversationDialog({ open, onClose }: NewConversationDialogProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Track the element that had focus before the dialog opened so we can restore it on close.
  const previousFocusRef = useRef<Element | null>(null);

  // Reset state on open; save and restore focus around the dialog lifecycle.
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      setPrompt("");
      setError(null);
      setLoading(false);
      // rAF defers focus until after the browser has painted the newly opened dialog.
      const raf = requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
        first?.focus();
      });
      return () => cancelAnimationFrame(raf);
    } else {
      // Restore focus to the previously focused element when dialog closes.
      if (
        previousFocusRef.current instanceof HTMLElement ||
        previousFocusRef.current instanceof SVGElement
      ) {
        previousFocusRef.current.focus();
      }
    }
  }, [open]);

  // Escape to close + focus trap (Tab/Shift+Tab stays inside the dialog).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, loading, onClose]);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    const trimmed = prompt.trim();

    try {
      // Step 1: create conversation
      const createRes = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "chat",
          context_kind: "global",
          ...(trimmed ? { first_user_prompt: trimmed } : {}),
        }),
      });

      if (!createRes.ok) {
        const body = await createRes.json().catch(() => null);
        const msg =
          (body && typeof body.error === "string" ? body.error : null) ??
          `Error ${createRes.status} al crear la conversación`;
        setError(msg);
        setLoading(false);
        return;
      }

      const created: { id: string } = await createRes.json();
      const { id } = created;

      // Step 2: stash the prompt in sessionStorage (same-tab, consumed once on
      // arrival) then navigate. ConversationPane reads and clears the entry.
      if (trimmed) {
        sessionStorage.setItem(`conv-autosend-${id}`, trimmed);
      }
      router.push(`/conversations/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="new-conversation-backdrop"
        onClick={() => { if (!loading) onClose(); }}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 100,
        }}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conv-title"
        data-testid="new-conversation-dialog"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 101,
          background: "var(--bg-2, #1a1a2e)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px 24px 20px",
          width: "min(480px, 95vw)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Title */}
        <h2
          id="new-conv-title"
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 700,
            color: "var(--fg)",
            letterSpacing: "-0.01em",
          }}
        >
          Nueva conversación
        </h2>

        {/* Textarea with accessible label */}
        <label
          htmlFor="new-conv-prompt"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            color: "var(--fg-muted)",
          }}
        >
          Primera pregunta (opcional)
          <textarea
            id="new-conv-prompt"
            data-testid="new-conversation-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Escribe tu primera pregunta o déjalo en blanco…"
            disabled={loading}
            rows={4}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--fg)",
              fontSize: 13,
              padding: "10px 12px",
              resize: "vertical",
              fontFamily: "inherit",
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
              opacity: loading ? 0.6 : 1,
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !loading) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </label>

        {/* Inline error */}
        {error && (
          <div
            role="alert"
            data-testid="new-conversation-error"
            style={{
              background: "rgba(239,68,68,0.12)",
              border: "1px solid rgba(239,68,68,0.35)",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--down, #ef4444)",
            }}
          >
            {error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            data-testid="new-conversation-cancel"
            onClick={onClose}
            disabled={loading}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--fg-muted)",
              fontSize: 13,
              padding: "8px 16px",
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: loading ? 0.5 : 1,
            }}
          >
            Cancelar
          </button>

          <button
            type="button"
            data-testid="new-conversation-submit"
            onClick={handleSubmit}
            disabled={loading}
            style={{
              background: loading ? "var(--border)" : "var(--accent)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {loading && (
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.3)",
                  borderTopColor: "#fff",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            Empezar
          </button>
        </div>
      </div>
    </>
  );
}
