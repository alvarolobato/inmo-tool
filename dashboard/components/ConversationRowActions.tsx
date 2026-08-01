"use client";

import { useRouter } from "next/navigation";
import type { ConversationRow } from "@/app/conversations/types";

interface ConversationRowActionsProps {
  conversation: ConversationRow;
}

export function ConversationRowActions({
  conversation,
}: ConversationRowActionsProps) {
  const router = useRouter();
  const isGlobal = conversation.context_kind === "global";

  const btnStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--fg-muted)",
    padding: "4px 6px",
    borderRadius: 4,
    fontSize: 14,
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };

  const disabledStyle: React.CSSProperties = {
    ...btnStyle,
    cursor: "not-allowed",
    opacity: 0.4,
  };

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 2 }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Continuar */}
      <button
        type="button"
        title="Continuar conversación"
        style={btnStyle}
        onClick={() => router.push(`/c/${conversation.id}`)}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg-muted)")
        }
        aria-label="Continuar"
      >
        👁
      </button>

      {/* Abrir en contexto */}
      {isGlobal ? (
        <button
          type="button"
          title="Sin contexto nativo para esta conversación"
          style={disabledStyle}
          disabled
          aria-label="Abrir en contexto (no disponible)"
        >
          ⊞
        </button>
      ) : (
        <button
          type="button"
          title="Abrir en contexto"
          style={btnStyle}
          onClick={() => router.push(`/k/${conversation.id}`)}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg-muted)")
          }
          aria-label="Abrir en contexto"
        >
          ⊞
        </button>
      )}
    </div>
  );
}
