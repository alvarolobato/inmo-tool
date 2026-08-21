import Link from "next/link";
import { ConversationListSidebar } from "@/components/ConversationListSidebar";
import { ConversationPane } from "@/components/ConversationPane";

// Must be dynamic: data depends on the conversation ID.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationSplitViewPage({ params }: PageProps) {
  const { id } = await params;

  return (
    <div
      style={{
        display: "flex",
        // The root layout's <main> has .main-content padding: var(--pad)
        // vertical / var(--pad-x) horizontal (D-129) — 20/20 at desktop,
        // 20/12 below 768px (globals.css). Negate it so this page is
        // full-bleed and exactly fills the viewport below the 56px TopBar.
        // #573: this used to hardcode -20/+40, which was correct only at
        // desktop's --pad-x=20 coincidence — on phone --pad-x is 12, so the
        // fixed -20 margin overshot main's actual padding box by 8px on
        // each side. Reading the real tokens keeps this exact at every
        // width instead of assuming they match --pad.
        margin: "calc(-1 * var(--pad, 20px)) calc(-1 * var(--pad-x, 20px))",
        width: "calc(100% + calc(2 * var(--pad-x, 20px)))",
        height: "calc(100vh - 56px)",
        overflow: "hidden",
      }}
    >
      {/* Left panel: conversation list — hidden below `md` (D-121: single
          pane on a phone is a different screen, not a reflow). */}
      <ConversationListSidebar selectedId={id} />

      {/* Right panel: conversation detail */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* #573: below `md` there is no visible list to navigate back to
            (the sidebar is `hidden`) — this is the phone-width escape
            hatch. `flex md:hidden` (both own `display`, D-120 — no inline
            `display` here) is the mirror of the sidebar's `hidden md:flex`:
            visible only when the sidebar isn't. */}
        <Link
          href="/conversations"
          data-testid="mobile-back-to-list"
          className="flex md:hidden"
          style={{
            alignItems: "center",
            padding: "10px 16px",
            fontSize: 13,
            color: "var(--fg-muted)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          ← Conversaciones
        </Link>
        <ConversationPane mode="standalone" conversationId={id} />
      </div>
    </div>
  );
}
