/**
 * Batch auto-start signal for the browser extension (issue #297).
 *
 * When the dashboard opens a portal SEARCH URL for guided capture ("Abrir
 * búsqueda" on /captura), we tag the URL with a signal the extension's content
 * script reads on a recognized listing page to AUTO-START the batch run — so
 * the owner never has to open the popup or click the in-page banner.
 *
 * The signal is the URL fragment `#inmo-capture` (preferred: invisible to the
 * portal, never sent to its server). If the URL already carries a fragment we
 * fall back to a query key `?inmo-capture` rather than clobbering it — and if
 * the URL can't be parsed at all we return it untouched, so tagging can NEVER
 * break the opened URL.
 *
 * This MUST agree byte-for-byte with the extension's
 * browser-extension/detect.js `captureSignalPresent` / `CAPTURE_SIGNAL`.
 */

export const CAPTURE_SIGNAL = "inmo-capture";

/**
 * Return `rawUrl` tagged with the batch auto-start signal. Never throws; returns
 * the input unchanged when it isn't a parseable absolute URL.
 */
export function withCaptureSignal(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // never break the URL
  }
  // Already tagged (either form) — idempotent, leave it untouched.
  if (u.hash.replace(/^#/, "") === CAPTURE_SIGNAL || u.searchParams.has(CAPTURE_SIGNAL)) {
    return rawUrl;
  }
  if (!u.hash) {
    u.hash = CAPTURE_SIGNAL;
    return u.toString();
  }
  // Already has a fragment — don't clobber it; use the query fallback instead.
  if (!u.searchParams.has(CAPTURE_SIGNAL)) {
    u.searchParams.set(CAPTURE_SIGNAL, "1");
  }
  return u.toString();
}

/**
 * "Capturar todo" batch-queue signal (issue #556).
 *
 * The dashboard has NO direct messaging channel to the extension — it can only
 * reach it by opening a tab the extension's content script is running on (see
 * `withCaptureSignal` above; `browser-extension/background.js`'s own
 * `sendHeartbeat` docstring records the same constraint the other way: "the
 * extension can NOT inject into the dashboard origin"). So queuing several
 * capture TASKS from one button click can only open ONE tab (the popup-blocker
 * constraint — see `ConnectorSection.onExecuteAll`) and must hand the REST to
 * the extension through that one tab's content script.
 *
 * `withCaptureQueue` piggybacks the remaining tasks' `{portal, captureUrl}`
 * pairs onto the FIRST task's URL as a `?inmo-capture-queue=<json>` query
 * param (a compact `[portal, captureUrl][]` tuple array). The content script
 * reads it (`detect.js` `parseCaptureQueue`) and forwards it to
 * `background.js`'s `startBatch`, which appends each entry to #555/D-112's
 * OWN pending-search queue (`InmoBatch.enqueueSearch`) — the extension then
 * opens each queued search itself, one at a time (`chrome.tabs`, exempt from
 * the page-level popup blocker), exactly as D-043/D-112 already do for
 * pagination and for manually-queued searches. No parallel queue is invented.
 *
 * Query param, not fragment: `withCaptureSignal` already claims the fragment
 * slot for the (byte-for-byte pinned) `#inmo-capture` signal, so this rides in
 * the query string instead — visible to the first task's portal, same class of
 * exposure already accepted for `CAPTURE_SIGNAL`'s own query-key fallback.
 * Kept compact (a 2-tuple per entry, no other fields) to minimise that
 * footprint. MUST agree byte-for-byte with `browser-extension/detect.js`
 * `CAPTURE_QUEUE_SIGNAL` / `parseCaptureQueue`.
 */
export const CAPTURE_QUEUE_SIGNAL = "inmo-capture-queue";

/** One additional search to queue behind the tab actually being opened. */
export interface QueuedSearch {
  portal: string;
  /** The harvester-facing URL (issue #529 / D-101) — never the display `url`. */
  captureUrl: string;
}

/** Encode a queue of searches as the `inmo-capture-queue` param value. */
export function encodeCaptureQueue(queue: readonly QueuedSearch[]): string {
  return JSON.stringify(queue.map((q) => [q.portal, q.captureUrl]));
}

/** Inverse of {@link encodeCaptureQueue}. Never throws; `null` on bad input. */
export function decodeCaptureQueue(raw: string): QueuedSearch[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: QueuedSearch[] = [];
  for (const entry of data) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      out.push({ portal: entry[0], captureUrl: entry[1] });
    }
  }
  return out;
}

/**
 * Return `rawUrl` with `queue` appended as the `inmo-capture-queue` query
 * param. A no-op (returns `rawUrl` unchanged) when `queue` is empty or the URL
 * isn't parseable — tagging can never break the opened URL, same contract as
 * `withCaptureSignal`. Apply AFTER `withCaptureSignal` (order doesn't matter
 * functionally — this always uses the query string — but matches call-site
 * order at the one place both are used, `ConnectorSection.onExecuteAll`).
 */
export function withCaptureQueue(rawUrl: string, queue: readonly QueuedSearch[]): string {
  if (queue.length === 0) return rawUrl;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // never break the URL
  }
  u.searchParams.set(CAPTURE_QUEUE_SIGNAL, encodeCaptureQueue(queue));
  return u.toString();
}
