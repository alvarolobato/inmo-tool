"use client";

import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./types";

// ---------------------------------------------------------------------------
// MessageList — renders an array of ChatMessage with MessageBubble
// ---------------------------------------------------------------------------

interface MessageListProps {
  messages: ChatMessage[];
  /** Track which message indices have their log block expanded. */
  expandedLogs?: Record<number, boolean>;
  /** Called when a log toggle button is clicked, with the message index. */
  onLogToggle?: (index: number) => void;
  /** When true, all non-user messages are rendered as Markdown. */
  isMarkdown?: boolean;
}

export function MessageList({
  messages,
  expandedLogs = {},
  onLogToggle,
  isMarkdown = false,
}: MessageListProps) {
  return (
    <>
      {messages.map((msg, idx) => (
        <MessageBubble
          key={idx}
          msg={msg}
          isMarkdown={isMarkdown}
          logExpanded={expandedLogs[idx] ?? false}
          onLogToggle={onLogToggle ? () => onLogToggle(idx) : undefined}
        />
      ))}
    </>
  );
}
