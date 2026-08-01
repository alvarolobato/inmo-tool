import { ConversationPane } from "@/components/ConversationPane";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationChatPage({ params }: PageProps) {
  const { id } = await params;

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
