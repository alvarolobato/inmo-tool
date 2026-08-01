"use client";

import { useState, useCallback, useEffect, type ReactNode } from "react";
import type { InitialContext } from "@/lib/conversation-types";

interface InitialContextPanelProps {
  /** Eager context (already loaded). Use this OR `load`, not both. */
  context?: InitialContext;
  /**
   * Lazy loader. When provided (and no eager `context`), the panel fetches the
   * context the first time it is expanded — the heavy context log lives in a file
   * on the data volume and is only loaded on demand.
   */
  load?: () => Promise<InitialContext | null>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }, [text]);
  return (
    <button
      onClick={copy}
      style={{
        fontSize: 11,
        color: "var(--accent)",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
        fontFamily: "inherit",
      }}
    >
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </span>
      <div style={{ color: "var(--fg)", fontSize: 12 }}>{children}</div>
    </div>
  );
}

function smartUnescape(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* not valid JSON as-is */ }
    // Fallback: system prompts delivered as JSON-in-JSON may have \" escaped quotes.
    try {
      return JSON.stringify(JSON.parse(trimmed.replace(/\\"/g, '"')), null, 2);
    } catch { /* not valid JSON after unescaping either */ }
  }
  return text;
}

function PromptBlock({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--fg-muted)",
          }}
        >
          {label}
        </span>
        <CopyButton text={smartUnescape(text)} />
      </div>
      <pre
        style={{
          margin: 0,
          fontSize: 11,
          fontFamily: "var(--font-jetbrains, monospace)",
          color: "var(--fg)",
          background: "var(--bg-1)",
          borderRadius: 4,
          padding: "8px 10px",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid var(--border)",
        }}
      >
        {smartUnescape(text)}
      </pre>
    </div>
  );
}

function CollapsibleSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "4px 0",
          textAlign: "left",
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 9 }}>{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

interface ToolEntryProps {
  name: string;
  schema: Record<string, unknown>;
}

function ToolEntry({ name, schema }: ToolEntryProps) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 8px",
          background: "var(--bg-1)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg)",
        }}
        aria-expanded={open}
      >
        <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        {name}
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            fontSize: 11,
            fontFamily: "var(--font-jetbrains, monospace)",
            color: "var(--fg)",
            background: "var(--bg-0, var(--bg))",
            padding: "6px 8px",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
          }}
        >
          {JSON.stringify(schema, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ContextBody({ context }: { context: InitialContext }) {
  const providerLabel =
    context.provider === "cli"
      ? `Claude CLI (${context.driver ?? "claude_code"})`
      : "OpenRouter";

  return (
    <div
      style={{
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* Modelo y proveedor */}
      <FieldRow label="Modelo y proveedor">
        <span>
          {context.model} via {providerLabel}
        </span>
      </FieldRow>

      {/* Prior messages in context */}
      {context.prior_messages !== undefined && (
        <FieldRow label="Mensajes previos en contexto">
          <span>{context.prior_messages} mensaje{context.prior_messages !== 1 ? "s" : ""}</span>
        </FieldRow>
      )}

      {/* Conversation history preview */}
      {context.prior_messages_history && context.prior_messages_history.length > 0 && (
        <CollapsibleSection
          label={`Historial de la conversación (${context.prior_messages_history.length} mensajes)`}
        >
          <div
            data-testid="history-preview"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            {context.prior_messages_history.map((msg, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-jetbrains, monospace)",
                  padding: "4px 6px",
                  background: "var(--bg-1)",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <span style={{ color: "var(--fg-muted)", fontWeight: 600 }}>
                  {msg.role}:{" "}
                </span>
                <span style={{ color: "var(--fg)" }}>{msg.content}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Prompt inicial */}
      {context.seed_prompt && (
        <FieldRow label="Prompt inicial del usuario">
          <span
            style={{
              fontFamily: "var(--font-jetbrains, monospace)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {context.seed_prompt}
          </span>
        </FieldRow>
      )}

      {/* System prompts */}
      {context.system_prompt_stable && (
        <PromptBlock label="System prompt — Estable (cacheado)" text={context.system_prompt_stable} />
      )}
      {context.system_prompt_volatile && (
        <PromptBlock label="System prompt — Volátil" text={context.system_prompt_volatile} />
      )}

      {/* Tools */}
      {context.tools && context.tools.length > 0 && (
        <div>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--fg-muted)",
            }}
          >
            Herramientas disponibles ({context.tools.length})
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {context.tools.map((tool) => (
              <ToolEntry key={tool.name} name={tool.name} schema={tool.schema} />
            ))}
          </div>
        </div>
      )}

      {/* Config — only show readable fields, not raw dashboard spec JSON */}
      {context.config && Object.keys(context.config).length > 0 && (
        <FieldRow label="Configuración">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {Object.entries(context.config)
              .filter(([, v]) => typeof v !== "string" || v.length < 200)
              .map(([k, v]) => (
                <span key={k} style={{ fontSize: 11, fontFamily: "var(--font-jetbrains, monospace)" }}>
                  <span style={{ color: "var(--fg-muted)" }}>{k}: </span>
                  <span style={{ color: "var(--fg)" }}>
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </span>
                </span>
              ))}
          </div>
        </FieldRow>
      )}
    </div>
  );
}

function StatusRow({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderTop: "1px solid var(--border)",
        fontSize: 12,
        color: "var(--fg-muted)",
      }}
    >
      {text}
    </div>
  );
}

export function InitialContextPanel({ context, load }: InitialContextPanelProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<InitialContext | null>(context ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (open && !loaded && !loading && load) {
      setLoading(true);
      setError(null);
      load()
        .then((c) => {
          if (c) setLoaded(c);
          else setError("No hay contexto disponible para este turno.");
        })
        .catch(() => setError("No se pudo cargar el contexto."))
        .finally(() => setLoading(false));
    }
  }, [open, loaded, loading, load]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 12,
      }}
    >
      {/* Toggle row */}
      <button
        onClick={handleToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 14px",
          background: "var(--bg-1)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--fg-muted)",
          fontFamily: "inherit",
        }}
        aria-expanded={open}
        data-testid="initial-context-toggle"
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        Contexto original
      </button>

      {open && loading && <StatusRow text="Cargando contexto…" />}
      {open && !loading && error && <StatusRow text={error} />}
      {open && loaded && <ContextBody context={loaded} />}
    </div>
  );
}
