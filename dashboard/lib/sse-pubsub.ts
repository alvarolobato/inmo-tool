/**
 * In-process SSE pub/sub — conversation-scoped event fan-out.
 *
 * Uses a plain Node.js EventEmitter keyed by conversation ID. Every live SSE
 * connection subscribes here; the background turn job publishes here after
 * each DB write so clients receive events in real-time.
 *
 * Scale boundary: this is a single-process, in-memory bus. It works correctly
 * for a single-container deployment (one Node.js process). If the app is ever
 * scaled to multiple processes or containers, replace this with an external
 * pub/sub transport (Redis Pub/Sub, NATS, etc.) so all processes share the
 * same event stream. The subscribe/publish interface is intentionally thin to
 * make that replacement straightforward.
 */

import { EventEmitter } from "events";

export interface SseEvent {
  /** turn_events.id (BIGSERIAL) — used as SSE `id:` for Last-Event-ID resumption. */
  dbEventId: number;
  turnId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
}

type Listener = (event: SseEvent) => void;

// One emitter per conversation, cleaned up when the last subscriber leaves.
const emitters = new Map<string, { emitter: EventEmitter; count: number }>();

function getOrCreate(conversationId: string): EventEmitter {
  const existing = emitters.get(conversationId);
  if (existing) {
    existing.count++;
    return existing.emitter;
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  emitters.set(conversationId, { emitter, count: 1 });
  return emitter;
}

function release(conversationId: string): void {
  const entry = emitters.get(conversationId);
  if (!entry) return;
  entry.count--;
  if (entry.count <= 0) {
    entry.emitter.removeAllListeners();
    emitters.delete(conversationId);
  }
}

/**
 * Subscribe to live events for a conversation.
 * Returns an unsubscribe function — call it when the SSE connection closes.
 * The returned function is idempotent: calling it twice is a no-op.
 */
export function subscribe(conversationId: string, listener: Listener): () => void {
  const emitter = getOrCreate(conversationId);
  emitter.on("event", listener);

  let called = false;
  return () => {
    if (called) return;
    called = true;
    emitter.off("event", listener);
    release(conversationId);
  };
}

/**
 * Publish an event to all active subscribers for a conversation.
 * Called by the background turn job after each insertTurnEvent() DB write.
 */
export function publish(conversationId: string, event: SseEvent): void {
  const entry = emitters.get(conversationId);
  if (entry) {
    entry.emitter.emit("event", event);
  }
}

/** Exposed for testing only — current subscriber count for a conversation. */
export function subscriberCount(conversationId: string): number {
  return emitters.get(conversationId)?.count ?? 0;
}

/** Exposed for testing only — resets all emitter state between tests. */
export function __resetForTests(): void {
  for (const { emitter } of emitters.values()) {
    emitter.removeAllListeners();
  }
  emitters.clear();
}
