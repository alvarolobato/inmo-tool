/**
 * Extension presence — client-safe pure helpers (issue #509).
 *
 * No `pg` import, so both the API route (server) and the `<ExtensionCta/>`
 * client component can share the linked-window math and the status shape. DB
 * access lives in lib/db/extension-status.ts (server-only), the same split as
 * lib/data-health.ts ↔ lib/db/data-health.ts.
 *
 * "Linked" is a recency judgement: the extension pings on worker spawn and on
 * its ~30s watchdog tick (browser-extension/background.js), so a last-seen
 * within LINKED_WINDOW_MS means it is installed AND configured with a working
 * API URL + key right now. Older than that (or never seen) → show the CTA.
 */

/**
 * How recent the last heartbeat must be to count as "linked". The extension
 * pings every ~30s while its worker is alive; 10 minutes is 20× that, generous
 * headroom for a briefly-evicted MV3 service worker without calling a genuinely
 * absent extension "linked".
 */
export const LINKED_WINDOW_MS = 10 * 60 * 1000;

/** The status shape both the API route and the CTA component consume. */
export interface ExtensionStatus {
  /** True when a heartbeat landed within LINKED_WINDOW_MS. */
  linked: boolean;
  /** ISO timestamp of the last heartbeat, or null if none recorded. */
  lastSeenAt: string | null;
  /** The extension version reported at the last heartbeat, or null. */
  version: string | null;
}

/**
 * Pure: is a last-seen timestamp recent enough to count as linked? Null (never
 * seen) or an unparseable value is never linked. The single source of truth for
 * the rule, tested in isolation.
 */
export function isLinked(lastSeenAt: string | null, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return false;
  return now.getTime() - seen <= LINKED_WINDOW_MS;
}
