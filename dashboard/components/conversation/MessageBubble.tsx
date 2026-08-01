"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import LogBlock from "@/components/LogBlock";
import { ErrorBubble } from "./ErrorBubble";
import type { ChatMessage } from "./types";

// ---------------------------------------------------------------------------
// MessageBubble — renders a single chat message with optional log block
// ---------------------------------------------------------------------------

export function MessageBubble({
  msg,
  isMarkdown = false,
  logExpanded,
  onLogToggle,
}: {
  msg: ChatMessage;
  isMarkdown?: boolean;
  logExpanded?: boolean;
  onLogToggle?: () => void;
}) {
  const isError =
    msg.role === "assistant" &&
    (msg.isError === true || msg.errorDetail !== undefined);
  const isUser = msg.role === "user";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      {/* Log block above AI messages that have logs */}
      {!isUser && msg.logs && msg.logs.length > 0 && (
        <LogBlock
          lines={msg.logs}
          expanded={logExpanded}
          onToggle={onLogToggle}
          streaming={false}
        />
      )}

      {isError ? (
        <div
          style={{
            maxWidth: "86%",
            borderRadius: 10,
            padding: "10px 12px",
            background: "rgba(220,38,38,0.1)",
            border: "1px solid rgba(220,38,38,0.3)",
          }}
        >
          <ErrorBubble message={msg.content} errorDetail={msg.errorDetail} />
        </div>
      ) : (
        <div
          style={{
            maxWidth: "86%",
            background: isUser ? "var(--accent)" : "var(--bg-2)",
            color: isUser ? "#fff" : "var(--fg)",
            padding: "10px 12px",
            borderRadius: 10,
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          {isMarkdown && !isUser ? (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-headings:font-semibold">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                allowedElements={[
                  "p",
                  "br",
                  "strong",
                  "em",
                  "ul",
                  "ol",
                  "li",
                  "code",
                  "pre",
                  "blockquote",
                  "a",
                  "h1",
                  "h2",
                  "h3",
                  "h4",
                  "h5",
                  "h6",
                  "table",
                  "thead",
                  "tbody",
                  "tr",
                  "th",
                  "td",
                ]}
                components={{
                  a: ({ ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  ),
                }}
              >
                {msg.content}
              </ReactMarkdown>
            </div>
          ) : (
            msg.content
          )}
        </div>
      )}

      {/* "Cambios aplicados" / "Análisis publicado" chip — shown for successful publish-tool responses */}
      {!isUser && !isError && msg.appliedSummary && (
        <div
          data-testid="applied-chip"
          style={{
            fontSize: 10,
            padding: "3px 8px",
            borderRadius: 10,
            background: "rgba(var(--accent-rgb,99,102,241),0.12)",
            border: "1px solid rgba(var(--accent-rgb,99,102,241),0.25)",
            color: "var(--accent)",
            maxWidth: "86%",
          }}
        >
          ✓ {msg.appliedChipLabel ?? "Cambios aplicados"}
        </div>
      )}
    </div>
  );
}
