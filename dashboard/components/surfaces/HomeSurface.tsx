"use client";

/**
 * HomeSurface — renders /inicio with an optional conversation side drawer.
 *
 * Stub implementation for the /k/<id> viewer when context_kind='home'.
 * Full implementation (drawer integration) is a follow-up task.
 */

import type { ConversationWithMessages } from "@/lib/conversation-types";

export interface HomeSurfaceProps {
  preloadedConversation?: ConversationWithMessages | null;
  contextUrl?: string | null;
}

export default function HomeSurface({ contextUrl }: HomeSurfaceProps) {
  // Only allow relative paths to prevent open-redirect from a crafted context_url.
  const safeHref = contextUrl && contextUrl.startsWith("/") ? contextUrl : null;
  return (
    <div>
      {safeHref && (
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
            href={safeHref}
            style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
            data-testid="ver-solo-panel"
          >
            Ver solo el panel →
          </a>
        </div>
      )}
      <iframe
        src="/inicio"
        style={{ width: "100%", height: "calc(100vh - 100px)", border: "none" }}
        title="Inicio"
      />
    </div>
  );
}
