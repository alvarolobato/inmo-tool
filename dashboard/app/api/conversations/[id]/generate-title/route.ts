import { NextRequest, NextResponse } from "next/server";
import { getConversationWithMessages, maybeGenerateTitle } from "@/lib/conversations";
import { generateRequestId } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

/** POST /api/conversations/:id/generate-title — fire-and-forget title generation. */
export async function POST(
  _request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { id } = await context.params;
  const requestId = generateRequestId();
  try {
    const conv = await getConversationWithMessages(id);
    if (!conv?.messages?.length) return NextResponse.json({ ok: true });
    const turns = conv.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const c = m.content;
        const text =
          typeof c === "string" ? c
          : c !== null && typeof c === "object" && typeof (c as Record<string,unknown>).text === "string"
            ? ((c as Record<string,unknown>).text as string)
            : JSON.stringify(c);
        return { role: m.role as "user" | "assistant", content: text };
      });
    void maybeGenerateTitle(id, turns).catch((e) =>
      console.warn(`[${requestId}] maybeGenerateTitle failed for ${id}:`, e),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.warn(`[${requestId}] generate-title error for ${id}:`, err);
    return NextResponse.json({ ok: true });
  }
}
