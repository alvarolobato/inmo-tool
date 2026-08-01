import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ConversationPane } from "@/components/ConversationPane";
import DashboardSurface from "@/components/surfaces/DashboardSurface";
import HomeSurface from "@/components/surfaces/HomeSurface";
import AdminSurface from "@/components/surfaces/AdminSurface";
import { fetchConversation } from "@/lib/conversation-api";

// Must be dynamic: fetchConversation calls the internal API at render time.
// Without this, Next.js tries to statically generate the page at build time
// when no real conversation exists, fetches null, and bakes in a 404.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function LoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div
        className="h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
        role="status"
        aria-label="Cargando"
      />
    </div>
  );
}

export default async function ConversationInContextPage({ params }: PageProps) {
  const { id } = await params;
  const conv = await fetchConversation(id);
  if (!conv) notFound();

  const { context_kind, context_ref, context_url, mode } = conv;

  // Derive sidebar tab from conversation mode
  const chatTabMode: "modificar" | "analizar" =
    mode === "analyze" ? "analizar" : "modificar";

  if (context_kind === "dashboard" && context_ref) {
    return (
      <Suspense fallback={<LoadingSpinner />}>
        <DashboardSurface
          dashboardId={context_ref}
          preloadedConversation={conv}
          initialChatTabMode={chatTabMode}
          kMode
          contextUrl={context_url}
        />
      </Suspense>
    );
  }

  if (context_kind === "home") {
    return (
      <HomeSurface
        preloadedConversation={conv}
        contextUrl={context_url}
      />
    );
  }

  if (context_kind === "admin") {
    return (
      <AdminSurface
        preloadedConversation={conv}
        contextUrl={context_url}
      />
    );
  }

  // context_kind === 'global' or unknown: fall back to chat-only viewer
  return (
    <div
      style={{
        height: "calc(100vh - 56px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ConversationPane mode="standalone" conversationId={id} />
    </div>
  );
}
