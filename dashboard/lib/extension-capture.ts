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
