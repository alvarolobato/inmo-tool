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

/** The heartbeat-derived status the DB layer produces. */
export interface ExtensionStatus {
  /** True when a heartbeat landed within LINKED_WINDOW_MS. */
  linked: boolean;
  /** ISO timestamp of the last heartbeat, or null if none recorded. */
  lastSeenAt: string | null;
  /** The extension version reported at the last heartbeat, or null. */
  version: string | null;
}

/**
 * The full shape `GET /api/extension/status` returns and the CTA consumes: the
 * heartbeat status plus `servedVersion` — the version of the extension this
 * dashboard currently serves at `/api/extension/download`. Read from a shared
 * source at request time (see lib/extension-served-version.ts), never hardcoded,
 * so the CTA can tell the installed version (`version`) from the available one
 * and prompt an update even while linked (#527).
 */
export interface ExtensionStatusResponse extends ExtensionStatus {
  /** The version this dashboard currently serves, or null if unknown. */
  servedVersion: string | null;
}

/**
 * Compare two dotted numeric versions ("0.14.2" vs "0.13.10"). Returns -1 if
 * `a < b`, 1 if `a > b`, 0 if equal. Missing trailing parts count as 0
 * ("0.14" == "0.14.0"). A non-numeric part anywhere makes the pair
 * incomparable → 0, so an unparseable version never triggers a false update
 * prompt. Pure; the single source of the ordering rule, tested in isolation.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = i < pa.length ? Number(pa[i]) : 0;
    const y = i < pb.length ? Number(pb[i]) : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Is an update available? True only when both versions are known and the
 * installed one is strictly older than the served one. Null on either side (or
 * an incomparable pair) → false, so we never nag when we can't be sure.
 */
export function updateAvailable(installed: string | null, served: string | null): boolean {
  if (!installed || !served) return false;
  return compareVersions(installed, served) < 0;
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
