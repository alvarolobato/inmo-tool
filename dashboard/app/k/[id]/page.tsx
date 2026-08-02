import { notFound } from "next/navigation";
import { ConversationPane } from "@/components/ConversationPane";
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

export default async function ConversationInContextPage({ params }: PageProps) {
  const { id } = await params;
  const conv = await fetchConversation(id);
  if (!conv) notFound();

  const { context_kind, context_url } = conv;

  // context_kind === 'dashboard' deliberately has NO branch here (#101): the
  // generic dashboard-builder feature this product inherited from
  // powershop-analytics was removed, along with every /api/dashboard/* route
  // its viewer called at runtime. Historical dashboard-attached conversations
  // still exist in the `conversations` table, so they fall through to the
  // chat-only viewer below and remain readable — they just no longer render a
  // dashboard alongside the transcript.

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
