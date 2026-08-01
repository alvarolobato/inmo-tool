"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ConversationWithMessages,
  ConversationMessage,
  AssistantMessageContent,
} from "@/lib/conversation-types";
import {
  isAssistantContent,
  isToolResultContent,
  getMessageText,
} from "@/lib/conversation-types";
import { InitialContextPanel } from "@/components/InitialContextPanel";
import { InlineToolCall } from "@/components/InlineToolCall";
import { RoundDivider } from "@/components/RoundDivider";
import AgenticErrorDetails from "@/components/AgenticErrorDetails";
import type { AgenticErrorDiagnostic } from "@/lib/errors";
import { generateRequestId } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Round detection
// ---------------------------------------------------------------------------

interface RoundedMessage {
  msg: ConversationMessage;
  roundStart?: number;
}

function annotateRounds(messages: ConversationMessage[]): RoundedMessage[] {
  const result: RoundedMessage[] = [];
  let round = 1;
  let hasToolCallsInRound = false;

  for (const msg of messages) {
    let insertDivider: number | undefined;

    if (msg.role === "assistant") {
      const ac = isAssistantContent(msg.content) ? msg.content : null;
      const hasTools = ac?.tool_calls && ac.tool_calls.length > 0;

      if (hasTools) {
        if (round > 1 || hasToolCallsInRound) {
          insertDivider = round;
        }
        hasToolCallsInRound = true;
        round++;
      } else if (hasToolCallsInRound) {
        hasToolCallsInRound = false;
      }
    }

    result.push({ msg, roundStart: insertDivider });
  }

  return result;
}

// ---------------------------------------------------------------------------
// UserBubble
// ---------------------------------------------------------------------------

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
      <div
        style={{
          maxWidth: "85%",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent)",
          borderRadius: "12px 12px 2px 12px",
          padding: "8px 12px",
          fontSize: 13,
          color: "var(--fg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
        data-testid="user-bubble"
      >
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssistantBubble
// ---------------------------------------------------------------------------

function AssistantBubble({ content }: { content: AssistantMessageContent }) {
  const text = content.text ?? "";
  const hasError = content.is_error || !!content.error_detail;
  const [detailsOpen, setDetailsOpen] = useState(false);

  const errorStyle: React.CSSProperties = hasError
    ? { borderLeft: "3px solid var(--down)", borderRadius: "2px 12px 12px 2px" }
    : { borderRadius: "12px 12px 12px 2px" };

  const errorResponse = hasError
    ? {
        error: text || "Error en la respuesta del asistente",
        code: "AGENTIC_RUNNER" as const,
        details: undefined,
        timestamp: new Date().toISOString(),
        requestId: generateRequestId(),
        diagnostic: content.error_detail as AgenticErrorDiagnostic | undefined,
      }
    : null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          maxWidth: "85%",
          background: hasError
            ? "color-mix(in srgb, var(--down) 8%, var(--bg-1))"
            : "var(--bg-1)",
          border: `1px solid ${hasError ? "var(--down)" : "var(--border)"}`,
          padding: "8px 12px",
          fontSize: 13,
          color: "var(--fg)",
          ...errorStyle,
        }}
        data-testid="assistant-bubble"
      >
        {hasError && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: text ? 6 : 0,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--down)",
                fontFamily: "var(--font-jetbrains, monospace)",
              }}
            >
              {content.error_detail
                ? `Error: ${(content.error_detail as AgenticErrorDiagnostic & { subError?: string }).subError?.split(":")[0] ?? "AGENTIC_RUNNER"}`
                : "Error"}
            </span>
            <button
              onClick={() => setDetailsOpen((o) => !o)}
              style={{
                fontSize: 11,
                color: "var(--down)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                fontFamily: "inherit",
                textDecoration: "underline",
              }}
            >
              {detailsOpen ? "Ocultar detalles" : "Ver detalles"}
            </button>
          </div>
        )}
        {text && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
        {hasError && detailsOpen && errorResponse && (
          <div style={{ marginTop: 8 }}>
            <AgenticErrorDetails errorDetail={errorResponse} skipHeader />
          </div>
        )}
      </div>

      {content.tool_calls && content.tool_calls.length > 0 && (
        <div style={{ marginTop: 4, paddingLeft: 8 }}>
          {content.tool_calls.map((call) => (
            <InlineToolCall key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolResultCard
// ---------------------------------------------------------------------------

function ToolResultCard({
  name,
  content,
}: {
  name: string;
  content: unknown;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        marginBottom: 6,
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 12,
        overflow: "hidden",
      }}
      data-testid="tool-result-card"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 10px",
          background: "var(--bg-1)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "var(--font-jetbrains, monospace)",
          fontSize: 11,
          color: "var(--fg-muted)",
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        Resultado: {name}
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--font-jetbrains, monospace)",
            color: "var(--fg)",
            background: "var(--bg-0, var(--bg))",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
          }}
        >
          {JSON.stringify(content, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConversationThread — renders InitialContextPanel + messages + optional footer
// ---------------------------------------------------------------------------

interface ConversationThreadProps {
  conversation: ConversationWithMessages;
  /** Optional footer rendered after the message list (e.g. an input area). */
  footer?: React.ReactNode;
}

export function ConversationThread({
  conversation,
  footer,
}: ConversationThreadProps) {
  const annotated = annotateRounds(conversation.messages);

  return (
    <>
      {conversation.initial_context && (
        <InitialContextPanel context={conversation.initial_context} />
      )}

      {annotated.map(({ msg, roundStart }) => (
        <div key={msg.id}>
          {roundStart !== undefined && <RoundDivider round={roundStart} />}

          {msg.role === "user" && (
            <UserBubble text={getMessageText(msg.content)} />
          )}

          {msg.role === "assistant" &&
            (() => {
              const ac = isAssistantContent(msg.content)
                ? msg.content
                : { text: getMessageText(msg.content) };
              return <AssistantBubble content={ac} />;
            })()}

          {msg.role === "tool" && isToolResultContent(msg.content) && (
            <ToolResultCard
              name={msg.content.tool_name}
              content={msg.content.content}
            />
          )}
        </div>
      ))}

      {conversation.messages.length === 0 && (
        <p
          style={{
            fontSize: 13,
            color: "var(--fg-muted)",
            textAlign: "center",
            marginTop: 40,
          }}
        >
          No hay mensajes en esta conversación.
        </p>
      )}

      {footer}
    </>
  );
}
