/**
 * URL-building discovery signal for the browser extension (issue #336).
 *
 * When the /etl/discovery admin page opens a portal SEARCH URL to start a
 * discovery session, we tag the URL with a signal the extension's content
 * script reads to run the OPTION-ENUMERATION pass (discover.js) instead of the
 * listing-capture pass.
 *
 * The signal is the URL fragment `#inmo-discover` (preferred: invisible to the
 * portal, never sent to its server). If the URL already carries a fragment we
 * fall back to a query key `?inmo-discover` rather than clobbering it — and if
 * the URL can't be parsed we return it untouched, so tagging can NEVER break the
 * opened URL.
 *
 * This MUST agree byte-for-byte with the extension's browser-extension/detect.js
 * `discoverSignalPresent` / `DISCOVER_SIGNAL`.
 */

export const DISCOVER_SIGNAL = "inmo-discover";

/**
 * Return `rawUrl` tagged with the discovery signal. Never throws; returns the
 * input unchanged when it isn't a parseable absolute URL.
 */
export function withDiscoverSignal(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // never break the URL
  }
  // Already tagged (either form) — idempotent, leave it untouched.
  if (u.hash.replace(/^#/, "") === DISCOVER_SIGNAL || u.searchParams.has(DISCOVER_SIGNAL)) {
    return rawUrl;
  }
  if (!u.hash) {
    u.hash = DISCOVER_SIGNAL;
    return u.toString();
  }
  // Already has a fragment — don't clobber it; use the query fallback instead.
  u.searchParams.set(DISCOVER_SIGNAL, "1");
  return u.toString();
}
