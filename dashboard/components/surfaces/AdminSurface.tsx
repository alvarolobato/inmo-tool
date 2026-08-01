"use client";

/**
 * AdminSurface — renders an admin page with an optional conversation side drawer.
 *
 * Stub implementation for the /k/<id> viewer when context_kind='admin'.
 * Full implementation (drawer integration) is a follow-up task.
 */

import type { ConversationWithMessages } from "@/lib/conversation-types";

export interface AdminSurfaceProps {
  preloadedConversation?: ConversationWithMessages | null;
  contextUrl?: string | null;
}

export default function AdminSurface({ contextUrl }: AdminSurfaceProps) {
  // Only allow relative paths to prevent loading arbitrary external URLs in the iframe.
  const safeSrc = contextUrl && contextUrl.startsWith("/") ? contextUrl : "/admin";
  return (
    <div>
      {safeSrc !== "/admin" && (
        <div
          style={{
            padding: "6px 20px",
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--fg-muted)" }}>Vista de conversación</span>
          <a
            href={safeSrc}
            style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
            data-testid="ver-solo-panel"
          >
            Ver solo el panel →
          </a>
        </div>
      )}
      <iframe
        src={safeSrc}
        style={{ width: "100%", height: "calc(100vh - 100px)", border: "none" }}
        title="Admin"
      />
    </div>
  );
}
