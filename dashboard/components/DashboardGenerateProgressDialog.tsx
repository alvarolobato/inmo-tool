"use client";

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InteractionLine } from "@/lib/db-write";
import { interactionLineClass } from "@/lib/interaction-line-class";

// ─── Line rendering ─────────────────────────────────────────────────────────

/**
 * Infer a line `kind` from its raw text when no explicit kind is provided.
 * Exported so callers can set kind when constructing ProgressLine objects,
 * preserving tool-call / tool-result / error styling.
 */
export function inferKind(text: string): InteractionLine["kind"] {
  const t = text.trim();
  if (t.startsWith("  →") || t.startsWith("→") || t.includes("Herramientas solicitadas")) {
    return "tool_call";
  }
  // ✓ = success tool result; ✗ = failed tool result → render as error
  if (t.startsWith("  ✓") || t.startsWith("✓")) {
    return "tool_result";
  }
  if (t.startsWith("  ✗") || t.startsWith("✗") || t.toLowerCase().startsWith("error")) {
    return "error";
  }
  return "meta";
}

// ─── Component types ─────────────────────────────────────────────────────────

/** A typed line with optional kind + text + body. Accepts plain string or typed object. */
export interface ProgressLine {
  kind?: InteractionLine["kind"];
  text: string;
  /** Optional expanded body text (e.g. model reasoning/thinking content). */
  body?: string;
}

export interface DashboardGenerateProgressDialogProps {
  open: boolean;
  title: string;
  requestId: string | null;
  /** Accept either raw string lines (legacy) or typed ProgressLine objects. */
  lines: string[] | ProgressLine[];
  phase: "running" | "error" | "success";
  errorSummary?: ReactNode | null;
  /** The full user prompt — shown collapsed at the top. */
  fullPrompt?: string;
  /** URL of the conversation created for this generation (/c/:id). */
  conversationUrl?: string;
  onDismiss: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DashboardGenerateProgressDialog({
  open,
  title,
  requestId,
  lines,
  phase,
  errorSummary = null,
  fullPrompt,
  conversationUrl,
  onDismiss,
}: DashboardGenerateProgressDialogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  // Reset expand state whenever the dialog opens so the prompt starts collapsed.
  useEffect(() => {
    if (open) {
      setPromptExpanded(false);
    }
  }, [open]);

  // Normalise lines so we always have ProgressLine[] — done before effects
  // so lastLine is available for the auto-scroll dependency.
  const normalised: ProgressLine[] = (lines as (string | ProgressLine)[]).map((l) =>
    typeof l === "string" ? { kind: inferKind(l), text: l } : l,
  );

  // Auto-scroll to bottom on each new line or coalesced update, unless the
  // user has scrolled up manually. The dependency on the last line's text and
  // body ensures coalescing (same array length, content replaced) also
  // triggers the scroll.
  const lastLine = normalised[normalised.length - 1];
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length, lastLine?.text, lastLine?.body]);

  // Reset userScrolled when dialog opens.
  useEffect(() => {
    if (open) {
      userScrolledRef.current = false;
    }
  }, [open]);

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    userScrolledRef.current = !atBottom;
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (phase !== "running") {
          onDismiss();
        }
      }}
      className="relative z-50"
    >
      <DialogBackdrop className="fixed inset-0 bg-black/40 backdrop-blur-[1px]" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          className="flex flex-col rounded-xl border border-tremor-border bg-tremor-background shadow-xl dark:border-dark-tremor-border dark:bg-dark-tremor-background"
          style={{ width: "min(64rem, 95vw)", height: "min(42rem, 85vh)" }}
        >
          {/* Header */}
          <div className="flex-none px-5 pt-5 pb-2">
            <div className="flex items-start justify-between gap-3">
              <DialogTitle className="text-lg font-semibold text-tremor-content-strong dark:text-dark-tremor-content-strong">
                {title}
              </DialogTitle>
              {conversationUrl && (
                <a
                  href={conversationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-tremor-brand dark:text-dark-tremor-brand hover:underline mt-1"
                >
                  Ver conversación →
                </a>
              )}
            </div>
            {requestId ? (
              <p className="mt-1 font-mono text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                ID: {requestId}
              </p>
            ) : null}
            {/* Expandable full prompt */}
            {fullPrompt && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setPromptExpanded((v) => !v)}
                  className="flex items-center gap-1 text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle hover:text-tremor-content dark:hover:text-dark-tremor-content"
                  aria-expanded={promptExpanded}
                >
                  <span
                    style={{ display: "inline-block", transition: "transform 150ms", transform: promptExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                    aria-hidden="true"
                  >
                    ▶
                  </span>
                  Prompt completo
                </button>
                {promptExpanded && (
                  <pre
                    className="mt-1 rounded border border-tremor-border dark:border-dark-tremor-border bg-tremor-background-muted/80 dark:bg-dark-tremor-background-muted/50 p-2 text-xs text-tremor-content dark:text-dark-tremor-content overflow-auto max-h-40"
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-jetbrains, monospace)" }}
                  >
                    {fullPrompt}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Log panel — fills remaining space, scrolls independently */}
          <div
            ref={logRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto mx-5 rounded-lg border border-tremor-border bg-tremor-background-muted/80 p-3 text-xs leading-relaxed dark:border-dark-tremor-border dark:bg-dark-tremor-background-muted/50"
            style={{ scrollBehavior: "smooth" }}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            data-testid="progress-log"
          >
            {normalised.length === 0 ? (
              <span className="italic text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Iniciando…
              </span>
            ) : (
              normalised.map((line, i) => (
                <div
                  key={`${i}-${line.text.slice(0, 24)}`}
                  className={`whitespace-pre-wrap break-words ${interactionLineClass(line.kind)}`}
                >
                  {line.text}
                  {line.body && (
                    <pre
                      style={{
                        marginTop: 4,
                        marginLeft: 12,
                        padding: "6px 8px",
                        fontSize: 11,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-jetbrains, monospace)",
                        background: "var(--bg-2, rgba(0,0,0,0.15))",
                        borderRadius: 4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: "var(--fg-muted)",
                        borderLeft: "2px solid var(--border)",
                      }}
                    >
                      {line.body}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex-none px-5 pb-5 pt-3">
            {phase === "error" && errorSummary ? (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100">
                {errorSummary}
              </div>
            ) : null}

            {phase !== "running" ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onDismiss}
                  style={{ borderRadius: 6, background: "var(--accent)", padding: "8px 16px", fontSize: 13, fontWeight: 500, color: "#fff", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                >
                  Cerrar
                </button>
              </div>
            ) : (
              <p className="text-center text-xs text-tremor-content-subtle dark:text-dark-tremor-content-subtle">
                Generando… puedes seguir el progreso arriba. Los mismos pasos se registran en el log
                del servidor.
              </p>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
