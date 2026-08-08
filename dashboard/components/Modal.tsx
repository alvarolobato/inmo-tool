"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog title, rendered as the panel heading. */
  title: string;
  children: ReactNode;
  /** Disables backdrop-click / Escape close while a submit is in flight. */
  busy?: boolean;
  /** Test id for the panel (backdrop gets `${testId}-backdrop`). */
  testId?: string;
  /** Max panel width; defaults to a comfortable form width. */
  maxWidth?: number;
}

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Generic accessible modal dialog (issue #446).
 *
 * Extracted from the NewConversationDialog pattern so any surface that needs a
 * focus-managed popup can reuse it. Handles: backdrop, centered panel with
 * role="dialog"/aria-modal, save+restore focus, autofocus of the first field on
 * open, Escape-to-close, and a Tab/Shift+Tab focus trap. The body scrolls when
 * its content is taller than the viewport so long forms stay fully reachable.
 *
 * No entrance animation is used, so prefers-reduced-motion needs no special
 * handling here — the dialog simply appears in place (nothing scrolls or moves).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  busy = false,
  testId = "modal",
  maxWidth = 560,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const titleId = `${testId}-title`;

  // Save the trigger's focus, then move focus into the panel on open; restore
  // it to the trigger on close so keyboard users land back where they were.
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      // rAF defers focus until the panel has painted. Prefer the first field in
      // the BODY (the form's first input — issue #446 wants focus on the first
      // field, not the header's close button); fall back to the whole panel.
      const raf = requestAnimationFrame(() => {
        const first =
          bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTORS) ??
          panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
        first?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    if (
      previousFocusRef.current instanceof HTMLElement ||
      previousFocusRef.current instanceof SVGElement
    ) {
      previousFocusRef.current.focus();
    }
  }, [open]);

  // Escape closes; Tab/Shift+Tab is trapped inside the panel.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid={`${testId}-backdrop`}
        onClick={() => {
          if (!busy) onClose();
        }}
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
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 101,
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "20px 20px 18px",
          width: `min(${maxWidth}px, 95vw)`,
          maxHeight: "90vh",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 700,
              color: "var(--fg)",
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Cerrar"
            data-testid={`${testId}-close`}
            onClick={() => {
              if (!busy) onClose();
            }}
            disabled={busy}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-muted)",
              fontSize: 20,
              lineHeight: 1,
              cursor: busy ? "not-allowed" : "pointer",
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Scrollable body — keeps long forms fully reachable within maxHeight. */}
        <div ref={bodyRef} style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </>
  );
}
