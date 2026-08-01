"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogLine {
  timestamp: string; // e.g. "+0.3s"
  kind: "tool" | "reason" | "done" | "default";
  label: string;
  detail?: string;
  /** Multi-line content rendered below the row (e.g. streaming model text). */
  body?: string;
}

export interface LogBlockProps {
  lines: LogLine[];
  /** true = pending streaming state */
  streaming?: boolean;
  /** controlled expanded state (post-delivery) */
  expanded?: boolean;
  onToggle?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconFor(kind: LogLine["kind"]): string {
  if (kind === "tool") return "⌬";
  if (kind === "reason") return "✦";
  if (kind === "done") return "✓";
  return "·";
}

function colorFor(kind: LogLine["kind"]): string {
  if (kind === "tool") return "var(--accent-2)";
  if (kind === "reason") return "var(--accent)";
  if (kind === "done") return "var(--up)";
  return "var(--fg-subtle)";
}

// ---------------------------------------------------------------------------
// LogLineRow
// ---------------------------------------------------------------------------

function LogLineRow({ line, isLast }: { line: LogLine; isLast: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "42px 14px 1fr",
        gap: 6,
        alignItems: "start",
        lineHeight: 1.45,
      }}
    >
      <span style={{ color: "var(--fg-subtle)" }}>{line.timestamp}</span>
      <span style={{ color: colorFor(line.kind), textAlign: "center" }}>
        {iconFor(line.kind)}
      </span>
      <span>
        <span style={{ color: "var(--fg)" }}>{line.label}</span>
        {line.detail && (
          <span style={{ color: "var(--fg-subtle)" }}> · {line.detail}</span>
        )}
        {isLast && (
          <span
            aria-hidden="true"
            style={{
              marginLeft: 4,
              display: "inline-block",
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--accent)",
              verticalAlign: "middle",
              animation: "pulse-dot 2s ease-in-out infinite",
            }}
          />
        )}
        {line.body && (
          <pre
            style={{
              marginTop: 4,
              padding: "8px 10px",
              borderLeft: "2px solid var(--accent)",
              background: "var(--bg-1)",
              color: "var(--fg)",
              fontFamily: "inherit",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowX: "hidden",
            }}
          >
            {line.body}
          </pre>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogBlock
// ---------------------------------------------------------------------------

export default function LogBlock({
  lines,
  streaming = false,
  expanded: controlledExpanded,
  onToggle,
}: LogBlockProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);

  const isExpanded =
    controlledExpanded !== undefined ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalExpanded((v) => !v);
    }
  };

  const sharedPanelStyle: React.CSSProperties = {
    background: "var(--bg-2)",
    borderRadius: 8,
    padding: "8px 10px",
    fontFamily: "var(--font-jetbrains, 'JetBrains Mono', monospace)",
    fontSize: 10.5,
    color: "var(--fg-muted)",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  };

  // --- Streaming state ---
  if (streaming) {
    return (
      <div
        data-testid="logblock-streaming"
        style={{
          ...sharedPanelStyle,
          border: "1px dashed var(--border-strong)",
          maxWidth: "86%",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: "var(--fg-subtle)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 2,
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
              animation: "pulse-dot 2s ease-in-out infinite",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          Procesando · {lines.length} paso{lines.length !== 1 ? "s" : ""}
        </div>
        {lines.map((ln, i) => (
          <LogLineRow key={i} line={ln} isLast={i === lines.length - 1} />
        ))}
      </div>
    );
  }

  // --- Post-delivery state ---
  return (
    <div
      data-testid="logblock-collapsed"
      style={{ maxWidth: "86%", width: "100%" }}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        style={{
          background: "transparent",
          border: "none",
          padding: "2px 0",
          color: "var(--fg-subtle)",
          fontFamily: "var(--font-jetbrains, 'JetBrains Mono', monospace)",
          fontSize: 10,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            transition: "transform 0.15s",
            display: "inline-block",
            transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▸
        </span>
        {isExpanded ? "Ocultar logs" : `Ver logs (${lines.length})`}
      </button>
      {isExpanded && (
        <div
          data-testid="logblock-lines"
          style={{
            ...sharedPanelStyle,
            border: "1px solid var(--border)",
            marginTop: 4,
          }}
        >
          {lines.map((ln, i) => (
            <LogLineRow key={i} line={ln} isLast={false} />
          ))}
        </div>
      )}
    </div>
  );
}
