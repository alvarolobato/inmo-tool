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

  // #573 (repo-wide tap-target convention, see #656): these were 22×26px —
  // well under the 44px floor — an icon-only button doesn't get a pass just
  // because it's visually small.
  //
  // The 44px floor is applied PHONE-ONLY, per D-121: `min-width`/
  // `min-height` are static literals with no prop/state dependency, so
  // they live on `.conv-row-action-btn` in globals.css behind
  // `@media (max-width: 767px)` and are absent from this inline style
  // object entirely (rung 1 — no specificity fight to lose, no
  // `!important`). Applying them unconditionally, as the first revision of
  // this fix did, cost desktop real density: measured at 1440px, the row
  // grew 46 -> 61px (+33%) and the Acciones column 90 -> 116px, on a
  // pointer device that never needed a 44px target. Same ladder as
  // `.profile-enter-btn` / `.profile-novedades-link` (#572, #656).
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
    justifyContent: "center",
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
        className="conv-row-action-btn"
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
          className="conv-row-action-btn"
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
          className="conv-row-action-btn"
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
