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
 * "Capturar todo" batch-queue signal (issue #556, revised per D-113 review B2).
 *
 * The dashboard has NO direct messaging channel to the extension — it can only
 * reach it by opening a tab the extension's content script is running on (see
 * `withCaptureSignal` above; `browser-extension/background.js`'s own
 * `sendHeartbeat` docstring records the same constraint the other way: "the
 * extension can NOT inject into the dashboard origin"). So queuing several
 * capture TASKS from one button click can only open ONE tab (the popup-blocker
 * constraint — see `CapturaProfileSection.onCapturarTodo`) and must hand the
 * REST to the extension through that one tab's content script.
 *
 * `withCaptureQueue` piggybacks the remaining tasks' `{portal, captureUrl}`
 * pairs onto the FIRST task's URL as `#inmo-capture-queue=<json>` — the URL
 * FRAGMENT, not the query string — a compact `[portal, captureUrl][]` tuple
 * array, percent-encoded explicitly (`encodeURIComponent`, decoded the same
 * way on the extension side — see `browser-extension/detect.js`
 * `urlSignalValue`'s fragment branch). The content script reads it
 * (`detect.js` `parseCaptureQueue`) and forwards it to `background.js`'s
 * `startBatch`, which appends each entry to #555/D-112's OWN pending-search
 * queue (`InmoBatch.enqueueSearch`) — the extension then opens each queued
 * search itself, one at a time (`chrome.tabs`, exempt from the page-level
 * popup blocker), exactly as D-043/D-112 already do for pagination and for
 * manually-queued searches. No parallel queue is invented.
 *
 * **Fragment, never query** (revised from the first version of this feature,
 * which used a query param — see D-113 for the fresh-context review that
 * caught it, issue #556 review B1/B2). A fragment is NEVER sent to the portal
 * server by the browser, so:
 *   - it costs nothing in WAF/analytics exposure on the first task's portal
 *     (a multi-kilobyte list of our own search URLs never reaches idealista/
 *     aliseda/altamira's logs — versus a query param, which would);
 *   - every portal URL-grammar PARSER in `lib/search-url/portals/*.ts`
 *     (`parseAliseda` etc.) derives its template from pathname + query only,
 *     never `.hash` — so a payload that lives in the fragment can never reach
 *     a learned/pinned search-url template (D-051/D-101), REGARDLESS of
 *     whether any particular call site remembers to strip it first. This is
 *     what makes the "stale learned template gets poisoned" failure mode
 *     (review B1) structurally impossible rather than merely avoided by
 *     convention at today's one stripping call site.
 *
 * **Composition order matters**: the call site
 * (`CapturaProfileSection.onCapturarTodo`) applies `withCaptureQueue` FIRST,
 * then `withCaptureSignal` — i.e. `withCaptureSignal(withCaptureQueue(url,
 * queue))`. `withCaptureQueue` claims the fragment slot (when `queue` is
 * non-empty); `withCaptureSignal` then sees a fragment already present and
 * falls back to its OWN existing query-key form (`?inmo-capture=1`) — this
 * requires ZERO changes to `withCaptureSignal`/`captureSignalPresent` (that
 * fallback already existed for the "URL already has an unrelated fragment"
 * case). The SIGNAL therefore still travels in the query for a batch-opened
 * URL — a small (~15-byte), already-accepted exposure, same class as before
 * this revision — while the (potentially multi-KB) QUEUE payload never
 * reaches the wire at all. When only one task is ticked (`queue` is empty),
 * `withCaptureQueue` is a no-op and the URL is byte-identical to the
 * single-task flow (signal in the fragment, exactly as today).
 *
 * MUST agree byte-for-byte with `browser-extension/detect.js`
 * `CAPTURE_QUEUE_SIGNAL` / `parseCaptureQueue` / `urlSignalValue`.
 */
export const CAPTURE_QUEUE_SIGNAL = "inmo-capture-queue";

/** One additional search to queue behind the tab actually being opened. */
export interface QueuedSearch {
  portal: string;
  /** The harvester-facing URL (issue #529 / D-101) — never the display `url`. */
  captureUrl: string;
}

/**
 * Sane cap on how many additional searches one "Capturar todo" click will
 * piggyback (issue #556 review B3). A URL fragment has no server-enforced
 * length limit, but an unbounded queue is still a bad contract — browsers cap
 * total URL length, and a very long tail just means "queued but nothing
 * visibly happens for a long time" with no feedback. Real profiles are
 * single-digit portal×section counts; this cap is generous headroom, not a
 * target. See `lib/captura-tasks.ts` `capCaptureBatchPlan`, which enforces it
 * and reports how many were dropped so the caller can tell the owner honestly.
 */
export const MAX_QUEUE_ENTRIES = 24;

/** Encode a queue of searches as the `inmo-capture-queue` signal value. */
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
 * Return `rawUrl` with `queue` appended as the `#inmo-capture-queue=<json>`
 * URL FRAGMENT (never the query string — see the module docstring for why).
 * A no-op (returns `rawUrl` unchanged) when `queue` is empty or the URL isn't
 * parseable — tagging can never break the opened URL, same contract as
 * `withCaptureSignal`. Idempotent (already-tagged URL returned unchanged).
 *
 * Falls back to the query string ONLY when `rawUrl` already carries an
 * unrelated fragment (rare for a portal search URL, but never break it) —
 * documented, accepted degrade: that fallback re-exposes the queue to the
 * first task's portal server, same class of risk this fragment-first design
 * exists to avoid in the common case.
 *
 * Call this BEFORE `withCaptureSignal` (see module docstring on composition
 * order) — `CapturaProfileSection.onCapturarTodo` is the one real call site.
 */
export function withCaptureQueue(rawUrl: string, queue: readonly QueuedSearch[]): string {
  if (queue.length === 0) return rawUrl;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // never break the URL
  }
  const hashKey = u.hash.replace(/^#/, "");
  // Already tagged (either form) — idempotent, leave it untouched.
  if (
    hashKey === CAPTURE_QUEUE_SIGNAL ||
    hashKey.startsWith(`${CAPTURE_QUEUE_SIGNAL}=`) ||
    u.searchParams.has(CAPTURE_QUEUE_SIGNAL)
  ) {
    return rawUrl;
  }
  const payload = encodeCaptureQueue(queue);
  if (!u.hash) {
    u.hash = `${CAPTURE_QUEUE_SIGNAL}=${encodeURIComponent(payload)}`;
    return u.toString();
  }
  // Already has an unrelated fragment — fall back to the query string rather
  // than clobbering it. See docstring: an accepted, documented degrade.
  u.searchParams.set(CAPTURE_QUEUE_SIGNAL, payload);
  return u.toString();
}
