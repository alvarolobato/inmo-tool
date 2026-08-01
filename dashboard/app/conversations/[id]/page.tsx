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
        // The root layout's <main> has .main-content padding: 20px on all sides.
        // Negate it so this page is full-bleed and exactly fills the viewport
        // below the 56px TopBar. Without this, height: calc(100vh - 56px) makes
        // the content 40px taller than the available space and the page scrolls.
        margin: -20,
        width: "calc(100% + 40px)",
        height: "calc(100vh - 56px)",
        overflow: "hidden",
      }}
    >
      {/* Left panel: conversation list */}
      <ConversationListSidebar selectedId={id} />

      {/* Right panel: conversation detail */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <ConversationPane mode="standalone" conversationId={id} />
      </div>
    </div>
  );
}
