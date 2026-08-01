/**
 * GET /api/conversations/:id/stream — SSE event stream for a conversation.
 *
 * On connect:
 *   1. Validate the conversation exists.
 *   2. Subscribe to the in-process pub/sub (before history replay, to avoid the race
 *      window where events published during the DB query would be lost).
 *   3. Replay all turn_events with id > Last-Event-ID (default 0) in seq order.
 *   4. Flush any live events buffered during replay, deduplicating against history.
 *   5. Send a keepalive ping every 15 s.
 *   6. On client disconnect: unsubscribe and close the stream.
 *
 * SSE format:
 *   id: <turn_event.id>
 *   data: <JSON with turnId, seq, eventType, payload>
 *
 * Clients reconnect by sending `Last-Event-ID: N` — they will only receive
 * events with turn_event.id > N.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/conversations";
import { getConversationEvents } from "@/lib/turn-events";
import { subscribe, type SseEvent } from "@/lib/sse-pubsub";
import { formatApiError, generateRequestId } from "@/lib/errors";

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

const ID_PATTERN = /^[a-f0-9]{12}$/;
// Must be shorter than the server's Keep-Alive timeout (5 s in Next.js standalone).
// Without a ping within 5 s, the connection closes and the client replays all
// events as a batch on reconnect, breaking live streaming.
const KEEPALIVE_MS = 3_000;

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse | Response> {
  const requestId = generateRequestId();
  const { id } = await context.params;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      formatApiError("ID de conversación no válido.", "VALIDATION", undefined, requestId),
      { status: 400 },
    );
  }

  // Verify conversation exists before opening the stream.
  let conversation;
  try {
    conversation = await getConversation(id);
  } catch (err) {
    console.error(`[${requestId}] GET /api/conversations/${id}/stream DB error:`, err);
    return NextResponse.json(
      formatApiError("Error al acceder a la conversación.", "DB_ERROR", undefined, requestId),
      { status: 500 },
    );
  }
  if (!conversation) {
    return NextResponse.json(
      formatApiError(
        "Conversación no encontrada.",
        "NOT_FOUND",
        `No existe ninguna conversación con ID ${id}.`,
        requestId,
      ),
      { status: 404 },
    );
  }

  // Parse Last-Event-ID header for resumption (default: replay everything).
  // Number() rejects trailing garbage ("5xyz" → NaN) unlike parseInt which returns 5.
  const lastEventIdHeader = request.headers.get("Last-Event-ID");
  const rawSinceId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;
  const sinceIdParam = Number.isInteger(rawSinceId) && rawSinceId > 0 ? rawSinceId : undefined;

  const encoder = new TextEncoder();

  function formatEvent(eventId: number, data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`id: ${eventId}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function formatPing(): Uint8Array {
    return encoder.encode(`event: ping\ndata: {}\n\n`);
  }

  // Closure-captured cleanup refs so cancel() can reach them.
  let unsubscribeFn: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (unsubscribeFn !== null) {
      unsubscribeFn();
      unsubscribeFn = null;
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      // Subscribe BEFORE fetching history to close the race window where events
      // published between the DB snapshot and subscribe() would be lost. Events
      // that arrive during replay are buffered and deduplicated afterwards.
      const liveBuffer: SseEvent[] = [];
      let replayDone = false;
      let maxReplayedId = 0;

      unsubscribeFn = subscribe(id, (event: SseEvent) => {
        if (!replayDone) {
          liveBuffer.push(event);
          return;
        }
        if (event.dbEventId <= maxReplayedId) return;
        try {
          controller.enqueue(
            formatEvent(event.dbEventId, {
              turnId: event.turnId,
              seq: event.seq,
              eventType: event.eventType,
              payload: event.payload,
            }),
          );
        } catch {
          cleanup();
        }
      });

      // Replay historical events. On a FRESH connection (no Last-Event-ID)
      // these frames are tagged `replay: true` so the client treats them as
      // catch-up data (accumulate state; no refetch per historical turn; no
      // pending-turn adoption) — see ConversationPane's handleEvent and issues
      // #825/#836. On a RESUMPTION connection (Last-Event-ID > 0) the replayed
      // frames are live events the client missed during the disconnect —
      // including a possible complete/error — so they are NOT tagged, letting
      // the client run its normal refetch/settlement logic immediately instead
      // of waiting for the liveness poll.
      const isFreshConnection = sinceIdParam === undefined;
      let historicalEvents;
      try {
        historicalEvents = await getConversationEvents(id, sinceIdParam);
      } catch (err) {
        console.error(`[${requestId}] stream replay error for ${id}:`, err);
        cleanup();
        controller.close();
        return;
      }

      for (const ev of historicalEvents) {
        if (ev.id > maxReplayedId) maxReplayedId = ev.id;
        try {
          controller.enqueue(
            formatEvent(ev.id, {
              turnId: ev.turn_id,
              seq: ev.seq,
              eventType: ev.event_type,
              payload: ev.payload,
              ...(isFreshConnection ? { replay: true } : {}),
            }),
          );
        } catch {
          // Controller already closed (client disconnected during replay).
          cleanup();
          return;
        }
      }

      // Flush buffered live events, skipping those already sent via history
      // replay. These arrived while the snapshot query ran — they are LIVE
      // events (just slightly delayed), so they are never tagged as replay:
      // a complete/error landing in this window must trigger the client's
      // normal refetch/settlement logic.
      replayDone = true;
      for (const ev of liveBuffer) {
        if (ev.dbEventId <= maxReplayedId) continue;
        try {
          controller.enqueue(
            formatEvent(ev.dbEventId, {
              turnId: ev.turnId,
              seq: ev.seq,
              eventType: ev.eventType,
              payload: ev.payload,
            }),
          );
        } catch {
          cleanup();
          return;
        }
      }
      liveBuffer.length = 0;

      // Keepalive timer — prevents proxy/load-balancer idle timeouts.
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(formatPing());
        } catch {
          cleanup();
        }
      }, KEEPALIVE_MS);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
