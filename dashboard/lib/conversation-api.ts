import type { ConversationWithMessages } from "@/lib/conversation-types";
import { getAppPublicUrl } from "@/lib/public-urls";

/**
 * Fetches a conversation by ID from the internal API.
 *
 * IMPORTANT: This is a server-to-self call made during SSR. It MUST use the
 * loopback address (127.0.0.1) and the container's own PORT — never the
 * incoming request's Host header.
 *
 * Why not use the Host header?
 *   When the app is served through a reverse proxy (e.g. power.lobato.vip),
 *   the Host header contains the external hostname. A self-fetch to
 *   `http://power.lobato.vip/api/...` leaves the container network, goes
 *   through the proxy, and fails (TLS mismatch, routing, or DNS inside Docker).
 *   The result is a null response → notFound() → 404 for every /c/ and /k/ page.
 *
 * Fix: always fetch via http://127.0.0.1:{DASHBOARD_PORT|PORT|4000}. The
 * loopback address always resolves inside the container. Port resolution:
 * DASHBOARD_PORT (docker-compose env) → PORT (Next.js standalone) → 4000.
 *
 * Returns null for 404 or any fetch error (caller should `notFound()`).
 */
export async function fetchConversation(id: string): Promise<ConversationWithMessages | null> {
  try {
    // Use the loopback address so the fetch always stays inside the container
    // regardless of how the request arrived (direct LAN access or reverse proxy).
    // Port resolution order: DASHBOARD_PORT (docker-compose), PORT (Next.js
    // standalone default), fallback 4000.
    const port = process.env.DASHBOARD_PORT ?? process.env.PORT ?? "4000";
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await fetch(`${baseUrl}/api/conversations/${id}`, {
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as ConversationWithMessages;
  } catch {
    return null;
  }
}

// Re-export for convenience — callers that need the public URL for other
// purposes can import it from here instead of lib/public-urls directly.
export { getAppPublicUrl };
