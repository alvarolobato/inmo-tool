/**
 * Shared helpers for post-login redirect handling in the admin area.
 *
 * The middleware forwards the originally requested path as `?redirect=<path>`
 * to `/admin/login`. After a successful login, we return the user to that
 * target — but only if the value is a safe local path that actually lives
 * inside the admin area (either `/admin/*` or `/etl*`).
 *
 * Rejecting everything else prevents open-redirect attacks where a crafted
 * value like `//evil.example.com` or `https://evil.example.com` would send
 * the user off-site once they hold a valid session cookie.
 */

/**
 * Fallback landing page when no valid redirect target is supplied.
 *
 * Invariant: this value must (a) pass all the validation rules in
 * `safeAdminRedirectTarget`, (b) not be the login page, and (c) not be the
 * bare `/admin` root (which only server-side redirects back here). It is a
 * compile-time constant so there is no runtime loop risk.
 */
export const DEFAULT_ADMIN_LANDING = "/admin/slow-queries";

// Matches ASCII control characters (0x00-0x1F, 0x7F) plus any whitespace.
// These must never appear in a Location header because CR/LF could be abused
// to inject headers, and other whitespace would have been percent-encoded by
// the browser if legitimate.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_WHITESPACE = /[\x00-\x1F\x7F\s]/;

// Matches local paths that live inside the admin area.
const ADMIN_AREA_PATH = /^\/(admin|etl)(\/|\?|#|$)/;

/**
 * Returns a sanitized local redirect path, or the default landing page if the
 * supplied value is missing, malformed, or not inside the admin area.
 *
 * Accepts only paths that:
 * - start with a single `/` (rejects protocol-relative `//…` and any URL with
 *   a scheme such as `http:`/`https:`/`javascript:`/`data:`).
 * - do not contain a backslash (rejects quirks like `/\evil.example.com`).
 * - contain no control characters or whitespace.
 * - begin with `/admin` or `/etl` followed by `/`, `?`, `#`, or end-of-string.
 * - are not the login page itself.
 *
 * The bare `/admin` (and `/admin/`, with or without query/hash) is also mapped
 * to `DEFAULT_ADMIN_LANDING`. Although `app/admin/page.tsx` now exists and
 * server-redirects there, bypassing the extra round-trip is both faster for
 * the user and avoids any redirect chaining in the login flow.
 */
export function safeAdminRedirectTarget(input: string | null | undefined): string {
  if (typeof input !== "string") return DEFAULT_ADMIN_LANDING;
  const value = input.trim();
  if (value.length === 0) return DEFAULT_ADMIN_LANDING;

  // Must be an absolute local path.
  if (!value.startsWith("/")) return DEFAULT_ADMIN_LANDING;
  // Reject protocol-relative (`//host`) and any backslash tricks.
  if (value.startsWith("//")) return DEFAULT_ADMIN_LANDING;
  if (value.includes("\\")) return DEFAULT_ADMIN_LANDING;

  // Reject any control characters (including CR/LF) or whitespace.
  if (CONTROL_OR_WHITESPACE.test(value)) return DEFAULT_ADMIN_LANDING;

  // Normalize dot-segments (e.g. `/admin/../` → `/`) so that paths like
  // `/admin/../somewhere` cannot pass the allowlist check but resolve to a
  // non-admin path after user-agent normalization.
  let parsed: URL;
  try {
    parsed = new URL(value, "http://local");
  } catch {
    return DEFAULT_ADMIN_LANDING;
  }
  const pathOnly = parsed.pathname;

  // Only admin-area paths are allowed after normalizing dot segments.
  if (!ADMIN_AREA_PATH.test(pathOnly)) return DEFAULT_ADMIN_LANDING;

  // Never bounce back to the login page itself.
  if (pathOnly === "/admin/login" || pathOnly.startsWith("/admin/login/")) {
    return DEFAULT_ADMIN_LANDING;
  }

  return `${pathOnly}${parsed.search}${parsed.hash}`;
}
