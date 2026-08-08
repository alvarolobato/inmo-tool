/**
 * Validation-mode signal for the browser extension (issue #478 P3).
 *
 * When the dashboard opens a portal search URL from the "Validar filtros" page
 * ("Abrir" on /profiles/[id]/filtros), we tag the URL with a signal the
 * extension's content script reads on load to enter VALIDATION MODE for that
 * tab: no batch autostart, no listing banner, and no detail auto-capture — so
 * the owner can open the portal, tune the search filters (e.g. draw a zone on
 * Idealista → `shape=`) and hand the URL back as this connector's pinned filter,
 * all WITHOUT the extension capturing anything.
 *
 * Unlike the bare `#inmo-capture` signal, this one carries a PAYLOAD — the
 * profile id + connector the owner is validating — so the popup's "Usar esta URL
 * como filtro" button knows which (profile × connector) to pin. The payload is
 * `#inmo-validate=<profileId>:<connector>` (preferred: a fragment, invisible to
 * the portal, never sent to its server). If the URL already carries a fragment
 * we fall back to a query key `?inmo-validate=<profileId>:<connector>` rather
 * than clobbering it — and if the URL can't be parsed at all we return it
 * untouched, so tagging can NEVER break the opened URL.
 *
 * The extension strips the signal off the visible URL on load
 * (history.replaceState) and holds the (profile × connector) in per-tab session
 * state, so validation mode SURVIVES in-portal navigation while the owner tunes
 * — the fragment is gone, but the tab stays suppressed.
 *
 * This MUST agree byte-for-byte with the extension's browser-extension/detect.js
 * `validateSignalPayload` / `stripValidateSignal` / `VALIDATE_SIGNAL`.
 */

export const VALIDATE_SIGNAL = "inmo-validate";

/** The `<profileId>:<connector>` payload string for a validation signal. */
export function validateSignalPayload(profileId: number, connector: string): string {
  return `${profileId}:${connector}`;
}

/**
 * Return `rawUrl` tagged with the validation-mode signal for `(profileId,
 * connector)`. Never throws; returns the input unchanged when it isn't a
 * parseable absolute URL. Idempotent — a URL already carrying the signal (either
 * form) is returned untouched.
 */
export function withValidateSignal(
  rawUrl: string,
  profileId: number,
  connector: string,
): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // never break the URL
  }
  const payload = validateSignalPayload(profileId, connector);
  // Already tagged (either form) — idempotent, leave it untouched.
  const hashKey = u.hash.replace(/^#/, "");
  if (hashKey === VALIDATE_SIGNAL || hashKey.startsWith(VALIDATE_SIGNAL + "=") || u.searchParams.has(VALIDATE_SIGNAL)) {
    return rawUrl;
  }
  if (!u.hash) {
    u.hash = `${VALIDATE_SIGNAL}=${payload}`;
    return u.toString();
  }
  // Already has a fragment — don't clobber it; use the query fallback instead.
  u.searchParams.set(VALIDATE_SIGNAL, payload);
  return u.toString();
}
